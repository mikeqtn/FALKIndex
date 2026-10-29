import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { planPublish, applyPublish, changedIds, planReferences, claimMutable } from './publish-record.ts';
import { loadCatalogue } from '../server/catalogue.ts';
import { realm } from '../server/accounts.ts';
import { pool } from '../server/db.ts';

after(() => pool.end());
const live = await loadCatalogue();
const evidenced = live.watches.find(w => w.profiles.some(p => p.status === 'published' && !p.is_seed))!;
// A local copy of the catalogue with one record edited.
const edit = (mutate: (w: typeof evidenced) => void, id = evidenced.id) => {
  const local = structuredClone(live);
  mutate(local.watches.find(w => w.id === id)!);
  return local;
};
// The normal editorial step: a new published version by "tester", the old one superseded.
const newVersion = (editor = 'tester') => edit(w => {
  const old = w.profiles.find(p => p.status === 'published')!;
  w.profiles.push({ ...structuredClone(old), version: w.profiles.length + 1, editor, change_note: 'Test version.' });
  old.status = 'superseded';
});

test('an unchanged record has nothing to publish', () =>
  assert.throws(() => planPublish(live, structuredClone(live), evidenced.id), /nothing to publish/));

test('--all finds exactly the records that differ from the live catalogue', () => {
  assert.deepEqual(changedIds(live, structuredClone(live)), []);
  assert.deepEqual(changedIds(live, newVersion()), [evidenced.id]);
  const added = structuredClone(live);
  added.watches.push({ ...structuredClone(evidenced), id: 'test/new-record' });
  assert.deepEqual(changedIds(live, added), ['test/new-record']);
});

test('--all also publishes a source edited on its own', () => {
  const local = structuredClone(live);
  const source = [...local.sources.values()][0];
  local.sources.set(source.id, { ...source, notes: 'Edited on its own.' });
  assert.deepEqual(planReferences(live, structuredClone(live)).changes, []);
  assert.deepEqual(planReferences(live, local).changes, [`update source "${source.id}"`]);
});

test('published history cannot be rewritten', () => {
  assert.throws(() => planPublish(live, edit(w => { w.profiles[0].scores.MA.value = 5 - (w.profiles[0].scores.MA.value ?? 0); }), evidenced.id), /version 1 was edited/);
  assert.throws(() => planPublish(live, edit(w => { w.claims.pop(); }), evidenced.id), /was removed/);
  assert.throws(() => planPublish(live, edit(w => { w.claims[0].statement += ' (changed)'; }), evidenced.id), /was edited; supersede/);
  // A claim already live under another record cannot be reworded by citing it here.
  const shared = live.watches.flatMap(w => w.claims).find(c => !evidenced.claims.some(e => e.id === c.id))!;
  assert.throws(() => planPublish(live, edit(w => { w.claims.push({ ...shared, statement: `${shared.statement} (changed)` }); }), evidenced.id), new RegExp(`claim "${shared.id}" was edited`));
  // Superseding is final.
  const before = edit(w => Object.assign(w.claims[0], { status: 'superseded', superseded_by: w.claims[1].id }));
  const revive = structuredClone(before);
  Object.assign(revive.watches.find(w => w.id === evidenced.id)!.claims[0], { status: 'active', superseded_by: undefined });
  assert.throws(() => planPublish(before, revive, evidenced.id), /was edited; supersede/);
});

test('an ai-draft version cannot be published', () =>
  assert.throws(() => planPublish(live, newVersion('ai-draft'), evidenced.id), /ai-draft profile cannot be published/));

test('a reviewer verifying an ai-draft claim is allowed', () => {
  const claim = evidenced.claims.find(c => c.editor === 'ai-draft');
  if (!claim) return;
  const plan = planPublish(live, edit(w => { w.claims.find(c => c.id === claim.id)!.editor = 'tester'; }), evidenced.id);
  assert.deepEqual(plan.changes, [`claim "${claim.id}": verified by tester`]);
});

