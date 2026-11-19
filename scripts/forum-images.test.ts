import { test, after, before, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { crc32 } from 'node:zlib';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { PoolClient } from 'pg';
import { pool } from '../server/db.ts';
import { realm } from '../server/accounts.ts';
import { createApp } from '../server/index.ts';
import { FORUM_IMAGES_PER_HOUR, rateLimitKey } from '../server/api.ts';
import { addImage, clearUnattachedImages, createThread, editPost, FORUM_MAX_IMAGES, imageForServing, purgeImage, reply, replyInput, setImageHidden, setPostHidden, threadDetail } from '../server/forum.ts';
import { acquireImageUploadSlot, fromWorker, limitConcurrentImageUploads, loadImage, MAX_INPUT_EDGE, MAX_UPLOAD_BYTES, rebuildImage, removeImage, storeImage, THUMB_EDGE, UPLOAD_DEADLINE_MS } from '../server/forumImages.ts';

let dir = '';
before(async () => { dir = await mkdtemp(join(tmpdir(), 'falk-images-')); process.env.FORUM_IMAGE_DIR = dir; });
after(async () => { await rm(dir, { recursive:true, force:true }); delete process.env.FORUM_IMAGE_DIR; await pool.end(); });

const picture = (format: 'jpeg' | 'png' | 'webp', width = 64, height = 48) =>
  sharp({ create:{ width, height, channels:3, background:{ r:120, g:40, b:60 } } })[format]().toBuffer();

test('JPEG, PNG and WebP all come back as new WebP files with no metadata', async () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const { data, width, height } = await rebuildImage(await picture(format));
    assert.equal((await sharp(data).metadata()).format, 'webp');
    assert.deepEqual([width, height], [64, 48]);
  }
});

test('concurrent image uploads are capped and slots release only once', () => {
  const first = acquireImageUploadSlot(), second = acquireImageUploadSlot();
  assert.ok(first); assert.ok(second);
  assert.equal(acquireImageUploadSlot(), undefined, 'a third upload is rejected while both slots are active');
  first();
  first();
  const third = acquireImageUploadSlot();
  assert.ok(third, 'a slot becomes available after release');
  second();
  third();
  const reusable = acquireImageUploadSlot();
  assert.ok(reusable, 'all slots are reusable after release');
  reusable();
});

test('location data and other metadata do not survive', async () => {
  const withGps = await sharp({ create:{ width:32, height:32, channels:3, background:'#336699' } })
    .withExif({ IFD0:{ Copyright:'SECRET-COPYRIGHT' }, IFD3:{ GPSLatitudeRef:'N', GPSLatitude:'38/1 53/1 0/1' } }).jpeg().toBuffer();
  assert.ok((await sharp(withGps).metadata()).exif, 'the fixture really has EXIF');
  const { data } = await rebuildImage(withGps);
  const meta = await sharp(data).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.xmp, undefined);
  assert.ok(!data.toString('latin1').includes('SECRET-COPYRIGHT'));
});

test('anything hidden in or after a real image is gone', async () => {
  const marker = '<script>alert("FALK-PAYLOAD")</script>PK\x03\x04FALK-PAYLOAD';
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const polyglot = Buffer.concat([await picture(format), Buffer.from(marker, 'latin1')]);
    assert.ok(polyglot.toString('latin1').includes('FALK-PAYLOAD'));
    const { data } = await rebuildImage(polyglot);
    assert.ok(!data.toString('latin1').includes('FALK-PAYLOAD'), format);
  }
});

test('files that are not JPEG, PNG or WebP are refused, whatever they claim to be', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
  const gif = await sharp({ create:{ width:8, height:8, channels:3, background:'#000' } }).gif().toBuffer();
  const refused = {
    svg, gif, html:Buffer.from('<!doctype html><script>alert(1)</script>'), php:Buffer.from('<?php system($_GET["c"]); ?>'),
    exe:Buffer.from('MZ\x90\x00 this is not an image', 'latin1'), empty:Buffer.alloc(0),
    fakeJpeg:Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<script>alert(1)</script>')]),
    fakeWebp:Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WEBP', 'latin1'), Buffer.from('nonsense')]),
  };
  for (const [name, file] of Object.entries(refused)) await assert.rejects(rebuildImage(file), /could not be read/, name);
});

