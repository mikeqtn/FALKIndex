import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { check, load } from './validate.ts';
import { newWatchInput, type NewWatchInput } from '../src/accounts/contracts.ts';
import { anyArchetype, buildNewWatch, isArchetype, planNewWatch, slugify } from '../server/newWatch.ts';

// The YAML catalogue stands in for the live one, so these run without a database.
const live = check(load(fileURLToPath(new URL('../data', import.meta.url)))).parsed;
const brand = live.watches[0].brand;
const knownSource = [...live.sources.values()][0];
const ctx = { username: 'contributor_1', archetype: anyArchetype(live), checkedOn: '2026-11-01', today: '2026-11-06' };
const proposal = (overrides: Partial<NewWatchInput> = {}) => newWatchInput.parse({
  brand: { id: brand }, model: 'Test Model Ärë', reference: '', caliber: 'Cal. 1',
  claims: [
    { statement: 'The brand states the case is made in-house.', url: 'https://example.com/case', sourceType: 'manufacturer', dimensions: ['EX'] },
    { statement: 'The brand states the dial is printed in-house.', url: 'https://example.com/case', sourceType: 'manufacturer', dimensions: ['DH'] },
    { statement: 'A specialist reports the movement is a Sellita base.', url: knownSource.url, sourceType: 'press', dimensions: ['MM', 'MA'] },
  ],
  explanation: 'A current model with primary sources on the case and dial.',
  ...overrides,
});

test('a proposal publishes as version 1: published, all U, confidence D, by the contributor', () => {
  const { watch, sources, organization } = buildNewWatch(proposal(), live, ctx);
  assert.equal(watch.id, `${brand}/test-model-are`);
  assert.equal(organization, undefined);
  assert.equal(watch.reference, undefined, 'empty optional fields are dropped');
  const [p] = watch.profiles;
  assert.deepEqual([p.version, p.status, p.confidence, p.editor, p.created_on, p.is_seed], [1, 'published', 'D', 'contributor_1', '2026-11-06', false]);
  assert.ok(Object.values(p.scores).every(s => s.value === null && s.evidence.length === 0));
  assert.deepEqual(p.classification, [ctx.archetype]);
  // One new source for the repeated URL; the known URL reuses the existing source.
  assert.equal(sources.length, 1);
  assert.equal(sources[0].tier, 'primary');
  assert.deepEqual(watch.claims.map(c => c.source), [sources[0].id, sources[0].id, knownSource.id]);
  assert.equal(new Set(watch.claims.map(c => c.id)).size, 3);
  assert.ok(watch.claims.every(c => c.editor === 'contributor_1' && c.date_checked === '2026-11-01'));
});

test('the plan is the one db:publish would run, and passes catalogue validation', () => {
  const plan = planNewWatch(live, buildNewWatch(proposal(), live, ctx));
  assert.equal(plan.current, undefined);
  assert.ok(plan.changes.includes('new record'));
  assert.deepEqual(plan.authors, ['contributor_1']);
});

test('a new brand is added with the record', () => {
  const input = proposal({ brand: { name: 'Nouvelle Maison', kind: 'atelier', country: 'CH', website: '' } });
  const built = buildNewWatch(input, live, ctx);
  assert.deepEqual(built.organization, { id: 'nouvelle-maison', name: 'Nouvelle Maison', kind: 'atelier', country: 'CH', ownership: 'unknown', scale: 'unknown' });
  assert.ok(planNewWatch(live, built).changes.includes('add organization "nouvelle-maison"'));
});

test('taken ids, listed brands and unknown brands are refused', () => {
  const existing = live.watches[0];
  const model = existing.id.split('/')[1];
  assert.throws(() => buildNewWatch(proposal({ brand: { id: existing.brand }, model }), live, ctx), /already has a record/);
  assert.throws(() => buildNewWatch(proposal({ brand: { name: live.orgs.get(brand)!.name, kind: 'brand' } }), live, ctx), /already lists/);
  assert.throws(() => buildNewWatch(proposal({ brand: { id: 'no-such-brand' } }), live, ctx), /Choose a brand/);
  assert.throws(() => buildNewWatch(proposal({ model: '時計' }), live, ctx), /Latin letters/);
});

test('the archetype must come from the methodology, and the contract refuses bad input', () => {
  assert.equal(isArchetype(live, ctx.archetype), true);
  assert.equal(isArchetype(live, 'independent_watchmaker'), false, 'a descriptor is not an archetype');
  assert.throws(() => planNewWatch(live, buildNewWatch(proposal(), live, { ...ctx, archetype: 'made_up' })), /vocabulary/);
  const ok = { brand: { id: brand }, model: 'X', explanation: 'Long enough reason.',
    claims: [{ statement: 'A sourced statement.', url: 'https://example.com', sourceType: 'press', dimensions: ['MA'] }] };
  assert.equal(newWatchInput.safeParse(ok).success, true);
  for (const bad of [
    { ...ok, claims: [] },
    { ...ok, productionStart: 2020, productionEnd: 2010 },
    { ...ok, claims: [{ ...ok.claims[0], url: 'javascript:alert(1)' }] },
    { ...ok, scores: {} },
  ]) assert.equal(newWatchInput.safeParse(bad).success, false);
  assert.equal(slugify('  Ref. 5711/1A  '), 'ref-5711-1a');
});
