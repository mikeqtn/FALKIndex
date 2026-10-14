// Checks the built site (dist/) for the "no sums" rule. Run after `npm run build`; skipped if dist/ is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const skip = !existsSync(dist) && 'run npm run build first';
const files = skip ? [] : readdirSync(dist, { recursive: true, encoding: 'utf8' }).map(f => join(dist, f));
const read = (f: string) => readFileSync(f, 'utf8');
const AGGREGATE = /^(total|sum|average|avg|mean|aggregate|overall|score)$/i;

test('no exported JSON has an aggregate field', { skip }, () => {
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      assert.doesNotMatch(k, AGGREGATE, `${at}.${k}`);
      walk(x, `${at}.${k}`);
    }
  };
  // schema.json describes the fields, so its "properties" keys are checked by the same walk.
  for (const f of files.filter(f => f.endsWith('.json'))) walk(JSON.parse(read(f)), f);
});

test('the CSV has no aggregate column', { skip }, () => {
  const header = read(join(dist, 'data/falk.csv')).split('\n')[0].split(',');
  for (const h of header) assert.doesNotMatch(h, AGGREGATE);
});

test('every record page shows seven dimension rows and nothing that sums them', { skip }, () => {
  const pages = files.filter(f => /records\/[^/]+\/[^/]+\/index\.html$/.test(f));
  assert.equal(pages.length, 56);
  for (const f of pages) {
    const html = read(f);
    const strip = html.match(/<table class="strip[^"]*">([\s\S]*?)<\/table>/)?.[1] ?? '';
    assert.equal(strip.match(/<th scope="row"/g)?.length, 7, f);
    assert.doesNotMatch(strip, /<tfoot/, f);
    assert.doesNotMatch(html, /\b(total|average|overall|aggregate) (score|profile)\b/i, f);
  }
});

test('published evidence repeats the strip scores; a draft gets its own section', { skip }, () => {
  for (const f of files.filter(f => /records\/[^/]+\/[^/]+\/index\.html$/.test(f))) {
    const html = read(f);
    const strip = [...(html.match(/<table class="strip[^"]*">([\s\S]*?)<\/table>/)?.[1] ?? '').matchAll(/<span class="num"[^>]*>([^<]+)</g)].map(m => m[1]);
    const section = html.match(/class="block evidence-section"[\s\S]*?<\/section>/)?.[0] ?? '';
    const evidence = [...section.matchAll(/<span class="code"[^>]*>[A-Z]{2} ([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(evidence, strip, f);
    assert.equal(html.includes('Draft under review'), html.includes('id="draft-evidence-ma"'), f);
  }
  const fleming = read(join(dist, 'records/fleming/series-1/index.html'));
  assert.doesNotMatch(fleming, /Provisional record|v0\.2 reference dataset/, 'an evidenced record still shows seed wording');
});
