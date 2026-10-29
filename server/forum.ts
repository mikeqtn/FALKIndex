import { Router, type Request } from 'express';
import { z } from 'zod';
import { getAuth } from '@clerk/express';
import type { Pool, PoolClient } from 'pg';
import { isClerkImage, type Role } from '../src/accounts/contracts.ts';
import { pool, querySeries, transaction } from './db.ts';
import { audit, authenticatedAccount, enforceAccount, HttpError, realm } from './accounts.ts';

// The FALK Forum (forum.falkindex.com). Anyone may read; posting needs a verified, active
// account with a username. Editors and administrators moderate: nothing is deleted, only
// hidden with a reason, and every moderation decision is written to the audit log.
type Queryable = Pick<Pool | PoolClient, 'query'>;
type Viewer = { id: string, role: Role } | null;
const MODERATORS = ['editor','admin'] as const;
const isModerator = (viewer: Viewer) => viewer?.role === 'editor' || viewer?.role === 'admin';
export const THREADS_PAGE = 25;
export const POSTS_PAGE = 50;

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const body = z.string().trim().min(1,'Write something first.').max(20000);
const reason = z.string().trim().min(3,'Give a reason of at least 3 characters.').max(1000);
export const threadInput = z.object({ category:slug, title:z.string().trim().min(3).max(150), body, record:z.string().trim().max(200).optional() }).strict();
export const postInput = z.object({ body }).strict();
export const reasonInput = z.object({ reason }).strict();
export const threadModeration = z.object({ pinned:z.boolean().optional(), locked:z.boolean().optional(), hidden:z.boolean().optional(), reason }).strict()
  .refine(m => m.pinned !== undefined || m.locked !== undefined || m.hidden !== undefined, 'Choose what to change.');
export const reportResolution = z.object({ resolution:z.enum(['hidden','dismissed']), reason }).strict();
export const readInput = z.object({ ids:z.array(z.uuid()).max(100).optional() }).strict();
export const pageQuery = z.object({ page:z.coerce.number().int().min(1).max(10000).default(1) });
export const searchQuery = z.object({ q:z.string().trim().min(2).max(200) });

/** The acting member, read again inside the transaction so a suspension or demotion applies at once. */
async function actor(db: PoolClient, id: string, roles?: readonly Role[]) {
  const row = (await db.query(`SELECT id,username,role,status,email_verified AS "emailVerified" FROM falk_account
    WHERE id=$1 AND realm=$2 FOR SHARE`, [id,realm()])).rows[0];
  if (!row) throw new HttpError(403,'You do not have permission to perform this action.');
  enforceAccount(row,roles);
  if (!row.username) throw new HttpError(403,'Choose a username on your account page before posting.');
  return row as { id: string, username: string, role: Role };
}

const authorColumns = (a: string, m: string) => `${a}.username,${m}.display_name,${m}.image_url`;
const authorFrom = (row: any) => ({ username:row.username, displayName:row.display_name ?? row.username, imageUrl:isClerkImage(row.image_url ?? '') ? row.image_url : '' });
const threadColumns = `t.id,t.category_id,t.title,t.watch_id,t.pinned,t.locked,t.created_at,t.last_post_at,${authorColumns('a','m')},
  greatest((SELECT count(*)::int FROM falk_forum_post p WHERE p.thread_id=t.id AND p.hidden_at IS NULL)-1,0) AS replies`;
const threadJoins = 'FROM falk_forum_thread t JOIN falk_account a ON a.id=t.author_id LEFT JOIN falk_member_profile m ON m.account_id=a.id';
function threadFrom(row: any) {
  return { id:row.id, category:row.category_id, title:row.title, record:row.watch_id, pinned:row.pinned, locked:row.locked,
    createdAt:row.created_at.toISOString(), lastPostAt:row.last_post_at.toISOString(), replies:row.replies, author:authorFrom(row) };
}

