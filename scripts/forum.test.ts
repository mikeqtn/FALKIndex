import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../server/db.ts';
import { realm } from '../server/accounts.ts';
import { createApp } from '../server/index.ts';
import { FORUM_THREADS_PER_HOUR, rateLimitKey } from '../server/api.ts';
import { createThread, editPost, listAllThreads, listCategories, listQuery, listReports, listThreads, markRead, MAX_REPLY_DEPTH, moderateThread, notifications, POSTS_PAGE,
  recentThreads, recordsUnderDiscussion, recordThreads, reply, reportPost, resolveReport, searchForum, setPostHidden, threadDetail, vote, voteInput } from '../server/forum.ts';

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
  const listing = (await listThreads('test-category', 1, 'active', db))!;
  assert.deepEqual(listing.threads.map(t => [t.id, t.replies]), [[id, 1]]);
  assert.equal((await listCategories(db)).find(c => c.id === 'test-category')?.threads, 1);
  assert.deepEqual((await recordThreads(watch, db)).map(t => t.id), [id]);
  assert.ok((await searchForum('specialist', db)).some(t => t.id === id), 'finds a reply');
  assert.ok((await searchForum('cases', db)).some(t => t.id === id), 'finds a title');
  const detail = (await threadDetail(id, 1, null, db))!;
  assert.deepEqual(detail.posts.map(p => p.body), ['Asking about case suppliers.', 'Mostly specialist case makers.']);
}));

test('a reply notifies the thread author, and a locked thread takes only moderators', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  await reply(m.bob, id, { body:'First reply.' }, db);
  await reply(m.editor, id, { body:'Second reply.' }, db);
  assert.equal((await notifications(m.alice, db)).unread, 2);
  assert.equal((await notifications(m.bob, db)).unread, 0, 'not for a reply to someone else');
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
  assert.deepEqual((await listThreads('test-category', 1, 'active', db))!.threads, []);
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
  await createThread(m.alice, { category:'test-category', title:'About a record', body:'Second', record }, db);
  assert.deepEqual((await recordsUnderDiscussion(1, db))[0], { id:record, threads:1 });
}));

test('posts by a deleted member stay, shown as a deleted member with no profile link', () => members(async (db, m) => {
  const { thread } = await createThread(m.alice, { category:'test-category', title:'Soon anonymous', body:'Still here' }, db);
  await db.query("UPDATE falk_account SET username=NULL,deleted_at=now() WHERE id=$1", [m.alice]);
  await db.query("UPDATE falk_member_profile SET display_name='' WHERE account_id=$1", [m.alice]);
  const { posts } = (await threadDetail(thread, 1, null, db))!;
  assert.equal(posts[0].body, 'Still here');
  assert.deepEqual([posts[0].author.username, posts[0].author.displayName], [null, 'Deleted member']);
}));

test('thread sorts rank by activity, age and replies in their window, and windows drop quiet threads', () => members(async (db, m) => {
  const start = async (title: string, age: string, ...replyAges: string[]) => {
    const id = (await db.query(`INSERT INTO falk_forum_thread(category_id,author_id,title,created_at,last_post_at) VALUES('test-category',$1,$2,now()-$3::interval,now()-$3::interval) RETURNING id`, [m.alice, title, age])).rows[0].id as string;
    await db.query(`INSERT INTO falk_forum_post(thread_id,author_id,body,created_at) VALUES($1,$2,'Opening',now()-$3::interval)`, [id, m.alice, age]);
    for (const ago of replyAges) await db.query(`INSERT INTO falk_forum_post(thread_id,author_id,body,created_at) VALUES($1,$2,'Reply',now()-$3::interval)`, [id, m.bob, ago]);
    return id;
  };
  const old = await start('Old and long', '30 days', '29 days', '29 days', '29 days', '6 days');
  const busy = await start('Busy this week', '10 days', '3 days', '2 days', '90 minutes');
  const hot = await start('Hot today', '2 days', '2 hours', '1 hour');
  const fresh = await start('Brand new', '1 minute');
  const order = async (sort: 'active'|'newest'|'day'|'week'|'all') => {
    const listing = (await listThreads('test-category', 1, sort, db))!;
    return { ids:listing.threads.map(t => t.id), total:listing.total, recent:listing.threads.map(t => t.recentReplies) };
  };
  assert.deepEqual((await order('active')).ids, [fresh, hot, busy, old]);
  assert.deepEqual((await order('newest')).ids, [fresh, hot, busy, old]);
  assert.deepEqual((await order('all')).ids.slice(0, 1), [old], 'most replies ever');
  const day = await order('day');
  assert.deepEqual([day.ids, day.total, day.recent], [[hot, busy], 2, [2, 1]], 'a new thread with no replies is not popular yet');
  const week = await order('week');
  assert.deepEqual([week.ids, week.total, week.recent], [[busy, hot, old], 3, [3, 2, 1]]);
  await db.query('UPDATE falk_forum_thread SET pinned=true WHERE id=$1', [old]);
  assert.equal((await order('active')).ids[0], old, 'a pin leads the default order');
  assert.equal((await order('newest')).ids[0], fresh, 'but not the others');
  assert.ok((await listAllThreads(1, 'newest', db)).threads.some(t => t.id === hot && t.categoryName === 'Test'), 'the all-threads list spans categories');
  assert.equal(listQuery.parse({ sort:'nonsense' }).sort, 'active', 'an unknown sort falls back');
  assert.equal(listQuery.parse({}).sort, 'active');
}));

