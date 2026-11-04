import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.ts';
import { pool } from '../server/db.ts';
import { rateLimitKey, SUPPORT_PER_HOUR } from '../server/api.ts';

const server = createApp().listen(0,'127.0.0.1');
await new Promise(resolve => server.once('listening',resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;

// Only calls to Postmark are faked; requests to the test server are real.
const realFetch = globalThis.fetch;
let sent: { headers: Record<string,string>, body: any }[] = [];
let postmark: () => Response = () => Response.json({ ErrorCode:0 });
globalThis.fetch = (async (url: any, init?: any) => {
  if (!String(url).startsWith('https://api.postmarkapp.com/')) return realFetch(url,init);
  sent.push({ headers:init.headers, body:JSON.parse(init.body) });
  return postmark();
}) as typeof fetch;

// 'write' is the per-minute limit shared with every other test file on this address.
const keys = [rateLimitKey('support','127.0.0.1'),rateLimitKey('support-site','all'),rateLimitKey('write','127.0.0.1')];
const clear = () => pool.query('DELETE FROM falk_rate_limit WHERE key=ANY($1)',[keys]);
beforeEach(async () => {
  sent = [];
  postmark = () => Response.json({ ErrorCode:0 });
  process.env.POSTMARK_SERVER_TOKEN = 'test-token';
  await clear();
});
after(async () => {
  await clear();
  globalThis.fetch = realFetch;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const valid = { topic:'account', message:'I cannot sign in.', email:'reader@example.test', _gotcha:'' };
const send = (body: object) => fetch(`${base}/api/support`,{ method:'POST', headers:{ 'Content-Type':'application/json', Origin:base }, body:JSON.stringify(body) });

test('a help message goes to the support inbox, replies go to the visitor, and nothing is tracked', async () => {
  assert.equal((await send(valid)).status,201);
  assert.equal(sent.length,1);
  const [{ headers, body }] = sent;
  assert.equal(headers['X-Postmark-Server-Token'],'test-token');
  assert.equal(body.To,'support@falkindex.com');
  assert.equal(body.ReplyTo,valid.email);
  assert.match(body.From,/@falkindex\.com>$/);
  assert.equal(body.Subject,'Help form: Account or sign-in');
  assert.match(body.TextBody,/I cannot sign in\./);
  assert.equal(body.TrackOpens,false);
  assert.equal(body.TrackLinks,'None');
});

test('invalid messages and the spam trap never reach Postmark', async () => {
  for (const body of [{ ...valid, email:'not-an-email' }, { ...valid, message:'   ' }, { ...valid, topic:'billing' }, { ...valid, _gotcha:'bot' }])
    assert.equal((await send(body)).status,400,JSON.stringify(body));
  assert.equal(sent.length,0);
});

test('a Postmark failure or missing token tells the visitor it was not sent, without leaking details', async () => {
  postmark = () => Response.json({ ErrorCode:10, Message:'Bad server token secret-detail' },{ status:422 });
  let response = await send(valid);
  assert.equal(response.status,503);
  assert.doesNotMatch(await response.text(),/secret-detail/);
  delete process.env.POSTMARK_SERVER_TOKEN;
  sent = [];
  response = await send(valid);
  assert.equal(response.status,503);
  assert.equal(sent.length,0);
});

test('help messages are capped per hour, counting invalid attempts', async () => {
  for (let i = 0; i < SUPPORT_PER_HOUR; i++) assert.equal((await send({})).status,400);
  const limited = await send(valid);
  assert.equal(limited.status,429);
  assert.match((await limited.json()).error,/last hour/);
  assert.equal(sent.length,0);
});
