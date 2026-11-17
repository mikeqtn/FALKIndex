import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { hasLink } from '../src/lib/post-text.ts';
import { authenticatedAccount, HttpError, realm } from './accounts.ts';
import { transaction } from './db.ts';
import { actor, authorColumns, authorFrom, FORUM_MAX_IMAGES, isEstablished, NEW_MEMBER } from './forum.ts';
import { removeImage } from './forumImages.ts';

// Direct messages between forum members (db/013-forum-messages.sql, db/014-forum-message-edits.sql). Only the two members of a conversation can read
// it. Members are addressed by username, so a conversation needs no id until its first message. Sending needs the
// same verified, active account with a username as posting; a block, either way round, stops new messages. A sender
// can edit or delete their own messages and attach up to FORUM_MAX_IMAGES of their uploads to one.
export const MESSAGES_PAGE = 100;
export const CONVERSATIONS_PAGE = 50;
/** New accounts can start this many conversations an hour, and cannot send links, until they are established (NEW_MEMBER). */
export const NEW_MEMBER_CONVERSATIONS_PER_HOUR = 3;

export const username = z.string().regex(/^[a-z][a-z0-9_]{2,29}$/, 'Enter a username.');
const text = z.string().trim().max(2000);
const images = z.array(z.uuid()).max(FORUM_MAX_IMAGES,`A message can have up to ${FORUM_MAX_IMAGES} images.`).refine(ids => new Set(ids).size === ids.length, 'Attach an image only once.');
export const messageInput = z.object({ body:text.default(''), images:images.optional() }).strict()
  .refine(m => m.body.length > 0 || !!m.images?.length, 'Write something first.');
export const editInput = z.object({ body:text }).strict();
export const blockInput = z.object({ blocked:z.boolean() }).strict();
export const peopleQuery = z.object({ q:z.string().trim().min(1).max(60) });
export const PEOPLE_SUGGESTIONS = 6;

type Other = { id: string, status: string, deleted: boolean, username: string, display_name: string, image_url: string };

async function memberWhere(db: PoolClient, where: 'a.id' | 'a.username', value: string) {
  return (await db.query(`SELECT a.id,a.status,a.deleted_at IS NOT NULL AS deleted,${authorColumns('a','m')}
    FROM falk_account a LEFT JOIN falk_member_profile m ON m.account_id=a.id WHERE a.realm=$1 AND ${where}=$2`, [realm(),value])).rows[0] as Other | undefined;
}
async function memberNamed(db: PoolClient, name: string) {
  const row = await memberWhere(db,'a.username',name);
  if (!row) throw new HttpError(404,'No member has that username.');
  return row;
}
const pair = (one: string, two: string) => one < two ? [one,two] : [two,one];

/** Who has blocked whom between me and other. */
async function blocks(db: PoolClient, me: string, other: string) {
  const rows = (await db.query('SELECT blocker_id FROM falk_forum_block WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)', [me,other])).rows;
  return { byMe:rows.some(r => r.blocker_id === me), byThem:rows.some(r => r.blocker_id === other) };
}
/** Why I cannot message other right now, or null if I can. */
function refusal(other: Other, me: string, blocked: { byMe: boolean, byThem: boolean }) {
  if (other.id === me) return 'You cannot message yourself.';
  if (blocked.byMe) return `You have blocked @${other.username}. Unblock them to send a message.`;
  // A member who blocked you looks like any member who is not taking messages, so a block is not announced.
  if (blocked.byThem || other.status !== 'active' || other.deleted) return 'This member is not taking messages.';
  return null;
}

// A message as its two members see it. A deleted one keeps its place, but not its text or images.
const messageColumns = `g.id,g.sender_id,g.body,g.created_at,g.edited_at,g.deleted_at,
  (SELECT coalesce(json_agg(json_build_object('id',i.id,'width',i.width,'height',i.height) ORDER BY i.position),'[]')
    FROM falk_forum_image i WHERE i.message_id=g.id AND i.hidden_at IS NULL AND i.purged_at IS NULL) AS images`;
type MessageImage = { id: string, width: number, height: number };
const messageFrom = (row: any, me: string) => ({
  id:row.id as string, mine:row.sender_id === me, deleted:!!row.deleted_at, body:(row.deleted_at ? null : row.body) as string | null,
  images:(row.deleted_at ? [] : row.images) as MessageImage[],
  createdAt:row.created_at.toISOString() as string, editedAt:(row.edited_at?.toISOString() ?? null) as string | null,
});
const messageById = async (db: PoolClient, id: string, me: string) =>
  messageFrom((await db.query(`SELECT ${messageColumns} FROM falk_forum_message g WHERE g.id=$1`, [id])).rows[0], me);
