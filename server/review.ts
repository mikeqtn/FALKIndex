import { Router } from 'express';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { REVIEW_ACTIONS, REVIEW_STATUSES, type MyContribution, type ReviewAction, type ReviewDetail, type ReviewStatus, type ReviewSummary } from '../src/accounts/contracts.ts';
import { pool, querySeries, transaction } from './db.ts';
import { audit, authenticatedAccount, enforceAccount, HttpError, realm } from './accounts.ts';
import { newWatchInput, replyInput } from '../src/accounts/contracts.ts';
import { loadCatalogue } from './catalogue.ts';
import { applyPublish } from '../scripts/publish-record.ts';
import { buildNewWatch, isArchetype, planNewWatch } from './newWatch.ts';
import { notifyAuthor } from './notify.ts';

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
  // Approving a new watch publishes it, and the editor names its production archetype (DECISIONS.md Q16).
  archetype:z.string().regex(/^[a-z_]+$/).max(100).optional(),
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
const summaryColumns = `s.id,s.status,s.created_at,s.target_kind,s.watch_id,s.author_id,s.submitter_name,a.deleted_at,
  a.username,w.payload->>'model' AS model,o.payload->>'name' AS brand,t.payload->>'name' AS organization,
  s.original_proposal->>'proposedId' AS proposed_id,s.original_proposal->>'proposedName' AS proposed_name,
  left(s.explanation,240) AS excerpt,
  CASE WHEN jsonb_typeof(s.evidence)='array' THEN jsonb_array_length(s.evidence) ELSE 0 END AS evidence_count`;
function summaryFrom(row: any): ReviewSummary {
  return {
    id:row.id,status:row.status,createdAt:row.created_at.toISOString(),targetKind:row.target_kind,
    record:row.watch_id ? {id:row.watch_id,name:[row.brand,row.model].filter(Boolean).join(' ') || row.watch_id} : null,
    subject:row.watch_id ? [row.brand,row.model].filter(Boolean).join(' ') || row.watch_id
      : row.proposed_name ? `New watch: ${row.proposed_name}`
      : row.organization ? `Organization: ${row.organization}` : row.target_kind === 'evidence' ? 'Evidence proposal' : 'New record proposal',
    submitter:row.author_id
      ? {kind:'member',label:row.username ? `@${row.username}` : row.deleted_at ? 'Deleted member' : 'Member (profile incomplete)'}
      : {kind:'guest',label:row.submitter_name || 'Anonymous guest'},
    excerpt:row.excerpt,evidenceCount:row.evidence_count,
  };
}

