import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createApp } from '../server/index.ts';
import { pool } from '../server/db.ts';
import { realm } from '../server/accounts.ts';
import { correctionInput, saveCorrection } from '../server/corrections.ts';
import { decideSubmission, listSubmissions, nextStatus, reviewDecision, reviewQuery, submissionDetail } from '../server/review.ts';

const note = 'Checked every evidence link against the record.';
test('only open submissions can be decided, and each action has one outcome', () => {
  assert.equal(nextStatus('pending','approve'),'approved');
  assert.equal(nextStatus('pending','reject'),'rejected');
  assert.equal(nextStatus('pending','request_info'),'needs_info');
  assert.equal(nextStatus('needs_info','approve'),'approved');
  for (const status of ['approved','rejected','withdrawn'] as const) {
    assert.throws(() => nextStatus(status,'approve'),/already been decided/);
  }
});
test('decisions require a reason and cannot smuggle extra fields', () => {
  assert.equal(reviewDecision.safeParse({action:'reject',expectedStatus:'pending',note}).success,true);
  for (const input of [
    {action:'reject',expectedStatus:'pending',note:'too short'},
    {action:'publish',expectedStatus:'pending',note},
    {action:'approve',expectedStatus:'pending',note,status:'approved'},
    {action:'approve',note},
  ]) assert.equal(reviewDecision.safeParse(input).success,false);
  assert.equal(reviewQuery.parse({status:''}).status,undefined);
  assert.equal(reviewQuery.safeParse({status:'published'}).success,false);
});

async function rolledBack(fn: (db: PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); await fn(db); } finally { await db.query('ROLLBACK'); db.release(); }
}
async function member(db: PoolClient, role: 'contributor'|'editor'|'admin') {
  const username = `test_${randomUUID().replaceAll('-','').slice(0,12)}`;
  const id = (await db.query('INSERT INTO falk_account(realm,clerk_id,username,role,email_verified) VALUES($1,$2,$3,$4,true) RETURNING id',
    [realm(),`test-${randomUUID()}`,username,role])).rows[0].id as string;
  await db.query("INSERT INTO falk_account_private(account_id,email) VALUES($1,'reviewer@example.invalid')", [id]);
  await db.query('INSERT INTO falk_member_profile(account_id) VALUES($1)', [id]);
  return {id,username};
}
async function guestCorrection(db: PoolClient) {
  const watch = (await db.query('SELECT id,brand_id,payload,current_revision_id FROM falk_watch ORDER BY id LIMIT 1')).rows[0];
  const input = correctionInput.parse({record:watch.id,role:'reader',correction:'The dial is made by a named supplier.',
    evidence:['https://example.com/dial'],name:'Private Guest',email:'guest@example.invalid'});
  return {watch,submission:await saveCorrection(input,db)};
}

