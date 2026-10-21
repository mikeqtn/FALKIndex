// Exercise the built SSR app anonymously, not obsolete static HTML on disk.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp,attachProductionSite } from '../server/index.ts';

const dist = 'dist';
assert.ok(existsSync('dist/server/entry.mjs'),'Run npm run build before npm test');
const skip = false;
const app = createApp();
await attachProductionSite(app);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
after(() => new Promise<void>(resolve => server.close(() => resolve())));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const cache = new Map<string,string>();
async function snapshot(route: string, file: string) {
  const response = await fetch(`${base}${route}`);
  assert.equal(response.status,200,route);
  cache.set(join(dist,file),await response.text());
}
await snapshot('/data/falk.json','data/falk.json');
const dataset = JSON.parse(cache.get(join(dist,'data/falk.json'))!);
await snapshot('/data/falk.csv','data/falk.csv');
await snapshot('/data/schema.json','data/schema.json');
for (const watch of dataset.watches.filter((w:any) => w.profiles.some((p:any) => p.status==='published'))) {
  await snapshot(`/records/${watch.id}/`,`records/${watch.id}/index.html`);
  await snapshot(`/records/${watch.id}.json`,`records/${watch.id}.json`);
}
for (const route of ['sources','organizations/la-joux-perret','corrections','sign-up']) await snapshot(`/${route}/`,`${route}/index.html`);
const files = [...cache.keys()];
const read = (f: string) => {
  assert.ok(cache.has(f),`Missing rendered response ${f}`);
  return cache.get(f)!;
};
const AGGREGATE = /^(total|sum|average|avg|mean|aggregate|overall|score)$/i;

test('the production host serves the scripts and styles used by sign-up and catalogue pages', async () => {
  const assets = new Set<string>();
  for (const html of cache.values()) {
    for (const match of html.matchAll(/(?:src|href)="(\/_astro\/[^"]+)"/g)) assets.add(match[1]);
  }
  assert.ok(assets.size>1,'Expected built CSS and JavaScript assets');
  for (const asset of assets) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status,200,asset);
    assert.doesNotMatch(response.headers.get('content-type') ?? '',/text\/html/,asset);
    if (asset.endsWith('.css')) assert.match(response.headers.get('content-type') ?? '',/text\/css/);
  }
});

test('every published record has a PNG share image', async () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47];
  for (const watch of dataset.watches.filter((w:any) => w.profiles.some((p:any) => p.status==='published'))) {
    const response = await fetch(`${base}/og/records/${watch.id}.png`);
    assert.equal(response.status,200,watch.id);
    assert.equal(response.headers.get('content-type'),'image/png',watch.id);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).subarray(0,4)],PNG,watch.id);
  }
  assert.equal((await fetch(`${base}/og/records/nobody/nothing.png`)).status,404);
});

test('the sitemap lists every record and no private page; robots.txt points to it', async () => {
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  for (const watch of dataset.watches.filter((w:any) => w.profiles.some((p:any) => p.status==='published'))) {
    assert.ok(sitemap.includes(`/records/${watch.id}/</loc>`),watch.id);
  }
  assert.doesNotMatch(sitemap,/\/(account|admin|editor|sign-in|sign-up)/);
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots,/^Disallow: \/admin\/$/m);
  assert.match(robots,/^Sitemap: .+\/sitemap\.xml$/m);
});

test('pages carry baseline security headers, and production also blocks framing', async () => {
  const dev = await fetch(`${base}/`);
  assert.equal(dev.headers.get('x-content-type-options'),'nosniff');
  assert.equal(dev.headers.get('referrer-policy'),'strict-origin-when-cross-origin');
  assert.equal(dev.headers.get('x-frame-options'),null,'the Replit preview frame must keep working in development');
  assert.match(dev.headers.get('content-security-policy') ?? '',/img-src 'self' data: https:\/\/img\.clerk\.com(;|$)/);
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const prod = await fetch(`${base}/`);
    assert.equal(prod.headers.get('x-frame-options'),'DENY');
    assert.match(prod.headers.get('content-security-policy') ?? '',/frame-ancestors 'none'/);
    assert.match(prod.headers.get('strict-transport-security') ?? '',/max-age=\d+/);
  } finally { process.env.NODE_ENV = env; }
});

test('only readers with a Clerk session load the account menu; everyone else gets plain links', async () => {
  const page = async (cookie?: string) => (await fetch(`${base}/methodology/`,{headers:cookie ? {cookie} : {}})).text();
  for (const html of [await page(), await page('__client_uat=0')]) {
    assert.match(html,/<a href="\/sign-in">Sign in<\/a>/);
    assert.doesNotMatch(html,/AccountNavigation/);
  }
  for (const cookie of ['__client_uat=1791917601','__client_uat_Ab1-x=1791917601; theme=dark']) {
    assert.match(await page(cookie),/<astro-island[^>]*AccountNavigation/,cookie);
  }
});

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
  const pages = files.filter(f => /records\/[^/]+\/[^/]+\/index\.html$/.test(f) && !read(f).includes('http-equiv="refresh"'));
  const published = JSON.parse(read(join(dist, 'data/falk.json'))).watches.filter((w: any) => w.profiles.some((p: any) => p.status === 'published'));
  assert.equal(pages.length, published.length);
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

test('sources, supplier and corrections pages are built', { skip }, () => {
  const sourcesPage = read(join(dist, 'sources/index.html'));
  const sourceIds = JSON.parse(read(join(dist, 'data/falk.json'))).sources.length;
  assert.equal(sourcesPage.match(/<li data-tier=/g)?.length, sourceIds, 'every source is listed');
  const ljp = read(join(dist, 'organizations/la-joux-perret/index.html'));
  assert.match(ljp, /Where La Joux-Perret appears/);
  assert.match(ljp, /records\/awake\/son-mai-guilloche-main\//);
  const corrections = read(join(dist, 'corrections/index.html'));
  assert.match(corrections, /<form id="correction"[^>]*action="\/api\/corrections"/);
  assert.match(corrections, /stored privately for editors/);
  assert.doesNotMatch(corrections, /github\.com\/mikeqtn\/FALKIndex\/issues\/new|PUBLIC_CORRECTIONS_ENDPOINT/);
});
