import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../server/db.ts';
import { realm } from '../server/accounts.ts';
import { createApp } from '../server/index.ts';
import { FORUM_THREADS_PER_HOUR, rateLimitKey } from '../server/api.ts';
import { createThread, editPost, listCategories, listReports, listThreads, markRead, moderateThread, notifications,
  recordThreads, reply, reportPost, resolveReport, searchForum, setPostHidden, threadDetail } from '../server/forum.ts';

after(() => pool.end());

// Each test runs in a transaction that is rolled back, with a test category, two members and a thread.
async function forum(run: (db: PoolClient, ids: { thread: string, post: string, author: string, moderator: string }) => Promise<void>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const member = async () => (await db.query("INSERT INTO falk_account(realm,clerk_id) VALUES('test',$1) RETURNING id", [`test-${randomUUID()}`])).rows[0].id;
    const author = await member(), moderator = await member();
    await db.query("INSERT INTO falk_forum_category(id,name,description,position) VALUES('test-category','Test','For tests',99)");
    const thread = (await db.query("INSERT INTO falk_forum_thread(category_id,author_id,title) VALUES('test-category',$1,'A test thread') RETURNING id", [author])).rows[0].id;
    const post = (await db.query("INSERT INTO falk_forum_post(thread_id,author_id,body) VALUES($1,$2,'First text') RETURNING id", [thread, author])).rows[0].id;
    await run(db, { thread, post, author, moderator });
  } finally { await db.query('ROLLBACK'); db.release(); }
}
// Runs a statement that must fail, then rolls back to before it so the test can go on.
async function refused(db: PoolClient, sql: string, params: unknown[], error: RegExp) {
  await db.query('SAVEPOINT refused');
  await assert.rejects(db.query(sql, params), error, sql);
  await db.query('ROLLBACK TO SAVEPOINT refused');
}

test('editing a post keeps its earlier text, which cannot be rewritten', () => forum(async (db, { post }) => {
  await db.query("UPDATE falk_forum_post SET body='Second text' WHERE id=$1", [post]);
  const row = (await db.query('SELECT body,edited_at FROM falk_forum_post WHERE id=$1', [post])).rows[0];
  assert.equal(row.body, 'Second text');
  assert.ok(row.edited_at);
  const edits = (await db.query('SELECT id,body FROM falk_forum_post_edit WHERE post_id=$1', [post])).rows;
  assert.deepEqual(edits.map(e => e.body), ['First text']);
  await refused(db, "UPDATE falk_forum_post_edit SET body='tampered' WHERE id=$1", [edits[0].id], /append-only/);
  await refused(db, 'DELETE FROM falk_forum_post_edit WHERE id=$1', [edits[0].id], /append-only/);
  await refused(db, 'UPDATE falk_forum_post SET edited_at=NULL WHERE id=$1', [post], /follows its body/);
}));

test('posts and threads are never deleted, moved or reassigned', () => forum(async (db, { thread, post, moderator }) => {
  await refused(db, 'DELETE FROM falk_forum_post WHERE id=$1', [post], /never deleted/);
  await refused(db, 'TRUNCATE falk_forum_post CASCADE', [], /never deleted|append-only/);
  await refused(db, 'UPDATE falk_forum_post SET author_id=$2 WHERE id=$1', [post, moderator], /cannot be moved or reassigned/);
  await refused(db, 'DELETE FROM falk_forum_thread WHERE id=$1', [thread], /never deleted/);
  await refused(db, 'TRUNCATE falk_forum_thread CASCADE', [], /never deleted|append-only/);
  await refused(db, "UPDATE falk_forum_thread SET title='Rewritten title' WHERE id=$1", [thread], /cannot be rewritten/);
  await refused(db, "UPDATE falk_forum_thread SET last_post_at=last_post_at - interval '1 day' WHERE id=$1", [thread], /cannot be rewritten/);
  // What moderation may change.
  await db.query('UPDATE falk_forum_thread SET pinned=true,locked=true WHERE id=$1', [thread]);
}));

test('a new post moves its thread to the top of the listing', () => forum(async (db, { thread, author }) => {
  const before = (await db.query('SELECT last_post_at FROM falk_forum_thread WHERE id=$1', [thread])).rows[0].last_post_at;
  await db.query("INSERT INTO falk_forum_post(thread_id,author_id,body,created_at) VALUES($1,$2,'A reply',now() + interval '1 minute')", [thread, author]);
  const after = (await db.query('SELECT last_post_at FROM falk_forum_thread WHERE id=$1', [thread])).rows[0].last_post_at;
  assert.ok(after > before);
}));