/** No links from new accounts, in a message or an edit. */
async function screenMessage(db: PoolClient, me: Parameters<typeof isEstablished>[1], body: string) {
  if (hasLink(body) && !(await isEstablished(db,me))) throw new HttpError(403,`New accounts cannot send links yet. You can once your account is ${NEW_MEMBER.days} days old and has ${NEW_MEMBER.posts} visible posts.`);
}

/** My conversations, newest first, with the last message of each. */
export async function inbox(actorId: string, db: PoolClient) {
  const me = await actor(db,actorId);
  const mine = `(c.member_a=$1 OR c.member_b=$1)`;
  // A message deleted before it was read no longer waits to be read.
  const unreadFor = `l.sender_id<>$1 AND l.deleted_at IS NULL AND l.created_at > coalesce(CASE WHEN c.member_a=$1 THEN c.read_a ELSE c.read_b END,'-infinity')`;
  const latest = `JOIN LATERAL (SELECT body,sender_id,created_at,deleted_at,(SELECT count(*)::int FROM falk_forum_image i WHERE i.message_id=g.id AND i.purged_at IS NULL) AS images
    FROM falk_forum_message g WHERE conversation_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) l ON true`;
  const rows = await db.query(`SELECT c.id,${authorColumns('o','m')},l.body,l.sender_id=$1 AS mine,l.created_at,l.deleted_at,l.images,${unreadFor} AS unread,
      EXISTS(SELECT 1 FROM falk_forum_block b WHERE b.blocker_id=$1 AND b.blocked_id=o.id) AS blocked
    FROM falk_forum_conversation c ${latest}
    JOIN falk_account o ON o.id=CASE WHEN c.member_a=$1 THEN c.member_b ELSE c.member_a END LEFT JOIN falk_member_profile m ON m.account_id=o.id
    WHERE ${mine} ORDER BY c.last_message_at DESC,c.id LIMIT ${CONVERSATIONS_PAGE}`, [me.id]);
  const unread = await db.query(`SELECT count(*)::int AS count FROM falk_forum_conversation c ${latest} WHERE ${mine} AND ${unreadFor}`, [me.id]);
  return { unread:unread.rows[0].count as number, conversations:rows.rows.map(r => ({
    id:r.id as string, with:authorFrom(r), blocked:r.blocked as boolean, unread:r.unread as boolean,
    last:{ body:r.deleted_at ? '' : (r.body as string).slice(0,140), deleted:!!r.deleted_at, images:(r.deleted_at ? 0 : r.images) as number,
      mine:r.mine as boolean, createdAt:r.created_at.toISOString() as string },
  })) };
}

/**
 * Members to message as someone types: a username starting with the text, or a display name with a word starting with
 * it. People I already have a conversation with come first, most recent first, so typing a name I have messaged finds
 * that conversation. Only members who could be messaged are offered, and never me.
 */
export async function suggestPeople(actorId: string, q: string, db: PoolClient) {
  const me = await actor(db,actorId);
  const text = q.replace(/^@/, '').trim().toLowerCase();
  if (!text) return [];
  // LIKE treats % _ and \ as patterns (and usernames have underscores); escape them so they match as typed.
  const like = text.replace(/[\\%_]/g, c => `\\${c}`);
  const rows = await db.query(`SELECT ${authorColumns('a','m')},c.last_message_at IS NOT NULL AS talked
    FROM falk_account a LEFT JOIN falk_member_profile m ON m.account_id=a.id
    LEFT JOIN falk_forum_conversation c ON (c.member_a=$1 AND c.member_b=a.id) OR (c.member_b=$1 AND c.member_a=a.id)
    WHERE a.realm=$2 AND a.id<>$1 AND a.username IS NOT NULL AND a.status='active' AND a.deleted_at IS NULL
      AND (a.username LIKE $3||'%' OR lower(m.display_name) LIKE $3||'%' OR lower(m.display_name) LIKE '% '||$3||'%')
      AND NOT EXISTS(SELECT 1 FROM falk_forum_block b WHERE b.blocker_id=a.id AND b.blocked_id=$1)
    ORDER BY c.last_message_at DESC NULLS LAST,a.username=$4 DESC,a.username
    LIMIT ${PEOPLE_SUGGESTIONS}`, [me.id,realm(),like,text]);
  return rows.rows.map(r => ({ ...authorFrom(r), username:r.username as string, talked:r.talked as boolean }));
}

