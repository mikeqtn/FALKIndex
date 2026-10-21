import pg from 'pg';

// No schema changes or data seeding at application startup.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, allowExitOnIdle: true,
});
pool.on('error', () => console.error('PostgreSQL connection failed'));

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>, readOnly = false): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    // A dead connection fails the rollback too: keep the original error and let the pool drop the client.
    const failed = await client.query('ROLLBACK').then(() => undefined, (e: Error) => e);
    client.release(failed);
    throw error;
  }
}

/** pg clients must not receive concurrent query() calls (pg 9 removes queuing). */
export async function querySeries(db: Pick<pg.Pool,'query'>, statements: string[], values?: unknown[]) {
  const results: pg.QueryResult[] = [];
  for (const statement of statements) results.push(await db.query(statement,values));
  return results;
}
