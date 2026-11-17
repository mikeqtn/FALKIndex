import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestHandler, Response } from 'express';
import sharp from 'sharp';
import { HttpError } from './accounts.ts';

// Uploaded files are never stored or served. Each is decoded to pixels and written out as a new WebP,
// so scripts, appended files and metadata (including GPS location) in the original do not survive.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 64_000_000; // refuses decompression bombs: small files that expand to huge images
const MAX_EDGE = 2000;
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

/** Hold a slot across body parsing; release it on every response path, including parser errors. */
export const limitConcurrentImageUploads: RequestHandler = (_req, res, next) => {
  const release = acquireImageUploadSlot();
  if (!release) {
    res.setHeader('Retry-After', '10');
    return next(new HttpError(429, 'Image processing is busy. Please try again shortly.'));
  }
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

// ponytail: decodes in this process, with a pixel cap and a time limit. A separate worker would also contain a decoder crash.
export async function rebuildImage(input: Buffer) {
  if (!hasImageSignature(input)) throw new HttpError(400, UNREADABLE);
  try {
    const image = sharp(input, { limitInputPixels:MAX_INPUT_PIXELS, failOn:'error' });
    const { format } = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(format ?? '')) throw new Error('Unexpected format');
    // rotate() applies the camera's orientation before the metadata that records it is dropped.
    const { data, info } = await image.rotate().resize({ width:MAX_EDGE, height:MAX_EDGE, fit:'inside', withoutEnlargement:true })
      .toColourspace('srgb').webp({ quality:82 }).timeout({ seconds:20 }).toBuffer({ resolveWithObject:true });
    return { data, width:info.width, height:info.height, thumb:await makeThumbnail(data) };
  } catch { throw new HttpError(400, UNREADABLE); }
}

/** The long edge of the small copy kept for previews such as message bubbles, which show images at about 110-260px. */
export const THUMB_EDGE = 480;
export type ImageSize = 'full' | 'thumb';
/** A small copy of an image we already rebuilt, so it needs no limits beyond the time one. */
export const makeThumbnail = (data: Buffer) => sharp(data).resize({ width:THUMB_EDGE, height:THUMB_EDGE, fit:'inside', withoutEnlargement:true })
  .webp({ quality:76 }).timeout({ seconds:10 }).toBuffer();

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
  await write(id, 'full', data);
  if (thumb) await write(id, 'thumb', thumb);
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
  if (dir) { await Promise.all((['full', 'thumb'] as const).map(size => rm(join(dir, fileName(id, size)), { force:true }))); return; }
  const store = await client();
  const results = await Promise.all((['full', 'thumb'] as const).map(size => store.delete(objectName(id, size), { ignoreNotFound:true }).catch(() => null)));
  if (!results.every(result => result?.ok)) throw unavailable();
}
