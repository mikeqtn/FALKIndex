import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, load } from './validate.ts';

const data = load('data');
// Run check() on a copy of data/ with one watch's first profile mutated.
const broken = (mutate: (profile: any, watch: any) => void) => {
  const d = structuredClone(data);
  mutate(d.watches[0].value.profiles[0], d.watches[0].value);
  return check(d).errors.join('\n');
};

test('data/ is valid', () => assert.deepEqual(check(data).errors, []));

test('a sum field is rejected', () => assert.match(broken(p => { p.total = 30; }), /Unrecognized key.*total/));

test('a missing dimension is rejected', () => assert.match(broken(p => { delete p.scores.CF; }), /scores\.CF/));

test('an unknown classification is rejected', () =>
  assert.match(broken(p => { p.classification = ['integrated_haute_manufacture']; }), /not in the v0\.2 vocabulary/));

test('a descriptor cannot be a classification', () =>
  assert.match(broken(p => { p.classification = ['independent_watchmaker']; }), /descriptor/));

test('U is null, not 0, and passes', () => assert.equal(broken(p => { p.scores.MA.value = null; }), ''));

test('published non-seed profiles need rationale and supporting evidence', () => {
  const errors = broken(p => { p.is_seed = false; });
  assert.match(errors, /rationale required/);
  assert.match(errors, /supporting claim required/);
});

test('version gaps are rejected', () => assert.match(broken(p => { p.version = 2; }), /expected version 1/));

test('unknown claim references are rejected', () =>
  assert.match(broken(p => { p.scores.MA.evidence = [{ claim: 'nope', stance: 'supports', note: 'x' }]; }), /unknown claim "nope"/));

test('a record with no published profile is flagged', () => {
  const d = structuredClone(data);
  d.watches[0].value.profiles[0].status = 'draft';
  assert.match(check(d).warnings.join('\n'), /no published profile/);
});

test('a source behind a published profile needs an archived copy', () => {
  const d = structuredClone(data);
  const w = d.watches.find((w: any) => w.value.profiles.some((p: any) => p.status === 'published' && !p.is_seed))!.value;
  const source: any = d.sources.find((s: any) => s.value.id === w.claims[0].source)!.value;
  delete source.archived_url;
  assert.match(check(d).errors.join('\n'), new RegExp(`"${source.id}" supports a published profile`));
});

test('any other source without an archived copy is only a warning', () => {
  const d = structuredClone(data);
  d.sources.push({ file: 'sources.yaml[new]', value: { id: 'uncited', url: 'https://example.com', source_type: 'manufacturer', tier: 'primary' } });
  const { errors, warnings } = check(d);
  assert.deepEqual(errors, []);
  assert.match(warnings.join('\n'), /"uncited" has no archived copy/);
});
