// Exercise the built SSR app anonymously, not obsolete static HTML on disk.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { keepBaseline, toReportOnly } from '../server/csp.ts';
import { createApp,attachProductionSite } from '../server/index.ts';
import { DIRECT_BRANDS, RETAIL_BRANDS, publisherTie } from '../src/lib/publisher.ts';
import { hostPolicy } from '../server/middlewares/siteHost.ts';

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
for (const route of ['sources','organizations/la-joux-perret','corrections','records/new','account/contributions','sign-up','archetypes','terms']) await snapshot(`/${route}/`,`${route}/index.html`);
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

test('pages without their own share image use the site card; structured data parses', async () => {
  const card = await fetch(`${base}/og/site.png`);
  assert.equal(card.status,200);
  assert.equal(card.headers.get('content-type'),'image/png');
  const ld = async (path:string) => [...(await (await fetch(`${base}${path}`)).text()).matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(m => JSON.parse(m[1]));
  assert.equal((await ld('/'))[0]['@type'],'WebSite');
  const [data] = await ld('/data/');
  assert.equal(data['@type'],'Dataset');
  assert.equal(data.distribution.length,2);
  const watch = dataset.watches.find((w:any) => w.profiles.some((p:any) => p.status==='published')).id;
  const [crumbs] = await ld(`/records/${watch}/`);
  assert.equal(crumbs['@type'],'BreadcrumbList');
  assert.match(crumbs.itemListElement.at(-1).item,new RegExp(`/records/${watch}/$`));
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

test('pages send a report-only script policy that hashes every inline script', async () => {
  // The forum has its own layout, so it is checked separately; a new is:inline script there would go unhashed.
  for (const [route, cookie] of [['/',''],['/records/',''],['/sign-in',''],['/methodology/','__client_uat=1791917601'],['/forum/',''],['/forum/new','__client_uat=1791917601']]) {
    const response = await fetch(`${base}${route}`,{headers:cookie ? {cookie} : {}});
    const policy = response.headers.get('content-security-policy-report-only') ?? '';
    const scriptSrc = policy.split(';').find(d => d.trim().startsWith('script-src')) ?? '';
    assert.ok(scriptSrc,`${route}: no report-only script-src`);
    assert.doesNotMatch(scriptSrc,/'unsafe-inline'|'unsafe-eval'/,route);
    assert.match(scriptSrc,/https:\/\/clerk\.127\.0\.0\.1(\s|$)/,`${route}: Clerk's per-host script origin`);
    // Clerk Protect runs on sign-in: its scripts, and probes on several ports.
    assert.match(scriptSrc,/https:\/\/cdn\.protect\.clerk\.com https:\/\/\*\.client\.protect\.clerk\.com/,route);
    assert.match(policy,/connect-src [^;]*https:\/\/\*\.client\.protect\.clerk\.com:\*/,route);
    assert.match(policy,/report-uri \/csp-report/);
    assert.equal(response.headers.get('reporting-endpoints'),'csp="/csp-report"');
    // The enforced baseline stays separate and unchanged.
    assert.match(response.headers.get('content-security-policy') ?? '',/img-src 'self' data: https:\/\/img\.clerk\.com/);
    const html = await response.text();
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(([,attrs]) => !/type="application\/(ld\+)?json"/.test(attrs!));
    assert.ok(inline.length >= 2,`${route}: expected the layout's inline scripts`);
    for (const [,,body] of inline) {
      const hash = createHash('sha256').update(body!).digest('base64');
      assert.ok(scriptSrc.includes(`'sha256-${hash}'`),`${route}: inline script without a hash: ${body!.trim().slice(0,60)}`);
    }
  }
});

test('CSP reports in both browser formats are accepted and logged without query strings', async () => {
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => { logged.push(line); };
  try {
    const post = (type: string, body: string) => fetch(`${base}/csp-report`,{method:'POST',headers:{'content-type':type},body});
    assert.equal((await post('application/csp-report',JSON.stringify({'csp-report':{'document-uri':'https://falkindex.com/records/?q=private','effective-directive':'script-src-elem','blocked-uri':'inline'}}))).status,204);
    assert.equal((await post('application/reports+json',JSON.stringify([{type:'csp-violation',body:{documentURL:'https://falkindex.com/a?token=x',effectiveDirective:'script-src-elem',blockedURL:'https://cdn.example/x.js?v=1'}}]))).status,204);
    // Safari sends one Reporting API object, not an array, under the legacy content type.
    assert.equal((await post('application/csp-report',JSON.stringify({type:'csp-violation',body:{documentURL:'https://falkindex.com/b',effectiveDirective:'script-src-attr',blockedURL:'inline'}}))).status,204);
    assert.equal((await post('application/csp-report','{"csp-report":{}}')).status,204);
    assert.equal((await post('text/plain','hello')).status,204);
    assert.equal((await post('application/csp-report',JSON.stringify({'csp-report':{x:'a'.repeat(20000)}}))).status,413);
  } finally { console.warn = warn; }
  const events = logged.map(line => JSON.parse(line)).filter(e => e.event === 'csp.violation');
  assert.deepEqual(events.map(e => [e.page,e.blocked]),[['https://falkindex.com/records/','inline'],['https://falkindex.com/a','https://cdn.example/x.js'],['https://falkindex.com/b','inline']]);
});

test('enforcing the page policy keeps the baseline policy as a second header', () => {
  const headers: Record<string,string|string[]> = {'content-security-policy':"script-src 'self'"};
  keepBaseline(headers,"frame-ancestors 'none'");
  assert.deepEqual(headers['content-security-policy'],["frame-ancestors 'none'","script-src 'self'"]);
  assert.deepEqual(toReportOnly({'Content-Security-Policy':"script-src 'self'"}),{'Content-Security-Policy-Report-Only':"script-src 'self'"});
});

test('a forged host cannot add sources to the page policy', async () => {
  const response = await fetch(`${base}/`,{headers:{'x-forwarded-host':"a.com; script-src *"}});
  const policy = response.headers.get('content-security-policy-report-only') ?? '';
  assert.doesNotMatch(policy,/a\.com|script-src \*/);
  assert.match(policy,/script-src 'self'/);
});

test('with an allowlist, a well-formed but unlisted host never reaches the page policy', async () => {
  const listed = createApp(hostPolicy({SITE_HOSTS:'127.0.0.1'}));
  await attachProductionSite(listed);
  const strict = createServer(listed);
  await new Promise<void>(resolve => strict.listen(0,'127.0.0.1',resolve));
  try {
    const port = (strict.address() as {port:number}).port;
    const response = await fetch(`http://127.0.0.1:${port}/`,{headers:{'x-forwarded-host':'evil.example'}});
    const policy = response.headers.get('content-security-policy-report-only') ?? '';
    assert.doesNotMatch(policy,/evil\.example/);
    assert.match(policy,/https:\/\/clerk\.127\.0\.0\.1[ ;]/);
  } finally { strict.closeAllConnections(); await new Promise<void>(resolve => strict.close(() => resolve())); }
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

test('signed in, the server draws the account links so the menu does not wait for Clerk', async () => {
  const headers = { cookie:'__client_uat=1791917601' };
  const site = await (await fetch(`${base}/methodology/`,{headers})).text();
  assert.match(site,/<a href="\/account">Account<\/a><button type="button" disabled[^>]*>Sign out<\/button>/);
  const forum = await (await fetch(`${base}/forum/threads/`,{headers})).text();
  assert.match(forum,/<a href="\/forum\/notifications\/">Replies<\/a><a href="\/account">Account<\/a><button type="button" disabled[^>]*>Sign out<\/button>/);
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
    // Confidence D shows provenance notes instead of a profile (DESIGN.md §4.1), so it has no strip.
    if (html.includes('class="no-profile"')) { assert.equal(strip, '', f); continue; }
    assert.equal(strip.match(/<th scope="row"/g)?.length, 7, f);
    assert.doesNotMatch(strip, /<tfoot/, f);
    assert.doesNotMatch(html, /\b(total|average|overall|aggregate) (score|profile)\b/i, f);
  }
});

test('published evidence repeats the strip scores; a draft gets its own section', { skip }, () => {
  for (const f of files.filter(f => /records\/[^/]+\/[^/]+\/index\.html$/.test(f))) {
    const html = read(f);
    if (html.includes('class="no-profile"')) continue; // confidence D: no strip to repeat
    const strip = [...(html.match(/<table class="strip[^"]*">([\s\S]*?)<\/table>/)?.[1] ?? '').matchAll(/<span class="num"[^>]*>([^<]+)</g)].map(m => m[1]);
    const section = html.match(/class="block evidence-section"[\s\S]*?<\/section>/)?.[0] ?? '';
    const evidence = [...section.matchAll(/<span class="code"[^>]*>[A-Z]{2} ([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(evidence, strip, f);
    assert.equal(html.includes('Draft under review'), html.includes('id="draft-evidence-ma"'), f);
  }
  const fleming = read(join(dist, 'records/fleming/series-1/index.html'));
  assert.doesNotMatch(fleming, /Provisional record|v0\.2 reference dataset/, 'an evidenced record still shows seed wording');
  assert.match(fleming, /Based on the cited sources below.*Brands can <a href="[^"]+"[^>]*>reply with evidence/s, 'records carry the right-of-reply note');
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
  assert.match(read(join(dist, 'terms/index.html')), /CC BY-SA 4\.0[\s\S]*at least 13/, 'terms cover licensing and minimum age');
  assert.match(read(join(dist, 'terms/index.html')), /published by Falk Watches, LLC[\s\S]*endorse or sponsor[\s\S]*Legal notices[\s\S]*penalty of perjury/, 'terms name the publisher and cover trademarks, legal notices and copyright');
  assert.doesNotMatch(corrections, /github\.com\/mikeqtn\/FALKIndex\/issues\/new|PUBLIC_CORRECTIONS_ENDPOINT/);
});

test('every methodology archetype has plain-English copy and its own section on /archetypes/, with no aggregate', { skip }, async () => {
  const { ARCHETYPES } = await import('../src/lib/archetypes.ts');
  const codes = dataset.methodologies.flatMap((m: any) => m.classifications).filter((c: any) => c.kind === 'archetype').map((c: any) => c.code);
  assert.deepEqual(Object.keys(ARCHETYPES).sort(), [...new Set(codes)].sort(), 'archetype copy matches the methodology');
  const page = read(join(dist, 'archetypes/index.html'));
  for (const code of new Set<string>(codes)) assert.match(page, new RegExp(`id="${code.replaceAll('_', '-')}"`), code);
  assert.doesNotMatch(page, />\s*(Total|Overall|Average)\b/, 'no summary figure on the archetypes page');
});

test('records of brands the publisher sells carry a disclosure, and only those', () => {
  for (const id of [...DIRECT_BRANDS, ...RETAIL_BRANDS]) assert.ok(dataset.organizations.some((o: any) => o.id === id), `${id} is not a catalogue brand`);
  for (const watch of dataset.watches.filter((w: any) => w.profiles.some((p: any) => p.status === 'published'))) {
    const html = read(join(dist, `records/${watch.id}/index.html`));
    assert.equal(html.includes('Disclosure: FALK'), !!publisherTie(watch.brand), watch.id);
    if (DIRECT_BRANDS.has(watch.brand)) assert.match(html, /deals directly with this brand/, watch.id);
  }
});

test('the forum links to the terms and privacy pages, and the publisher is named', async () => {
  const forum = await (await fetch(`${base}/forum/`)).text();
  assert.match(forum, /href="[^"]*\/terms\/"/);
  assert.match(forum, /href="[^"]*\/privacy\/"/);
  assert.match(read(join(dist, 'terms/index.html')), /Falk Watches, LLC/);
});

test('the forum renders for anonymous readers, and record pages link to their discussions', async () => {
  const record = dataset.watches.find((w:any) => w.profiles.some((p:any) => p.status==='published')).id;
  for (const path of ['/forum/', '/forum/search/?q=movement', `/forum/records/${record}/`, '/forum/notifications/']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /FALK Forum/, path);
    assert.doesNotMatch(html, /class="site-nav"|class="site-footer"/, `${path} is its own site, without the main site's header or footer`);
  }
  for (const path of ['/forum/no-such-category/', '/forum/t/not-a-thread', '/forum/records/no/such-record/', '/forum/no/such/page/'])
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  assert.match(read(join(dist, `records/${record}/index.html`)), new RegExp(`href="/forum/records/${record}/"`));
});

test('forum tabs load ahead of the click, but Start a thread does not', async () => {
  const html = await (await fetch(`${base}/forum/threads/`)).text();
  const links = [...html.matchAll(/<a\b[^>]*>/g)].map(m => m[0]);
  const marked = (href: string) => links.filter(a => a.includes(`href="${href}"`)).some(a => a.includes('data-astro-prefetch'));
  assert.ok(marked('?sort=newest'), 'sort tabs');
  assert.ok(marked('/forum/threads/'), 'sidebar');
  assert.ok(!marked('/forum/new/'), 'Start a thread redirects to sign-in when signed out');
});

test('signed out, "Start a thread" goes to sign-in and comes back to the form', async () => {
  const open = (path: string, cookie = '') => fetch(`${base}${path}`, { redirect:'manual', headers:{ cookie } });
  const out = await open('/forum/new/?category=general');
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), `/sign-in?redirect_url=${encodeURIComponent('/forum/new/?category=general')}`);
  assert.equal((await open('/forum/new/', '__client_uat=0')).status, 302, 'signed out sets this cookie to 0');
  assert.equal((await open('/forum/new/', '__client_uat=1791917601')).status, 200, 'signed in, the link goes to the form');
});

test('data embedded in pages cannot close its own script tag', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const blocks = [...html.matchAll(/<script type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length >= 3, 'structured data, search suggestions and compare data');
  for (const block of blocks) {
    assert.doesNotMatch(block, /</, 'every < is escaped as \\u003c');
    JSON.parse(block);
  }
});

test('the main site and the forum do not load each other\'s stylesheets on their sign-in pages', async () => {
  const css = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    const sheets = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(m => m[1]);
    assert.ok(sheets.length, `${path} loads a stylesheet`);
    return { html, styles:(await Promise.all(sheets.map(async s => (await fetch(`${base}${s}`)).text()))).join('\n') };
  };
  for (const path of ['/sign-in', '/sign-up']) {
    const main = await css(path);
    assert.match(main.html, /class="site-nav"/, path);
    assert.doesNotMatch(main.styles, /\.f-frame|account-auth-slot[^{]*\{[^}]*max-width/, `${path} has no forum styles`);
    const forum = await css(`/forum${path}/`);
    assert.match(forum.html, /class="f-frame"/, path);
    assert.doesNotMatch(forum.styles, /\.site-nav|account-auth-slot[^{]*\{[^}]*max-width/, `the forum's ${path} has no main-site styles`);
  }
});

test('forum pages allow sign-in through the main site', async () => {
  for (const route of ['/forum/', '/forum/sign-in/']) {
    const response = await fetch(`${base}${route}`, { headers:{ 'x-forwarded-host':'forum.falkindex.com' } });
    const policy = response.headers.get('content-security-policy-report-only') ?? '';
    const directive = (name: string) => policy.split(';').find(d => d.trim().startsWith(`${name} `)) ?? '';
    for (const name of ['script-src', 'connect-src']) {
      assert.match(directive(name), /https:\/\/falkindex\.com(\s|$)/, `${route} ${name}`);
      assert.match(directive(name), /https:\/\/clerk\.falkindex\.com(\s|$)/, `${route} ${name}`);
      assert.doesNotMatch(directive(name), /clerk\.forum\.falkindex\.com/, `${route} ${name}`);
    }
  }
});

test('pages and share images are rate limited per visitor; static files are not counted', async () => {
  const limited = createApp();
  await attachProductionSite(limited,{mode:'enforce',pagesPerMinute:2,imagesPerMinute:1,log:() => {}});
  const strict = createServer(limited);
  await new Promise<void>(resolve => strict.listen(0,'127.0.0.1',resolve));
  try {
    const at = `http://127.0.0.1:${(strict.address() as {port:number}).port}`;
    const asset = (await import('node:fs')).readdirSync('dist/client/_astro').find(f => f.endsWith('.js'))!;
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${at}/_astro/${asset}`)).status,200,'static files are free');
    assert.equal((await fetch(`${at}/about/`)).status,200);
    assert.equal((await fetch(`${at}/methodology/`)).status,200);
    const blocked = await fetch(`${at}/sources/`);
    assert.equal(blocked.status,429);
    assert.ok(blocked.headers.get('retry-after'));
    assert.equal((await fetch(`${at}/og/site.png`)).status,200);
    assert.equal((await fetch(`${at}/og/site.png`)).status,429);
  } finally { strict.closeAllConnections(); await new Promise<void>(resolve => strict.close(() => resolve())); }
});

test('the main site and the forum share one set of colours, the logo mark and the record strip', async () => {
  const styles = async (path: string) => {
    const html = await (await fetch(`${base}${path}`)).text();
    const sheets = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(m => m[1]);
    return (await Promise.all(sheets.map(async s => (await fetch(`${base}${s}`)).text()))).join('\n');
  };
  const [main, forum] = await Promise.all([styles('/records/'), styles('/forum/')]);
  // Each hex value must appear in both stylesheets: page ground and ink, light and dark, and the action colour.
  for (const colour of ['#e8ebef', '#14233f', '#9c1a33', '#0b121e', '#ec7a8e'])
    for (const [site, css] of [['main site', main], ['forum', forum]])
      assert.ok(css.toLowerCase().includes(colour), `${site} has ${colour}`);
  assert.doesNotMatch(forum, /\.site-nav/, 'the forum keeps its own layout');
  for (const shared of ['.mark i', '.cstrip', '.cell.lu']) {
    assert.ok(main.includes(shared), `main site has ${shared}`);
    assert.ok(forum.includes(shared), `forum has ${shared}`);
  }
});

