import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, load } from './validate.ts';

const data = load('data');
// A record whose first profile is still its published seed profile, so the published-profile rules apply to it.
const seedIndex = data.watches.findIndex((w: any) => w.value.profiles[0].status === 'published');
// Run check() on a copy of data/ with that watch's first profile mutated.
const broken = (mutate: (profile: any, watch: any) => void) => {
  const d = structuredClone(data);
  mutate(d.watches[seedIndex].value.profiles[0], d.watches[seedIndex].value);
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
  const errors = broken(p => {
    const d = Object.keys(p.scores).find(k => p.scores[k].value !== null)!;
    p.is_seed = false; p.scores[d].rationale = ''; p.scores[d].evidence = [];
  });
  assert.match(errors, /rationale required/);
  assert.match(errors, /supporting claim required/);
});

test('an ai-draft profile cannot be published; ai-draft evidence behind one is flagged', () => {
  assert.match(broken(p => { p.editor = 'ai-draft'; }), /ai-draft profile cannot be published/);
  const d = structuredClone(data);
  const w = d.watches.find((w: any) => w.value.profiles.some((p: any) => p.status === 'published' && !p.is_seed))!.value;
  w.claims.forEach((c: any) => { c.editor = 'ai-draft'; });
  assert.match(check(d).warnings.join('\n'), /still an ai-draft/);
});

test('version gaps are rejected', () => assert.match(broken(p => { p.version = 2; }), /expected version 1/));

test('unknown claim references are rejected', () =>
  assert.match(broken(p => { p.scores.MA.evidence = [{ claim: 'nope', stance: 'supports', note: 'x' }]; }), /unknown claim "nope"/));

test('a record with no published profile is flagged', () => {
  const d = structuredClone(data);
  d.watches[seedIndex].value.profiles[0].status = 'draft';
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

test('a past period with an outside performer is not flagged when the group bought it later', () => {
  const d = structuredClone(data);
  const w = d.watches.find((x: any) => x.value.id === 'studio-underd0g/03series')!.value;
  const past = w.provenance.find((e: any) => e.performer === 'horologium' && e.valid_to !== undefined);
  assert.equal(past.relationship, 'external_specialist');
  const quiet = (ws: string[]) => !ws.some(m => m.includes('03series') && m.includes('expected in_group'));
  assert.ok(quiet(check(d).warnings));
  delete past.valid_to;
  assert.ok(!quiet(check(d).warnings));
});
