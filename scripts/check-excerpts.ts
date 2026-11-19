import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import YAML from 'yaml';

// Checks that each claim's excerpt appears word for word on its source's archived page.
// It is the check on AI-drafted research before it is published (EDITORIAL.md §7, §9), and CI runs it on pull requests.
// Usage: npm run check:excerpts -- <brand/model> [...more]   (only ai-draft claims; --all-claims for every claim)
//        npm run check:excerpts -- --since <git ref>          (claims added or changed since that ref; CI runs this)

const args = process.argv.slice(2);
const allClaims = args.includes('--all-claims');
const valueOf = (flag: string) => args.flatMap((a, i) => args[i - 1] === flag ? [a] : []);
// --sources <file> adds sources not yet merged into data/sources.yaml (a draft's own list).
const extra = valueOf('--sources');
const since = valueOf('--since')[0];
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
// A file as it was at the ref, or nothing if it did not exist there.
const before = (path: string) => { try { return YAML.parse(git('show', `${since}:${path}`)); } catch { return null; } };
const changedFiles = since ? git('diff', '--name-only', `${since}...HEAD`, '--', 'data/watches', 'data/sources.yaml').split('\n').filter(Boolean) : [];
const ids = since
  ? changedFiles.filter(f => f.startsWith('data/watches/') && f.endsWith('.yaml') && existsSync(f)).map(f => f.slice('data/watches/'.length, -'.yaml'.length))
  : args.filter((a, i) => !a.startsWith('--') && !['--sources', '--since'].includes(args[i - 1]));
if (!ids.length && !since) { console.error('Give at least one brand/model id, or --since <git ref>.'); process.exit(2); }

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
// Some snapshots keep the site's zstd encoding, which fetch does not decode. The archive also rate-limits (429).
const get = async (u: string, tries = 4): Promise<string> => {
  const r = await fetch(raw(u), { headers: { 'user-agent': 'Mozilla/5.0 (excerpt-check)' } });
  if (r.status === 429 && tries > 1) { await new Promise(ok => setTimeout(ok, 30_000)); return get(u, tries - 1); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = Buffer.from(await r.arrayBuffer());
  return (body.readUInt32LE(0) === 0xfd2fb528 ? zstdDecompressSync(body) : body).toString('utf8');
};
const page = (u: string) => {
  if (!pages.has(u)) pages.set(u, get(u).then(normalize));
  return pages.get(u)!;
};

// With --since, a claim is checked when it is new, its excerpt or source changed, or its source's archived copy moved.
const sourcesBefore = since ? new Map<string, any>(((before('data/sources.yaml') as any[] | null) ?? []).map(s => [s.id, s])) : new Map();
const movedSources = new Set([...sources.values()].filter(s => sourcesBefore.get(s.id)?.archived_url !== s.archived_url).map(s => s.id));
const changed = (id: string, c: any) => {
  const old = (before(`data/watches/${id}.yaml`)?.claims ?? []).find((o: any) => o.id === c.id);
  return !old || old.excerpt !== c.excerpt || old.source !== c.source || movedSources.has(c.source);
};
// Moving a source's archived copy affects every record that quotes it, not only the files this change touched.
if (since && movedSources.size) {
  for (const f of git('ls-files', 'data/watches').split('\n').filter(f => f.endsWith('.yaml'))) {
    const id = f.slice('data/watches/'.length, -'.yaml'.length);
    if (!ids.includes(id) && (YAML.parse(readFileSync(f, 'utf8')).claims ?? []).some((c: any) => movedSources.has(c.source))) ids.push(id);
  }
}

let failed = 0, checked = 0;
for (const id of ids) {
  const rec = YAML.parse(readFileSync(`data/watches/${id}.yaml`, 'utf8'));
  for (const c of rec.claims ?? []) {
    if (since ? !changed(id, c) : !allClaims && c.editor !== 'ai-draft') continue;
    // A claim may cite a source without quoting it; there is nothing to match.
    if (!c.excerpt) continue;
    checked++;
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
console.log(failed ? `\n${failed} claim(s) failed.` : checked ? `\nAll ${checked} checked excerpts found.` : '\nNo quoted claims to check.');
process.exit(failed ? 1 : 0);
