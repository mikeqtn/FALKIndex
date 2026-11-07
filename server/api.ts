import { createHmac } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { clerkClient, getAuth } from '@clerk/express';
import { profileInput, qualificationOptions } from '../src/accounts/contracts.ts';
import { pool } from './db.ts';
import { authenticatedAccount, deleteAccount, HttpError, publicProfile, saveProfile } from './accounts.ts';
import { getClerkProxyHost } from './middlewares/clerkProxyMiddleware.ts';
import { clientKey, minuteCounter } from './pageLimit.ts';
import admin from './admin.ts';
import { correctionInput, saveCorrection } from './corrections.ts';
import { saveNewWatch } from './newWatch.ts';
import { loadCatalogue } from './catalogue.ts';
import { transaction } from './db.ts';
import review, { myContributions } from './review.ts';
import forum from './forum.ts';
import { sendSupportMessage, supportInput } from './support.ts';

export const api = Router();
api.use((_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
export function requireSameOrigin(origin: string | undefined, host: string | undefined, protocol = 'https') {
  let valid = false;
  try {
    const parsed = origin && new URL(origin);
    valid = !!parsed && parsed.host === host && parsed.protocol === `${protocol}:` && /^https?:$/.test(parsed.protocol);
  } catch {}
  if (!valid) throw new HttpError(403,'This request must come from the FALK website.');
}
// Keys hold hashed IPs and user ids. A secret key stops anyone with the table from reversing them by trying every
// IPv4 address. Production refuses to start without SESSION_SECRET (see start()); the fallback is for development only.
export const rateLimitKey = (scope: string, who: string) =>
  createHmac('sha256',process.env.SESSION_SECRET || 'falk-rate-limit-dev').update(`${scope}:${who}`).digest('hex');
/** Count one hit toward an hourly cap; a bucket is the minute number the hour starts. These survive restarts and are shared across instances. */
async function hit(key: string, bucket: number) {
  const hits = await pool.query(`INSERT INTO falk_rate_limit(key,bucket) VALUES($1,$2)
    ON CONFLICT(key,bucket) DO UPDATE SET hits=falk_rate_limit.hits+1 RETURNING hits`, [key,bucket]);
  // Clear older hours now and then so the table stays small.
  if (Math.random() < 0.01) await pool.query('DELETE FROM falk_rate_limit WHERE bucket<$1', [bucket-60]);
  return hits.rows[0].hits as number;
}
// Per-minute budgets are kept in memory, so an API call costs no database write. As with pageLimit.ts, each Autoscale
// instance counts separately: the limit is per instance. The hourly caps on writes that are never deleted stay exact.
const minuteHit = minuteCounter();
api.use(async (req,_res,next) => {
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    requireSameOrigin(req.get('origin'),getClerkProxyHost(req),req.protocol);
    const upload = req.path === '/forum/images' && req.is(['image/jpeg','image/png','image/webp']);
    if (!upload && !req.is('application/json')) throw new HttpError(415,'Send application/json.');
  }
  const write = !['GET','HEAD','OPTIONS'].includes(req.method);
  const hits = minuteHit(`${write ? 'write' : 'read'}:${getAuth(req).userId ?? clientKey(req.ip)}`);
  if (hits > (write ? 30 : 300)) throw new HttpError(429,'Too many requests. Please wait a minute and try again.');
  next();
});
api.get('/health', async (_req,res) => {
  const rows = await pool.query('SELECT count(*)::int AS records FROM falk_watch');
  if (!rows.rows[0].records) throw new HttpError(503,'The catalogue has not been imported.');
  res.json({ok:true,records:rows.rows[0].records});
});
api.get('/accounts/meta', async (_req,res) => {
  const rows = await pool.query("SELECT id,payload->>'name' AS name FROM falk_organization ORDER BY name");
  res.json({qualificationOptions,organizations:rows.rows});
});
api.get('/account', async (req,res) => { res.json(await authenticatedAccount(req)); });
api.patch('/account', async (req,res) => {
  const { account } = await authenticatedAccount(req);
  const input = profileInput.parse(req.body);
  await saveProfile(account,input);
  const { username,...profile } = input;
  res.json({account:{...account,username,onboarded:true,profile:{...profile,imageUrl:account.profile.imageUrl}}});
});
// A member deletes their account. Suspended and unverified members may do so too: it is their data.
// The FALK details go first, then the Clerk user. If Clerk fails, signing in again makes a fresh, empty
// account (its old Clerk link is already cut), and deleting that one finishes the job.
api.delete('/account', async (req,res) => {
  const { account } = await authenticatedAccount(req,undefined,false);
  const { confirm } = z.object({confirm:z.string().max(20)}).strict().parse(req.body);
  const { clerkId } = await transaction(db => deleteAccount(account.id,confirm,db));
  try { await clerkClient.users.deleteUser(clerkId); }
  catch {
    console.error('Account deleted, but the Clerk user could not be deleted');
    throw new HttpError(502,'Your FALK details are deleted, but your sign-in could not be closed. Sign in again and delete once more to finish.');
  }
  res.json({ok:true});
});
// A member's own submissions and the feedback on them. Suspended members may still read their own.
api.get('/account/contributions', async (req,res) => {
  const { account } = await authenticatedAccount(req,undefined,false);
  res.json({contributions:await myContributions(account.id)});
});
api.get('/profiles/:username', async (req,res) => {
  const username = z.string().regex(/^[a-z][a-z0-9_]{2,29}$/).parse(req.params.username);
  const profile = await publicProfile(username);
  if (!profile) throw new HttpError(404,'Public profile not found.');
  res.json({profile});
});
// Corrections can never be deleted (the review history is append-only), so cap them per hour
// as well as per minute. Every attempt counts, including invalid ones.
export const CORRECTIONS_PER_HOUR = 10;
api.post('/corrections', async (req,res) => {
  const hour = Math.floor(Date.now()/3600000)*60;
  if (await hit(rateLimitKey('correction',getAuth(req).userId ?? req.ip ?? ''),hour) > CORRECTIONS_PER_HOUR) {
    throw new HttpError(429,'You have sent several corrections in the last hour. Please try again later.');
  }
  const input = correctionInput.parse(req.body);
  const submission = await transaction(db => saveCorrection(input,db));
  res.status(201).json({submission});
});
// Forum posts are never deleted either, so new threads and replies are capped per hour too.
export const FORUM_THREADS_PER_HOUR = 5;
export const FORUM_POSTS_PER_HOUR = 30;
export const FORUM_REPORTS_PER_HOUR = 20;
export const FORUM_IMAGES_PER_HOUR = 20;
const hourly = (scope: string, limit: number, message: string): RequestHandler => async (req,_res,next) => {
  const hour = Math.floor(Date.now()/3600000)*60;
  if (await hit(rateLimitKey(scope,getAuth(req).userId ?? req.ip ?? ''),hour) > limit) throw new HttpError(429,message);
  next();
};
// Members propose new watches (DECISIONS.md Q16). Proposals are kept for review, so they are capped per hour.
export const NEW_WATCHES_PER_HOUR = 5;
api.post('/contributions/watches',hourly('new-watch',NEW_WATCHES_PER_HOUR,'You have proposed several watches in the last hour. Please try again later.'),async (req,res) => {
  const { account } = await authenticatedAccount(req);
  // Checked against the catalogue as it is now, not the page cache, so a just-published record counts.
  const live = await loadCatalogue();
  const submission = await transaction(db => saveNewWatch(account,req.body,live,db));
  res.status(201).json({submission});
});
api.post('/forum/threads',hourly('forum-thread',FORUM_THREADS_PER_HOUR,'You have started several threads in the last hour. Please try again later.'));
api.post('/forum/threads/:id/posts',hourly('forum-post',FORUM_POSTS_PER_HOUR,'You have posted a lot in the last hour. Please try again later.'));
api.post('/forum/images',hourly('forum-image',FORUM_IMAGES_PER_HOUR,'You have uploaded a lot of images in the last hour. Please try again later.'));
api.post('/forum/posts/:id/reports',hourly('forum-report',FORUM_REPORTS_PER_HOUR,'You have sent several reports in the last hour. Please try again later.'));
// Each help message is a paid email to a real inbox, so cap it per visitor and, against many addresses at once, for the site.
export const SUPPORT_PER_HOUR = 5;
export const SUPPORT_SITE_PER_HOUR = 60;
api.post('/support',hourly('support',SUPPORT_PER_HOUR,'You have sent several messages in the last hour. Please try again later.'),async (req,res) => {
  const input = supportInput.parse(req.body);
  if (await hit(rateLimitKey('support-site','all'),Math.floor(Date.now()/3600000)*60) > SUPPORT_SITE_PER_HOUR) {
    throw new HttpError(429,'The help form is busy. Please try again later.');
  }
  await sendSupportMessage(input);
  res.status(201).json({ok:true});
});
api.use('/admin',admin);
api.use('/review',review);
api.use('/forum',forum);
api.use((_req,_res) => { throw new HttpError(404,'API route not found.'); });
