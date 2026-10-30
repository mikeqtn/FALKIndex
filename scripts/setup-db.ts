import { readFile } from 'node:fs/promises';
import { pool } from '../server/db.ts';

if (process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT) {
  throw new Error('Production schema changes must use Replit Publish, not this script.');
}
try {
  for (const migration of ['001-foundation.sql','002-guest-corrections.sql','003-immutable-claims.sql','004-account-deletion.sql']) {
    await pool.query(await readFile(new URL(`../db/${migration}`, import.meta.url), 'utf8'));
  }
  console.log('Development database schema is ready.');
} finally { await pool.end(); }
