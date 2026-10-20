import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { pool } from './db.ts';
import { HttpError } from './accounts.ts';

export const correctionInput = z.object({
  record: z.string().trim().min(1).max(200),
  role: z.enum(['brand', 'watchmaker', 'reader', 'other']),
  correction: z.string().trim().min(1).max(5000),
  evidence: z.array(z.string().trim().url().max(2000).refine(url => /^https?:\/\//i.test(url), 'Use an https:// or http:// URL')).min(1).max(10),
  name: z.string().trim().max(150).optional().default(''),
  email: z.union([z.literal(''), z.email().max(254)]).optional().default(''),
  _gotcha: z.string().max(0).optional().default(''),
}).strict();

type CorrectionInput = z.infer<typeof correctionInput>;
type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Save an anonymous correction without returning or publicly projecting contact details. */
export async function saveCorrection(input: CorrectionInput, db: Queryable = pool) {
  if (input._gotcha) throw new HttpError(400, 'The correction could not be submitted. Please review the form and try again.');
  const watch = await db.query(
    'SELECT id,current_revision_id FROM falk_watch WHERE id=$1',
    [input.record],
  );
  if (!watch.rowCount) throw new HttpError(404, 'Choose a record from the list.');

  const result = await db.query(
    `INSERT INTO falk_submission(author_id,target_kind,watch_id,base_revision_id,original_proposal,
      explanation,evidence,submitter_name,submitter_email)
     VALUES(NULL,'watch',$1,$2,$3,$4,$5,$6,$7)
     RETURNING id,created_at`,
    [
      watch.rows[0].id,
      watch.rows[0].current_revision_id,
      JSON.stringify({ type: 'correction', submitterRole: input.role }),
      input.correction,
      JSON.stringify(input.evidence),
      input.name || null,
      input.email || null,
    ],
  );
  return { id: result.rows[0].id as string, createdAt: result.rows[0].created_at };
}