test('a truncated image and a decompression bomb are refused', async () => {
  const whole = await sharp({ create:{ width:600, height:600, channels:3, background:'#888', noise:{ type:'gaussian', mean:128, sigma:30 } } }).jpeg().toBuffer();
  await assert.rejects(rebuildImage(whole.subarray(0, Math.floor(whole.length / 2))), /could not be read/);
  const bomb = await sharp({ create:{ width:10000, height:10000, channels:3, background:'#fff' }, limitInputPixels:false }).png({ compressionLevel:9 }).toBuffer();
  assert.ok(bomb.length < MAX_UPLOAD_BYTES, 'small enough on disk to pass the size limit');
  await assert.rejects(rebuildImage(bomb), /could not be read/);
});

test('large images shrink, small ones do not grow, and camera rotation is applied', async () => {
  const big = await rebuildImage(await picture('jpeg', 4000, 1000));
  assert.deepEqual([big.width, big.height], [2000, 500]);
  const sideways = await sharp({ create:{ width:60, height:30, channels:3, background:'#123456' } }).withMetadata({ orientation:6 }).jpeg().toBuffer();
  const turned = await rebuildImage(sideways);
  assert.deepEqual([turned.width, turned.height], [30, 60]);
});

test('payloads inside the image\'s own comment and text blocks are gone', async () => {
  const marker = Buffer.from('<script>alert("FALK-PAYLOAD")</script>', 'latin1');
  // A JPEG comment segment (FF FE) straight after the start marker.
  const jpeg = await picture('jpeg');
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0, marker.length + 2]), marker]);
  const jpegWithComment = Buffer.concat([jpeg.subarray(0, 2), comment, jpeg.subarray(2)]);
  // A PNG tEXt chunk straight after the header chunk.
  const png = await picture('png');
  const body = Buffer.concat([Buffer.from('tEXtComment\0', 'latin1'), marker]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(body.length - 4, 0); body.copy(chunk, 4); chunk.writeUInt32BE(crc32(body), body.length + 4);
  const pngWithText = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
  for (const [name, file] of Object.entries({ jpegWithComment, pngWithText })) {
    assert.ok(file.toString('latin1').includes('FALK-PAYLOAD'), name);
    const { data, thumb } = await rebuildImage(file);
    assert.ok(!data.toString('latin1').includes('FALK-PAYLOAD') && !thumb.toString('latin1').includes('FALK-PAYLOAD'), name);
  }
});

test('very wide or very tall images are refused, even when their pixel count is allowed', async () => {
  for (const [width, height] of [[MAX_INPUT_EDGE + 1, 4], [4, MAX_INPUT_EDGE + 1]]) {
    const strip = await sharp({ create:{ width, height, channels:3, background:'#000' } }).png().toBuffer();
    await assert.rejects(rebuildImage(strip), /could not be read/, `${width}x${height}`);
  }
});

test('decoding runs in a separate process, which is killed when it runs too long', async () => {
  await assert.rejects(rebuildImage(await picture('png', 1600, 1200), { timeoutMs:1 }), /could not be read/);
  assert.equal((await rebuildImage(await picture('png'))).width, 64, 'the next upload still works');
});

test('a reply from the decoder is checked before it is trusted', async () => {
  const { data, thumb } = await rebuildImage(await picture('png'));
  assert.deepEqual(fromWorker({ data, thumb, width:64, height:48 }), { data, thumb, width:64, height:48 }, 'a real reply passes');
  const html = Buffer.from('<!doctype html><script>alert(1)</script>');
  for (const [name, reply] of Object.entries({
    html:{ data:html, thumb, width:64, height:48 }, htmlThumb:{ data, thumb:html, width:64, height:48 },
    hugeWidth:{ data, thumb, width:1e9, height:48 }, fraction:{ data, thumb, width:1.5, height:48 }, noWidth:{ data, thumb, height:48 },
    notBytes:{ data:'RIFF....WEBP', thumb, width:64, height:48 }, unknownRejection:{ rejected:'<script>' }, nothing:null,
  })) assert.deepEqual(fromWorker(reply), { rejected:'crashed' }, name);
});

