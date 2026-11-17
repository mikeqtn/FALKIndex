import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../server/db.ts';
import { realm } from '../server/accounts.ts';
import { conversationWith, inbox, markConversationRead, NEW_MEMBER_CONVERSATIONS_PER_HOUR, sendMessage, setBlocked } from '../server/messages.ts';

after(() => pool.end());

type Members = Record<'alice'|'bob'|'carol'|'editor'|'nameless'|'suspended', { id: string, name: string }>;
// Members in this auth realm, in a transaction that is rolled back. Alice, Bob and the editor are established
// (old enough, with posts) unless a test says otherwise.
async function members(run: (db: PoolClient, m: Members) => Promise<void>, { established = true } = {}) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("INSERT INTO falk_forum_category(id,name,description,position) VALUES('test-category','Test','For tests',99)");
    const add = async (role: string, name: string | null = `t_${randomUUID().slice(0, 8)}`, status = 'active') => {
      const id = (await db.query(`INSERT INTO falk_account(realm,clerk_id,username,role,email_verified,status,created_at)
        VALUES($1,$2,$3,$4,true,$5,now() - make_interval(days => $6)) RETURNING id`, [realm(), `test-${randomUUID()}`, name, role, status, established ? 30 : 0])).rows[0].id as string;
      if (established) {
        const thread = (await db.query("INSERT INTO falk_forum_thread(category_id,author_id,title) VALUES('test-category',$1,'History') RETURNING id", [id])).rows[0].id;
        for (let i = 0; i < 3; i++) await db.query('INSERT INTO falk_forum_post(thread_id,author_id,body) VALUES($1,$2,$3)', [thread, id, `Post ${i}`]);
      }
      return { id, name:name ?? '' };
    };
    await run(db, { alice:await add('contributor'), bob:await add('contributor'), carol:await add('contributor'), editor:await add('editor'),
      nameless:await add('contributor', null), suspended:await add('contributor', undefined, 'suspended') });
  } finally { await db.query('ROLLBACK'); db.release(); }
}
async function refused(db: PoolClient, sql: string, params: unknown[], error: RegExp) {
  await db.query('SAVEPOINT refused');
  await assert.rejects(db.query(sql, params), error, sql);
  await db.query('ROLLBACK TO SAVEPOINT refused');
}

