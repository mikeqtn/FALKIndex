// Share image (og:image) for a record: name on the left, the seven-row profile on the right.
// Drawn as SVG and rasterised with resvg using bundled fonts, so it renders the same on any host.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { DIMENSIONS, type Record } from './data.ts';

export type DimensionLabels = { [D in typeof DIMENSIONS[number]]: string };

// One file per Unicode subset (Latin, Latin Extended, Vietnamese); resvg falls back across them per glyph.
// resvg picks the first loaded face for a family, so the basic Latin files (no subset suffix) load first.
const FONT_DIR = join(process.cwd(), 'server/og/fonts');
const fontFiles = readdirSync(FONT_DIR).filter(f => f.endsWith('.ttf'))
  .sort((a, b) => Number(/-(latin-ext|vietnamese)\.ttf$/.test(a)) - Number(/-(latin-ext|vietnamese)\.ttf$/.test(b)))
  .map(f => join(FONT_DIR, f));
const NARROW = 'Archivo Narrow';
const BODY = 'Archivo SemiBold';

// Light-mode tokens from global.css.
const C = {
  page: '#E3E6EA', surface: '#F6F7F8', ink: '#14233F', ink2: '#4A5361', action: '#9C1A33',
  giltTint: '#F1E7D2', giltInk: '#6E5218',
  level: ['transparent', '#D5DCE6', '#AFBCCF', '#7F93B0', '#4A6288', '#14233F'],
};

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

// Greedy word wrap on an average glyph width; close enough for a fixed layout.
function wrap(text: string, maxChars: number, maxLines: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > maxChars) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

function profileRows(r: Record, labels: DimensionLabels) {
  const x = 600, top = 104, rowH = 62, seg = 26, gap = 4;
  return DIMENSIONS.map((d, i) => {
    const y = top + i * rowH;
    const v = r.profile.scores[d].value;
    const segs = [1, 2, 3, 4, 5].map(n => {
      const filled = v !== null && n <= v;
      const fill = v === null ? 'url(#unknown)' : filled ? C.level[v] : 'none';
      return `<rect x="${x + 64 + (n - 1) * (seg + gap)}" y="${y - 30}" width="${seg}" height="38" fill="${fill}" stroke="${filled ? C.level[v] : C.ink2}" stroke-width="1.5"/>`;
    }).join('');
    return `<text x="${x}" y="${y}" font-family="${NARROW}" font-size="34" fill="${C.ink}">${d}</text>${segs}`
      + `<text x="${x + 228}" y="${y}" font-family="${NARROW}" font-size="34" fill="${C.ink}">${v ?? 'U'}</text>`
      + `<text x="${x + 266}" y="${y - 4}" font-family="${BODY}" font-size="20" fill="${C.ink}">${esc(labels[d])}</text>`;
  }).join('');
}

export function recordSvg(r: Record, labels: DimensionLabels) {
  const size = r.model.length > 40 ? 52 : r.model.length > 22 ? 62 : 76;
  const lines = wrap(r.model, Math.floor(440 / (size * 0.46)), 3);
  const model = lines.map((l, i) => `<tspan x="72" dy="${i ? size * 1.04 : 0}">${esc(l)}</tspan>`).join('');
  const body = r.profile.confidence === 'D'
    ? `<text x="600" y="290" font-family="${BODY}" font-size="26" fill="${C.ink2}">Not enough evidence for a profile yet.</text>`
    : profileRows(r, labels);
  const provisional = r.profile.is_seed
    ? `<rect x="72" y="470" width="146" height="40" rx="3" fill="${C.giltTint}"/><text x="88" y="497" font-family="${BODY}" font-size="19" fill="${C.giltInk}">Provisional</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><pattern id="unknown" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.5" height="6" fill="${C.ink2}"/></pattern></defs>
<rect width="1200" height="630" fill="${C.page}"/>
<text x="72" y="96" font-family="${NARROW}" font-size="34" fill="${C.ink}">FALK Index</text>
<text x="72" y="214" font-family="${BODY}" font-size="28" fill="${C.action}">${esc(r.brandName)}</text>
<text x="72" y="${214 + size + 8}" font-family="${NARROW}" font-size="${size}" fill="${C.ink}">${model}</text>
${provisional}
<text x="72" y="572" font-family="${BODY}" font-size="21" fill="${C.ink2}">Not a ranking. Darker means more of the work is done inside the brand.</text>
<rect x="560" y="44" width="592" height="476" rx="8" fill="${C.surface}"/>
${body}
</svg>`;
}

export function recordPng(r: Record, labels: DimensionLabels) {
  const svg = new Resvg(recordSvg(r, labels), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: BODY } });
  return svg.render().asPng();
}

// Share image for every page without its own: the name, the promise, and the seven levels as the mark.
export function siteSvg(count: number) {
  const bars = C.level.slice(1).concat(C.level.slice(1, 3)).map((fill, i) =>
    `<rect x="${600 + i * 76}" y="${150 + (i % 3) * 40}" width="60" height="${330 - (i % 3) * 40}" rx="4" fill="${fill}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${C.page}"/>
<text x="72" y="96" font-family="${NARROW}" font-size="34" fill="${C.ink}">FALK Index</text>
<text x="72" y="250" font-family="${NARROW}" font-size="80" fill="${C.ink}"><tspan x="72">Where each</tspan><tspan x="72" dy="82">watch is</tspan><tspan x="72" dy="82">really made</tspan></text>
<text x="72" y="540" font-family="${BODY}" font-size="26" fill="${C.ink2}">An open index of ${count} watches, every score sourced.</text>
${bars}
</svg>`;
}
export function sitePng(count: number) {
  return new Resvg(siteSvg(count), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: BODY } }).render().asPng();
}