test('refused uploads are logged with a reason and size, never their contents', async () => {
  const lines: string[] = [], php = Buffer.from('<?php system($_GET["c"]); ?> FALK-SECRET');
  const log = mock.method(console, 'error', (line: string) => { lines.push(line); });
  try {
    await assert.rejects(rebuildImage(php));
    await assert.rejects(rebuildImage((await picture('png')).subarray(0, 60)));
  } finally { log.mock.restore(); }
  assert.deepEqual(lines.map(line => JSON.parse(line)), [
    { event:'forum.image_rejected', reason:'not_an_image', bytes:php.length },
    { event:'forum.image_rejected', reason:'unreadable', bytes:60 },
  ]);
  assert.ok(!lines.join('').includes('FALK-SECRET'));
});

// The upload middleware with stand-ins for Express's request and response.
function startUpload(member: string) {
  const res = Object.assign(new EventEmitter(), { locals:{ member } as Record<string, unknown>, setHeader() {} });
  const req = Object.assign(new EventEmitter(), { destroyed:false, destroy() { this.destroyed = true; res.emit('close'); } });
  let error: unknown = 'next was not called';
  limitConcurrentImageUploads(req as never, res as never, (e?: unknown) => { error = e; });
  return { req, res, error };
}
test('a member uploads one image at a time, and an upload that stalls is cut off', () => {
  mock.timers.enable({ apis:['setTimeout'] });
  const open: EventEmitter[] = [];
  try {
    const alice = startUpload('alice'); open.push(alice.res);
    assert.equal(alice.error, undefined);
    const again = startUpload('alice');
    assert.match((again.error as Error).message, /other image/, 'a second upload from the same member waits');
    const bob = startUpload('bob'); open.push(bob.res);
    assert.equal(bob.error, undefined, 'another member is not held up');
    mock.timers.tick(UPLOAD_DEADLINE_MS - 1);
    assert.ok(!alice.req.destroyed);
    mock.timers.tick(1);
    assert.ok(alice.req.destroyed && bob.req.destroyed, 'a slow sender cannot hold a slot past the deadline');
    const next = startUpload('alice'); open.push(next.res);
    assert.equal(next.error, undefined, 'the cut-off upload gave back its slot');
  } finally { for (const res of open) res.emit('close'); mock.timers.reset(); }
});

test('if the small copy cannot be stored, the full image is not left behind', async () => {
  const id = randomUUID();
  await mkdir(join(dir, `${id}-thumb.webp`)); // a folder where the file should go makes that write fail
  try {
    const { data, thumb } = await rebuildImage(await picture('png'));
    await assert.rejects(storeImage(id, data, thumb));
    assert.ok(!(await readdir(dir)).includes(`${id}.webp`));
  } finally { await rm(join(dir, `${id}-thumb.webp`), { recursive:true, force:true }); }
});

// The rules for attaching, against the database. Everything is rolled back.
async function members(run: (db: PoolClient, m: Record<'alice' | 'bob' | 'editor' | 'admin', string>) => Promise<void>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const add = async (role: string) => (await db.query('INSERT INTO falk_account(realm,clerk_id,username,role,email_verified,status) VALUES($1,$2,$3,$4,true,$5) RETURNING id',
      [realm(), `test-${randomUUID()}`, `t_${randomUUID().slice(0, 8)}`, role, 'active'])).rows[0].id as string;
    await db.query("INSERT INTO falk_forum_category(id,name,description,position) VALUES('image-test','Test','For tests',99)");
    await run(db, { alice:await add('contributor'), bob:await add('contributor'), editor:await add('editor'), admin:await add('admin') });
  } finally { await db.query('ROLLBACK'); db.release(); }
}
const image = (who: string, db: PoolClient) => addImage(who, randomUUID(), { width:10, height:10, bytes:100 }, db);
const opening = (images: string[]) => ({ category:'image-test', title:'Photos of my watch', body:'Have a look.', images });

