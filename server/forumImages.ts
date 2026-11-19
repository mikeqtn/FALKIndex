import { fork } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestHandler, Response } from 'express';
import { HttpError } from './accounts.ts';
import { makeThumbnail, MAX_EDGE, type Rebuilt, type Rejected } from './imageWorker.ts';
export { makeThumbnail, MAX_INPUT_EDGE, THUMB_EDGE } from './imageWorker.ts';

// Uploaded files are never stored or served. Each is decoded to pixels and written out as a new WebP,
// so scripts, appended files and metadata (including GPS location) in the original do not survive.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** How long one upload may take, from its first byte to its decoded image. Node would otherwise wait 5 minutes for a slow sender. */
export const UPLOAD_DEADLINE_MS = 90_000;
const DECODE_DEADLINE_MS = 30_000;
const UNREADABLE = 'That file could not be read as a JPEG, PNG or WebP image.';
const MAX_CONCURRENT_IMAGE_UPLOADS = 2;
let activeImageUploads = 0;

/** Per-instance cap, acquired before reading the raw request body and decoding it. */
export function acquireImageUploadSlot() {
  if (activeImageUploads >= MAX_CONCURRENT_IMAGE_UPLOADS) return undefined;
  activeImageUploads++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeImageUploads--;
  };
}

const uploading = new Set<string>();
/** Hold a slot across body parsing; release it on every response path, including parser errors. A member has one upload
 * at a time (the picker sends them one by one), so a member alone cannot fill the slots, and each upload has a deadline. */
export const limitConcurrentImageUploads: RequestHandler = (req, res, next) => {
  const member = res.locals.member as string;
  if (uploading.has(member)) return next(new HttpError(429, 'Wait for your other image to finish uploading.'));
  const slot = acquireImageUploadSlot();
  if (!slot) {
    res.setHeader('Retry-After', '10');
    return next(new HttpError(429, 'Image processing is busy. Please try again shortly.'));
  }
  uploading.add(member);
  const deadline = setTimeout(() => req.destroy(), UPLOAD_DEADLINE_MS);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(deadline);
    uploading.delete(member);
    slot();
  };
  res.locals.releaseImageUploadSlot = release;
  res.once('finish', release);
  res.once('close', release);
  next();
};

/** Free the slot as soon as decoding finishes; response listeners remain as an error-path safety net. */
export function releaseImageUploadSlot(res: Response) {
  const release = res.locals.releaseImageUploadSlot as (() => void) | undefined;
  release?.();
}

/** The first bytes must already say JPEG, PNG or WebP, so no other decoder in the image library sees member files. */
function hasImageSignature(input: Buffer) {
  const jpeg = input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const png = input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = input.subarray(0, 4).toString('latin1') === 'RIFF' && input.subarray(8, 12).toString('latin1') === 'WEBP';
  return jpeg || png || webp;
}

// The decoder's process gets only PATH: none of the server's secrets, and no NODE_OPTIONS to change how it runs.
// ponytail: a fresh process per upload costs some milliseconds; uploads are capped per member, so it is not kept warm.
const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'imageWorker.ts');
function decodeInWorker(input: Buffer, timeoutMs: number) {
  return new Promise<Rebuilt | Rejected | { rejected: 'timeout' | 'crashed' }>(resolve => {
    const child = fork(WORKER, [], { env:{ PATH:process.env.PATH ?? '' }, execArgv:['--disable-warning=ExperimentalWarning'],
      serialization:'advanced', stdio:['ignore', 'ignore', 'ignore', 'ipc'] });
    let reply: Rebuilt | Rejected | undefined, killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('message', message => { reply = message as Rebuilt | Rejected; });
    child.once('error', () => child.kill('SIGKILL'));
    // 'close' comes after the last message, so a reply sent just before exiting is not lost.
    child.once('close', () => {
      clearTimeout(timer);
      resolve(reply ? fromWorker(reply) : { rejected:killed ? 'timeout' : 'crashed' });
    });
    child.send(input);
  });
}

const REJECTIONS = new Set(['format', 'dimensions', 'unreadable']);
const isWebp = (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
const isEdge = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_EDGE;
/** The decoder's reply, trusted no further than its shape: a decoder taken over by a crafted file could send anything. */
export function fromWorker(reply: unknown): Rebuilt | Rejected | { rejected: 'crashed' } {
  const r = reply as Partial<Rebuilt & Rejected> | null;
  if (r && typeof r === 'object' && 'rejected' in r) return REJECTIONS.has(r.rejected as string) ? { rejected:r.rejected! } : { rejected:'crashed' };
  if (!r || !(r.data instanceof Uint8Array) || !(r.thumb instanceof Uint8Array) || !isEdge(r.width) || !isEdge(r.height)) return { rejected:'crashed' };
  // Buffers arrive as plain byte arrays.
  const data = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), thumb = Buffer.from(r.thumb.buffer, r.thumb.byteOffset, r.thumb.byteLength);
  if (!isWebp(data) || !isWebp(thumb) || data.length > MAX_UPLOAD_BYTES || thumb.length > MAX_UPLOAD_BYTES) return { rejected:'crashed' };
  return { data, thumb, width:r.width!, height:r.height! };
}

