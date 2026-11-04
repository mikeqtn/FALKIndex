import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../server/db.ts';
import { realm } from '../server/accounts.ts';
import { createApp } from '../server/index.ts';
import { FORUM_THREADS_PER_HOUR, rateLimitKey } from '../server/api.ts';
import { alertModerators, createThread, editPost, listCategories, listReports, listThreads, markRead, moderateThread, NEW_MEMBER, notifications,
  recentThreads, recordsUnderDiscussion, recordThreads, removeMember, REPORT_ALERTS_PER_HOUR, reply, reportPost, resolveReport, searchForum, setPostHidden, threadDetail } from '../server/forum.ts';

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

test('the forum home lists the latest thread per category, recent threads and records under discussion', () => members(async (db, m) => {
  const { thread } = await createThread(m.alice, { category:'test-category', title:'Hello there', body:'First' }, db);
  const category = (await listCategories(db)).find(c => c.id === 'test-category')!;
  assert.deepEqual(category.latest, { id:thread, title:'Hello there' });
  assert.equal((await recentThreads(1, db))[0].id, thread);
  const record = (await db.query('SELECT id FROM falk_watch LIMIT 1')).rows[0].id;
  await createThread(m.bob, { category:'test-category', title:'About a record', body:'Second', record }, db);
  assert.deepEqual((await recordsUnderDiscussion(1, db))[0], { id:record, threads:1 });
}));

// Give a member enough age and visible posts to count as established, in a thread of their own.
async function establish(db: PoolClient, id: string, hiddenBy?: string) {
  await db.query(`UPDATE falk_account SET created_at=now() - make_interval(days => $2) WHERE id=$1`, [id, NEW_MEMBER.days + 1]);
  const thread = (await db.query("INSERT INTO falk_forum_thread(category_id,author_id,title,created_at) VALUES('test-category',$1,'Older thread',now() - interval '2 days') RETURNING id", [id])).rows[0].id;
  await db.query(`INSERT INTO falk_forum_post(thread_id,author_id,body,created_at,hidden_at,hidden_by,hidden_reason)
    SELECT $1,$2,'Older post '||n,now() - interval '2 days',$3::timestamptz,$4::uuid,$5 FROM generate_series(1,$6::int) n`,
    [thread, id, hiddenBy ? new Date() : null, hiddenBy ?? null, hiddenBy ? 'Spam' : null, NEW_MEMBER.posts]);
  return thread as string;
}
const linked = 'See https://spam.example/deal for more.';

test('new members cannot post links, in threads, replies or edits, until they are established', () => members(async (db, m) => {
  await assert.rejects(createThread(m.alice, { ...thread, body:linked }, db), /cannot post links/);
  await assert.rejects(createThread(m.alice, { ...thread, title:'Deals at https://spam.example' }, db), /cannot post links/);
  const { thread:id, post } = await createThread(m.alice, thread, db);
  await assert.rejects(reply(m.bob, id, { body:linked }, db), /cannot post links/);
  await assert.rejects(editPost(m.alice, post, { body:linked }, db), /cannot post links/);
  await reply(m.editor, id, { body:linked }, db);
  // Old enough, but without enough visible posts: what a moderator hid does not count.
  await establish(db, m.bob, m.editor);
  await assert.rejects(reply(m.bob, id, { body:linked }, db), /cannot post links/);
  await establish(db, m.alice);
  await editPost(m.alice, post, { body:linked }, db);
}));

test('new members have lower hourly limits, and established members do not', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  await assert.rejects(createThread(m.alice, { ...thread, body:'A second opening post.' }, db), /one thread an hour/);
  for (let i = 1; i < NEW_MEMBER.postsPerHour; i++) await reply(m.alice, id, { body:`Reply number ${i}` }, db);
  await assert.rejects(reply(m.alice, id, { body:'One reply too many' }, db), /five times an hour/);
  await establish(db, m.alice);
  await reply(m.alice, id, { body:'One more, now established' }, db);
  await createThread(m.alice, { ...thread, body:'A second opening post.' }, db);
}));

test('the same long text is refused within a day, but short replies and unchanged edits are fine', () => members(async (db, m) => {
  const text = 'This exact sentence, posted more than once.';
  const { thread:id, post } = await createThread(m.alice, { ...thread, body:text }, db);
  await assert.rejects(reply(m.alice, id, { body:`  ${text.toUpperCase().replaceAll(' ', '\n')} ` .trim() }, db), /already posted/);
  await editPost(m.alice, post, { body:text }, db);
  await reply(m.alice, id, { body:'Thanks!' }, db);
  await reply(m.alice, id, { body:'Thanks!' }, db);
  await reply(m.bob, id, { body:text }, db);
  await reply(m.editor, id, { body:text }, db);
  await reply(m.editor, id, { body:text }, db);
  await db.query("UPDATE falk_forum_post SET hidden_at=now(),hidden_by=$2,hidden_reason='Spam' WHERE id=$1", [post, m.editor]);
  await assert.rejects(reply(m.alice, id, { body:text }, db), /already posted/, 'hiding it does not let it be posted again');
}));