export async function listCategories(db: Queryable = pool) {
  const rows = await db.query(`SELECT c.id,c.name,c.description,count(t.id)::int AS threads,max(t.last_post_at) AS last_post_at
    FROM falk_forum_category c LEFT JOIN falk_forum_thread t ON t.category_id=c.id AND t.hidden_at IS NULL
    GROUP BY c.id ORDER BY c.position,c.id`);
  return rows.rows.map(r => ({ id:r.id, name:r.name, description:r.description, threads:r.threads, lastPostAt:r.last_post_at?.toISOString() ?? null }));
}

export async function listThreads(categoryId: string, page: number, db: Queryable = pool) {
  const category = (await db.query('SELECT id,name,description FROM falk_forum_category WHERE id=$1', [categoryId])).rows[0];
  if (!category) return null;
  const [rows, total] = await querySeries(db,[
    `SELECT ${threadColumns} ${threadJoins} WHERE t.category_id=$1 AND t.hidden_at IS NULL
      ORDER BY t.pinned DESC,t.last_post_at DESC,t.id LIMIT ${THREADS_PAGE} OFFSET ${(page-1)*THREADS_PAGE}`,
    'SELECT count(*)::int AS count FROM falk_forum_thread WHERE category_id=$1 AND hidden_at IS NULL',
  ],[categoryId]);
  return { category, threads:rows.rows.map(threadFrom), total:total.rows[0].count, page, pageSize:THREADS_PAGE };
}

/** A thread and one page of its posts. Hidden posts keep their place but only moderators see their text. */
export async function threadDetail(id: string, page: number, viewer: Viewer, db: Queryable = pool) {
  const moderator = isModerator(viewer);
  const row = (await db.query(`SELECT ${threadColumns},c.name AS category_name,t.hidden_at,t.hidden_reason
    ${threadJoins} JOIN falk_forum_category c ON c.id=t.category_id WHERE t.id=$1`, [id])).rows[0];
  if (!row || (row.hidden_at && !moderator)) return null;
  const [posts, total] = await querySeries(db,[
    `SELECT p.id,p.author_id,p.body,p.created_at,p.edited_at,p.hidden_at,p.hidden_reason,${authorColumns('a','m')}
      FROM falk_forum_post p JOIN falk_account a ON a.id=p.author_id LEFT JOIN falk_member_profile m ON m.account_id=a.id
      WHERE p.thread_id=$1 ORDER BY p.created_at,p.id LIMIT ${POSTS_PAGE} OFFSET ${(page-1)*POSTS_PAGE}`,
    'SELECT count(*)::int AS count FROM falk_forum_post WHERE thread_id=$1',
  ],[id]);
  return {
    thread:{ ...threadFrom(row), categoryName:row.category_name, hidden:!!row.hidden_at, hiddenReason:moderator ? row.hidden_reason : null },
    posts:posts.rows.map(p => ({
      id:p.id, author:authorFrom(p), createdAt:p.created_at.toISOString(), editedAt:p.edited_at?.toISOString() ?? null,
      hidden:!!p.hidden_at, body:p.hidden_at && !moderator ? null : p.body,
      hiddenReason:moderator ? p.hidden_reason : null, own:viewer?.id === p.author_id,
    })),
    total:total.rows[0].count, page, pageSize:POSTS_PAGE,
  };
}

export async function recordThreads(watchId: string, db: Queryable = pool) {
  const rows = await db.query(`SELECT ${threadColumns} ${threadJoins} WHERE t.watch_id=$1 AND t.hidden_at IS NULL ORDER BY t.last_post_at DESC,t.id`, [watchId]);
  return rows.rows.map(threadFrom);
}

/** Threads whose title or any visible post matches, newest activity first. */
export async function searchForum(q: string, db: Queryable = pool) {
  const rows = await db.query(`SELECT ${threadColumns} ${threadJoins}, websearch_to_tsquery('english',$1) AS q
    WHERE t.hidden_at IS NULL AND (t.search @@ q OR EXISTS(SELECT 1 FROM falk_forum_post p
      WHERE p.thread_id=t.id AND p.hidden_at IS NULL AND p.search @@ q))
    ORDER BY t.last_post_at DESC,t.id LIMIT ${THREADS_PAGE}`, [q]);
  return rows.rows.map(threadFrom);
}