export async function listSubmissions(query: z.infer<typeof reviewQuery>, db: Queryable = pool) {
  // Search text is literal: % and _ must not act as wildcards.
  const values = [realm(),query.status ?? null,`%${query.search.replace(/[\\%_]/g,'\\$&')}%`];
  const where = `${scope} AND ($2::text IS NULL OR s.status=$2)
    AND (s.explanation ILIKE $3 OR coalesce(s.watch_id,'') ILIKE $3 OR coalesce(w.payload->>'model','') ILIKE $3
      OR coalesce(o.payload->>'name','') ILIKE $3 OR coalesce(t.payload->>'name','') ILIKE $3
      OR coalesce(s.original_proposal->>'proposedName','') ILIKE $3)`;
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

const links = (value: unknown) => Array.isArray(value) ? value.filter((url): url is string => typeof url === 'string') : [];

/**
 * The author answers a request for information. The reply joins the append-only history and the submission goes
 * back to the queue as pending; the original submission is never changed.
 */
export async function replyToRequest(accountId: string, id: string, body: unknown, db: PoolClient) {
  const input = replyInput.parse(body);
  const submission = (await db.query('SELECT status FROM falk_submission WHERE id=$1 AND author_id=$2 FOR UPDATE', [id,accountId])).rows[0];
  if (!submission) throw new HttpError(404,'Submission not found.');
  if (submission.status !== 'needs_info') throw new HttpError(409,'No editor is waiting on a reply to this submission.');
  await db.query("UPDATE falk_submission SET status='pending' WHERE id=$1", [id]);
  await db.query(`INSERT INTO falk_review_event(submission_id,actor_id,action,payload) VALUES($1,$2,'reply',$3)`,
    [id,accountId,{note:input.text,evidence:input.evidence,from:'needs_info',to:'pending'}]);
  return {status:'pending' as const};
}

/** A member's own submissions, newest first, with the decisions on each. */
export async function myContributions(accountId: string, db: Queryable = pool): Promise<MyContribution[]> {
  const rows = (await db.query(`SELECT ${summaryColumns},s.explanation,s.evidence,s.original_proposal->>'type' AS type
    ${scope} AND s.author_id=$2 ORDER BY s.created_at DESC,s.id LIMIT 200`, [realm(),accountId])).rows;
  if (!rows.length) return [];
  const events = (await db.query(`SELECT id,submission_id,action,payload->>'note' AS note,payload->'evidence' AS evidence,created_at FROM falk_review_event
    WHERE submission_id=ANY($1::uuid[]) ORDER BY created_at,id`, [rows.map(r => r.id)])).rows;
  return rows.map(row => {
    const newWatch = row.type === 'new_watch';
    const recordId = newWatch ? (row.status === 'approved' ? row.proposed_id : null) : row.watch_id;
    return {
      id:row.id,status:row.status,createdAt:row.created_at.toISOString(),subject:summaryFrom(row).subject,
      kind:newWatch ? 'new_watch' : 'correction',
      record:recordId ? {id:recordId,url:`/records/${recordId}/`} : null,
      explanation:row.explanation,
      evidence:Array.isArray(row.evidence) ? row.evidence.filter((url: unknown) => typeof url === 'string') : [],
      events:events.filter(e => e.submission_id === row.id)
        .map(e => ({id:e.id,action:e.action,note:e.note ?? '',evidence:links(e.evidence),createdAt:e.created_at.toISOString()})),
    };
  });
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
      f.organization_id=s.original_proposal->'input'->'brand'->>'id' OR
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
  const row = (await db.query(`SELECT ${summaryColumns},s.explanation,s.evidence,s.submitter_email,s.original_proposal,
    s.original_proposal->>'submitterRole' AS submitter_role,
    (s.watch_id IS NOT NULL AND s.base_revision_id IS DISTINCT FROM w.current_revision_id) AS stale_base
    ${scope} AND s.id=$2`, [realm(),id])).rows[0];
  if (!row) return null;
  const events = await db.query(`SELECT e.id,e.action,e.payload->>'note' AS note,e.payload->'evidence' AS evidence,e.created_at,
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
    proposal:row.original_proposal?.type === 'new_watch'
      ? {proposedId:row.original_proposal.proposedId,input:row.original_proposal.input} : null,
    events:events.rows.map(e => ({id:e.id,action:e.action,note:e.note ?? '',evidence:links(e.evidence),createdAt:e.created_at.toISOString(),actor:e.actor})),
  };
}

/**
 * Record an editorial decision. Accepting a correction does not change the public record; accepting a
 * new watch publishes it in the same transaction, through the same plan as `npm run db:publish`.
 */
export async function decideSubmission(actorId: string, id: string, input: z.infer<typeof reviewDecision>, db: PoolClient) {
  // FOR SHARE makes a concurrent suspension or demotion wait for this decision, or win before it.
  const actor = (await db.query('SELECT role,status,username,email_verified AS "emailVerified" FROM falk_account WHERE id=$1 AND realm=$2 FOR SHARE', [actorId,realm()])).rows[0];
  if (!actor) throw new HttpError(403,'You do not have permission to perform this action.');
  enforceAccount(actor,EDITORS);
  const submission = (await db.query(`SELECT s.id,s.status,s.author_id,s.submitter_email,s.watch_id,s.organization_id,
    s.original_proposal,s.created_at,a.username AS author_username
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
  const newWatch = submission.original_proposal?.type === 'new_watch';
  if (input.archetype && !(newWatch && input.action === 'approve')) throw new HttpError(400,'An archetype is chosen only when approving a new watch.');
  const record = newWatch && input.action === 'approve'
    ? await publishNewWatch(db,submission,actor.username,input.archetype)
    : submission.watch_id ?? submission.organization_id ?? submission.original_proposal?.proposedId ?? null;
  await db.query('UPDATE falk_submission SET status=$2 WHERE id=$1', [id,status]);
  await db.query('INSERT INTO falk_review_event(submission_id,actor_id,action,payload) VALUES($1,$2,$3,$4)',
    [id,actorId,input.action,{note:input.note,from:submission.status,to:status,...(newWatch ? {record} : {})}]);
  await audit(db,actorId,null,`submission_${input.action}`,input.note,{submission:id,record});
  return {status,...(newWatch && input.action === 'approve' ? {record} : {})};
}

/** Publish an approved new-watch proposal as its version 1. Returns the new record id. */
async function publishNewWatch(db: PoolClient, submission: any, reviewer: string | null, archetype: string | undefined) {
  if (!archetype) throw new HttpError(400,'Choose the production archetype before approving a new watch.');
  if (!reviewer) throw new HttpError(403,'Choose a public username before publishing records.');
  const live = await loadCatalogue();
  if (!isArchetype(live,archetype)) throw new HttpError(400,'Choose a production archetype from the methodology.');
  const built = buildNewWatch(newWatchInput.parse(submission.original_proposal.input),live,{
    // A deleted member's work stays attributed, without a username to link to.
    username:submission.author_username ?? 'former-member', archetype,
    checkedOn:submission.created_at.toISOString().slice(0,10), today:new Date().toISOString().slice(0,10),
  });
  // A null base revision: if someone else publishes this record first, applyPublish refuses instead of overwriting it.
  try { await applyPublish(db,planNewWatch(live,built),reviewer,null); }
  // applyPublish's own refusals are plain Errors written for editors; database errors (with a code) are not shown.
  catch (e) { throw e instanceof HttpError || (e as any)?.code ? e : new HttpError(409,(e as Error).message); }
  return built.watch.id;
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
  const result = await transaction(db => decideSubmission(res.locals.account.id,id,input,db));
  // Only after the decision is committed, so the member is never told about a decision that rolled back.
  await notifyAuthor(id,input.action,input.note,result.record ?? null);
  res.status(201).json(result);
});
export default review;
