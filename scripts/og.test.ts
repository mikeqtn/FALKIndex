import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sitePng } from '../src/lib/og.ts';

// Drawing a share image blocks the server for a moment, so the same image is drawn once and then reused.
test('a share image is drawn once and reused until its content changes', () => {
  const first = sitePng(57);
  assert.ok(first.length > 1000, 'a real PNG');
  assert.equal(sitePng(57), first, 'reused, not redrawn');
  const changed = sitePng(58);
  assert.notEqual(changed, first, 'new content draws a new image');
  assert.equal(sitePng(58), changed);
});