test('a moderator can hide everything by a contributor and suspend them in one step', () => members(async (db, m) => {
  const { thread:id, post } = await createThread(m.alice, thread, db);
  const second = (await reply(m.alice, id, { body:'More from the same member.' }, db)).post;
  const { thread:other } = await createThread(m.bob, { ...thread, body:'A thread by someone else.' }, db);
  const bystander = (await reply(m.bob, id, { body:'A reply by someone else.' }, db)).post;
  const onOther = (await reply(m.alice, other, { body:'A reply on another thread.' }, db)).post;
  const { report } = await reportPost(m.bob, post, { reason:'Spam' }, db);
  await assert.rejects(removeMember(m.bob, post, 'Spam', db), /permission/);
  assert.deepEqual(await removeMember(m.editor, second, 'Spam wave', db), { posts:3, threads:1 });
  const hidden = async (ids: string[]) => (await db.query('SELECT count(*)::int AS count FROM falk_forum_post WHERE id=ANY($1) AND hidden_at IS NOT NULL', [ids])).rows[0].count;
  assert.equal(await hidden([post, second, onOther]), 3);
  assert.equal(await hidden([bystander]), 0, "another member's reply is not hidden");
  assert.equal(await threadDetail(id, 1, null, db), null, 'their thread is hidden');
  assert.ok(await threadDetail(other, 1, null, db), "another member's thread stays");
  assert.ok(!(await listReports(m.editor, db)).some(r => r.id === report), 'open reports are settled');
  await assert.rejects(reply(m.alice, other, { body:'Back again.' }, db), /suspended/);
  const audited = (await db.query("SELECT reason,payload FROM falk_audit_event WHERE action='forum_member_removed' AND target_id=$1", [m.alice])).rows;
  assert.deepEqual(audited, [{ reason:'Spam wave', payload:{ posts:3, threads:1 } }]);
}));

test('one-step removal cannot reach a moderator', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  const theirs = (await reply(m.editor, id, { body:'A note from an editor.' }, db)).post;
  await assert.rejects(removeMember(m.editor, theirs, 'Testing', db), /administrator/);
  assert.equal((await db.query('SELECT status FROM falk_account WHERE id=$1', [m.editor])).rows[0].status, 'active');
}));

test('a report emails the support inbox without naming the reporter, up to a cap, and never fails the report', () => members(async (db, m) => {
  const { thread:id, post } = await createThread(m.alice, thread, db);
  const { report } = await reportPost(m.bob, post, { reason:'Looks like spam' }, db);
  const realFetch = globalThis.fetch, token = process.env.POSTMARK_SERVER_TOKEN;
  const sent: any[] = [];
  let respond = () => Response.json({ ErrorCode:0 });
  globalThis.fetch = (async (_url: any, init: any) => { sent.push(JSON.parse(init.body)); return respond(); }) as typeof fetch;
  process.env.POSTMARK_SERVER_TOKEN = 'test-token';
  try {
    await alertModerators(report, db);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].To, 'support@falkindex.com');
    assert.equal(sent[0].Subject, `Forum report: ${thread.title}`);
    assert.match(sent[0].TextBody, /Looks like spam/);
    const reporter = (await db.query('SELECT username FROM falk_account WHERE id=$1', [m.bob])).rows[0].username;
    assert.ok(!JSON.stringify(sent[0]).includes(reporter));
    assert.equal(sent[0].ReplyTo, undefined);
    respond = () => Response.json({ ErrorCode:10 }, { status:422 });
    await alertModerators(report, db);
    sent.length = 0;
    await db.query(`WITH p AS (INSERT INTO falk_forum_post(thread_id,author_id,body) SELECT $1,$2,'Bulk' FROM generate_series(1,$4::int) RETURNING id)
      INSERT INTO falk_forum_report(post_id,reporter_id,reason) SELECT id,$3,'Bulk' FROM p`, [id, m.alice, m.bob, REPORT_ALERTS_PER_HOUR]);
    await alertModerators(report, db);
    assert.equal(sent.length, 0, 'over the cap, reports wait in the queue');
  } finally {
    globalThis.fetch = realFetch;
    if (token === undefined) delete process.env.POSTMARK_SERVER_TOKEN; else process.env.POSTMARK_SERVER_TOKEN = token;
  }
}));

test('posts by a deleted member stay, shown as a deleted member with no profile link', () => members(async (db, m) => {
  const { thread } = await createThread(m.alice, { category:'test-category', title:'Soon anonymous', body:'Still here' }, db);
  await db.query("UPDATE falk_account SET username=NULL,deleted_at=now() WHERE id=$1", [m.alice]);
  await db.query("UPDATE falk_member_profile SET display_name='' WHERE account_id=$1", [m.alice]);
  const { posts } = (await threadDetail(thread, 1, null, db))!;
  assert.equal(posts[0].body, 'Still here');
  assert.deepEqual([posts[0].author.username, posts[0].author.displayName], [null, 'Deleted member']);
}));
