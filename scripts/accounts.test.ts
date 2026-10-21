import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.ts';
import { pool } from '../server/db.ts';
import { enforceAccount, invitationRole, publicProfile, realm } from '../server/accounts.ts';
import { adminAccountQuery, createInvitation, protectLastAdmin } from '../server/admin.ts';
import { CORRECTIONS_PER_HOUR, rateLimitKey, requireSameOrigin } from '../server/api.ts';
import { profileInput } from '../src/accounts/contracts.ts';
import { loadCatalogue } from '../server/catalogue.ts';
import { check, load } from './validate.ts';
import { correctionInput, saveCorrection } from '../server/corrections.ts';

test('database catalogue exactly preserves the validated YAML corpus and profile versions', async () => {
  const actual = await loadCatalogue();
  const expected = check(load('data')).parsed;
  // Filesystem path order and database ID order differ for prefix slugs;
  // compare every complete watch by its identity, not incidental array order.
  assert.deepEqual({...actual,watches:new Map(actual.watches.map(w => [w.id,w]))},
    {...expected,watches:new Map(expected.watches.map(w => [w.id,w]))});
});
test('unverified and suspended accounts fail closed for every role', () => {
  for (const role of ['contributor','editor','admin'] as const) {
    assert.throws(() => enforceAccount({role,status:'active',emailVerified:false}),/Verify your email/);
    assert.throws(() => enforceAccount({role,status:'suspended',emailVerified:true}),/suspended/);
  }
});
test('qualifications cannot elevate a contributor or editor to administrator', () => {
  for (const role of ['contributor','editor'] as const) {
    assert.throws(() => enforceAccount({role,status:'active',emailVerified:true},['admin']),/permission/);
  }
  assert.doesNotThrow(() => enforceAccount({role:'admin',status:'active',emailVerified:true},['admin']));
});
test('last active administrator cannot be suspended or demoted', () => {
  const current = {role:'admin',status:'active'};
  assert.throws(() => protectLastAdmin(current,{role:'editor',status:'active'},1),/last active/);
  assert.throws(() => protectLastAdmin(current,{role:'admin',status:'suspended'},1),/last active/);
  assert.doesNotThrow(() => protectLastAdmin(current,{role:'editor',status:'active'},2));
});
test('admin account filters accept omitted and empty all-values but reject invalid filters', () => {
  const defaults = {search:'',page:1};
  assert.deepEqual(adminAccountQuery.parse({}),defaults);
  const all = adminAccountQuery.parse({search:'',role:'',status:'',page:'1'});
  assert.equal(all.role,undefined);
  assert.equal(all.status,undefined);
  assert.equal(all.page,1);
  assert.deepEqual(adminAccountQuery.parse({role:'admin',status:'active',page:'2'}),
    {...defaults,role:'admin',status:'active',page:2});
  for (const query of [{role:'owner'},{status:'deleted'},{page:'0'},{role:['admin','contributor']}]) {
    assert.equal(adminAccountQuery.safeParse(query).success,false);
  }
});
test('an invitation cannot replay a weaker role over an existing staff grant', () => {
  assert.equal(invitationRole('admin','contributor'),'admin');
  assert.equal(invitationRole('admin','editor'),'admin');
  assert.equal(invitationRole('editor','contributor'),'editor');
  assert.equal(invitationRole('contributor','editor'),'editor');
  assert.equal(invitationRole('editor','admin'),'admin');
});
const profile = {username:'example_user',displayName:'',realName:'',showRealName:false,bio:'',
  qualifications:['collector'],qualificationDetails:'',professionalAffiliations:'',website:'',imageUrl:'',brandTies:[]};
