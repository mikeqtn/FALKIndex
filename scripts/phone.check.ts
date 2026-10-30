// Open every public page on phone-sized screens in WebKit (Safari's engine), against the built app.
// Run with `npm run test:phone` after `npm run build`; it needs `npx playwright install webkit` once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, webkit, devices } from 'playwright';
import { createApp, attachProductionSite } from '../server/index.ts';

assert.ok(existsSync('dist/server/entry.mjs'), 'Run npm run build before npm run test:phone');
const app = createApp();
await attachProductionSite(app);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const browser = await webkit.launch();
after(async () => { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); });

// One record with photos, one with a profile and none, one still at confidence D, plus every other public page.
const pages = ['/', '/records/', '/records/nomos/tangente-neomatik/', '/records/jn-shapiro/resurgence/', '/records/omega/speedmaster-moonwatch-3861/',
  '/archetypes/', '/methodology/', '/sources/', '/data/', '/about/', '/organizations/tudor/', '/corrections/', '/no-such-page/'];

for (const name of ['iPhone SE', 'iPhone 14']) {
  test(`${name}: no page scrolls sideways or throws`, async () => {
    const context = await browser.newContext({ ...devices[name], reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(`${page.url()}: ${e.message}`));
    for (const path of pages) {
      const response = await page.goto(`${base}${path}`, { waitUntil: 'load' });
      assert.equal(response!.status(), path === '/no-such-page/' ? 404 : 200, path);
      const { overflow, wide } = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        // The widest elements, to say where an overflow comes from.
        wide: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 3).map(el => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`),
      }));
      assert.ok(overflow <= 0, `${path} scrolls sideways by ${overflow}px on ${name} (${wide.join(', ')})`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// The header search sits in the sticky header. Scroll-padding on <html> once made the browser scroll
// the page up on every keystroke there, trying to bring the box out from "under" the header.
test('desktop: typing in the header search leaves the page where it is, and section links still clear the header', async () => {
  const desktop = await chromium.launch();
  try {
    const page = await desktop.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(`${base}/methodology/`, { waitUntil: 'load' });
    await page.evaluate(() => scrollTo(0, 1500));
    await page.locator('#nav-q').focus();
    for (const key of 'omega') await page.keyboard.type(key);
    assert.equal(await page.evaluate(() => scrollY), 1500);
    await page.evaluate(() => { (document.activeElement as HTMLElement).blur(); location.hash = 'rules'; });
    const gap = await page.evaluate(() => document.getElementById('rules')!.getBoundingClientRect().top - document.querySelector('.site-nav')!.getBoundingClientRect().bottom);
    assert.ok(gap >= 0 && gap < 40, `#rules lands ${gap}px below the header`);
  } finally { await desktop.close(); }
});

test('desktop: a header search suggestion opens that record, and a broad search still lists records', async () => {
  const desktop = await chromium.launch();
  try {
    const page = await desktop.newPage({ viewport: { width: 1400, height: 900 } });
    const search = async (text: string, pick?: 'click' | 'arrow') => {
      await page.goto(`${base}/methodology/`, { waitUntil: 'load' });
      await page.locator('#nav-q').fill(text);
      if (pick === 'click') await page.locator('#nav-suggest li[role="option"]').first().dispatchEvent('pointerdown');
      else { if (pick === 'arrow') await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); }
      // The methodology page is already loaded, so wait for the address to change, not for "load".
      await page.waitForURL(url => url.pathname !== '/methodology/');
      return new URL(page.url()).pathname + new URL(page.url()).search;
    };
    assert.equal(await search('speedmaster moonwatch', 'click'), '/records/omega/speedmaster-moonwatch-3861/');
    assert.equal(await search('speedmaster moonwatch', 'arrow'), '/records/omega/speedmaster-moonwatch-3861/');
    assert.equal(await search('speedmaster moonwatch'), '/records/omega/speedmaster-moonwatch-3861/', 'one match: Enter opens it');
    assert.match(await search('tudor'), /^\/records\/\?q=tudor$/, 'several matches: Enter searches');
  } finally { await desktop.close(); }
});

// The hero heading grows with window width but the hero was capped at window height, so on wide, short
// windows its buttons ran past the bottom of the tile and were cut off.
test('desktop: the home page hero keeps its buttons inside the tile on short, wide windows', async () => {
  const desktop = await chromium.launch();
  try {
    for (const [width, height] of [[1300, 560], [1440, 620], [1920, 600], [1440, 900]]) {
      const page = await desktop.newPage({ viewport: { width, height } });
      await page.goto(`${base}/`, { waitUntil: 'load' });
      const overflow = await page.evaluate(() => document.querySelector('.t-name-foot .actions')!.getBoundingClientRect().bottom
        - document.querySelector('.t-name')!.getBoundingClientRect().bottom);
      assert.ok(overflow <= 0, `at ${width}×${height} the hero buttons run ${overflow}px past the tile`);
      await page.close();
    }
  } finally { await desktop.close(); }
});

// Two automated accessibility (axe) findings: small tap targets on /sources/, and tabpanel on <article>.
test('desktop: source links are large enough to tap, and the archetype tab panels use an element that allows the role', async () => {
  const desktop = await chromium.launch();
  try {
    const page = await desktop.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${base}/sources/`, { waitUntil: 'load' });
    const small = await page.$$eval('.meta a', links => links.map(a => a.getBoundingClientRect().height).filter(h => h < 24));
    assert.deepEqual(small, [], 'every source link is at least 24px tall');
    await page.goto(`${base}/`, { waitUntil: 'load' });
    const panels = await page.$$eval('[role="tabpanel"]', els => els.map(el => el.tagName.toLowerCase()));
    assert.ok(panels.length > 0 && panels.every(tag => tag === 'section'), `tab panels are ${[...new Set(panels)]}`);
  } finally { await desktop.close(); }
});
