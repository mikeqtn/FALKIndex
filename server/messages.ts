import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { hasLink } from '../src/lib/post-text.ts';
import { authenticatedAccount, HttpError, realm } from './accounts.ts';
import { transaction } from './db.ts';
import { actor, authorColumns, authorFrom, isEstablished, NEW_MEMBER } from './forum.ts';

// Direct messages between forum members (db/013-forum-messages.sql). Only the two members of a conversation can read
// it. Members are addressed by username, so a conversation needs no id until its first message. Sending needs the
// same verified, active account with a username as posting; a block, either way round, stops new messages.
export const MESSAGES_PAGE = 100;
export const CONVERSATIONS_PAGE = 50;
/** New accounts can start this many conversations an hour, and cannot send links, until they are established (NEW_MEMBER). */
export const NEW_MEMBER_CONVERSATIONS_PER_HOUR = 3;

export const username = z.string().regex(/^[a-z][a-z0-9_]{2,29}$/, 'Enter a username.');
export const messageInput = z.object({ body:z.string().trim().min(1,'Write something first.').max(2000) }).strict();
export const blockInput = z.object({ blocked:z.boolean() }).strict();

type Other = { id: string, status: string, deleted: boolean, username: string, display_name: string, image_url: string };

async function memberNamed(db: PoolClient, name: string) {
  const row = (await db.query(`SELECT a.id,a.status,a.deleted_at IS NOT NULL AS deleted,${authorColumns('a','m')}
    FROM falk_account a LEFT JOIN falk_member_profile m ON m.account_id=a.id WHERE a.realm=$1 AND a.username=$2`, [realm(),name])).rows[0];
  if (!row) throw new HttpError(404,'No member has that username.');
  return row as Other;
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

/** My conversations, newest first, with the last message of each. */
export async function inbox(actorId: string, db: PoolClient) {
  const me = await actor(db,actorId);
  const mine = `(c.member_a=$1 OR c.member_b=$1)`;
  const unreadFor = `l.sender_id<>$1 AND l.created_at > coalesce(CASE WHEN c.member_a=$1 THEN c.read_a ELSE c.read_b END,'-infinity')`;
  const latest = 'JOIN LATERAL (SELECT body,sender_id,created_at FROM falk_forum_message WHERE conversation_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) l ON true';
  const rows = await db.query(`SELECT c.id,${authorColumns('o','m')},l.body,l.sender_id=$1 AS mine,l.created_at,${unreadFor} AS unread,
      EXISTS(SELECT 1 FROM falk_forum_block b WHERE b.blocker_id=$1 AND b.blocked_id=o.id) AS blocked
    FROM falk_forum_conversation c ${latest}
    JOIN falk_account o ON o.id=CASE WHEN c.member_a=$1 THEN c.member_b ELSE c.member_a END LEFT JOIN falk_member_profile m ON m.account_id=o.id
    WHERE ${mine} ORDER BY c.last_message_at DESC,c.id LIMIT ${CONVERSATIONS_PAGE}`, [me.id]);
  const unread = await db.query(`SELECT count(*)::int AS count FROM falk_forum_conversation c ${latest} WHERE ${mine} AND ${unreadFor}`, [me.id]);
  return { unread:unread.rows[0].count as number, conversations:rows.rows.map(r => ({
    id:r.id as string, with:authorFrom(r), blocked:r.blocked as boolean, unread:r.unread as boolean,
    last:{ body:(r.body as string).slice(0,140), mine:r.mine as boolean, createdAt:r.created_at.toISOString() as string },
  })) };
}

/** My conversation with a member, its latest messages oldest first, and whether I can write to them. */
export async function conversationWith(actorId: string, name: string, db: PoolClient) {
  const me = await actor(db,actorId);
  const other = await memberNamed(db,name);
  const blocked = await blocks(db,me.id,other.id);
  const [a,b] = pair(me.id,other.id);
  const messages = await db.query(`SELECT * FROM (SELECT g.id,g.sender_id=$3 AS mine,g.body,g.created_at FROM falk_forum_message g
    JOIN falk_forum_conversation c ON c.id=g.conversation_id WHERE c.member_a=$1 AND c.member_b=$2
    ORDER BY g.created_at DESC,g.id DESC LIMIT ${MESSAGES_PAGE}) recent ORDER BY created_at,id`, [a,b,me.id]);
  return {
    with:authorFrom(other), blocked:blocked.byMe, refusal:refusal(other,me.id,blocked),
    messages:messages.rows.map(m => ({ id:m.id as string, mine:m.mine as boolean, body:m.body as string, createdAt:m.created_at.toISOString() as string })),
  };
}

export async function sendMessage(actorId: string, name: string, input: z.infer<typeof messageInput>, db: PoolClient) {
  const me = await actor(db,actorId);
  const other = await memberNamed(db,name);
  const why = refusal(other,me.id,await blocks(db,me.id,other.id));
  if (why) throw new HttpError(other.id === me.id ? 400 : 403,why);
  const [a,b] = pair(me.id,other.id);
  let conversation = (await db.query('SELECT id FROM falk_forum_conversation WHERE member_a=$1 AND member_b=$2 FOR UPDATE', [a,b])).rows[0]?.id as string | undefined;
  if (!(await isEstablished(db,me))) {
    if (hasLink(input.body)) throw new HttpError(403,`New accounts cannot send links yet. You can once your account is ${NEW_MEMBER.days} days old and has ${NEW_MEMBER.posts} visible posts.`);
    const started = (await db.query(`SELECT count(*)::int AS count FROM falk_forum_conversation c WHERE c.created_at > now() - interval '1 hour'
      AND (SELECT sender_id FROM falk_forum_message WHERE conversation_id=c.id ORDER BY created_at,id LIMIT 1)=$1`, [me.id])).rows[0].count;
    if (!conversation && started >= NEW_MEMBER_CONVERSATIONS_PER_HOUR) throw new HttpError(429,'New accounts can start three conversations an hour. Please try again later.');
  }
  conversation ??= (await db.query(`INSERT INTO falk_forum_conversation(member_a,member_b) VALUES($1,$2)
    ON CONFLICT(member_a,member_b) DO UPDATE SET member_a=EXCLUDED.member_a RETURNING id`, [a,b])).rows[0].id as string;
  const message = (await db.query('INSERT INTO falk_forum_message(conversation_id,sender_id,body) VALUES($1,$2,$3) RETURNING id,created_at', [conversation,me.id,input.body])).rows[0];
  return { message:{ id:message.id as string, mine:true, body:input.body, createdAt:message.created_at.toISOString() as string } };
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
messages.get('/with/:username', async (req,res) => {
  const id = await member(req), name = username.parse(req.params.username);
  res.json(await write(db => conversationWith(id,name,db)));
});
messages.post('/with/:username', async (req,res) => {
  const id = await member(req), name = username.parse(req.params.username), input = messageInput.parse(req.body);
  res.status(201).json(await write(db => sendMessage(id,name,input,db)));
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