/** My conversation with a member, its latest messages oldest first, and whether I can write to them. */
export async function conversationWith(actorId: string, name: string, db: PoolClient) {
  const me = await actor(db,actorId);
  const other = await memberNamed(db,name);
  const blocked = await blocks(db,me.id,other.id);
  const [a,b] = pair(me.id,other.id);
  const messages = await db.query(`SELECT * FROM (SELECT ${messageColumns} FROM falk_forum_message g
    JOIN falk_forum_conversation c ON c.id=g.conversation_id WHERE c.member_a=$1 AND c.member_b=$2
    ORDER BY g.created_at DESC,g.id DESC LIMIT ${MESSAGES_PAGE}) recent ORDER BY created_at,id`, [a,b]);
  return {
    with:authorFrom(other), blocked:blocked.byMe, refusal:refusal(other,me.id,blocked),
    messages:messages.rows.map(m => messageFrom(m,me.id)),
  };
}

export async function sendMessage(actorId: string, name: string, input: z.infer<typeof messageInput>, db: PoolClient) {
  const me = await actor(db,actorId);
  const other = await memberNamed(db,name);
  const why = refusal(other,me.id,await blocks(db,me.id,other.id));
  if (why) throw new HttpError(other.id === me.id ? 400 : 403,why);
  const [a,b] = pair(me.id,other.id);
  let conversation = (await db.query('SELECT id FROM falk_forum_conversation WHERE member_a=$1 AND member_b=$2 FOR UPDATE', [a,b])).rows[0]?.id as string | undefined;
  await screenMessage(db,me,input.body);
  if (!(await isEstablished(db,me))) {
    const started = (await db.query(`SELECT count(*)::int AS count FROM falk_forum_conversation c WHERE c.created_at > now() - interval '1 hour'
      AND (SELECT sender_id FROM falk_forum_message WHERE conversation_id=c.id ORDER BY created_at,id LIMIT 1)=$1`, [me.id])).rows[0].count;
    if (!conversation && started >= NEW_MEMBER_CONVERSATIONS_PER_HOUR) throw new HttpError(429,'New accounts can start three conversations an hour. Please try again later.');
  }
  // Only my own uploads that are on nothing yet, checked (and locked) before anything is written.
  const free = 'i.uploader_id=$2 AND i.post_id IS NULL AND i.message_id IS NULL AND i.hidden_at IS NULL AND i.purged_at IS NULL';
  if (input.images?.length) {
    const usable = await db.query(`SELECT i.id FROM falk_forum_image i WHERE i.id=ANY($1::uuid[]) AND ${free} FOR UPDATE`, [input.images,me.id]);
    if (usable.rowCount !== input.images.length) throw new HttpError(400,'One of those images is no longer available. Remove it and try again.');
  }
  conversation ??= (await db.query(`INSERT INTO falk_forum_conversation(member_a,member_b) VALUES($1,$2)
    ON CONFLICT(member_a,member_b) DO UPDATE SET member_a=EXCLUDED.member_a RETURNING id`, [a,b])).rows[0].id as string;
  const message = (await db.query('INSERT INTO falk_forum_message(conversation_id,sender_id,body) VALUES($1,$2,$3) RETURNING id', [conversation,me.id,input.body])).rows[0].id as string;
  if (input.images?.length) await db.query(`UPDATE falk_forum_image i SET message_id=$3,position=o.position
    FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id,position) WHERE i.id=o.id AND ${free}`, [input.images,me.id,message]);
  return { message:await messageById(db,message,me.id) };
}

/** My own message, locked, with the member it was sent to. */
async function ownMessage(db: PoolClient, me: string, id: string) {
  const row = (await db.query(`SELECT g.sender_id,g.deleted_at,CASE WHEN c.member_a=$2 THEN c.member_b ELSE c.member_a END AS other,
      (SELECT count(*)::int FROM falk_forum_image i WHERE i.message_id=g.id AND i.purged_at IS NULL) AS images
    FROM falk_forum_message g JOIN falk_forum_conversation c ON c.id=g.conversation_id
    WHERE g.id=$1 AND (c.member_a=$2 OR c.member_b=$2) FOR UPDATE OF g`, [id,me])).rows[0];
  if (!row) throw new HttpError(404,'Message not found.');
  if (row.sender_id !== me) throw new HttpError(403,'You can only change your own messages.');
  if (row.deleted_at) throw new HttpError(409,'This message was deleted.');
  return row as { other: string, images: number };
}

