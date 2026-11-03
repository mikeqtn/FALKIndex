import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clerkHostFor, clerkProxyFor } from '../src/accounts/clerk-host.ts';
import { pool } from '../server/db.ts';
import { createApp } from '../server/index.ts';

after(() => pool.end());

test('subdomains use the main site for sign-in, and other hosts are left alone', () => {
  for (const host of ['forum.falkindex.com', 'FORUM.falkindex.com:443']) {
    assert.equal(clerkHostFor(host), 'falkindex.com', host);
    assert.equal(clerkProxyFor(host), 'https://falkindex.com/api/__clerk', host);
  }
  for (const host of ['falkindex.com', 'example.replit.dev', 'notfalkindex.com', 'falkindex.com.evil.example', 'localhost']) {
    assert.equal(clerkHostFor(host), host, host);
    assert.equal(clerkProxyFor(host), undefined, host);
  }
});

test('a forum page with no session token yet asks the main site for it', async () => {
  const server = createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const live = process.env.CLERK_PUBLISHABLE_KEY;
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_live_Y2xlcmsuZXhhbXBsZS5jb20k';
    const open = (host: string) => fetch(`${base}/api/health`, { redirect:'manual', headers:{
      'x-forwarded-host':host, 'x-forwarded-proto':'https', cookie:'__client_uat=1791917601', accept:'text/html', 'sec-fetch-dest':'document',
    } });
    try {
      const location = (await open('forum.falkindex.com')).headers.get('location') ?? '';
      assert.match(location, /^https:\/\/falkindex\.com\/api\/__clerk\/v1\/client\/handshake/);
      assert.match(new URL(location).searchParams.get('redirect_url') ?? '', /^https:\/\/forum\.falkindex\.com\//);
      assert.doesNotMatch((await open('falkindex.com')).headers.get('location') ?? '', /forum\.falkindex\.com\/api/);
    } finally { process.env.CLERK_PUBLISHABLE_KEY = live; }
  } finally { server.closeAllConnections(); server.close(); }
});
