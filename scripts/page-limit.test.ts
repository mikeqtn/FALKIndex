import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { clientKey, minuteCounter, pageLimit, type PageLimitOptions } from '../server/pageLimit.ts';

async function serve(options: PageLimitOptions) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(pageLimit(options));
  app.use((_req, res) => { res.send('ok'); });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // X-Forwarded-For stands in for the proxy's report of the visitor's address.
  const get = (path: string, ip = '203.0.113.7') => fetch(base + path, { headers:{ 'x-forwarded-for':ip } });
  return { get, close:() => { server.closeAllConnections(); server.close(); } };
}
const clock = (start = 1_800_000_000_000) => { let t = start; return { now:() => t, tick:(ms: number) => { t += ms; } }; };

test('minuteCounter counts per key, resets each minute, and stops adding keys at the cap', () => {
  const c = clock(), hit = minuteCounter({ maxClients:2, now:c.now });
  assert.equal(hit('a'), 1);
  assert.equal(hit('a'), 2);
  assert.equal(hit('b'), 1);
  assert.equal(hit('c'), 0, 'over the cap, a new key is not counted');
  assert.equal(hit('a'), 3, 'known keys keep counting');
  c.tick(60_000);
  assert.equal(hit('a'), 1);
  assert.equal(hit('c'), 1);
});

test('enforce: pages and share images have separate budgets, per visitor, and reset each minute', async () => {
  const c = clock(), logs: any[] = [];
  const { get, close } = await serve({ mode:'enforce', pagesPerMinute:3, imagesPerMinute:1, now:c.now, log:l => logs.push(l) });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await get('/records/')).status, 200);
    const blocked = await get('/records/');
    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get('retry-after') ?? '', /^\d+$/);
    assert.equal(blocked.headers.get('cache-control'), 'no-store');
    assert.equal((await get('/og/site.png')).status, 200, 'images count separately');
    assert.equal((await get('/og/records/a/b.png')).status, 429);
    assert.equal((await get('/records/', '198.51.100.9')).status, 200, 'another visitor is unaffected');
    assert.equal(logs.filter(l => l.event === 'rate_limit.page').length, 2, 'logged once per visitor and kind');
    assert.doesNotMatch(JSON.stringify(logs), /203\.0\.113|198\.51/, 'no addresses in the log');
    c.tick(60_000);
    assert.equal((await get('/records/')).status, 200, 'a new minute, a new budget');
    const summary = logs.find(l => l.event === 'rate_limit.window');
    assert.deepEqual({ clients:summary.clients, overLimit:summary.overLimit, maxHits:summary.maxHits }, { clients:3, overLimit:2, maxHits:4 });
  } finally { close(); }
});

test('log mode never blocks but records who went over; off does nothing', async () => {
  const logs: any[] = [];
  const logged = await serve({ mode:'log', pagesPerMinute:2, log:l => logs.push(l) });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await logged.get('/')).status, 200);
    assert.equal(logs.filter(l => l.event === 'rate_limit.page' && l.mode === 'log').length, 1);
  } finally { logged.close(); }
  const off = await serve({ mode:'off', pagesPerMinute:1, log:l => logs.push(l) });
  try { for (let i = 0; i < 3; i++) assert.equal((await off.get('/')).status, 200); } finally { off.close(); }
});

test('the counter table is capped: past the cap, new visitors pass uncounted', async () => {
  const logs: any[] = [];
  const { get, close } = await serve({ mode:'enforce', pagesPerMinute:1, maxClients:2, log:l => logs.push(l) });
  try {
    await get('/', '192.0.2.1'); await get('/', '192.0.2.2');
    for (let i = 0; i < 3; i++) assert.equal((await get('/', '192.0.2.3')).status, 200);
    assert.equal(logs.filter(l => l.event === 'rate_limit.table_full').length, 1);
    assert.equal((await get('/', '192.0.2.1')).status, 429, 'visitors already counted are still limited');
  } finally { close(); }
});

test('IPv6 visitors are grouped by /64; IPv4-mapped addresses count as IPv4', () => {
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey(undefined), 'unknown');
});