test('images attach to your own new post, once, and appear in order', () => members(async (db, m) => {
  const [one, two] = [await image(m.alice, db), await image(m.alice, db)];
  const { thread } = await createThread(m.alice, opening([two, one]), db);
  const post = (await threadDetail(thread, 1, null, db))!.posts[0];
  assert.deepEqual(post.images.map(i => i.id), [two, one]);
  await assert.rejects(reply(m.alice, thread, { body:'Again.', images:[one] }, db), /no longer available/, 'already attached');
  const bobs = await image(m.bob, db);
  await assert.rejects(reply(m.alice, thread, { body:'Stealing.', images:[bobs] }, db), /no longer available/, 'someone else\'s');
  await assert.rejects(reply(m.alice, thread, { body:'Nothing.', images:[randomUUID()] }, db), /no longer available/, 'does not exist');
}));

test('a post is limited to four images, without repeats', () => {
  const ids = Array.from({ length:FORUM_MAX_IMAGES + 1 }, () => randomUUID());
  assert.equal(replyInput.safeParse({ body:'Hi', images:ids }).success, false);
  assert.equal(replyInput.safeParse({ body:'Hi', images:ids.slice(0, FORUM_MAX_IMAGES) }).success, true);
  assert.equal(replyInput.safeParse({ body:'Hi', images:[ids[0], ids[0]] }).success, false);
});

test('only uploaders see unattached images; readers see attached ones until they or their post are hidden', () => members(async (db, m) => {
  const id = await image(m.alice, db);
  const view = async (viewer: { id: string, role: 'contributor' | 'editor' } | null) => (await imageForServing(id, async () => viewer, db)).allowed;
  const alice = { id:m.alice, role:'contributor' as const }, editor = { id:m.editor, role:'editor' as const };
  assert.deepEqual([await view(null), await view({ id:m.bob, role:'contributor' }), await view(alice)], [false, false, true]);
  const { thread, post } = await createThread(m.alice, opening([id]), db);
  assert.equal(await view(null), true);
  await setImageHidden(m.editor, id, true, 'Not a watch', db);
  assert.deepEqual([await view(null), await view(alice), await view(editor)], [false, false, true]);
  const hidden = (await threadDetail(thread, 1, null, db))!.posts[0].images[0];
  assert.deepEqual([hidden.hidden, hidden.hiddenReason], [true, null]);
  assert.equal((await threadDetail(thread, 1, editor, db))!.posts[0].images[0].hiddenReason, 'Not a watch');
  await setImageHidden(m.editor, id, false, 'Restored', db);
  assert.equal(await view(null), true);
  await setPostHidden(m.editor, post, true, 'Off topic', db);
  assert.equal(await view(null), false, 'hiding a post hides its images');
  assert.deepEqual((await threadDetail(thread, 1, null, db))!.posts[0].images, []);
  await assert.rejects(setImageHidden(m.alice, id, true, 'Mine', db), /permission/);
}));

test('only administrators purge, and a purged image is gone for everyone, with the decision audited', () => members(async (db, m) => {
  const id = await image(m.alice, db);
  const { thread } = await createThread(m.alice, opening([id]), db);
  await assert.rejects(purgeImage(m.editor, id, 'Illegal content', db), /permission/);
  await purgeImage(m.admin, id, 'Illegal content', db);
  assert.equal((await imageForServing(id, async () => ({ id:m.admin, role:'admin' }), db)).allowed, false);
  assert.deepEqual((await threadDetail(thread, 1, { id:m.admin, role:'admin' }, db))!.posts[0].images, []);
  assert.equal((await db.query("SELECT count(*)::int c FROM falk_audit_event WHERE action='forum_image_purged' AND actor_id=$1", [m.admin])).rows[0].c, 1);
}));

