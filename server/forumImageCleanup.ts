import type { PoolClient } from 'pg';
import { pool, transaction } from './db.ts';
import { removeImage } from './forumImages.ts';

const MEMBER_CLEANUP_LIMIT = 10;
const SWEEP_LIMIT = 100;

type RemovalResult = 'removed' | 'not_stale' | 'storage_failed';

/** Remove storage bytes before deleting the row, while holding the row lock against concurrent attachment. */
async function removeIfStale(id: string, db: PoolClient): Promise<RemovalResult> {
  const candidate = await db.query(`SELECT id FROM falk_forum_image
    WHERE id=$1 AND post_id IS NULL AND message_id IS NULL AND created_at < now()-interval '1 day'
    FOR UPDATE`, [id]);
  if (!candidate.rowCount) return 'not_stale';

  try {
    await removeImage(id);
  } catch {
    // Keep the row so a later scheduled run can retry the storage deletion.
    return 'storage_failed';
  }

  await db.query(`DELETE FROM falk_forum_image
    WHERE id=$1 AND post_id IS NULL AND message_id IS NULL`, [id]);
  return 'removed';
}

/** Small opportunistic sweep for this member, run as part of their next upload. */
export async function clearUnattachedImages(memberId: string, db: PoolClient) {
  const candidates = await db.query(`SELECT id FROM falk_forum_image
    WHERE uploader_id=$1 AND post_id IS NULL AND message_id IS NULL AND created_at < now()-interval '1 day'
    ORDER BY created_at,id LIMIT $2`, [memberId, MEMBER_CLEANUP_LIMIT]);
  const removed: string[] = [];
  for (const row of candidates.rows) {
    if (await removeIfStale(row.id as string, db) === 'removed') removed.push(row.id as string);
  }
  return removed;
}

/** One bounded batch for a Scheduled Deployment. Every item is rechecked under a row lock. */
export async function cleanupStaleUnattachedImages(limit = SWEEP_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > SWEEP_LIMIT) {
    throw new RangeError(`Cleanup limit must be an integer from 1 to ${SWEEP_LIMIT}.`);
  }
  const candidates = await pool.query(`SELECT id FROM falk_forum_image
    WHERE post_id IS NULL AND message_id IS NULL AND created_at < now()-interval '1 day'
    ORDER BY created_at,id LIMIT $1`, [limit]);
  let removed = 0, failed = 0;
  for (const row of candidates.rows) {
    try {
      const result = await transaction(db => removeIfStale(row.id as string, db));
      if (result === 'removed') removed++;
      else if (result === 'storage_failed') failed++;
    } catch {
      failed++;
    }
  }
  return { scanned:candidates.rows.length, removed, failed, hasMore:candidates.rows.length === limit };
}
