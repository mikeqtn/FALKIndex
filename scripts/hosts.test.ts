// The request host is settled once, by siteHost, against an allowlist. Every check below fails without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { publishableKeyFromHost } from '@clerk/shared/keys';
import { hostPolicy, resolveHost, siteHost } from '../server/middlewares/siteHost.ts';
import { getClerkProxyHost } from '../server/middlewares/clerkProxyMiddleware.ts';
import { forumHost } from '../server/middlewares/forumHost.ts';
import { createApp } from '../server/index.ts';

const MAIN = 'main.falk.test', FORUM = 'forum.falk.test';
const policy = (extra: NodeJS.ProcessEnv = {}) => hostPolicy({ SITE_HOSTS:MAIN, FORUM_HOST:FORUM, ...extra });

async function serve(app: Express) {
  const server: Server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => { server.closeAllConnections(); server.close(); } };
}

test('the allowlist comes from SITE_HOSTS and FORUM_HOST, and defaults to falkindex.com in production', () => {
  assert.deepEqual([...policy().allowed!], [MAIN, FORUM]);
  assert.equal(policy().canonical, MAIN);
  assert.deepEqual([...hostPolicy({ NODE_ENV:'production', FORUM_HOST:'forum.falkindex.com' }).allowed!], ['falkindex.com','forum.falkindex.com']);
  assert.equal(hostPolicy({}).allowed, null, 'development and the preview accept any well-formed host');
  for (const bad of ['https://falkindex.com','falkindex.com:443','falk index.com','falkindex.com/x'])
    assert.throws(() => hostPolicy({ SITE_HOSTS:bad }), /SITE_HOSTS/, bad);
});

test('only allowed, well-formed hosts are accepted; anything else becomes the canonical host', () => {
  const p = policy();
  const cases: [Record<string,string>, string][] = [
    [{ host:MAIN }, MAIN],
    [{ host:'Main.FALK.test:443' }, 'main.falk.test:443'],
    [{ host:MAIN, 'x-forwarded-host':FORUM }, FORUM],
    [{ host:MAIN, 'x-forwarded-host':`${FORUM}, evil.example` }, FORUM],
    [{ host:MAIN, 'x-forwarded-host':'evil.example' }, MAIN],
    [{ host:'evil.example' }, MAIN],
    [{ host:MAIN, 'x-forwarded-host':`${MAIN}; script-src *` }, MAIN],
    [{ host:MAIN, 'x-forwarded-host':`${MAIN}.evil.example` }, MAIN],
    [{ host:MAIN, 'x-forwarded-host':'' }, MAIN],
    [{}, MAIN],
  ];
  for (const [headers, expected] of cases) assert.equal(resolveHost(headers, p), expected, JSON.stringify(headers));
  // With forwarded hosts distrusted, only Host counts.
  assert.equal(resolveHost({ host:MAIN, 'x-forwarded-host':FORUM }, policy({ TRUST_FORWARDED_HOST:'0' })), MAIN);
  // Without an allowlist a well-formed host is kept, but a malformed one still is not.
  assert.equal(resolveHost({ host:'preview.replit.dev' }, hostPolicy({})), 'preview.replit.dev');
  assert.equal(resolveHost({ host:'x', 'x-forwarded-host':'a.com; script-src *' }, hostPolicy({})), 'localhost');
});

test('after siteHost, the Clerk host, publishable key and proxy URL all use the allowed host', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(siteHost(policy()));
  // The same expressions server/index.ts (key selection) and clerkProxyMiddleware.ts (proxy URL) evaluate.
  app.use((req, res) => {
    const host = getClerkProxyHost(req) ?? '';
    res.json({ host, forwarded:req.headers['x-forwarded-host'] ?? null, hostname:req.hostname,
      key:publishableKeyFromHost(host, 'pk_live_Y2xlcmsuZXhhbXBsZS5jb20k'),
      proxyUrl:`${req.headers['x-forwarded-proto'] || 'https'}://${host}/api/__clerk` });
  });
  const { base, close } = await serve(app);
  try {
    const seen = async (headers: Record<string,string>) => (await fetch(base, { headers })).json();
    const forged = await seen({ 'x-forwarded-host':'evil.example', 'x-forwarded-proto':'javascript' });
    assert.equal(forged.host, MAIN);
    assert.equal(forged.forwarded, null, 'X-Forwarded-Host is removed, so later code cannot read the forged value');
    assert.equal(forged.hostname, MAIN, 'req.hostname agrees');
    assert.equal(forged.key, publishableKeyFromHost(MAIN, 'pk_live_Y2xlcmsuZXhhbXBsZS5jb20k'));
    assert.equal(forged.proxyUrl, `https://${MAIN}/api/__clerk`, 'an unknown scheme is dropped');
    assert.equal((await seen({ 'x-forwarded-host':FORUM })).host, FORUM, 'the forum host is still recognised');
  } finally { close(); }
});

test('forum routing follows the allowed host, not a forged one', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(siteHost(policy({ TRUST_FORWARDED_HOST:'0' })));
  app.use(forumHost(FORUM));
  app.use((req, res) => { res.send(req.url); });
  const { base, close } = await serve(app);
  try {
    // Host says main site; a distrusted X-Forwarded-Host claims the forum. The main site's rules apply.
    const res = await fetch(`${base}/forum/t/abc`, { headers:{ 'x-forwarded-host':FORUM }, redirect:'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), `https://${FORUM}/t/abc`);
  } finally { close(); }
});

test('the same-origin check on API writes compares against the allowed host', async () => {
  const { base, close } = await serve(createApp(policy()));
  try {
    const post = (origin: string, forwarded: string) => fetch(`${base}/api/corrections`, { method:'POST',
      headers:{ origin, 'x-forwarded-host':forwarded, 'x-forwarded-proto':'https', 'content-type':'application/json' }, body:'{}' });
    // A forged host matching a forged origin no longer passes.
    const forged = await post('https://evil.example', 'evil.example');
    assert.equal(forged.status, 403);
    assert.match((await forged.json()).error, /must come from the FALK website/);
    // The real site still passes the origin check (it then fails validation, which is fine here).
    assert.notEqual((await post(`https://${MAIN}`, MAIN)).status, 403);
  } finally { close(); }
});