test('an editor decision is recorded append-only without changing the public record', async () => {
  await rolledBack(async db => {
    const editor = await member(db,'editor');
    const { watch, submission } = await guestCorrection(db);
    const result = await decideSubmission(editor.id,submission.id,{action:'approve',expectedStatus:'pending',note},db);
    assert.equal(result.status,'approved');
    const after = (await db.query('SELECT payload,current_revision_id FROM falk_watch WHERE id=$1', [watch.id])).rows[0];
    assert.deepEqual(after,{payload:watch.payload,current_revision_id:watch.current_revision_id});
    const detail = await submissionDetail(submission.id,editor.id,db);
    assert.equal(detail?.status,'approved');
    assert.equal(detail?.explanation,'The dial is made by a named supplier.');
    assert.deepEqual(detail?.events.map(e => [e.action,e.note,e.actor]),[['approve',note,`@${editor.username}`]]);
    const logged = await db.query("SELECT reason,payload FROM falk_audit_event WHERE actor_id=$1 AND action='submission_approve'", [editor.id]);
    assert.deepEqual(logged.rows,[{reason:note,payload:{submission:submission.id,record:watch.id}}]);
    await assert.rejects(decideSubmission(editor.id,submission.id,{action:'reject',expectedStatus:'approved',note},db),/already been decided/);
  });
});
test('a stale review cannot overwrite another editor\'s decision', async () => {
  await rolledBack(async db => {
    const [first, second] = [await member(db,'editor'),await member(db,'admin')];
    const { submission } = await guestCorrection(db);
    await decideSubmission(first.id,submission.id,{action:'request_info',expectedStatus:'pending',note},db);
    await assert.rejects(decideSubmission(second.id,submission.id,{action:'approve',expectedStatus:'pending',note},db),/changed this submission/);
    assert.equal((await decideSubmission(second.id,submission.id,{action:'reject',expectedStatus:'needs_info',note},db)).status,'rejected');
  });
});
test('contributors, self-reviewers and conflicted editors cannot decide', async () => {
  await rolledBack(async db => {
    const contributor = await member(db,'contributor');
    const editor = await member(db,'editor');
    const { watch, submission } = await guestCorrection(db);
    await assert.rejects(decideSubmission(contributor.id,submission.id,{action:'approve',expectedStatus:'pending',note},db),/permission/);
    const own = (await db.query(`INSERT INTO falk_submission(author_id,target_kind,watch_id,original_proposal,explanation,evidence)
      VALUES($1,'watch',$2,'{}','Editor-authored correction','[]') RETURNING id`, [editor.id,watch.id])).rows[0].id;
    assert.equal((await submissionDetail(own,editor.id,db))?.selfAuthored,true);
    await assert.rejects(decideSubmission(editor.id,own,{action:'approve',expectedStatus:'pending',note},db),/your own submission/);
    await db.query('INSERT INTO falk_affiliation(account_id,organization_id) VALUES($1,$2)', [editor.id,watch.brand_id]);
    const detail = await submissionDetail(submission.id,editor.id,db);
    assert.equal(detail?.conflicts.length,1);
    await assert.rejects(decideSubmission(editor.id,submission.id,{action:'approve',expectedStatus:'pending',note},db),/disclosed relationship/);
    await db.query('UPDATE falk_account SET status=$2 WHERE id=$1', [editor.id,'suspended']);
    await assert.rejects(decideSubmission(editor.id,submission.id,{action:'reject',expectedStatus:'pending',note},db),/suspended/);
  });
});
test('conflicts cover guest self-submissions, ended disclosures and organization proposals', async () => {
  await rolledBack(async db => {
    const editor = await member(db,'editor');
    const { watch, submission } = await guestCorrection(db);
    // The guest correction was sent from this editor's own private address.
    await db.query("UPDATE falk_account_private SET email='guest@example.invalid' WHERE account_id=$1", [editor.id]);
    assert.equal((await submissionDetail(submission.id,editor.id,db))?.selfAuthored,true);
    await assert.rejects(decideSubmission(editor.id,submission.id,{action:'approve',expectedStatus:'pending',note},db),/your own submission/);

    const other = await member(db,'editor');
    // Ending a tie after the submission arrived does not clear the conflict.
    await db.query("INSERT INTO falk_affiliation(account_id,organization_id,disclosed_at,ended_at) VALUES($1,$2,now()-interval '1 year',now()+interval '1 second')", [other.id,watch.brand_id]);
    await assert.rejects(decideSubmission(other.id,submission.id,{action:'approve',expectedStatus:'pending',note},db),/disclosed relationship/);

    const author = await member(db,'contributor');
    const proposal = (await db.query(`INSERT INTO falk_submission(author_id,target_kind,organization_id,original_proposal,explanation,evidence)
      VALUES($1,'organization',$2,'{}','Organization correction','[]') RETURNING id`, [author.id,watch.brand_id])).rows[0].id;
    const detail = await submissionDetail(proposal,other.id,db);
    assert.match(detail?.subject ?? '',/^Organization: /);
    await assert.rejects(decideSubmission(other.id,proposal,{action:'approve',expectedStatus:'pending',note},db),/disclosed relationship/);
  });
});
test('information cannot be requested from a guest without contact details', async () => {
  await rolledBack(async db => {
    const editor = await member(db,'editor');
    const watch = (await db.query('SELECT id FROM falk_watch ORDER BY id LIMIT 1')).rows[0].id;
    const { id } = await saveCorrection(correctionInput.parse({record:watch,role:'reader',correction:'No contact details given.',evidence:['https://example.com/a']}),db);
    await assert.rejects(decideSubmission(editor.id,id,{action:'request_info',expectedStatus:'pending',note},db),/no contact details/);
    assert.equal((await decideSubmission(editor.id,id,{action:'reject',expectedStatus:'pending',note},db)).status,'rejected');
  });
});
test('search text is literal, not a LIKE pattern', async () => {
  await rolledBack(async db => {
    await guestCorrection(db);
    assert.equal((await listSubmissions(reviewQuery.parse({search:'%'}),db)).total,0);
    assert.ok((await listSubmissions(reviewQuery.parse({search:'named supplier'}),db)).total >= 1);
  });
});
test('queue summaries never include guest contact details; editor detail does', async () => {
  await rolledBack(async db => {
    const editor = await member(db,'editor');
    const { submission } = await guestCorrection(db);
    const queue = await listSubmissions(reviewQuery.parse({status:'pending'}),db);
    const listed = queue.submissions.find(s => s.id === submission.id);
    assert.ok(listed);
    assert.equal(listed.submitter.label,'Private Guest');
    assert.ok(queue.counts.pending >= 1);
    assert.doesNotMatch(JSON.stringify(queue),/guest@example\.invalid/);
    const filtered = await listSubmissions(reviewQuery.parse({status:'rejected'}),db);
    assert.equal(filtered.counts.pending,queue.counts.pending,'tab counts ignore the active filter');
    assert.equal((await submissionDetail(submission.id,editor.id,db))?.contact?.email,'guest@example.invalid');
  });
});

const server = createApp().listen(0,'127.0.0.1');
await new Promise<void>(resolve => server.once('listening',resolve));
after(() => new Promise<void>(resolve => server.close(() => resolve())));
const address = server.address();
assert.ok(address && typeof address!=='string');
const base = `http://127.0.0.1:${address.port}`;
test('anonymous and cross-site requests cannot reach the review queue', async () => {
  const anonymous = await fetch(`${base}/api/review/submissions`);
  assert.equal(anonymous.status,401);
  assert.equal(anonymous.headers.get('cache-control'),'no-store');
  const url = `${base}/api/review/submissions/${randomUUID()}/decisions`;
  const body = JSON.stringify({action:'approve',expectedStatus:'pending',note});
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body})).status,401);
});