test('profile input rejects permissions, verification flags and executable URLs', () => {
  assert.equal(profileInput.safeParse(profile).success,true);
  for (const extra of [{role:'admin'},{emailVerified:true},{verifications:[{verified:true}]}]) {
    assert.equal(profileInput.safeParse({...profile,...extra}).success,false);
  }
  assert.equal(profileInput.safeParse({...profile,website:'javascript:alert(1)'}).success,false);
  assert.equal(profileInput.safeParse({...profile,imageUrl:'data:text/html,hello'}).success,false);
  assert.equal(profileInput.safeParse({...profile,username:'Invalid Username'}).success,false);
});
test('cross-site and missing-origin mutations are rejected', () => {
  assert.throws(() => requireSameOrigin(undefined,'example.com'),/FALK website/);
  assert.throws(() => requireSameOrigin('https://attacker.example','example.com'),/FALK website/);
  assert.throws(() => requireSameOrigin('http://example.com','example.com'),/FALK website/);
  assert.doesNotThrow(() => requireSameOrigin('https://example.com','example.com'));
});
test('public profiles reveal only opted-in names and counts, including suspended attribution', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const username = `test_${randomUUID().replaceAll('-','').slice(0,12)}`;
    const member = await db.query('INSERT INTO falk_account(realm,clerk_id,username,email_verified) VALUES($1,$2,$3,true) RETURNING id', [realm(),`test-${randomUUID()}`,username]);
    const id = member.rows[0].id;
    await db.query("INSERT INTO falk_account_private(account_id,email,real_name) VALUES($1,'private@example.invalid','Private Test Name')", [id]);
    await db.query("INSERT INTO falk_member_profile(account_id,qualifications) VALUES($1,ARRAY['watchmaker'])", [id]);
    await db.query(`INSERT INTO falk_submission(author_id,target_kind,original_proposal,explanation,evidence)
      VALUES($1,'evidence','{"private":"secret proposal body"}','private moderation explanation','[]')`, [id]);
    const result = await publicProfile(username,db);
    assert.ok(result);
    assert.equal(result.role,'contributor');
    assert.equal(result.realName,null);
    assert.equal(result.pendingCount,1);
    assert.equal(result.acceptedCount,0);
    assert.deepEqual(result.verifications,[]);
    assert.doesNotMatch(JSON.stringify(result),/private@example|Private Test Name|secret proposal body|private moderation|clerk_id|emailVerified/);
    await db.query("UPDATE falk_member_profile SET show_real_name=true WHERE account_id=$1", [id]);
    assert.equal((await publicProfile(username,db))?.realName,'Private Test Name');
    await db.query("UPDATE falk_account SET status='suspended' WHERE id=$1", [id]);
    assert.equal((await publicProfile(username,db))?.status,'suspended');
  } finally { await db.query('ROLLBACK'); db.release(); }
});
test('audit events and original submission bodies are protected by database guards', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const inserted = await db.query("INSERT INTO falk_audit_event(action,reason) VALUES('test','append-only check') RETURNING id");
    await db.query('SAVEPOINT guard');
    await assert.rejects(db.query("UPDATE falk_audit_event SET reason='tampered' WHERE id=$1", [inserted.rows[0].id]),/append-only/);
    await db.query('ROLLBACK TO SAVEPOINT guard');
    await assert.rejects(db.query('DELETE FROM falk_audit_event WHERE id=$1', [inserted.rows[0].id]),/append-only/);
    await db.query('ROLLBACK TO SAVEPOINT guard');
    const account = await db.query("INSERT INTO falk_account(realm,clerk_id) VALUES('test',$1) RETURNING id", [`test-${randomUUID()}`]);
    const submitted = await db.query(`INSERT INTO falk_submission(author_id,target_kind,original_proposal,explanation,evidence)
      VALUES($1,'evidence','{}','original','[]') RETURNING id`, [account.rows[0].id]);
    await db.query('SAVEPOINT submission');
    await assert.rejects(db.query("UPDATE falk_submission SET explanation='rewritten' WHERE id=$1", [submitted.rows[0].id]),/immutable/);
    await db.query('ROLLBACK TO SAVEPOINT submission');
    await db.query("UPDATE falk_submission SET status='needs_info' WHERE id=$1", [submitted.rows[0].id]);
  } finally { await db.query('ROLLBACK'); db.release(); }
});
test('anonymous evidence-backed corrections persist in PostgreSQL with contact details kept private', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const record = (await loadCatalogue()).watches[0].id;
    const input = correctionInput.parse({
      record, role:'brand', correction:'Please review this specific claim.',
      evidence:['https://example.com/evidence'],
      name:'Private Submitter', email:'contact@example.invalid', _gotcha:'',
    });
    const submission = await saveCorrection(input,db);
    assert.match(submission.id,/^[0-9a-f-]{36}$/i);
    const stored = await db.query(`SELECT author_id,target_kind,watch_id,base_revision_id,original_proposal,
      explanation,evidence,submitter_name,submitter_email FROM falk_submission WHERE id=$1`,[submission.id]);
    assert.equal(stored.rowCount,1);
    assert.equal(stored.rows[0].author_id,null);
    assert.equal(stored.rows[0].target_kind,'watch');
    assert.equal(stored.rows[0].watch_id,record);
    assert.ok(stored.rows[0].base_revision_id);
    assert.deepEqual(stored.rows[0].original_proposal,{type:'correction',submitterRole:'brand'});
    assert.equal(stored.rows[0].explanation,input.correction);
    assert.deepEqual(stored.rows[0].evidence,input.evidence);
    assert.equal(stored.rows[0].submitter_name,input.name);
    assert.equal(stored.rows[0].submitter_email,input.email);
    assert.deepEqual(Object.keys(submission).sort(),['createdAt','id']);
    assert.equal(correctionInput.safeParse({...input,submitter_email:'leak@example.invalid'}).success,false);
    await assert.rejects(saveCorrection(correctionInput.parse({...input,record:'not-a-real-watch'}),db),/Choose a record/);
  } finally { await db.query('ROLLBACK'); db.release(); }
});