export async function createThread(actorId: string, input: z.infer<typeof threadInput>, db: PoolClient) {
  const me = await actor(db,actorId);
  if (!(await db.query('SELECT 1 FROM falk_forum_category WHERE id=$1', [input.category])).rowCount) throw new HttpError(400,'Choose a category.');
  if (input.record && !(await db.query('SELECT 1 FROM falk_watch WHERE id=$1', [input.record])).rowCount) throw new HttpError(400,'Choose a record from the catalogue.');
  const thread = (await db.query('INSERT INTO falk_forum_thread(category_id,author_id,title,watch_id) VALUES($1,$2,$3,$4) RETURNING id',
    [input.category,me.id,input.title,input.record || null])).rows[0];
  const post = (await db.query('INSERT INTO falk_forum_post(thread_id,author_id,body) VALUES($1,$2,$3) RETURNING id', [thread.id,me.id,input.body])).rows[0];
  return { thread:thread.id as string, post:post.id as string };
}

/** A reply notifies everyone who has posted in the thread, except the person replying. */
export async function reply(actorId: string, threadId: string, input: z.infer<typeof postInput>, db: PoolClient) {
  const me = await actor(db,actorId);
  const thread = (await db.query('SELECT locked,hidden_at FROM falk_forum_thread WHERE id=$1 FOR SHARE', [threadId])).rows[0];
  if (!thread || (thread.hidden_at && !isModerator(me))) throw new HttpError(404,'Thread not found.');
  if (thread.locked && !isModerator(me)) throw new HttpError(403,'This thread is locked.');
  const post = (await db.query('INSERT INTO falk_forum_post(thread_id,author_id,body) VALUES($1,$2,$3) RETURNING id', [threadId,me.id,input.body])).rows[0];
  await db.query(`INSERT INTO falk_forum_notification(account_id,post_id)
    SELECT DISTINCT author_id,$2::uuid FROM falk_forum_post WHERE thread_id=$1 AND author_id<>$3 ON CONFLICT DO NOTHING`, [threadId,post.id,me.id]);
  return { post:post.id as string };
}

export async function editPost(actorId: string, postId: string, input: z.infer<typeof postInput>, db: PoolClient) {
  const me = await actor(db,actorId);
  const post = (await db.query(`SELECT p.author_id,p.hidden_at,t.locked,t.hidden_at AS thread_hidden FROM falk_forum_post p
    JOIN falk_forum_thread t ON t.id=p.thread_id WHERE p.id=$1 FOR UPDATE OF p`, [postId])).rows[0];
  if (!post) throw new HttpError(404,'Post not found.');
  if (post.author_id !== me.id) throw new HttpError(403,'You can only edit your own posts.');
  if (post.hidden_at) throw new HttpError(409,'A moderator hid this post, so it cannot be edited.');
  if (post.locked || post.thread_hidden) throw new HttpError(409,'This thread is locked.');
  await db.query('UPDATE falk_forum_post SET body=$2 WHERE id=$1', [postId,input.body]);
  return { post:postId };
}

export async function reportPost(actorId: string, postId: string, input: z.infer<typeof reasonInput>, db: PoolClient) {
  const me = await actor(db,actorId);
  const post = (await db.query(`SELECT p.author_id FROM falk_forum_post p JOIN falk_forum_thread t ON t.id=p.thread_id
    WHERE p.id=$1 AND p.hidden_at IS NULL AND t.hidden_at IS NULL`, [postId])).rows[0];
  if (!post) throw new HttpError(404,'Post not found.');
  if (post.author_id === me.id) throw new HttpError(400,'You cannot report your own post.');
  const report = await db.query(`INSERT INTO falk_forum_report(post_id,reporter_id,reason) VALUES($1,$2,$3)
    ON CONFLICT(post_id,reporter_id) DO NOTHING RETURNING id`, [postId,me.id,input.reason]);
  if (!report.rowCount) throw new HttpError(409,'You have already reported this post.');
  return { report:report.rows[0].id as string };
}

