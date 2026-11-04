import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { saveTheme, THEME_SCRIPT } from '../src/lib/inline-scripts.mjs';

// Runs the inline script against a given cookie and localStorage value, and returns the theme it applied.
function applied(cookie: string, stored: string | null, storageThrows = false) {
  const documentElement = { dataset: {} as { theme?: string } };
  runInNewContext(THEME_SCRIPT, {
    document: { cookie, documentElement },
    localStorage: { getItem: () => { if (storageThrows) throw new Error('blocked'); return stored; } },
  });
  return documentElement.dataset.theme;
}

test('the shared cookie decides the theme, so both sites agree', () => {
  assert.equal(applied('falk-theme=dark', 'light'), 'dark');
  assert.equal(applied('__client_uat=1; falk-theme=light', 'dark'), 'light');
  assert.equal(applied('falk-theme=dark', null, true), 'dark', 'blocked storage does not matter');
});

test('without the cookie, a choice saved on this site still applies; otherwise the system setting does', () => {
  assert.equal(applied('', 'dark'), 'dark');
  assert.equal(applied('', null), undefined);
  assert.equal(applied('', null, true), undefined);
  assert.equal(applied('not-falk-theme=dark', null), undefined);
  assert.equal(applied('falk-theme=purple', 'nonsense'), undefined);
});

test('saveTheme shares the cookie across falkindex.com only, and keeps the local copy', () => {
  const saved = (hostname: string, protocol = 'https:') => {
    const stored: string[] = [], doc = { cookie:'' };
    Object.assign(globalThis, { document:doc, localStorage:{ setItem:(_: string, v: string) => stored.push(v) } });
    saveTheme('dark', { hostname, protocol });
    assert.deepEqual(stored, ['dark']);
    return doc.cookie;
  };
  for (const host of ['falkindex.com', 'forum.falkindex.com']) {
    assert.equal(saved(host), 'falk-theme=dark; Path=/; Max-Age=31536000; Domain=falkindex.com; SameSite=Lax; Secure');
  }
  assert.doesNotMatch(saved('notfalkindex.com'), /Domain/);
  assert.doesNotMatch(saved('falkindex.com.example.org'), /Domain/);
  assert.equal(saved('localhost', 'http:'), 'falk-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax');
});
