import pg from 'pg';

// No schema changes or data seeding at application startup.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, allowExitOnIdle: true,
});
pool.on('error', (error: any) => console.error(JSON.stringify({
  event:'database.pool.error',
  errorName:error?.name ?? 'Error',
  errorCode:error?.code ?? 'unknown',
})));

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>, readOnly = false): Promise<T> {
  const started = process.hrtime.bigint();
  let acquiredAt = started;
  const client = await pool.connect().then(connection => {
    acquiredAt = process.hrtime.bigint();
    return connection;
  }).catch((error: any) => {
    console.error(JSON.stringify({
      event:'database.connection.failed',
      errorName:error?.name ?? 'Error',
      errorCode:error?.code ?? 'unknown',
      durationMs:Math.round(Number(process.hrtime.bigint()-started)/1_000_000),
    }));
    throw error;
  });
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    const durationMs = Number(process.hrtime.bigint()-started)/1_000_000;
    if (durationMs >= 1000 || Number(acquiredAt-started)/1_000_000 >= 500) {
      console.log(JSON.stringify({
        event:'database.transaction.slow',
        mode:readOnly ? 'read' : 'write',
        durationMs:Math.round(durationMs),
        acquireDurationMs:Math.round(Number(acquiredAt-started)/1_000_000),
      }));
    }
    client.release();
    return result;
  } catch (error) {
    // A dead connection fails the rollback too: keep the original error and let the pool drop the client.
    const failed = await client.query('ROLLBACK').then(() => undefined, (e: Error) => e);
    client.release(failed);
    const cause = error as {name?: string; code?: string};
    console.error(JSON.stringify({
      event:'database.transaction.failed',
      mode:readOnly ? 'read' : 'write',
      errorName:cause?.name ?? 'Error',
      errorCode:cause?.code ?? 'unknown',
      durationMs:Math.round(Number(process.hrtime.bigint()-started)/1_000_000),
      acquireDurationMs:Math.round(Number(acquiredAt-started)/1_000_000),
    }));
    throw error;
  }
}

/** pg clients must not receive concurrent query() calls (pg 9 removes queuing). */
export async function querySeries(db: Pick<pg.Pool,'query'>, statements: string[], values?: unknown[]) {
  const results: pg.QueryResult[] = [];
  for (const statement of statements) results.push(await db.query(statement,values));
  return results;
}
