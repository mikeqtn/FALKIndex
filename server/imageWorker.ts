import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Decodes one upload and writes it out as new WebP files. rebuildImage (forumImages.ts) runs this file as a child
// process of its own for each upload, with none of the server's environment, and kills it if it runs too long: a
// decoder that crashes, hangs or is exploited by a crafted file takes down only that process.
export const MAX_INPUT_PIXELS = 64_000_000; // refuses decompression bombs: small files that expand to huge images
export const MAX_INPUT_EDGE = 20_000;
export const MAX_EDGE = 2000;
/** The long edge of the small copy kept for previews such as message bubbles, which show images at about 110-260px. */
export const THUMB_EDGE = 480;

export type Rebuilt = { data: Buffer, width: number, height: number, thumb: Buffer };
export type Rejected = { rejected: 'format' | 'dimensions' | 'unreadable' };

/** A small copy of an image we already rebuilt, so it needs no limits beyond the time one. */
export const makeThumbnail = (data: Buffer) => sharp(data).resize({ width:THUMB_EDGE, height:THUMB_EDGE, fit:'inside', withoutEnlargement:true })
  .webp({ quality:76 }).timeout({ seconds:10 }).toBuffer();

async function rebuild(input: Buffer): Promise<Rebuilt | Rejected> {
  const image = sharp(input, { limitInputPixels:MAX_INPUT_PIXELS, failOn:'error' });
  // The header alone, so the size is checked before any pixels are decoded.
  const { format, width = 0, height = 0 } = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(format ?? '')) return { rejected:'format' };
  if (width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE || width * height > MAX_INPUT_PIXELS) return { rejected:'dimensions' };
  // rotate() applies the camera's orientation before the metadata that records it is dropped. Sharp writes no
  // metadata unless asked, so EXIF, XMP, comments and text blocks in the upload are not carried over.
  const { data, info } = await image.rotate().resize({ width:MAX_EDGE, height:MAX_EDGE, fit:'inside', withoutEnlargement:true })
    .toColourspace('srgb').webp({ quality:82 }).timeout({ seconds:20 }).toBuffer({ resolveWithObject:true });
  return { data, width:info.width, height:info.height, thumb:await makeThumbnail(data) };
}

if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.once('message', async (input: Uint8Array) => {
    const reply = await rebuild(Buffer.from(input.buffer, input.byteOffset, input.byteLength)).catch((): Rejected => ({ rejected:'unreadable' }));
    process.send!(reply, () => process.exit(0));
  });
}