test('a hidden reply does not count toward a popular window', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  const { post } = await reply(m.bob, id, { body:'Spam' }, db);
  assert.equal((await listThreads('test-category', 1, 'day', db))!.total, 1);
  await setPostHidden(m.editor, post, true, 'Spam link', db);
  assert.equal((await listThreads('test-category', 1, 'day', db))!.total, 0);
}));

test('replies nest under their parent, and a reply to the opening post is a reply to the thread', () => members(async (db, m) => {
  const { thread:id, post:opening } = await createThread(m.alice, thread, db);
  const { post:direct } = await reply(m.bob, id, { body:'Direct' }, db);
  const { post:nested } = await reply(m.alice, id, { body:'Nested', parent:direct }, db);
  const { post:viaOpening } = await reply(m.bob, id, { body:'Via opening', parent:opening }, db);
  const parents = new Map((await threadDetail(id, 1, null, db))!.posts.map(p => [p.id, p.parentId]));
  assert.deepEqual([parents.get(opening), parents.get(direct), parents.get(nested), parents.get(viaOpening)], [null, null, direct, null]);
  assert.equal((await listThreads('test-category', 1, 'active', db))!.threads[0].replies, 3, 'nested replies count');
  assert.equal((await notifications(m.bob, db)).unread, 1, 'the person replied to hears about it');
}));

test('a reply cannot attach to a post in another thread, by the API or the database', () => members(async (db, m) => {
  const { thread:one } = await createThread(m.alice, thread, db);
  const { thread:two, post } = await createThread(m.alice, { ...thread, title:'Another thread' }, db);
  const { post:other } = await reply(m.bob, two, { body:'Elsewhere' }, db);
  await assert.rejects(reply(m.bob, one, { body:'Wrong thread', parent:other }, db), /not in this thread/);
  await assert.rejects(reply(m.bob, one, { body:'Wrong thread', parent:post }, db), /not in this thread/);
  await refused(db, 'INSERT INTO falk_forum_post(thread_id,author_id,body,parent_id) VALUES($1,$2,$3,$4)', [one, m.bob, 'Wrong thread', other], /foreign key/);
}));

test('a hidden post takes replies only from moderators, keeps the replies it has, and a parent cannot be changed', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  const { post:direct } = await reply(m.bob, id, { body:'Direct' }, db);
  const { post:nested } = await reply(m.alice, id, { body:'Nested', parent:direct }, db);
  await setPostHidden(m.editor, direct, true, 'Off topic', db);
  await assert.rejects(reply(m.alice, id, { body:'Hello?', parent:direct }, db), /hid this post/);
  await reply(m.editor, id, { body:'A note', parent:direct }, db);
  const posts = (await threadDetail(id, 1, null, db))!.posts;
  assert.deepEqual([posts.find(p => p.id === direct)?.body, posts.find(p => p.id === nested)?.body], [null, 'Nested']);
  await refused(db, 'UPDATE falk_forum_post SET parent_id=NULL WHERE id=$1', [nested], /cannot be moved/);
}));

test('nesting stops at the cap: deeper replies stay at that level, under the same parent', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  let parent = (await reply(m.bob, id, { body:'Depth 0' }, db)).post;
  for (let depth = 1; depth <= MAX_REPLY_DEPTH; depth++) parent = (await reply(m.bob, id, { body:`Depth ${depth}`, parent }, db)).post;
  const { post:beyond } = await reply(m.bob, id, { body:'Beyond the cap', parent }, db);
  const rows = new Map((await db.query('SELECT id,parent_id,depth FROM falk_forum_post WHERE thread_id=$1', [id])).rows.map(r => [r.id, r]));
  assert.equal(rows.get(parent).depth, MAX_REPLY_DEPTH);
  assert.deepEqual([rows.get(beyond).depth, rows.get(beyond).parent_id], [MAX_REPLY_DEPTH, rows.get(parent).parent_id]);
}));

test('thread pages split by conversation, keeping each one whole', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  const replies: string[] = [];
  for (let i = 0; i < POSTS_PAGE; i++) replies.push((await reply(m.bob, id, { body:`Reply ${i}` }, db)).post);
  const { post:nested } = await reply(m.alice, id, { body:'On the second page', parent:replies.at(-1) }, db);
  const [one, two] = [(await threadDetail(id, 1, null, db))!, (await threadDetail(id, 2, null, db))!];
  assert.equal(one.total, POSTS_PAGE + 1, 'nested replies do not add pages');
  assert.equal(one.posts.length, POSTS_PAGE);
  assert.deepEqual(two.posts.map(p => p.id), [replies.at(-1), nested]);
}));

