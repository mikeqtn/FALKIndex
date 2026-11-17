import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../server/db.ts';
import { realm } from '../server/accounts.ts';
import { imageForServing, reply } from '../server/forum.ts';
import { MESSAGES_PAGE, conversationWith, deleteMessage, editMessage, inbox, markConversationRead, messageInput, NEW_MEMBER_CONVERSATIONS_PER_HOUR, sendMessage, setBlocked, suggestPeople } from '../server/messages.ts';

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

test('a message stays in the database: edits keep the earlier text, and a deleted one cannot change again', () => members(async (db, m) => {
  const { message } = await sendMessage(m.alice.id, m.bob.name, { body:'Kept for good' }, db);
  await refused(db, 'DELETE FROM falk_forum_message WHERE id=$1', [message.id], /never deleted/);
  await refused(db, 'UPDATE falk_forum_message SET sender_id=$2 WHERE id=$1', [message.id, m.bob.id], /moved or reassigned/);
  await refused(db, 'UPDATE falk_forum_message SET edited_at=now() WHERE id=$1', [message.id], /follows its text/);
  await db.query("UPDATE falk_forum_message SET body='Changed' WHERE id=$1", [message.id]);
  const edits = (await db.query('SELECT id,body FROM falk_forum_message_edit WHERE message_id=$1', [message.id])).rows;
  assert.deepEqual(edits.map(e => e.body), ['Kept for good']);
  await refused(db, "UPDATE falk_forum_message_edit SET body='tampered' WHERE id=$1", [edits[0].id], /append-only/);
  await db.query('UPDATE falk_forum_message SET deleted_at=now() WHERE id=$1', [message.id]);
  await refused(db, "UPDATE falk_forum_message SET body='Again' WHERE id=$1", [message.id], /deleted and cannot be changed/);
  await refused(db, 'UPDATE falk_forum_message SET deleted_at=NULL WHERE id=$1', [message.id], /deleted and cannot be changed/);
  const conversation = (await db.query('SELECT conversation_id FROM falk_forum_message WHERE id=$1', [message.id])).rows[0].conversation_id;
  await refused(db, 'UPDATE falk_forum_conversation SET member_b=$2 WHERE id=$1', [conversation, m.carol.id], /cannot be rewritten|check constraint/);
  await refused(db, 'DELETE FROM falk_forum_conversation WHERE id=$1', [conversation], /never deleted/);
}));

test('a sender edits their own messages, and both members see the change', () => members(async (db, m) => {
  const { message } = await sendMessage(m.alice.id, m.bob.name, { body:'Helo Bob' }, db);
  const answer = await sendMessage(m.bob.id, m.alice.name, { body:'Hi' }, db);
  const edited = (await editMessage(m.alice.id, message.id, { body:'Hello Bob' }, db)).message;
  assert.equal(edited.body, 'Hello Bob');
  assert.ok(edited.editedAt);
  const seen = (await conversationWith(m.bob.id, m.alice.name, db)).messages.find(x => x.id === message.id)!;
  assert.deepEqual([seen.body, !!seen.editedAt, seen.mine], ['Hello Bob', true, false]);
  await assert.rejects(editMessage(m.alice.id, answer.message.id, { body:'Not mine' }, db), /only change your own/);
  await assert.rejects(editMessage(m.carol.id, message.id, { body:'Not mine' }, db), /not found/, 'others cannot even find it');
  await assert.rejects(editMessage(m.alice.id, message.id, { body:'' }, db), /Write something first/);
  await setBlocked(m.bob.id, m.alice.name, true, db);
  await assert.rejects(editMessage(m.alice.id, message.id, { body:'Sneaky' }, db), /not taking messages/, 'no edits across a block');
}));

test('a deleted message shows as deleted to both members and no longer waits to be read', () => members(async (db, m) => {
  const { message } = await sendMessage(m.alice.id, m.bob.name, { body:'Oops, wrong person' }, db);
  assert.equal((await inbox(m.bob.id, db)).unread, 1);
  await assert.rejects(deleteMessage(m.bob.id, message.id, db), /only change your own/);
  await deleteMessage(m.alice.id, message.id, db);
  for (const [me, other] of [[m.alice, m.bob], [m.bob, m.alice]]) {
    const [shown] = (await conversationWith(me.id, other.name, db)).messages;
    assert.deepEqual([shown.deleted, shown.body, shown.images], [true, null, []]);
  }
  const bob = await inbox(m.bob.id, db);
  assert.equal(bob.unread, 0);
  assert.equal(bob.conversations[0].last.deleted, true);
  assert.equal(bob.conversations[0].last.body, '', 'the deleted text is not shown in the preview');
  await assert.rejects(deleteMessage(m.alice.id, message.id, db), /was deleted/);
  await assert.rejects(editMessage(m.alice.id, message.id, { body:'Back' }, db), /was deleted/);
}));