test('two members message each other in one conversation, and only they can read it', () => members(async (db, m) => {
  assert.deepEqual((await conversationWith(m.alice.id, m.bob.name, db)).messages, [], 'no conversation until the first message');
  await sendMessage(m.alice.id, m.bob.name, { body:'Hello Bob' }, db);
  await sendMessage(m.bob.id, m.alice.name, { body:'Hello Alice' }, db);
  await sendMessage(m.alice.id, m.bob.name, { body:'How are you?' }, db);
  const fromAlice = await conversationWith(m.alice.id, m.bob.name, db);
  assert.deepEqual(fromAlice.messages.map(x => [x.body, x.mine]), [['Hello Bob', true], ['Hello Alice', false], ['How are you?', true]]);
  assert.equal(fromAlice.refusal, null);
  assert.deepEqual((await conversationWith(m.bob.id, m.alice.name, db)).messages.map(x => x.mine), [false, true, false]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM falk_forum_conversation WHERE member_a=ANY($1) AND member_b=ANY($1)', [[m.alice.id, m.bob.id]])).rows[0].n, 1);
  assert.deepEqual((await conversationWith(m.carol.id, m.alice.name, db)).messages, [], 'a third member sees nothing');
  assert.deepEqual((await inbox(m.carol.id, db)).conversations, []);
}));

test('the inbox counts conversations with unread messages until they are read', () => members(async (db, m) => {
  await sendMessage(m.alice.id, m.bob.name, { body:'One' }, db);
  await sendMessage(m.alice.id, m.bob.name, { body:'Two' }, db);
  await sendMessage(m.carol.id, m.bob.name, { body:'From Carol' }, db);
  const bob = await inbox(m.bob.id, db);
  assert.equal(bob.unread, 2);
  assert.deepEqual(bob.conversations.map(c => [c.with.username, c.last.body, c.unread]), [[m.carol.name, 'From Carol', true], [m.alice.name, 'Two', true]]);
  assert.equal((await inbox(m.alice.id, db)).unread, 0, 'your own messages are read');
  await markConversationRead(m.bob.id, m.alice.name, db);
  assert.equal((await inbox(m.bob.id, db)).unread, 1);
  await sendMessage(m.bob.id, m.carol.name, { body:'Replying' }, db);
  assert.equal((await inbox(m.bob.id, db)).unread, 0, 'replying reads the conversation');
  assert.equal((await inbox(m.carol.id, db)).unread, 1);
}));

test('sending needs a member who can post, writing to an active member who is not yourself', () => members(async (db, m) => {
  await assert.rejects(sendMessage(m.nameless.id, m.bob.name, { body:'Hi' }, db), /Choose a username/);
  await assert.rejects(sendMessage(m.suspended.id, m.bob.name, { body:'Hi' }, db), /suspended/);
  await assert.rejects(sendMessage(m.alice.id, m.suspended.name, { body:'Hi' }, db), /not taking messages/);
  await assert.rejects(sendMessage(m.alice.id, m.alice.name, { body:'Hi' }, db), /yourself/);
  await assert.rejects(sendMessage(m.alice.id, 'no_such_member', { body:'Hi' }, db), /No member has that username/);
}));

test('a block stops messages both ways, without telling the blocked member', () => members(async (db, m) => {
  await sendMessage(m.alice.id, m.bob.name, { body:'Before the block' }, db);
  await setBlocked(m.bob.id, m.alice.name, true, db);
  await assert.rejects(sendMessage(m.alice.id, m.bob.name, { body:'Again' }, db), /not taking messages/);
  await assert.rejects(sendMessage(m.bob.id, m.alice.name, { body:'Hi' }, db), /You have blocked/);
  assert.equal((await conversationWith(m.alice.id, m.bob.name, db)).refusal, 'This member is not taking messages.');
  assert.equal((await conversationWith(m.bob.id, m.alice.name, db)).blocked, true);
  assert.equal((await conversationWith(m.bob.id, m.alice.name, db)).messages.length, 1, 'what was said stays readable');
  await setBlocked(m.bob.id, m.alice.name, false, db);
  await sendMessage(m.alice.id, m.bob.name, { body:'After the block' }, db);
}));

test('messages are never edited or deleted, and a conversation keeps its members', () => members(async (db, m) => {
  const { message } = await sendMessage(m.alice.id, m.bob.name, { body:'Kept for good' }, db);
  await refused(db, "UPDATE falk_forum_message SET body='Changed' WHERE id=$1", [message.id], /append-only/);
  await refused(db, 'DELETE FROM falk_forum_message WHERE id=$1', [message.id], /append-only/);
  const conversation = (await db.query('SELECT conversation_id FROM falk_forum_message WHERE id=$1', [message.id])).rows[0].conversation_id;
  await refused(db, 'UPDATE falk_forum_conversation SET member_b=$2 WHERE id=$1', [conversation, m.carol.id], /cannot be rewritten|check constraint/);
  await refused(db, 'DELETE FROM falk_forum_conversation WHERE id=$1', [conversation], /never deleted/);
}));

test('new accounts cannot send links and start only a few conversations an hour', () => members(async (db, m) => {
  await assert.rejects(sendMessage(m.alice.id, m.bob.name, { body:'See https://example.com' }, db), /cannot send links/);
  const others = [m.bob, m.carol, m.editor];
  for (const other of others.slice(0, NEW_MEMBER_CONVERSATIONS_PER_HOUR)) await sendMessage(m.alice.id, other.name, { body:'Hello' }, db);
  await sendMessage(m.alice.id, m.bob.name, { body:'A second message in a conversation I have' }, db);
  const fourth = (await db.query("INSERT INTO falk_account(realm,clerk_id,username,email_verified) VALUES($1,$2,$3,true) RETURNING username", [realm(), `test-${randomUUID()}`, `t_${randomUUID().slice(0, 8)}`])).rows[0].username;
  await assert.rejects(sendMessage(m.alice.id, fourth, { body:'Hello' }, db), /three conversations an hour/);
  await sendMessage(m.editor.id, fourth, { body:'Moderators are exempt, https://example.com' }, db);
}, { established:false }));
