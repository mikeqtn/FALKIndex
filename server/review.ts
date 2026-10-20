import { Router } from 'express';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { REVIEW_ACTIONS, REVIEW_STATUSES, type ReviewAction, type ReviewDetail, type ReviewStatus, type ReviewSummary } from '../src/accounts/contracts.ts';
import { pool, querySeries, transaction } from './db.ts';
import { audit, authenticatedAccount, enforceAccount, HttpError, realm } from './accounts.ts';

type Queryable = Pick<Pool | PoolClient, 'query'>;
const EDITORS = ['editor','admin'] as const;
const PAGE = 25;

export const reviewQuery = z.object({
  status:z.preprocess(value => value === '' ? undefined : value,z.enum(REVIEW_STATUSES).optional()),
  search:z.string().trim().max(100).default(''),
  page:z.coerce.number().int().min(1).max(100000).default(1),
});
export const reviewDecision = z.object({
  action:z.enum(REVIEW_ACTIONS),
  // The client states what it reviewed, so two editors cannot silently overwrite each other.
  expectedStatus:z.enum(REVIEW_STATUSES),
  note:z.string().trim().min(10,'Explain the decision in at least 10 characters').max(2000),
}).strict();

const outcome: Record<ReviewAction,ReviewStatus> = {approve:'approved',reject:'rejected',request_info:'needs_info'};
/** Decided and withdrawn submissions are final; a new correction starts a new review. */
export function nextStatus(current: ReviewStatus, action: ReviewAction): ReviewStatus {
  if (current !== 'pending' && current !== 'needs_info') throw new HttpError(409,'This submission has already been decided.');
  return outcome[action];
}

// Guest submissions have no realm; member submissions stay within this auth environment.
const scope = `FROM falk_submission s
  LEFT JOIN falk_watch w ON w.id=s.watch_id
  LEFT JOIN falk_organization o ON o.id=w.brand_id
  LEFT JOIN falk_organization t ON t.id=s.organization_id
  LEFT JOIN falk_account a ON a.id=s.author_id
  WHERE (s.author_id IS NULL OR a.realm=$1)`;
const summaryColumns = `s.id,s.status,s.created_at,s.target_kind,s.watch_id,s.author_id,s.submitter_name,
  a.username,w.payload->>'model' AS model,o.payload->>'name' AS brand,t.payload->>'name' AS organization,
  left(s.explanation,240) AS excerpt,
  CASE WHEN jsonb_typeof(s.evidence)='array' THEN jsonb_array_length(s.evidence) ELSE 0 END AS evidence_count`;
function summaryFrom(row: any): ReviewSummary {
  return {
    id:row.id,status:row.status,createdAt:row.created_at.toISOString(),targetKind:row.target_kind,
    record:row.watch_id ? {id:row.watch_id,name:[row.brand,row.model].filter(Boolean).join(' ') || row.watch_id} : null,
    subject:row.watch_id ? [row.brand,row.model].filter(Boolean).join(' ') || row.watch_id
      : row.organization ? `Organization: ${row.organization}` : row.target_kind === 'evidence' ? 'Evidence proposal' : 'New record proposal',
    submitter:row.author_id
      ? {kind:'member',label:row.username ? `@${row.username}` : 'Member (profile incomplete)'}
      : {kind:'guest',label:row.submitter_name || 'Anonymous guest'},
    excerpt:row.excerpt,evidenceCount:row.evidence_count,
  };
}

export async function listSubmissions(query: z.infer<typeof reviewQuery>, db: Queryable = pool) {
  // Search text is literal: % and _ must not act as wildcards.
  const values = [realm(),query.status ?? null,`%${query.search.replace(/[\\%_]/g,'\\$&')}%`];
  const where = `${scope} AND ($2::text IS NULL OR s.status=$2)
    AND (s.explanation ILIKE $3 OR coalesce(s.watch_id,'') ILIKE $3 OR coalesce(w.payload->>'model','') ILIKE $3
      OR coalesce(o.payload->>'name','') ILIKE $3 OR coalesce(t.payload->>'name','') ILIKE $3)`;
  const [rows, total] = await querySeries(db,[
    // Open work is served oldest first so nothing starves; decided work newest first.
    `SELECT ${summaryColumns} ${where}
      ORDER BY CASE WHEN s.status IN ('pending','needs_info') THEN s.created_at END ASC,s.created_at DESC,s.id
      LIMIT ${PAGE} OFFSET ${(query.page-1)*PAGE}`,
    `SELECT count(*)::int AS count ${where}`,
  ],values);
  // Tab counts ignore the active filter so every queue stays visible.
  const counts = await db.query(`SELECT s.status,count(*)::int AS count ${scope} GROUP BY s.status`, [realm()]);
  return {
    submissions:rows.rows.map(summaryFrom),total:total.rows[0].count,page:query.page,pageSize:PAGE,
    counts:Object.fromEntries(REVIEW_STATUSES.map(status => [status,counts.rows.find(r => r.status === status)?.count ?? 0])) as Record<ReviewStatus,number>,
  };
}

/**
 * Organizations the reviewer has disclosed ties to that the submission's brand,
 * suppliers or target organization include. A tie ended after the submission
 * arrived still counts, so removing a disclosure cannot clear the conflict.
 */
