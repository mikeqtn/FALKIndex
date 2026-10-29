import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../server/db.ts';

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