/** Hide a post and close its open reports as handled. Returns false if it was already hidden. */
async function hide(db: PoolClient, moderatorId: string, postId: string, why: string) {
  const post = (await db.query('SELECT author_id,thread_id,hidden_at FROM falk_forum_post WHERE id=$1 FOR UPDATE', [postId])).rows[0];
  if (!post) throw new HttpError(404,'Post not found.');
  if (post.hidden_at) return false;
  await db.query('UPDATE falk_forum_post SET hidden_at=now(),hidden_by=$2,hidden_reason=$3 WHERE id=$1', [postId,moderatorId,why]);
  await db.query(`UPDATE falk_forum_report SET resolved_at=now(),resolved_by=$2,resolution='hidden'
    WHERE post_id=$1 AND resolved_at IS NULL`, [postId,moderatorId]);
  await audit(db,moderatorId,post.author_id,'forum_post_hidden',why,{post:postId,thread:post.thread_id});
  return true;
}

export async function setPostHidden(actorId: string, postId: string, hidden: boolean, why: string, db: PoolClient) {
  const me = await actor(db,actorId,MODERATORS);
  if (hidden) {
    if (!(await hide(db,me.id,postId,why))) throw new HttpError(409,'This post is already hidden.');
    return { hidden };
  }
  const post = (await db.query('SELECT author_id,thread_id,hidden_at FROM falk_forum_post WHERE id=$1 FOR UPDATE', [postId])).rows[0];
  if (!post) throw new HttpError(404,'Post not found.');
  if (!post.hidden_at) throw new HttpError(409,'This post is not hidden.');
  await db.query('UPDATE falk_forum_post SET hidden_at=NULL,hidden_by=NULL,hidden_reason=NULL WHERE id=$1', [postId]);
  await audit(db,me.id,post.author_id,'forum_post_shown',why,{post:postId,thread:post.thread_id});
  return { hidden };
}

/** Pin, lock or hide a thread. A thread that is hidden again keeps its first hiding record. */
export async function moderateThread(actorId: string, threadId: string, input: z.infer<typeof threadModeration>, db: PoolClient) {
  const me = await actor(db,actorId,MODERATORS);
  const thread = (await db.query('SELECT author_id FROM falk_forum_thread WHERE id=$1 FOR UPDATE', [threadId])).rows[0];
  if (!thread) throw new HttpError(404,'Thread not found.');
  const { reason:why, ...changes } = input;
  await db.query(`UPDATE falk_forum_thread SET pinned=coalesce($2,pinned),locked=coalesce($3,locked),
    hidden_at=CASE WHEN $4::boolean IS NULL THEN hidden_at WHEN $4 THEN coalesce(hidden_at,now()) END,
    hidden_by=CASE WHEN $4::boolean IS NULL THEN hidden_by WHEN $4 THEN coalesce(hidden_by,$5) END,
    hidden_reason=CASE WHEN $4::boolean IS NULL THEN hidden_reason WHEN $4 THEN coalesce(hidden_reason,$6) END
    WHERE id=$1`, [threadId,changes.pinned ?? null,changes.locked ?? null,changes.hidden ?? null,me.id,why]);
  await audit(db,me.id,thread.author_id,'forum_thread_moderated',why,{thread:threadId,...changes});
  return changes;
}