test('editing a post removes, adds and reorders its images', () => members(async (db, m) => {
  const [one, two, three] = [await image(m.alice, db), await image(m.alice, db), await image(m.alice, db)];
  const { thread, post } = await createThread(m.alice, opening([one, two]), db);
  const shown = async () => (await threadDetail(thread, 1, null, db))!.posts[0].images.map(i => i.id);
  await editPost(m.alice, post, { body:'Have a look.' }, db);
  assert.deepEqual(await shown(), [one, two], 'leaving images out of the edit keeps them');
  const { removedImages } = await editPost(m.alice, post, { body:'Swapped one.', images:[three, two] }, db);
  assert.deepEqual(removedImages, [one]);
  assert.deepEqual(await shown(), [three, two]);
  assert.equal((await imageForServing(one, async () => ({ id:m.admin, role:'admin' }), db)).allowed, false, 'a removed image is gone for everyone');
  assert.equal((await db.query("SELECT count(*)::int c FROM falk_audit_event WHERE action='forum_image_removed' AND actor_id=$1", [m.alice])).rows[0].c, 1);
  await assert.rejects(editPost(m.alice, post, { body:'Back.', images:[one] }, db), /no longer available/, 'a removed image cannot come back');
  await assert.rejects(editPost(m.alice, post, { body:'Theirs.', images:[await image(m.bob, db)] }, db), /no longer available/, 'someone else\'s upload');
  const { post:other } = await reply(m.alice, thread, { body:'More.', images:[await image(m.alice, db)] }, db);
  const elsewhere = (await threadDetail(thread, 1, null, db))!.posts.find(p => p.id === other)!.images[0].id;
  await assert.rejects(editPost(m.alice, post, { body:'Moved.', images:[elsewhere] }, db), /no longer available/, 'an image on another post');
  await editPost(m.alice, post, { body:'None.', images:[] }, db);
  assert.deepEqual(await shown(), []);
}));

test('editing keeps images a moderator hid, and they count toward the limit', () => members(async (db, m) => {
  const ids = await Promise.all(Array.from({ length:FORUM_MAX_IMAGES }, () => image(m.alice, db)));
  const { thread, post } = await createThread(m.alice, opening(ids), db);
  await setImageHidden(m.editor, ids[0], true, 'Not a watch', db);
  const { removedImages } = await editPost(m.alice, post, { body:'Fewer.', images:[ids[1]] }, db);
  assert.deepEqual(removedImages.sort(), [ids[2], ids[3]].sort());
  const left = (await threadDetail(thread, 1, { id:m.editor, role:'editor' }, db))!.posts[0].images.map(i => i.id).sort();
  assert.deepEqual(left, [ids[0], ids[1]].sort());
  const extra = await Promise.all([1, 2, 3].map(() => image(m.alice, db)));
  await assert.rejects(editPost(m.alice, post, { body:'Too many.', images:[ids[1], ...extra] }, db), /up to/);
}));

test('only your own day-old unattached images are cleared', () => members(async (db, m) => {
  const [old, fresh, others] = [await image(m.alice, db), await image(m.alice, db), await image(m.bob, db)];
  const kept = await image(m.alice, db);
  await storeImage(old, Buffer.from('expired image bytes'));
  await createThread(m.alice, opening([kept]), db);
  await db.query("UPDATE falk_forum_image SET created_at=now()-interval '2 days' WHERE id=ANY($1)", [[old, others, kept]]);
  assert.deepEqual(await clearUnattachedImages(m.alice, db), [old]);
  await assert.rejects(loadImage(old));
  const left = (await db.query('SELECT id FROM falk_forum_image WHERE id=ANY($1)', [[old, fresh, others, kept]])).rows.map(r => r.id).sort();
  assert.deepEqual(left, [fresh, others, kept].sort());
}));

test('the stored file round-trips and removal is final', async () => {
  const id = randomUUID(), { data } = await rebuildImage(await picture('png'));
  await storeImage(id, data);
  assert.deepEqual(await loadImage(id), data);
  assert.deepEqual(await readdir(dir).then(f => f.includes(`${id}.webp`)), true);
  await removeImage(id);
  await removeImage(id);
  await assert.rejects(loadImage(id));
});