const server = createApp().listen(0,'127.0.0.1');
await new Promise<void>(resolve => server.once('listening',resolve));
after(() => new Promise<void>(resolve => server.close(() => resolve())));
const address = server.address();
assert.ok(address && typeof address!=='string');
const base = `http://127.0.0.1:${address.port}`;
test('anonymous requests cannot read accounts or use administrator controls', async () => {
  for (const path of ['/api/account','/api/admin/accounts']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status,401,path);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.doesNotMatch(await response.text(),/clerk_id|secret_key|session_token/);
  }
  const csrf = await fetch(`${base}/api/account`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(csrf.status,403);
  const unauthorized = await fetch(`${base}/api/account`,{method:'PATCH',headers:{'Content-Type':'application/json',Origin:base},body:'{}'});
  assert.equal(unauthorized.status,401);
  const correctionCsrf = await fetch(`${base}/api/corrections`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(correctionCsrf.status,403);
});
test('an invitation email that cannot be recorded is revoked; a refused inviter sends none', async () => {
  const calls: string[] = [];
  const provider = {
    createInvitation: async () => { calls.push('create'); return {id:'inv_test'}; },
    revokeInvitation: async (id: string) => { calls.push(`revoke:${id}`); return {}; },
  } as unknown as Parameters<typeof createInvitation>[3];
  // Runs the invitation inside a transaction that is always rolled back, with a throwaway inviter.
  const sandbox = (role: string, commitFails: boolean, saved: string[] = []) => (async (fn: (db: any) => Promise<unknown>) => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('INSERT INTO falk_account(id,realm,clerk_id,role,email_verified) VALUES($1,$2,$3,$4,true)', [inviter,realm(),`test-${randomUUID()}`,role]);
      const result = await fn(db);
      saved.push(...(await db.query("SELECT provider_id FROM falk_invitation WHERE provider_id='inv_test'")).rows.map(r => r.provider_id));
      if (commitFails) throw new Error('commit failed');
      return result;
    } finally { await db.query('ROLLBACK'); db.release(); }
  }) as unknown as Parameters<typeof createInvitation>[4];
  const inviter = randomUUID();
  const input = {email:'invitee@example.invalid',role:'editor' as const,reason:'Joining the editorial team.'};

  const saved: string[] = [];
  await createInvitation(inviter,input,'https://falk.example/sign-up',provider,sandbox('admin',false,saved));
  assert.deepEqual(calls,['create']);
  assert.deepEqual(saved,['inv_test']);

  calls.length = 0;
  await assert.rejects(createInvitation(inviter,input,'https://falk.example/sign-up',provider,sandbox('admin',true)),/commit failed/);
  assert.deepEqual(calls,['create','revoke:inv_test']);

  calls.length = 0;
  await assert.rejects(createInvitation(inviter,input,'https://falk.example/sign-up',provider,sandbox('contributor',false)),/permission/);
  assert.deepEqual(calls,[]);
});
test('guest corrections are capped per hour, counting invalid attempts', async () => {
  // Invalid bodies, so nothing permanent is stored; the counter is cleared either side.
  const key = rateLimitKey('correction','127.0.0.1');
  const clear = () => pool.query('DELETE FROM falk_rate_limit WHERE key=$1',[key]);
  await clear();
  try {
    const send = () => fetch(`${base}/api/corrections`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{}'});
    for (let i = 0; i < CORRECTIONS_PER_HOUR; i++) assert.equal((await send()).status,400);
    const limited = await send();
    assert.equal(limited.status,429);
    assert.match((await limited.json()).error,/last hour/);
  } finally { await clear(); }
});
