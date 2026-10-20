import { readFile } from 'node:fs/promises';
import { pool } from '../server/db.ts';

if (process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT) {
  throw new Error('Production schema changes must use Replit Publish, not this script.');
}
try {
  await pool.query(await readFile(new URL('../db/001-foundation.sql', import.meta.url), 'utf8'));
  console.log('Development database foundation is ready.');
} finally { await pool.end(); }
