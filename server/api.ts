import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getAuth } from '@clerk/express';
import { profileInput, qualificationOptions } from '../src/accounts/contracts.ts';
import { pool } from './db.ts';
import { authenticatedAccount, HttpError, publicProfile, saveProfile } from './accounts.ts';
import { getClerkProxyHost } from './middlewares/clerkProxyMiddleware.ts';
import admin from './admin.ts';
import { correctionInput, saveCorrection } from './corrections.ts';
import { transaction } from './db.ts';
import review from './review.ts';

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
export const rateLimitKey = (scope: string, who: string) =>
  createHash('sha256').update(`${process.env.SESSION_SECRET ?? 'falk-rate-limit'}:${scope}:${who}`).digest('hex');
/** Count one hit; buckets are minute numbers, so an hourly bucket is the minute the hour starts. */
async function hit(key: string, bucket: number) {
  const hits = await pool.query(`INSERT INTO falk_rate_limit(key,bucket) VALUES($1,$2)
    ON CONFLICT(key,bucket) DO UPDATE SET hits=falk_rate_limit.hits+1 RETURNING hits`, [key,bucket]);
  return hits.rows[0].hits as number;
}
api.use(async (req,_res,next) => {
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    requireSameOrigin(req.get('origin'),getClerkProxyHost(req),req.protocol);
    if (!req.is('application/json')) throw new HttpError(415,'Send application/json.');
  }
  const bucket = Math.floor(Date.now()/60000);
  const write = !['GET','HEAD','OPTIONS'].includes(req.method);
  const hits = await hit(rateLimitKey(write ? 'write' : 'read',getAuth(req).userId ?? req.ip ?? ''),bucket);
  // Keep an hour of buckets for the hourly limits; clear older ones now and then so the table stays small.
  if (Math.random() < 0.01) await pool.query('DELETE FROM falk_rate_limit WHERE bucket<$1', [bucket-60]);
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
api.use('/admin',admin);
api.use('/review',review);
api.use((_req,_res) => { throw new HttpError(404,'API route not found.'); });
