import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { HttpError } from './accounts.ts';

// Uploaded files are never stored or served. Each is decoded to pixels and written out as a new WebP,
// so scripts, appended files and metadata (including GPS location) in the original do not survive.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 64_000_000; // refuses decompression bombs: small files that expand to huge images
const MAX_EDGE = 2000;
const UNREADABLE = 'That file could not be read as a JPEG, PNG or WebP image.';

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
    return { data, width:info.width, height:info.height };
  } catch { throw new HttpError(400, UNREADABLE); }
}

// Replit Object Storage in the app, because Autoscale disks do not last. FORUM_IMAGE_DIR swaps in a
// folder for tests and local work, where Replit's storage service is not reachable.
const unavailable = () => new HttpError(503, 'Image storage is not available right now. Please try again later.');
const folder = () => process.env.FORUM_IMAGE_DIR;
const objectName = (id: string) => `forum/${id}.webp`;
// Loaded on first use so that every page render does not pay for the storage client.
let bucket: Promise<import('@replit/object-storage').Client> | undefined;
const client = () => bucket ??= import('@replit/object-storage').then(m => new m.Client());

export async function storeImage(id: string, data: Buffer) {
  const dir = folder();
  if (dir) { await mkdir(dir, { recursive:true }); await writeFile(join(dir, `${id}.webp`), data); return; }
  const result = await (await client()).uploadFromBytes(objectName(id), data).catch(() => null);
  if (!result?.ok) throw unavailable();
}

export async function loadImage(id: string) {
  const dir = folder();
  if (dir) return readFile(join(dir, `${id}.webp`));
  const result = await (await client()).downloadAsBytes(objectName(id)).catch(() => null);
  if (!result?.ok) throw unavailable();
  return result.value[0];
}

export async function removeImage(id: string) {
  const dir = folder();
  if (dir) { await rm(join(dir, `${id}.webp`), { force:true }); return; }
  const result = await (await client()).delete(objectName(id), { ignoreNotFound:true }).catch(() => null);
  if (!result?.ok) throw unavailable();
}