async function reviewerConflicts(db: Queryable, actorId: string, submissionId: string) {
  const rows = await db.query(`SELECT DISTINCT o.payload->>'name' AS name
    FROM falk_submission s JOIN falk_affiliation f ON f.account_id=$1
    JOIN falk_organization o ON o.id=f.organization_id
    WHERE s.id=$2 AND (f.ended_at IS NULL OR f.ended_at>s.created_at) AND (
      f.organization_id=s.organization_id OR
      f.organization_id=(SELECT brand_id FROM falk_watch WHERE id=s.watch_id) OR
      f.organization_id IN (SELECT performer_id FROM falk_provenance WHERE watch_id=s.watch_id AND performer_id IS NOT NULL))
    ORDER BY name`, [actorId,submissionId]);
  return rows.rows.map(r => r.name as string);
}
/** Member authorship, or a guest correction sent from the reviewer's own email address. */
async function isSelfAuthored(db: Queryable, actorId: string, submission: {author_id: string | null; submitter_email: string | null}) {
  if (submission.author_id) return submission.author_id === actorId;
  if (!submission.submitter_email) return false;
  return !!(await db.query('SELECT 1 FROM falk_account_private WHERE account_id=$1 AND email=lower(trim($2))', [actorId,submission.submitter_email])).rowCount;
}

export async function submissionDetail(id: string, actorId: string, db: Queryable = pool): Promise<ReviewDetail | null> {
  const row = (await db.query(`SELECT ${summaryColumns},s.explanation,s.evidence,s.submitter_email,
    s.original_proposal->>'submitterRole' AS submitter_role,
    (s.watch_id IS NOT NULL AND s.base_revision_id IS DISTINCT FROM w.current_revision_id) AS stale_base
    ${scope} AND s.id=$2`, [realm(),id])).rows[0];
  if (!row) return null;
  const events = await db.query(`SELECT e.id,e.action,e.payload->>'note' AS note,e.created_at,
    coalesce('@'||a.username,'Editor') AS actor FROM falk_review_event e
    LEFT JOIN falk_account a ON a.id=e.actor_id WHERE e.submission_id=$1 ORDER BY e.created_at,e.id`, [id]);
  return {
    ...summaryFrom(row),
    explanation:row.explanation,
    evidence:Array.isArray(row.evidence) ? row.evidence.filter((url: unknown) => typeof url === 'string') : [],
    submitterRole:row.submitter_role,
    contact:row.author_id ? null : {name:row.submitter_name,email:row.submitter_email},
    authorUsername:row.username,staleBase:row.stale_base,
    conflicts:await reviewerConflicts(db,actorId,id),
    selfAuthored:await isSelfAuthored(db,actorId,row),
    events:events.rows.map(e => ({id:e.id,action:e.action,note:e.note ?? '',createdAt:e.created_at.toISOString(),actor:e.actor})),
  };
}

/** Record an editorial decision. Accepting a correction does not change the public record. */
export async function decideSubmission(actorId: string, id: string, input: z.infer<typeof reviewDecision>, db: PoolClient) {
  // FOR SHARE makes a concurrent suspension or demotion wait for this decision, or win before it.
  const actor = (await db.query('SELECT role,status,email_verified AS "emailVerified" FROM falk_account WHERE id=$1 AND realm=$2 FOR SHARE', [actorId,realm()])).rows[0];
  if (!actor) throw new HttpError(403,'You do not have permission to perform this action.');
  enforceAccount(actor,EDITORS);
  const submission = (await db.query(`SELECT s.id,s.status,s.author_id,s.submitter_email,s.watch_id,s.organization_id
    ${scope} AND s.id=$2 FOR UPDATE OF s`, [realm(),id])).rows[0];
  if (!submission) throw new HttpError(404,'Submission not found.');
  if (await isSelfAuthored(db,actorId,submission)) throw new HttpError(403,'Another editor must review your own submission.');
  const conflicts = await reviewerConflicts(db,actorId,id);
  if (conflicts.length) throw new HttpError(403,`You have a disclosed relationship with ${conflicts.join(', ')}. Another editor must review this submission.`);
  if (submission.status !== input.expectedStatus) throw new HttpError(409,'Another editor changed this submission while you were reviewing it. Reload it and review again.');
  if (input.action === 'request_info' && !submission.author_id && !submission.submitter_email) {
    throw new HttpError(409,'This guest left no contact details, so they cannot be asked for more information.');
  }
  const status = nextStatus(submission.status,input.action);
  await db.query('UPDATE falk_submission SET status=$2 WHERE id=$1', [id,status]);
  await db.query('INSERT INTO falk_review_event(submission_id,actor_id,action,payload) VALUES($1,$2,$3,$4)',
    [id,actorId,input.action,{note:input.note,from:submission.status,to:status}]);
  await audit(db,actorId,null,`submission_${input.action}`,input.note,{submission:id,record:submission.watch_id ?? submission.organization_id});
  return {status};
}

const review = Router();
review.use(async (req,res,next) => {
  const { account } = await authenticatedAccount(req,EDITORS);
  res.locals.account = account;
  next();
});
review.get('/submissions', async (req,res) => {
  res.json(await transaction(db => listSubmissions(reviewQuery.parse(req.query),db),true));
});
review.get('/submissions/:id', async (req,res) => {
  const id = z.uuid().parse(req.params.id);
  const submission = await transaction(db => submissionDetail(id,res.locals.account.id,db),true);
  if (!submission) throw new HttpError(404,'Submission not found.');
  res.json({submission});
});
review.post('/submissions/:id/decisions', async (req,res) => {
  const id = z.uuid().parse(req.params.id);
  const input = reviewDecision.parse(req.body);
  res.status(201).json(await transaction(db => decideSubmission(res.locals.account.id,id,input,db)));
});
export default review;