test('images in a message are seen only by its two members, and go for good when it is deleted', () => members(async (db, m) => {
  const upload = async (who: string) => (await db.query('INSERT INTO falk_forum_image(uploader_id,width,height,bytes) VALUES($1,800,600,1000) RETURNING id', [who])).rows[0].id as string;
  const image = await upload(m.alice.id), bobs = await upload(m.bob.id);
  assert.throws(() => messageInput.parse({ body:'  ' }), /Write something first/);
  assert.deepEqual(messageInput.parse({ images:[image] }), { body:'', images:[image] }, 'an image alone is a message');
  await assert.rejects(sendMessage(m.alice.id, m.bob.name, { body:'', images:[bobs] }, db), /no longer available/, 'not an upload by someone else');
  const { message } = await sendMessage(m.alice.id, m.bob.name, { body:'', images:[image] }, db);
  assert.deepEqual(message.images, [{ id:image, width:800, height:600 }]);
  assert.deepEqual((await conversationWith(m.bob.id, m.alice.name, db)).messages[0].images.map(i => i.id), [image]);
  assert.equal((await inbox(m.bob.id, db)).conversations[0].last.images, 1);
  const as = (who: { id: string } | null, role: 'contributor' | 'editor' = 'contributor') => () => Promise.resolve(who && { id:who.id, role });
  assert.deepEqual(await imageForServing(image, as(m.bob), db), { allowed:true, cache:'private' }, 'kept only in their own browser');
  assert.deepEqual(await imageForServing(image, as(m.alice), db), { allowed:true, cache:'private' });
  assert.equal((await imageForServing(image, as(m.carol), db)).allowed, false);
  assert.equal((await imageForServing(image, as(m.editor, 'editor'), db)).allowed, false, 'moderators do not read messages');
  assert.equal((await imageForServing(image, as(null), db)).allowed, false);
  // An image in a message cannot be moved onto a public post.
  const thread = (await db.query('SELECT id FROM falk_forum_thread WHERE author_id=$1', [m.alice.id])).rows[0].id;
  await db.query('SAVEPOINT post');
  await assert.rejects(reply(m.alice.id, thread, { body:'Look at this', images:[image] }, db), /no longer available/);
  await db.query('ROLLBACK TO SAVEPOINT post');
  const { removedImages } = await deleteMessage(m.alice.id, message.id, db);
  assert.deepEqual(removedImages, [image]);
  assert.equal((await imageForServing(image, as(m.bob), db)).allowed, false);
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

test('the Message box suggests members by username or name, people already messaged first', () => members(async (db, m) => {
  // Members made for the test share a username prefix, so give two of them names to find.
  await db.query("INSERT INTO falk_member_profile(account_id,display_name) VALUES($1,'Bob Marsh'),($2,'Carol Marsden')", [m.bob.id, m.carol.id]);
  const names = async (q: string, who = m.alice.id) => (await suggestPeople(who, q, db)).map(p => p.username);
  assert.deepEqual(await names('mars'), [m.bob.name, m.carol.name].sort(), 'a word of the name, in username order');
  await sendMessage(m.alice.id, m.carol.name, { body:'Hello Carol' }, db);
  assert.deepEqual(await names('mars'), [m.carol.name, m.bob.name], 'someone already messaged comes first');
  assert.equal((await suggestPeople(m.alice.id, 'mars', db))[0].talked, true);
  assert.deepEqual(await names('Marsden'), [m.carol.name], 'any case');
  assert.deepEqual(await names(`@${m.bob.name}`), [m.bob.name], 'by username, with or without @');
  assert.deepEqual(await names(m.alice.name), [], 'never yourself');
  assert.deepEqual(await names(m.suspended.name), [], 'only members who can be messaged');
  assert.deepEqual(await names('%'), [], 'LIKE patterns match as typed');
  await setBlocked(m.bob.id, m.alice.name, true, db);
  assert.deepEqual(await names('mars'), [m.carol.name], 'not someone who blocked you');
}));

test('a new message brings its conversation to the top of the list, however old the conversation is', () => members(async (db, m) => {
  const order = async () => (await inbox(m.alice.id, db)).conversations.map(c => c.with.username);
  await sendMessage(m.alice.id, m.bob.name, { body:'My first conversation' }, db);
  await sendMessage(m.alice.id, m.carol.name, { body:'A later one' }, db);
  assert.deepEqual(await order(), [m.carol.name, m.bob.name]);
  await sendMessage(m.bob.id, m.alice.name, { body:'Bob writes back' }, db);
  assert.deepEqual(await order(), [m.bob.name, m.carol.name], 'a reply in the oldest conversation moves it up');
  // The order comes from the messages, not from the column the bump trigger keeps, so it holds even without the trigger.
  await db.query('ALTER TABLE falk_forum_message DISABLE TRIGGER falk_forum_message_bump');
  await sendMessage(m.carol.id, m.alice.name, { body:'Carol writes back' }, db);
  assert.deepEqual(await order(), [m.carol.name, m.bob.name]);
  assert.deepEqual((await suggestPeople(m.alice.id, 't_', db)).slice(0, 2).map(p => p.username), [m.carol.name, m.bob.name], 'suggestions follow the same order');
}));

test('a conversation opens on its newest messages, and older ones load a page at a time', () => members(async (db, m) => {
  for (let i = 1; i <= MESSAGES_PAGE + 5; i++) await sendMessage(i % 2 ? m.alice.id : m.bob.id, i % 2 ? m.bob.name : m.alice.name, { body:`Message ${i}` }, db);
  const newest = await conversationWith(m.alice.id, m.bob.name, db);
  assert.equal(newest.messages.length, MESSAGES_PAGE);
  assert.equal(newest.more, true);
  assert.deepEqual([newest.messages[0].body, newest.messages.at(-1)!.body], ['Message 6', `Message ${MESSAGES_PAGE + 5}`], 'oldest first within the page');
  const older = await conversationWith(m.alice.id, m.bob.name, db, newest.messages[0].id);
  assert.deepEqual(older.messages.map(x => x.body), ['Message 1', 'Message 2', 'Message 3', 'Message 4', 'Message 5']);
  assert.equal(older.more, false);
  // A cursor from someone else's conversation finds nothing here.
  const { message } = await sendMessage(m.carol.id, m.bob.name, { body:'Elsewhere' }, db);
  assert.deepEqual((await conversationWith(m.alice.id, m.bob.name, db, message.id)).messages, []);
}));