/** Changes the text of my message; the earlier text is kept (falk_forum_message_edit). Not while either of us has blocked the other. */
export async function editMessage(actorId: string, id: string, input: z.infer<typeof editInput>, db: PoolClient) {
  const me = await actor(db,actorId);
  const message = await ownMessage(db,me.id,id);
  const other = await memberWhere(db,'a.id',message.other);
  const why = other && refusal(other,me.id,await blocks(db,me.id,other.id));
  if (why) throw new HttpError(403,why);
  if (!input.body && !message.images) throw new HttpError(400,'Write something first, or delete the message.');
  await screenMessage(db,me,input.body);
  await db.query('UPDATE falk_forum_message SET body=$2 WHERE id=$1 AND body IS DISTINCT FROM $2', [id,input.body]);
  return { message:await messageById(db,id,me.id) };
}

/** Deletes my message for both of us. Its text stays in the database, as a deleted post's does, but its images are
 * removed for good: the caller deletes their bytes once this has committed. */
export async function deleteMessage(actorId: string, id: string, db: PoolClient) {
  const me = await actor(db,actorId);
  await ownMessage(db,me.id,id);
  await db.query('UPDATE falk_forum_message SET deleted_at=clock_timestamp() WHERE id=$1', [id]);
  const removed = await db.query('UPDATE falk_forum_image SET purged_at=now(),purged_by=$2 WHERE message_id=$1 AND purged_at IS NULL RETURNING id', [id,me.id]);
  return { deleted:true, removedImages:removed.rows.map(r => r.id as string) };
}

/** Marks my conversation with a member read up to now. Clock time, as messages use, so a message written earlier in the same transaction counts as read. */
export async function markConversationRead(actorId: string, name: string, db: PoolClient) {
  const me = await actor(db,actorId);
  const other = await memberNamed(db,name);
  const [a,b] = pair(me.id,other.id);
  const column = a === me.id ? 'read_a' : 'read_b';
  const rows = await db.query(`UPDATE falk_forum_conversation SET ${column}=greatest(clock_timestamp(),last_message_at) WHERE member_a=$1 AND member_b=$2`, [a,b]);
  return { read:(rows.rowCount ?? 0) > 0 };
}

/** Blocks or unblocks a member. Blocking stops messages both ways; the conversation so far stays readable. */
export async function setBlocked(actorId: string, name: string, blocked: boolean, db: PoolClient) {
  const me = await actor(db,actorId);
  const other = await memberNamed(db,name);
  if (other.id === me.id) throw new HttpError(400,'You cannot block yourself.');
  if (blocked) await db.query('INSERT INTO falk_forum_block(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [me.id,other.id]);
  else await db.query('DELETE FROM falk_forum_block WHERE blocker_id=$1 AND blocked_id=$2', [me.id,other.id]);
  return { blocked };
}

const member = async (req: Parameters<typeof authenticatedAccount>[0]) => (await authenticatedAccount(req)).account.id;
const write = <T>(fn: (db: PoolClient) => Promise<T>) => transaction(fn);

// Mounted at /api/forum/messages. Reads re-check the member with a row lock, so every route uses a write transaction.
const messages = Router();
messages.get('/', async (req,res) => {
  const id = await member(req);
  res.json(await write(db => inbox(id,db)));
});
messages.get('/people', async (req,res) => {
  const id = await member(req), { q } = peopleQuery.parse(req.query);
  res.json({ people:await write(db => suggestPeople(id,q,db)) });
});
messages.get('/with/:username', async (req,res) => {
  const id = await member(req), name = username.parse(req.params.username);
  res.json(await write(db => conversationWith(id,name,db)));
});
messages.post('/with/:username', async (req,res) => {
  const id = await member(req), name = username.parse(req.params.username), input = messageInput.parse(req.body);
  res.status(201).json(await write(db => sendMessage(id,name,input,db)));
});
messages.patch('/:id', async (req,res) => {
  const id = await member(req), message = z.uuid().parse(req.params.id), input = editInput.parse(req.body);
  res.json(await write(db => editMessage(id,message,input,db)));
});
messages.delete('/:id', async (req,res) => {
  const id = await member(req), message = z.uuid().parse(req.params.id);
  const { removedImages, ...result } = await write(db => deleteMessage(id,message,db));
  // The delete has committed, so a failed removal only leaves bytes that nothing serves any more.
  await Promise.allSettled(removedImages.map(removeImage));
  res.json(result);
});
messages.post('/with/:username/read', async (req,res) => {
  const id = await member(req), name = username.parse(req.params.username);
  res.json(await write(db => markConversationRead(id,name,db)));
});
messages.post('/with/:username/block', async (req,res) => {
  const id = await member(req), name = username.parse(req.params.username), { blocked } = blockInput.parse(req.body);
  res.json(await write(db => setBlocked(id,name,blocked,db)));
});
export default messages;
