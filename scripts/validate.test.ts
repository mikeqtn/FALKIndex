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