test('the replies list holds replies to your thread or comment, and nobody else\'s', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  const { post:bobs } = await reply(m.bob, id, { body:'From Bob.' }, db);
  const { post:toBob } = await reply(m.editor, id, { body:'To Bob.', parent:bobs }, db);
  const inbox = async (who: string) => (await notifications(who, db)).notifications.map(n => [n.post, n.kind]);
  assert.deepEqual(await inbox(m.bob), [[toBob, 'comment']]);
  assert.deepEqual((await inbox(m.alice)).map(([, kind]) => kind), ['thread', 'thread'], 'the author hears about every reply');
  await reply(m.bob, id, { body:'Answering.', parent:toBob }, db);
  assert.equal((await inbox(m.editor)).length, 1, 'the person replied to');
  assert.equal((await inbox(m.bob)).length, 1, 'not for your own reply');
  const { post:mine } = await reply(m.alice, id, { body:'The author, in a comment.' }, db);
  await reply(m.bob, id, { body:'To the author.', parent:mine }, db);
  const alice = await inbox(m.alice);
  assert.equal(alice.length, 4, 'once per reply, and not for the author\'s own');
  assert.ok(alice.some(([, kind]) => kind === 'comment'), 'a reply to your comment says so');
}));

test('older notifications stay only on threads you started', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  const { post } = await reply(m.bob, id, { body:'A reply.' }, db);
  await db.query('DELETE FROM falk_forum_notification WHERE post_id=$1', [post]);
  await db.query('INSERT INTO falk_forum_notification(account_id,post_id) VALUES($1,$3),($2,$3)', [m.alice, m.editor, post]);
  const [author, bystander] = [await notifications(m.alice, db), await notifications(m.editor, db)];
  assert.deepEqual([author.unread, author.notifications[0].kind], [1, 'thread']);
  assert.deepEqual([bystander.unread, bystander.notifications], [0, []]);
}));

test('a reply past the depth cap still notifies the person replied to', () => members(async (db, m) => {
  const { thread:id } = await createThread(m.alice, thread, db);
  let parent = (await reply(m.bob, id, { body:'Depth 0' }, db)).post;
  for (let depth = 1; depth <= MAX_REPLY_DEPTH; depth++) parent = (await reply(m.bob, id, { body:`Depth ${depth}`, parent }, db)).post;
  const { post } = await reply(m.editor, id, { body:'Beyond the cap', parent }, db);
  assert.ok((await notifications(m.bob, db)).notifications.some(n => n.post === post && n.kind === 'comment'));
}));

test('members vote once per comment, can change or take it back, and readers see only the total', () => members(async (db, m) => {
  const { thread:id, post:opening } = await createThread(m.alice, thread, db);
  const { post } = await reply(m.bob, id, { body:'Vote on me.' }, db);
  const seen = async (viewer: { id: string, role: 'contributor' } | null) => {
    const p = (await threadDetail(id, 1, viewer, db))!.posts.find(x => x.id === post)!;
    return [p.score, p.myVote];
  };
  const alice = { id:m.alice, role:'contributor' as const };
  await vote(m.alice, post, { value:1 }, db);
  await vote(m.alice, post, { value:1 }, db);
  await vote(m.editor, post, { value:1 }, db);
  assert.deepEqual(await seen(alice), [2, 1]);
  assert.deepEqual(await seen(null), [2, 0], 'a reader has no vote of their own');
  await vote(m.alice, post, { value:-1 }, db);
  assert.deepEqual(await seen(alice), [0, -1], 'changing a vote replaces it');
  await vote(m.alice, post, { value:0 }, db);
  assert.deepEqual(await seen(alice), [1, 0], 'taking it back removes it');
  assert.equal(voteInput.safeParse({ value:5 }).success, false);
  await refused(db, 'INSERT INTO falk_forum_vote(post_id,account_id,value) VALUES($1,$2,5)', [post, m.alice], /check constraint/);
  await assert.rejects(vote(m.bob, post, { value:1 }, db), /your own comment/);
  await assert.rejects(vote(m.bob, opening, { value:1 }, db), /Only comments/);
  await assert.rejects(vote(m.unverified, post, { value:1 }, db), /Verify your email/);
  await assert.rejects(vote(m.suspended, post, { value:1 }, db), /suspended/);
  await moderateThread(m.editor, id, { locked:true, reason:'Settled' }, db);
  await assert.rejects(vote(m.alice, post, { value:1 }, db), /locked/);
  await moderateThread(m.editor, id, { locked:false, reason:'Reopened' }, db);
  await setPostHidden(m.editor, post, true, 'Off topic', db);
  await assert.rejects(vote(m.alice, post, { value:1 }, db), /not found/);
}));
