import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { decisionEmail, notifyAuthor } from '../server/notify.ts';

// Only calls to Postmark are faked. No database: the lookup is a stand-in.
const realFetch = globalThis.fetch;
let sent: any[] = [];
let postmark: () => Response | Promise<Response> = () => Response.json({ ErrorCode: 0 });
globalThis.fetch = (async (url: any, init?: any) => {
  if (!String(url).startsWith('https://api.postmarkapp.com/')) return realFetch(url, init);
  sent.push(JSON.parse(init.body));
  return postmark();
}) as typeof fetch;
beforeEach(() => { sent = []; postmark = () => Response.json({ ErrorCode: 0 }); process.env.POSTMARK_SERVER_TOKEN = 'test-token'; });
after(() => { globalThis.fetch = realFetch; });
const member = (overrides = {}) => ({ query: async () => ({ rows: [{ username: 'contributor_1', email: 'member@example.test',
  subject: 'New watch: Nomos Club\nBcc: victim@example.test', original_proposal: { type: 'new_watch' }, ...overrides }] }) }) as any;
const nobody = { query: async () => ({ rows: [] }) } as any;

test('each decision has its own wording, with the editor note and the right link', () => {
  const base = { username: 'contributor_1', subject: 'New watch: Nomos Club', newWatch: true, note: 'Line one.\nLine two.', record: null };
  const ask = decisionEmail({ ...base, action: 'request_info' });
  assert.equal(ask.subject, 'FALK Index: A question about your proposal for Nomos Club');
  assert.match(ask.text, /> Line one\.\n> Line two\./);
  assert.match(ask.text, /Reply on My contributions: https:\/\/falkindex\.com\/account\/contributions\//);
  const live = decisionEmail({ ...base, action: 'approve', record: 'nomos/club' });
  assert.equal(live.subject, 'FALK Index: Your watch is live: Nomos Club');
  assert.match(live.text, /https:\/\/falkindex\.com\/records\/nomos\/club\//);
  const fixed = decisionEmail({ ...base, action: 'approve', newWatch: false, subject: 'Tudor Black Bay 58' });
  assert.equal(fixed.subject, 'FALK Index: Your correction was accepted');
  assert.match(fixed.text, /your correction to Tudor Black Bay 58/);
  assert.equal(decisionEmail({ ...base, action: 'reject' }).subject, 'FALK Index: Your submission was not accepted');
});

test('a member is emailed at their account address, from the site, with replies to support', async () => {
  assert.equal(await notifyAuthor('id', 'approve', 'Looks right.', 'nomos/club', member()), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].To, 'member@example.test');
  assert.equal(sent[0].From, 'FALK Index <notifications@falkindex.com>');
  assert.equal(sent[0].ReplyTo, 'support@falkindex.com');
  assert.doesNotMatch(sent[0].Subject, /[\r\n]/, 'a watch name cannot add a header');
});

test('guests, deleted and suspended members get nothing, and a mail failure never throws', async () => {
  assert.equal(await notifyAuthor('id', 'reject', 'Not supported.', null, nobody), false);
  assert.equal(sent.length, 0);
  postmark = () => new Response('{"ErrorCode":300}', { status: 422 });
  assert.equal(await notifyAuthor('id', 'reject', 'Not supported.', null, member()), false);
  postmark = () => { throw new TypeError('network down'); };
  assert.equal(await notifyAuthor('id', 'reject', 'Not supported.', null, member()), false);
  delete process.env.POSTMARK_SERVER_TOKEN;
  assert.equal(await notifyAuthor('id', 'reject', 'Not supported.', null, member()), false);
});