test('a new version is planned and applied append-only', async () => {
  const plan = planPublish(live, newVersion(), evidenced.id);
  const published = evidenced.profiles.find(p => p.status === 'published')!.version;
  assert.deepEqual(plan.changes, [`version ${published}: published → superseded`, `add version ${evidenced.profiles.length + 1} (published, by tester)`]);

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const username = `rev_${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO falk_account(realm,clerk_id,username,role,email_verified) VALUES($1,$2,$3,'editor',true)", [realm(), `test-${randomUUID()}`, username]);
    const revision = (await db.query('SELECT current_revision_id FROM falk_watch WHERE id=$1', [evidenced.id])).rows[0].current_revision_id;
    await assert.rejects(applyPublish(db, plan, 'tester', revision), /cannot review it/);
    await assert.rejects(applyPublish(db, plan, username, randomUUID()), /changed while this plan was prepared/);
    await applyPublish(db, plan, username, revision);
    const versions = (await db.query('SELECT version,status FROM falk_profile_version WHERE watch_id=$1 ORDER BY version', [evidenced.id])).rows;
    assert.equal(versions.at(-1).status, 'published');
    assert.equal(versions.filter(v => v.status === 'published').length, 1);
    const head = (await db.query('SELECT r.kind,r.parent_id FROM falk_watch w JOIN falk_revision r ON r.id=w.current_revision_id WHERE w.id=$1', [evidenced.id])).rows[0];
    assert.deepEqual(head, { kind: 'approval', parent_id: revision });
  } finally { await db.query('ROLLBACK'); db.release(); }
});

test('the plan and the database agree on what a claim may change', () => {
  const sql = readFileSync(new URL('../db/003-immutable-claims.sql', import.meta.url), 'utf8');
  const array = sql.match(/mutable CONSTANT text\[\] := ARRAY\[([^\]]*)\]/)![1];
  assert.deepEqual([...array.matchAll(/'([^']+)'/g)].map(m => m[1]), claimMutable);
});

test('the database refuses to edit or delete a published claim', async () => {
  const claim = evidenced.claims.find(c => c.editor !== 'ai-draft');
  assert.ok(claim, `${evidenced.id} needs a reviewed claim for this test`);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SAVEPOINT guard');
    for (const edit of [`payload=payload||'{"statement":"Rewritten."}'`, `payload=payload-'dimensions'`, `id='test-renamed'`, 'source_id=NULL']) {
      await assert.rejects(db.query(`UPDATE falk_claim SET ${edit} WHERE id=$1`, [claim.id]), /cannot be edited/, edit);
      await db.query('ROLLBACK TO SAVEPOINT guard');
    }
    await assert.rejects(db.query(`UPDATE falk_claim SET payload=payload||'{"editor":"someone-else"}' WHERE id=$1`, [claim.id]), /cannot be edited/);
    await db.query('ROLLBACK TO SAVEPOINT guard');
    await assert.rejects(db.query('DELETE FROM falk_claim WHERE id=$1', [claim.id]), /never deleted/);
    await db.query('ROLLBACK TO SAVEPOINT guard');
    await assert.rejects(db.query('TRUNCATE falk_claim CASCADE'), /never deleted/);
    await db.query('ROLLBACK TO SAVEPOINT guard');
    // What publishing may change: status, and the reviewer's handle on an ai-draft claim.
    await db.query(`UPDATE falk_claim SET payload=payload||'{"status":"disputed"}' WHERE id=$1`, [claim.id]);
    await db.query(`INSERT INTO falk_claim(id,source_id,payload) VALUES('test-ai-claim',$1,$2)`, [claim.source, { ...claim, id: 'test-ai-claim', editor: 'ai-draft' }]);
    await db.query('SAVEPOINT draft');
    await assert.rejects(db.query(`UPDATE falk_claim SET payload=payload-'editor' WHERE id='test-ai-claim'`), /cannot be edited/);
    await db.query('ROLLBACK TO SAVEPOINT draft');
    await assert.rejects(db.query(`UPDATE falk_claim SET payload=payload||'{"statement":"Rewritten."}' WHERE id='test-ai-claim'`), /cannot be edited/);
    await db.query('ROLLBACK TO SAVEPOINT draft');
    await db.query(`UPDATE falk_claim SET payload=payload||'{"editor":"tester"}' WHERE id='test-ai-claim'`);
    // Superseding is final: no going back, and the replacement stays recorded.
    await db.query(`UPDATE falk_claim SET payload=payload||'{"status":"superseded","superseded_by":"test-ai-claim"}' WHERE id=$1`, [claim.id]);
    await db.query('SAVEPOINT superseded');
    await assert.rejects(db.query(`UPDATE falk_claim SET payload=payload||'{"status":"active"}' WHERE id=$1`, [claim.id]), /cannot be edited/);
    await db.query('ROLLBACK TO SAVEPOINT superseded');
    await assert.rejects(db.query(`UPDATE falk_claim SET payload=payload-'superseded_by' WHERE id=$1`, [claim.id]), /cannot be edited/);
  } finally { await db.query('ROLLBACK'); db.release(); }
});

test('the database refuses to edit or delete a profile version or its scores', async () => {
  const profile = evidenced.profiles.find(p => p.status === 'published');
  assert.ok(profile && Object.values(profile.scores).some(s => s.evidence.length), `${evidenced.id} needs a published version with evidence for this test`);
  const key = [evidenced.id, profile.version];
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SAVEPOINT guard');
    const refused: [string, RegExp][] = [
      [`UPDATE falk_profile_version SET payload=payload||'{"change_note":"Rewritten."}' WHERE watch_id=$1 AND version=$2`, /cannot be edited/],
      [`UPDATE falk_profile_version SET status='draft',payload=payload||'{"status":"draft"}' WHERE watch_id=$1 AND version=$2`, /cannot be edited/],
      [`UPDATE falk_profile_version SET status='superseded' WHERE watch_id=$1 AND version=$2`, /cannot be edited/],
      ['DELETE FROM falk_profile_version WHERE watch_id=$1 AND version=$2', /never deleted/],
      ['UPDATE falk_dimension_score SET value=0 WHERE watch_id=$1 AND version=$2', /append-only/],
      ['DELETE FROM falk_score_evidence WHERE watch_id=$1 AND version=$2', /append-only/],
    ];
    for (const [sql, error] of refused) {
      await assert.rejects(db.query(sql, key), error, sql);
      await db.query('ROLLBACK TO SAVEPOINT guard');
    }
    await assert.rejects(db.query('TRUNCATE falk_profile_version CASCADE'), /never deleted|append-only/);
    await db.query('ROLLBACK TO SAVEPOINT guard');
    // Moving forward, as publishing does, is allowed.
    await db.query(`UPDATE falk_profile_version SET status='superseded',payload=payload||'{"status":"superseded"}' WHERE watch_id=$1 AND version=$2`, key);
  } finally { await db.query('ROLLBACK'); db.release(); }
});