export async function listReports(actorId: string, db: PoolClient) {
  await actor(db,actorId,MODERATORS);
  const rows = await db.query(`SELECT r.id,r.reason,r.created_at,r.post_id,left(p.body,400) AS excerpt,p.hidden_at,
    t.id AS thread_id,t.title,ra.username AS reporter,pa.username AS author
    FROM falk_forum_report r JOIN falk_forum_post p ON p.id=r.post_id JOIN falk_forum_thread t ON t.id=p.thread_id
    JOIN falk_account ra ON ra.id=r.reporter_id JOIN falk_account pa ON pa.id=p.author_id
    WHERE r.resolved_at IS NULL ORDER BY r.created_at,r.id LIMIT 100`);
  return rows.rows.map(r => ({ id:r.id, reason:r.reason, createdAt:r.created_at.toISOString(), post:r.post_id, excerpt:r.excerpt,
    postHidden:!!r.hidden_at, thread:{ id:r.thread_id, title:r.title }, reporter:r.reporter, author:r.author }));
}

/** Hiding the post settles every open report on it; dismissing settles only this one. */
export async function resolveReport(actorId: string, reportId: string, input: z.infer<typeof reportResolution>, db: PoolClient) {
  const me = await actor(db,actorId,MODERATORS);
  const report = (await db.query('SELECT post_id,resolved_at FROM falk_forum_report WHERE id=$1 FOR UPDATE', [reportId])).rows[0];
  if (!report) throw new HttpError(404,'Report not found.');
  if (report.resolved_at) throw new HttpError(409,'Another moderator has already resolved this report.');
  if (input.resolution === 'hidden') await hide(db,me.id,report.post_id,input.reason);
  await db.query(`UPDATE falk_forum_report SET resolved_at=now(),resolved_by=$2,resolution=$3 WHERE id=$1 AND resolved_at IS NULL`,
    [reportId,me.id,input.resolution]);
  await audit(db,me.id,null,'forum_report_resolved',input.reason,{report:reportId,post:report.post_id,resolution:input.resolution});
  return { resolution:input.resolution };
}

export async function notifications(actorId: string, db: PoolClient) {
  const me = await actor(db,actorId);
  const [rows, unread] = await querySeries(db,[
    `SELECT n.id,n.created_at,n.read_at,p.id AS post_id,t.id AS thread_id,t.title,${authorColumns('a','m')}
      FROM falk_forum_notification n JOIN falk_forum_post p ON p.id=n.post_id JOIN falk_forum_thread t ON t.id=p.thread_id
      JOIN falk_account a ON a.id=p.author_id LEFT JOIN falk_member_profile m ON m.account_id=a.id
      WHERE n.account_id=$1 AND p.hidden_at IS NULL AND t.hidden_at IS NULL ORDER BY n.created_at DESC,n.id LIMIT 50`,
    `SELECT count(*)::int AS count FROM falk_forum_notification n JOIN falk_forum_post p ON p.id=n.post_id
      JOIN falk_forum_thread t ON t.id=p.thread_id WHERE n.account_id=$1 AND n.read_at IS NULL AND p.hidden_at IS NULL AND t.hidden_at IS NULL`,
  ],[me.id]);
  return { unread:unread.rows[0].count, notifications:rows.rows.map(n => ({ id:n.id, createdAt:n.created_at.toISOString(), read:!!n.read_at,
    post:n.post_id, thread:{ id:n.thread_id, title:n.title }, author:authorFrom(n) })) };
}

/** Marks the given notifications read, or all of them. */
export async function markRead(actorId: string, input: z.infer<typeof readInput>, db: PoolClient) {
  const me = await actor(db,actorId);
  const rows = await db.query(`UPDATE falk_forum_notification SET read_at=now() WHERE account_id=$1 AND read_at IS NULL
    AND ($2::uuid[] IS NULL OR id=ANY($2))`, [me.id,input.ids ?? null]);
  return { marked:rows.rowCount ?? 0 };
}

