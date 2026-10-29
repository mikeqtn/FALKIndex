import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForDatabase } from '../server/db.ts';

test('startup warm-up retries until the database answers', async () => {
  let calls = 0;
  const ok = await waitForDatabase(async () => { if (++calls < 3) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }, 10000);
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test('startup warm-up gives up at its deadline instead of blocking the server', async () => {
  let calls = 0;
  const ok = await waitForDatabase(async () => { calls++; throw new Error('unreachable'); }, 1500);
  assert.equal(ok, false);
  assert.ok(calls >= 2, 'it retried before giving up');
});
