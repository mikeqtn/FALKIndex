import { readFile } from 'node:fs/promises';
import { pool } from '../server/db.ts';

if (process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT) {
  throw new Error('Production schema changes must use Replit Publish, not this script.');
}
try {
  for (const migration of ['001-foundation.sql','002-guest-corrections.sql','003-immutable-claims.sql','004-account-deletion.sql','005-forum.sql','006-forum-replies.sql','007-query-indexes.sql','008-forum-votes.sql','009-forum-images.sql','010-forum-author-indexes.sql','011-member-new-watches.sql','012-review-event-clock.sql']) {
    await pool.query(await readFile(new URL(`../db/${migration}`, import.meta.url), 'utf8'));
  }
  console.log('Development database schema is ready.');
} finally { await pool.end(); }