test('hiding needs a moderator and a reason', () => forum(async (db, { thread, post, moderator }) => {
  await refused(db, 'UPDATE falk_forum_post SET hidden_at=now(),hidden_by=$2 WHERE id=$1', [post, moderator], /check constraint/);
  await refused(db, "UPDATE falk_forum_thread SET hidden_at=now(),hidden_reason='Spam' WHERE id=$1", [thread], /check constraint/);
  await db.query("UPDATE falk_forum_post SET hidden_at=now(),hidden_by=$2,hidden_reason='Spam' WHERE id=$1", [post, moderator]);
  await db.query('UPDATE falk_forum_post SET hidden_at=NULL,hidden_by=NULL,hidden_reason=NULL WHERE id=$1', [post]);
}));

test('a report is fixed once made, resolved exactly once, and made once per member', () => forum(async (db, { post, author, moderator }) => {
  const report = (await db.query("INSERT INTO falk_forum_report(post_id,reporter_id,reason) VALUES($1,$2,'Off topic') RETURNING id", [post, author])).rows[0].id;
  await refused(db, "INSERT INTO falk_forum_report(post_id,reporter_id,reason) VALUES($1,$2,'Again')", [post, author], /duplicate key/);
  await refused(db, "UPDATE falk_forum_report SET reason='Changed' WHERE id=$1", [report], /cannot be changed/);
  await refused(db, "UPDATE falk_forum_report SET resolved_at=now() WHERE id=$1", [report], /check constraint/);
  await db.query("UPDATE falk_forum_report SET resolved_at=now(),resolved_by=$2,resolution='dismissed' WHERE id=$1", [report, moderator]);
  await refused(db, "UPDATE falk_forum_report SET resolution='hidden' WHERE id=$1", [report], /cannot be changed/);
  await refused(db, 'DELETE FROM falk_forum_report WHERE id=$1', [report], /never deleted/);
}));

test('a thread can only link to a record that exists, and search finds titles and posts', () => forum(async (db, { thread, author }) => {
  await refused(db, "INSERT INTO falk_forum_thread(category_id,author_id,title,watch_id) VALUES('test-category',$1,'Linked','no/such-record')", [author], /foreign key/);
  const watch = (await db.query('SELECT id FROM falk_watch LIMIT 1')).rows[0].id;
  await db.query("INSERT INTO falk_forum_thread(category_id,author_id,title,watch_id) VALUES('test-category',$1,'Linked thread',$2)", [author, watch]);
  const q = "websearch_to_tsquery('english',$1)";
  assert.deepEqual((await db.query(`SELECT id FROM falk_forum_thread WHERE search @@ ${q} AND id=$2`, ['tests', thread])).rows.length, 1);
  assert.deepEqual((await db.query(`SELECT id FROM falk_forum_post WHERE search @@ ${q} AND thread_id=$2`, ['first', thread])).rows.length, 1);
}));

// The API functions, against real accounts in this auth realm. Everything is rolled back.
async function members(run: (db: PoolClient, m: Record<'alice'|'bob'|'editor'|'unverified'|'nameless'|'suspended', string>) => Promise<void>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const add = async (role: string, verified = true, username: string | null = `t_${randomUUID().slice(0, 8)}`, status = 'active') =>
      (await db.query('INSERT INTO falk_account(realm,clerk_id,username,role,email_verified,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [realm(), `test-${randomUUID()}`, username, role, verified, status])).rows[0].id as string;
    await db.query("INSERT INTO falk_forum_category(id,name,description,position) VALUES('test-category','Test','For tests',99)");
    await run(db, { alice:await add('contributor'), bob:await add('contributor'), editor:await add('editor'),
      unverified:await add('contributor', false), nameless:await add('contributor', true, null), suspended:await add('contributor', true, undefined, 'suspended') });
  } finally { await db.query('ROLLBACK'); db.release(); }
}
const thread = { category:'test-category', title:'Who makes these cases?', body:'Asking about case suppliers.' };

test('posting needs a verified, active account with a username', () => members(async (db, m) => {
  await assert.rejects(createThread(m.unverified, thread, db), /Verify your email/);
  await assert.rejects(createThread(m.suspended, thread, db), /suspended/);
  await assert.rejects(createThread(m.nameless, thread, db), /Choose a username/);
  await assert.rejects(createThread(m.alice, { ...thread, category:'no-such-category' }, db), /Choose a category/);
  await assert.rejects(createThread(m.alice, { ...thread, record:'no/such-record' }, db), /Choose a record/);
}));

test('threads list, read, link to records and are found by search', () => members(async (db, m) => {
  const watch = (await db.query('SELECT id FROM falk_watch LIMIT 1')).rows[0].id;
  const { thread:id } = await createThread(m.alice, { ...thread, record:watch }, db);
  await reply(m.bob, id, { body:'Mostly specialist case makers.' }, db);
  const listing = (await listThreads('test-category', 1, db))!;
  assert.deepEqual(listing.threads.map(t => [t.id, t.replies]), [[id, 1]]);
  assert.equal((await listCategories(db)).find(c => c.id === 'test-category')?.threads, 1);
  assert.deepEqual((await recordThreads(watch, db)).map(t => t.id), [id]);
  assert.ok((await searchForum('specialist', db)).some(t => t.id === id), 'finds a reply');
  assert.ok((await searchForum('cases', db)).some(t => t.id === id), 'finds a title');
  const detail = (await threadDetail(id, 1, null, db))!;
  assert.deepEqual(detail.posts.map(p => p.body), ['Asking about case suppliers.', 'Mostly specialist case makers.']);
}));

test('a reply notifies everyone else in the thread, and a locked thread takes only moderators', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  await reply(m.bob, id, { body:'First reply.' }, db);
  await reply(m.editor, id, { body:'Second reply.' }, db);
  assert.equal((await notifications(m.alice, db)).unread, 2);
  assert.equal((await notifications(m.bob, db)).unread, 1, 'only the later reply');
  assert.equal((await notifications(m.editor, db)).unread, 0, 'not for your own reply');
  await markRead(m.alice, {}, db);
  assert.equal((await notifications(m.alice, db)).unread, 0);
  await assert.rejects(moderateThread(m.alice, id, { locked:true, reason:'Settled' }, db), /permission/);
  await moderateThread(m.editor, id, { locked:true, reason:'Settled' }, db);
  await assert.rejects(reply(m.bob, id, { body:'Too late.' }, db), /locked/);
  await reply(m.editor, id, { body:'A closing note.' }, db);
}));