// Signed-in readers are looked up only to show moderators hidden content. If that lookup fails
// (signed out of Clerk, unverified, suspended), they read the forum like everyone else.
async function viewerOf(req: Request): Promise<Viewer> {
  if (!getAuth(req).userId) return null;
  try { const { account } = await authenticatedAccount(req); return { id:account.id, role:account.role }; }
  catch { return null; }
}
const member = async (req: Request) => (await authenticatedAccount(req)).account.id;
const write = <T>(fn: (db: PoolClient) => Promise<T>) => transaction(fn);
// Reads that re-check the actor take a row lock, so they use write(); read() is for public reads.
const read = <T>(fn: (db: PoolClient) => Promise<T>) => transaction(fn,true);

const forum = Router();
forum.get('/categories', async (_req,res) => { res.json({ categories:await read(db => listCategories(db)) }); });
forum.get('/categories/:id/threads', async (req,res) => {
  const { page } = pageQuery.parse(req.query);
  const listing = await read(db => listThreads(slug.parse(req.params.id),page,db));
  if (!listing) throw new HttpError(404,'Category not found.');
  res.json(listing);
});
forum.get('/threads/:id', async (req,res) => {
  const id = z.uuid().parse(req.params.id);
  const { page } = pageQuery.parse(req.query);
  const viewer = await viewerOf(req);
  const detail = await read(db => threadDetail(id,page,viewer,db));
  if (!detail) throw new HttpError(404,'Thread not found.');
  res.json(detail);
});
forum.get('/records/:brand/:model', async (req,res) => {
  res.json({ threads:await read(db => recordThreads(`${slug.parse(req.params.brand)}/${slug.parse(req.params.model)}`,db)) });
});
forum.get('/search', async (req,res) => {
  const { q } = searchQuery.parse(req.query);
  res.json({ threads:await read(db => searchForum(q,db)) });
});
forum.post('/threads', async (req,res) => {
  const id = await member(req), input = threadInput.parse(req.body);
  res.status(201).json(await write(db => createThread(id,input,db)));
});
forum.post('/threads/:id/posts', async (req,res) => {
  const id = await member(req), thread = z.uuid().parse(req.params.id), input = postInput.parse(req.body);
  res.status(201).json(await write(db => reply(id,thread,input,db)));
});
forum.patch('/posts/:id', async (req,res) => {
  const id = await member(req), post = z.uuid().parse(req.params.id), input = postInput.parse(req.body);
  res.json(await write(db => editPost(id,post,input,db)));
});
forum.post('/posts/:id/reports', async (req,res) => {
  const id = await member(req), post = z.uuid().parse(req.params.id), input = reasonInput.parse(req.body);
  res.status(201).json(await write(db => reportPost(id,post,input,db)));
});
forum.post('/posts/:id/hide', async (req,res) => {
  const id = await member(req), post = z.uuid().parse(req.params.id), { reason:why } = reasonInput.parse(req.body);
  res.json(await write(db => setPostHidden(id,post,true,why,db)));
});
forum.post('/posts/:id/show', async (req,res) => {
  const id = await member(req), post = z.uuid().parse(req.params.id), { reason:why } = reasonInput.parse(req.body);
  res.json(await write(db => setPostHidden(id,post,false,why,db)));
});
forum.post('/threads/:id/moderation', async (req,res) => {
  const id = await member(req), thread = z.uuid().parse(req.params.id), input = threadModeration.parse(req.body);
  res.json(await write(db => moderateThread(id,thread,input,db)));
});
forum.get('/reports', async (req,res) => {
  const id = await member(req);
  res.json({ reports:await write(db => listReports(id,db)) });
});
forum.post('/reports/:id/resolution', async (req,res) => {
  const id = await member(req), report = z.uuid().parse(req.params.id), input = reportResolution.parse(req.body);
  res.json(await write(db => resolveReport(id,report,input,db)));
});
forum.get('/notifications', async (req,res) => {
  const id = await member(req);
  res.json(await write(db => notifications(id,db)));
});
forum.post('/notifications/read', async (req,res) => {
  const id = await member(req), input = readInput.parse(req.body);
  res.json(await write(db => markRead(id,input,db)));
});
export default forum;
