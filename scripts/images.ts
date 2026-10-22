// Write an AVIF copy beside every JPEG in public/images that lacks a current one. Run after adding photos:
// npm run images. Pages serve the AVIF through <Picture> and keep the JPEG for browsers without AVIF.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.jpg') ? [join(dir, e.name)] : []);

let made = 0;
for (const jpg of walk('public/images')) {
  const avif = jpg.replace(/\.jpg$/, '.avif');
  let fresh = false;
  try { fresh = statSync(avif).mtimeMs >= statSync(jpg).mtimeMs; } catch {}
  if (fresh) continue;
  await sharp(jpg).avif({ quality: 55 }).toFile(avif);
  made++;
}
console.log(`${made} AVIF file(s) written`);
