import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postParagraphs } from '../src/lib/post-text.ts';

test('forum posts keep paragraphs and line breaks, and link only http(s) addresses', () => {
  assert.deepEqual(postParagraphs('First line\nsecond line\n\nNew paragraph'), [
    [[{ text:'First line' }], [{ text:'second line' }]],
    [[{ text:'New paragraph' }]],
  ]);
  assert.deepEqual(postParagraphs('See https://example.com/a?b=1.'), [[[
    { text:'See ' }, { text:'https://example.com/a?b=1', href:'https://example.com/a?b=1' }, { text:'.' },
  ]]]);
  for (const text of ['javascript:alert(1)', 'data:text/html,<b>x</b>', '<a href="https://x.test">x</a>'])
    assert.ok(postParagraphs(text).flat(2).every(p => !p.href || /^https?:\/\//.test(p.href)), text);
  assert.deepEqual(postParagraphs('<script>alert(1)</script>'), [[[{ text:'<script>alert(1)</script>' }]]], 'markup stays text');
});
