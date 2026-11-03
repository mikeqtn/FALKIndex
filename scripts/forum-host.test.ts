import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { forumHost } from '../server/middlewares/forumHost.ts';

// Answers with the path the next handler saw, so the rewrite is visible.
async function serve(host?: string) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(forumHost(host));
  app.use((req, res) => { res.send(req.url); });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, host: string) => {
    const res = await fetch(base + path, { headers: { 'x-forwarded-host': host }, redirect: 'manual' });
    return { status: res.status, body: await res.text(), location: res.headers.get('location') };
  };
  return { get, close: () => { server.closeAllConnections(); server.close(); } };
}

test('the forum host serves /forum pages at its root and shares the API, sign-in and files', async () => {
  const { get, close } = await serve('forum.falkindex.com');
  try {
    assert.equal((await get('/', 'forum.falkindex.com')).body, '/forum/');
    assert.equal((await get('/t/abc?page=2', 'Forum.FALKindex.com:443')).body, '/forum/t/abc?page=2');
    for (const shared of ['/api/account', '/api/__clerk/v1/client', '/_astro/app.js', '/sign-in', '/sign-up/verify', '/favicon.svg'])
      assert.equal((await get(shared, 'forum.falkindex.com')).body, shared);
    const prefixed = await get('/forum/t/abc?x=1', 'forum.falkindex.com');
    assert.equal(prefixed.status, 301);
    assert.equal(prefixed.location, '/t/abc?x=1');
  } finally { close(); }
});

test('the main site redirects /forum to the forum host and leaves everything else alone', async () => {
  const { get, close } = await serve('forum.falkindex.com');
  try {
    const moved = await get('/forum/t/abc?x=1', 'falkindex.com');
    assert.equal(moved.status, 301);
    assert.equal(moved.location, 'https://forum.falkindex.com/t/abc?x=1');
    assert.equal((await get('/forum', 'falkindex.com')).location, 'https://forum.falkindex.com/');
    assert.equal((await get('/forums-guide', 'falkindex.com')).body, '/forums-guide');
    assert.equal((await get('/records/', 'falkindex.com')).body, '/records/');
  } finally { close(); }
});

test('without FORUM_HOST the forum stays at /forum on the one host', async () => {
  const { get, close } = await serve(undefined);
  try {
    assert.equal((await get('/forum/', 'falkindex.replit.dev')).body, '/forum/');
    assert.equal((await get('/', 'falkindex.replit.dev')).body, '/');
  } finally { close(); }
});
