import { readFileSync } from 'node:fs';
import YAML from 'yaml';

// Checks that each claim's excerpt appears word for word on its source's archived page.
// It stands in for the reviewer's excerpt check (EDITORIAL.md §7) on AI drafts.
// Usage: npm run check:excerpts -- <brand/model> [...more]   (only ai-draft claims; --all-claims for every claim)

const args = process.argv.slice(2);
const allClaims = args.includes('--all-claims');
// --sources <file> adds sources not yet merged into data/sources.yaml (a draft's own list).
const extra = args.flatMap((a, i) => args[i - 1] === '--sources' ? [a] : []);
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--sources');
if (!ids.length) { console.error('Give at least one brand/model id.'); process.exit(2); }

const sources = new Map<string, any>(['data/sources.yaml', ...extra]
  .flatMap(f => (YAML.parse(readFileSync(f, 'utf8')) as any[] | null) ?? []).map(s => [s.id, s]));

export const normalize = (s: string) => s
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  // Inline tags can sit inside a word ("c<span>aliber"); block tags separate words.
  .replace(/<\/?(span|a|em|strong|b|i|u|sup|sub|font|mark|small)\b[^>]*>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;|&#8217;|&#8216;/g, "'").replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
  .replace(/&ndash;|&mdash;|&#8211;|&#8212;/g, '-').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/[‘’ʼ]/g, "'")
  .replace(/&([a-z])(grave|acute|circ|uml|tilde|cedil|ring|slash);/gi, '$1')
  // Accents are dropped on both sides, so "M&ugrave;" on the page matches "Mù" in the excerpt.
  .normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/[‘’ʼ`]/g, "'").replace(/[“”«»]/g, '"').replace(/[–—‑]/g, '-').replace(/…/g, '...')
  .replace(/\s+/g, ' ').toLowerCase().trim();

// Raw snapshot (id_) so the Wayback toolbar does not split the text.
const raw = (u: string) => u.replace(/(web\.archive\.org\/web\/\d+)(?:[a-z_]+)?\//, '$1id_/');
const pages = new Map<string, Promise<string>>();
const page = (u: string) => {
  if (!pages.has(u)) pages.set(u, fetch(raw(u), { headers: { 'user-agent': 'Mozilla/5.0 (excerpt-check)' } })
    .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))).then(normalize));
  return pages.get(u)!;
};

let failed = 0;
for (const id of ids) {
  const rec = YAML.parse(readFileSync(`data/watches/${id}.yaml`, 'utf8'));
  for (const c of rec.claims ?? []) {
    if (!allClaims && c.editor !== 'ai-draft') continue;
    const src = sources.get(c.source);
    const url = src?.archived_url;
    let verdict: string;
    if (!src) verdict = 'FAIL unknown source';
    else if (!url) verdict = 'FAIL source has no archived_url';
    else {
      // An excerpt may end a sentence where the page continues it ("METAS." vs "METAS, Switzerland's…").
      const quote = normalize(c.excerpt).replace(/[.,;:]+$/, '');
      try { verdict = (await page(url)).includes(quote) ? 'ok' : 'FAIL excerpt not on page'; }
      catch (e) { verdict = `FAIL fetch ${(e as Error).message}`; }
    }
    if (verdict !== 'ok') failed++;
    console.log(`${verdict.padEnd(32)} ${id} ${c.id}`);
  }
}
console.log(failed ? `\n${failed} claim(s) failed.` : '\nAll checked excerpts found.');
process.exit(failed ? 1 : 0);
