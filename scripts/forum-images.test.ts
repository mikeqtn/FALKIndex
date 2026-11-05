import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { PoolClient } from 'pg';
import { pool } from '../server/db.ts';
import { realm } from '../server/accounts.ts';
import { createApp } from '../server/index.ts';
import { addImage, clearUnattachedImages, createThread, FORUM_MAX_IMAGES, imageForServing, purgeImage, reply, replyInput, setImageHidden, setPostHidden, threadDetail } from '../server/forum.ts';
import { loadImage, MAX_UPLOAD_BYTES, rebuildImage, removeImage, storeImage } from '../server/forumImages.ts';

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

test('only your own day-old unattached images are cleared', () => members(async (db, m) => {
  const [old, fresh, others] = [await image(m.alice, db), await image(m.alice, db), await image(m.bob, db)];
  const kept = await image(m.alice, db);
  await createThread(m.alice, opening([kept]), db);
  await db.query("UPDATE falk_forum_image SET created_at=now()-interval '2 days' WHERE id=ANY($1)", [[old, others, kept]]);
  assert.deepEqual(await clearUnattachedImages(m.alice, db), [old]);
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
