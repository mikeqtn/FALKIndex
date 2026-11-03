import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogueCache, deepFreeze } from '../src/lib/catalogue-cache.ts';

// A loader whose results and failures the test controls, and a clock it moves by hand.
function harness() {
  let t = 1_000_000, version = 0, fail = false, calls = 0;
  const logs: any[] = [];
  const load = async () => {
    calls++;
    await new Promise(resolve => setImmediate(resolve));
    if (fail) throw Object.assign(new Error('connection refused at 10.0.0.1'), { code:'ECONNREFUSED' });
    return { version:++version, records:[{ id:'a', scores:{ MA:1 } }], orgs:new Map([['o', { name:'Org' }]]) };
  };
  const cache = createCatalogueCache(load, { ttlMs:15_000, retryMs:5_000, now:() => t, log:line => logs.push(line) });
  return { cache, logs, calls:() => calls, tick:(ms: number) => { t += ms; }, setFail:(f: boolean) => { fail = f; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('concurrent cold requests share one load', async () => {
  const h = harness();
  const all = await Promise.all(Array.from({ length:20 }, () => h.cache.get()));
  assert.equal(h.calls(), 1);
  assert.ok(all.every(c => c === all[0]), 'every request got the same snapshot');
});

test('within the TTL nothing reloads; after it, the old copy is served while one reload runs', async () => {
  const h = harness();
  assert.equal((await h.cache.get()).version, 1);
  h.tick(14_999);
  assert.equal((await h.cache.get()).version, 1);
  assert.equal(h.calls(), 1);
  h.tick(1);
  const during = await Promise.all([h.cache.get(), h.cache.get(), h.cache.get()]);
  assert.deepEqual(during.map(c => c.version), [1,1,1], 'nobody waits for the reload');
  assert.equal(h.calls(), 2, 'one background reload, not one per request');
  await settle();
  assert.equal((await h.cache.get()).version, 2);
});

test('a failed reload keeps the last good copy, logs without details, and waits before retrying', async () => {
  const h = harness();
  await h.cache.get();
  h.setFail(true); h.tick(15_000);
  assert.equal((await h.cache.get()).version, 1);
  await settle();
  assert.equal((await h.cache.get()).version, 1, 'still the last good copy after the failure');
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].event, 'catalogue.reload_failed');
  assert.equal(h.logs[0].errorCode, 'ECONNREFUSED');
  assert.doesNotMatch(JSON.stringify(h.logs), /10\.0\.0\.1|refused at/, 'no error message in the log');
  const calls = h.calls();
  h.tick(4_999); await h.cache.get(); await settle();
  assert.equal(h.calls(), calls, 'no retry inside the retry interval');
  h.setFail(false); h.tick(1); await h.cache.get(); await settle();
  assert.equal((await h.cache.get()).version, 2, 'recovers once the database answers');
});

test('a cold failure is reported, then not retried by every request', async () => {
  const h = harness();
  h.setFail(true);
  await assert.rejects(h.cache.get(), /connection refused/);
  await assert.rejects(h.cache.get(), /connection refused/);
  assert.equal(h.calls(), 1);
  h.setFail(false); h.tick(5_000);
  assert.equal((await h.cache.get()).version, 1);
});

test('no request can change what another request sees', async () => {
  const h = harness();
  const one = await h.cache.get(), two = await h.cache.get();
  assert.throws(() => { (one.records as any[]).push({ id:'b' }); }, TypeError);
  assert.throws(() => { (one.records[0] as any).id = 'changed'; }, TypeError);
  assert.throws(() => { (one.records[0]!.scores as any).MA = 5; }, TypeError);
  assert.throws(() => { one.orgs.set('x', { name:'X' }); }, TypeError);
  assert.throws(() => { one.orgs.delete('o'); }, TypeError);
  assert.throws(() => { (one.orgs.get('o') as any).name = 'Changed'; }, TypeError);
  assert.equal(two.records.length, 1);
  assert.equal(two.records[0]!.id, 'a');
  assert.equal(two.orgs.get('o')!.name, 'Org');
});

test('deepFreeze handles shared and circular references', () => {
  const shared = { n:1 };
  const value: any = { a:shared, b:[shared], s:new Set([shared]) };
  value.self = value;
  deepFreeze(value);
  assert.ok(Object.isFrozen(shared) && Object.isFrozen(value.b) && Object.isFrozen(value));
  assert.throws(() => value.s.add(2), TypeError);
});