/** Logged for every refused upload: why and how big, never the bytes or who sent them. */
function refuse(reason: string, bytes: number) {
  console.error(JSON.stringify({ event:'forum.image_rejected', reason, bytes }));
  return new HttpError(400, UNREADABLE);
}

/** Decodes an upload in a process of its own and returns it rebuilt as WebP, with a small copy. */
export async function rebuildImage(input: Buffer, { timeoutMs = DECODE_DEADLINE_MS } = {}) {
  if (!hasImageSignature(input)) throw refuse('not_an_image', input.length);
  const result = await decodeInWorker(input, timeoutMs);
  if ('rejected' in result) throw refuse(result.rejected, input.length);
  return result;
}

export type ImageSize = 'full' | 'thumb';

// Replit Object Storage in the app, because Autoscale disks do not last. FORUM_IMAGE_DIR swaps in a
// folder for tests and local work, where Replit's storage service is not reachable.
const unavailable = () => new HttpError(503, 'Image storage is not available right now. Please try again later.');
const folder = () => process.env.FORUM_IMAGE_DIR;
const fileName = (id: string, size: ImageSize) => size === 'thumb' ? `${id}-thumb.webp` : `${id}.webp`;
const objectName = (id: string, size: ImageSize) => `forum/${fileName(id, size)}`;
// Loaded on first use so that every page render does not pay for the storage client.
let bucket: Promise<import('@replit/object-storage').Client> | undefined;
const client = () => bucket ??= import('@replit/object-storage').then(m => new m.Client());

// The images served most recently, kept in memory up to CACHE_BYTES, so a conversation or thread opened again is not
// fetched from storage again. An id's bytes never change, and every request is checked for access before this is read,
// so a purged image is never served from here; removeImage also drops it.
const CACHE_BYTES = 48 * 1024 * 1024;
const cache = new Map<string, Buffer>();
let cached = 0;
const remember = (key: string, data: Buffer) => {
  if (data.length > CACHE_BYTES / 8) return data;
  cache.delete(key); cache.set(key, data); cached += data.length;
  for (const [old, bytes] of cache) { if (cached <= CACHE_BYTES) break; cache.delete(old); cached -= bytes.length; }
  return data;
};
const recall = (key: string) => {
  const data = cache.get(key);
  if (data) { cache.delete(key); cache.set(key, data); }
  return data;
};
const forget = (key: string) => { const data = cache.get(key); if (data) { cache.delete(key); cached -= data.length; } };

async function write(id: string, size: ImageSize, data: Buffer) {
  const dir = folder();
  if (dir) { await mkdir(dir, { recursive:true }); await writeFile(join(dir, fileName(id, size)), data); return; }
  const result = await (await client()).uploadFromBytes(objectName(id, size), data).catch(() => null);
  if (!result?.ok) throw unavailable();
}
/** The stored bytes, or null if there are none (or storage did not answer). */
async function read(id: string, size: ImageSize) {
  const dir = folder();
  if (dir) return readFile(join(dir, fileName(id, size))).catch(() => null);
  const result = await (await client()).downloadAsBytes(objectName(id, size)).catch(() => null);
  return result?.ok ? result.value[0] : null;
}

/** Stores an image, and its small copy when there is one. */
export async function storeImage(id: string, data: Buffer, thumb?: Buffer) {
  try {
    await write(id, 'full', data);
    if (thumb) await write(id, 'thumb', thumb);
  } catch (error) {
    // Nothing records an image until it is stored, so a half-stored one would never be cleared up.
    await removeImage(id).catch(() => {});
    throw error;
  }
}

/** An image's bytes. Images stored before small copies existed get theirs made from the full image on first request. */
export async function loadImage(id: string, size: ImageSize = 'full'): Promise<Buffer> {
  const key = `${id}:${size}`;
  const hit = recall(key);
  if (hit) return hit;
  const stored = await read(id, size);
  if (stored) return remember(key, stored);
  if (size === 'full') throw unavailable();
  const thumb = await makeThumbnail(await loadImage(id, 'full')).catch(error => { throw error instanceof HttpError ? error : unavailable(); });
  // Kept for next time; failing to keep it only means making it again.
  write(id, 'thumb', thumb).catch(() => {});
  return remember(key, thumb);
}

export async function removeImage(id: string) {
  forget(`${id}:full`); forget(`${id}:thumb`);
  const dir = folder();
  if (dir) {
    // Every removal is tried, even when one fails, as with the bucket below.
    const results = await Promise.allSettled((['full', 'thumb'] as const).map(size => rm(join(dir, fileName(id, size)), { force:true })));
    if (results.some(result => result.status === 'rejected')) throw unavailable();
    return;
  }
  const store = await client();
  const results = await Promise.all((['full', 'thumb'] as const).map(size => store.delete(objectName(id, size), { ignoreNotFound:true }).catch(() => null)));
  if (!results.every(result => result?.ok)) throw unavailable();
}