test('only the author edits a post, and not once it is hidden', () => members(async (db, m) => {
  const { thread:id, post } = await createThread(m.alice, thread, db);
  await assert.rejects(editPost(m.bob, post, { body:'Not mine.' }, db), /your own posts/);
  await editPost(m.alice, post, { body:'Fixed a typo.' }, db);
  assert.equal((await threadDetail(id, 1, null, db))!.posts[0].body, 'Fixed a typo.');
  await setPostHidden(m.editor, post, true, 'Off topic', db);
  await assert.rejects(editPost(m.alice, post, { body:'Again.' }, db), /hid this post/);
}));

test('reports reach moderators, and hiding the post settles them and hides its text from readers', () => members(async (db, m) => {
  const { thread:id, post } = await createThread(m.alice, thread, db);
  await assert.rejects(reportPost(m.alice, post, { reason:'My own' }, db), /your own post/);
  const { report } = await reportPost(m.bob, post, { reason:'Spam link' }, db);
  await assert.rejects(reportPost(m.bob, post, { reason:'Again' }, db), /already reported/);
  await assert.rejects(listReports(m.bob, db), /permission/);
  await assert.rejects(resolveReport(m.bob, report, { resolution:'hidden', reason:'Spam' }, db), /permission/);
  assert.deepEqual((await listReports(m.editor, db)).map(r => r.id), [report]);
  await resolveReport(m.editor, report, { resolution:'hidden', reason:'Spam link' }, db);
  await assert.rejects(resolveReport(m.editor, report, { resolution:'dismissed', reason:'Changed mind' }, db), /already resolved/);
  assert.deepEqual(await listReports(m.editor, db), []);
  const publicView = (await threadDetail(id, 1, null, db))!.posts[0];
  assert.deepEqual([publicView.hidden, publicView.body, publicView.hiddenReason], [true, null, null]);
  const moderatorView = (await threadDetail(id, 1, { id:m.editor, role:'editor' }, db))!.posts[0];
  assert.deepEqual([moderatorView.body, moderatorView.hiddenReason], ['Asking about case suppliers.', 'Spam link']);
  const audited = (await db.query('SELECT action FROM falk_audit_event WHERE actor_id=$1', [m.editor])).rows.map(r => r.action);
  assert.deepEqual(audited.sort(), ['forum_post_hidden', 'forum_report_resolved']);
}));

test('a hidden thread disappears for readers but not for moderators', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  await moderateThread(m.editor, id, { hidden:true, reason:'Duplicate thread' }, db);
  assert.equal(await threadDetail(id, 1, null, db), null);
  assert.equal(await threadDetail(id, 1, { id:m.alice, role:'contributor' }, db), null);
  assert.equal((await threadDetail(id, 1, { id:m.editor, role:'editor' }, db))!.thread.hiddenReason, 'Duplicate thread');
  assert.deepEqual((await listThreads('test-category', 1, db))!.threads, []);
  assert.ok(!(await searchForum('cases', db)).some(t => t.id === id));
  await assert.rejects(reply(m.bob, id, { body:'Hello?' }, db), /not found/);
}));

test('new threads are capped per hour, counting every attempt', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const key = rateLimitKey('forum-thread', '127.0.0.1');
  const clear = () => pool.query('DELETE FROM falk_rate_limit WHERE key=$1', [key]);
  await clear();
  try {
    const send = () => fetch(`${base}/api/forum/threads`, { method:'POST', headers:{ 'Content-Type':'application/json', Origin:base }, body:'{}' });
    for (let i = 0; i < FORUM_THREADS_PER_HOUR; i++) assert.equal((await send()).status, 401);
    const limited = await send();
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /last hour/);
  } finally { await clear(); server.closeAllConnections(); server.close(); }
});
