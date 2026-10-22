// Open every public page on phone-sized screens in WebKit (Safari's engine), against the built app.
// Run with `npm run test:phone` after `npm run build`; it needs `npx playwright install webkit` once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { webkit, devices } from 'playwright';
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
  '/methodology/', '/sources/', '/data/', '/about/', '/organizations/tudor/', '/corrections/', '/no-such-page/'];

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