test('over HTTP: uploads need an account and an allowed type, and unknown images are 404', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const send = (type: string) => fetch(`${base}/api/forum/images`, { method:'POST', headers:{ 'Content-Type':type, Origin:base }, body:Buffer.from('x') });
    assert.equal((await send('image/png')).status, 401);
    assert.equal((await send('image/svg+xml')).status, 415);
    assert.equal((await send('text/html')).status, 415);
    assert.equal((await fetch(`${base}/api/forum/images`, { method:'POST', headers:{ 'Content-Type':'image/png' }, body:Buffer.from('x') })).status, 403, 'other sites cannot post');
    assert.equal((await fetch(`${base}/api/forum/images/${randomUUID()}`)).status, 404);
    assert.equal((await fetch(`${base}/api/forum/images/not-an-id`)).status, 400);
  } finally { server.closeAllConnections(); server.close(); }
});

test('over HTTP: image uploads are capped per hour counting every attempt, and image paths take only ids', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const key = rateLimitKey('forum-image', '127.0.0.1');
  const clear = () => pool.query('DELETE FROM falk_rate_limit WHERE key=$1', [key]);
  await clear();
  try {
    // A JPEG name and type on an executable: refused before anything reads it, and still counted.
    const send = () => fetch(`${base}/api/forum/images?name=malware.php.jpg`, { method:'POST', headers:{ 'Content-Type':'image/jpeg', Origin:base }, body:Buffer.from('MZ\x90\x00', 'latin1') });
    for (let i = 0; i < FORUM_IMAGES_PER_HOUR; i++) assert.equal((await send()).status, 401);
    const limited = await send();
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /last hour/);
    for (const path of ['..%2F..%2Fetc%2Fpasswd', '%2E%2E%2Fpackage.json', `${randomUUID()}.webp`]) {
      assert.equal((await fetch(`${base}/api/forum/images/${path}`)).status, 400, path);
    }
  } finally { await clear(); server.closeAllConnections(); server.close(); }
});

test('a small copy is kept with each image, and made on first request for images stored before them', async () => {
  const { data, thumb } = await rebuildImage(await picture('png', 1600, 1200));
  const small = await sharp(thumb).metadata();
  assert.deepEqual([small.format, Math.max(small.width!, small.height!)], ['webp', THUMB_EDGE]);
  const fresh = randomUUID();
  await storeImage(fresh, data, thumb);
  assert.deepEqual(await loadImage(fresh, 'thumb'), thumb);
  // An image from before small copies: only the full one is stored, so the first request makes and keeps one.
  const older = randomUUID();
  await storeImage(older, data);
  const made = await loadImage(older, 'thumb');
  assert.equal(Math.max(...[await sharp(made).metadata()].map(m => Math.max(m.width!, m.height!))), THUMB_EDGE);
  for (let i = 0; i < 50 && !(await readdir(dir)).includes(`${older}-thumb.webp`); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok((await readdir(dir)).includes(`${older}-thumb.webp`), 'kept for next time');
  // Removing an image takes both copies, from storage and from memory.
  for (const id of [fresh, older]) {
    await removeImage(id);
    await assert.rejects(loadImage(id));
    await assert.rejects(loadImage(id, 'thumb'));
  }
  assert.ok(!(await readdir(dir)).some(f => f.startsWith(fresh) || f.startsWith(older)));
});

test('browsers keep public images briefly, private ones only for their reader, and moderator views not at all', () => members(async (db, m) => {
  const posted = await image(m.alice, db), unposted = await image(m.alice, db);
  await createThread(m.alice, opening([posted]), db);
  const as = (id: string, role: 'contributor' | 'editor' = 'contributor') => async () => ({ id, role });
  assert.deepEqual(await imageForServing(posted, async () => null, db), { allowed:true, cache:'public' });
  assert.deepEqual(await imageForServing(unposted, as(m.alice), db), { allowed:true, cache:'private' });
  assert.deepEqual(await imageForServing(unposted, as(m.bob), db), { allowed:false, cache:'none' });
  await setImageHidden(m.editor, posted, true, 'Not suitable', db);
  assert.deepEqual(await imageForServing(posted, as(m.editor, 'editor'), db), { allowed:true, cache:'none' });
  assert.equal((await imageForServing(posted, async () => null, db)).allowed, false);
}));
