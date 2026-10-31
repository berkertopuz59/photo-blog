import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import sharp from 'sharp';
import { openDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { ingest, processPhoto } from '../lib/images.js';
import { emptyTrash, erasePhoto, purgeTrash, restorePhoto, trashList, trashPhoto, trashThumb } from '../lib/trash.js';
import { adminRoutes } from '../routes/admin.js';
import { publicRoutes } from '../routes/public.js';

const jpeg = (background) => sharp({ create: { width: 900, height: 600, channels: 3, background } }).jpeg().toBuffer();

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'trash-'));
  mkdirSync(join(dataDir, 'originals'));
  mkdirSync(join(dataDir, 'derived'));
  const db = openDb(':memory:');
  const config = {
    dataDir, port: 3000, siteUrl: 'http://localhost:3000', siteTitle: 'T', siteTagline: 'T', adminPasswordHash: hashPassword('pw'), adminUsername: 'admin',
    sessionSecret: 'test-session-secret-32chars-long!!', visitorSecret: 'v', turnstileSiteKey: 'x', turnstileSecret: 'x', trustCf: false, isProd: false,
  };
  const app = new Hono();
  app.route('/admin', adminRoutes({ db, config, dataDir }));
  app.route('/', publicRoutes({ db, config, dataDir }));

  const { id } = await ingest(db, dataDir, await jpeg('#336699'), 'a.jpg');
  await processPhoto(db, dataDir, id);
  db.prepare("INSERT INTO albums (slug, title, created_at, cover_photo_id) VALUES ('s', 'S', '2026-01-01', ?)").run(id);
  db.prepare('UPDATE photos SET is_published = 1, privacy_ok = 1, privacy_reviewed = 1, album_id = 1, published_at = ?, privacy_boxes = ? WHERE id = ?')
    .run('2026-01-01', JSON.stringify([{ type: 'face', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2, blur: true }]), id);
  db.prepare("INSERT INTO comments (photo_id, author, body, email, status, visitor, created_at) VALUES (?, 'Jane', 'Nice', 'j@example.org', 'approved', 'v', '2026-01-01')").run(id);
  db.prepare("INSERT INTO likes (photo_id, visitor, created_at) VALUES (?, 'v', '2026-01-01')").run(id);
  return { app, db, dataDir, id };
}

async function login(app) {
  const res = await app.request('/admin/login', {
    method: 'POST',
    body: new URLSearchParams({ username: 'admin', password: 'pw' }),
    headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '9.9.9.9' },
  });
  return res.headers.get('set-cookie').match(/sid=[^;]+/)[0];
}

describe('tab icon', () => {
  it('shows the camera until data/favicon.svg replaces it, on public pages too', async () => {
    const { app, dataDir, id } = await setup();
    const body = async () => (await app.request('/favicon.svg')).text();
    const res = await app.request('/favicon.svg');
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.ok((await res.text()).includes('viewBox="0 0 32 32"'));
    assert.ok((await (await app.request(`/p/${id}`)).text()).includes('href="/favicon.svg"'));

    writeFileSync(join(dataDir, 'favicon.svg'), '<svg id="mine"/>');
    assert.equal(await body(), '<svg id="mine"/>');
  });
});

describe('trash', () => {
  it('takes a photo off the site at once and keeps what a restore needs', async () => {
    const { app, db, dataDir, id } = await setup();
    assert.equal((await app.request(`/p/${id}`)).status, 200);

    assert.equal(trashPhoto(db, dataDir, id), true);
    assert.equal((await app.request(`/p/${id}`)).status, 404);
    assert.equal((await app.request(`/img/${id}/480.jpg`)).status, 404);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 0);
    assert.equal(db.prepare('SELECT cover_photo_id FROM albums').get().cover_photo_id, null);
    assert.equal(existsSync(join(dataDir, 'originals', `${id}.jpg`)), false);
    assert.equal(existsSync(join(dataDir, 'derived', id)), false);
    assert.equal(existsSync(join(dataDir, 'trash', id, 'original')), true);
    assert.ok(trashThumb(dataDir, id));
    assert.equal(trashList(db)[0].days_left, 30);
    assert.equal(trashPhoto(db, dataDir, 'ffffffffffffffff'), false);
  });

  it('restores the photo, its blur, comment, email and like, and rebuilds under a new address', async () => {
    const { app, db, dataDir, id } = await setup();
    const before = db.prepare('SELECT image_version FROM photos').get().image_version;
    trashPhoto(db, dataDir, id);

    assert.equal(restorePhoto(db, dataDir, id), 'ok');
    const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
    assert.equal(row.status, 'pending');
    assert.equal(row.image_version, before + 1);
    assert.equal(row.album_id, 1);
    assert.equal(row.is_published, 1);
    assert.equal(JSON.parse(row.privacy_boxes).length, 1);
    assert.equal(db.prepare('SELECT email FROM comments').get().email, 'j@example.org');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM likes').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trash').get().n, 0);
    assert.equal(existsSync(join(dataDir, 'trash', id)), false);

    await processPhoto(db, dataDir, id);
    assert.equal(db.prepare('SELECT status FROM photos').get().status, 'ready');
    assert.equal((await app.request(`/p/${id}`)).status, 200);
  });

  it('restores without the album if that was deleted meanwhile', async () => {
    const { db, dataDir, id } = await setup();
    trashPhoto(db, dataDir, id);
    db.prepare('DELETE FROM albums').run();
    assert.equal(restorePhoto(db, dataDir, id), 'ok');
    assert.equal(db.prepare('SELECT album_id FROM photos').get().album_id, null);
  });

  it('refuses a restore when the same photo was uploaded again, and keeps it in the trash', async () => {
    const { db, dataDir, id } = await setup();
    const sha = db.prepare('SELECT original_sha256 FROM photos').get().original_sha256;
    trashPhoto(db, dataDir, id);
    db.prepare("INSERT INTO photos (id, original_name, original_ext, original_sha256, created_at) VALUES ('aaaaaaaaaaaaaaaa', 'b.jpg', 'jpg', ?, '2026-01-01')").run(sha);
    assert.equal(restorePhoto(db, dataDir, id), 'duplicate');
    assert.equal(trashList(db).length, 1);
    assert.equal(existsSync(join(dataDir, 'trash', id, 'original')), true);
  });

  it('erases for good, one at a time or all at once', async () => {
    const { db, dataDir, id } = await setup();
    trashPhoto(db, dataDir, id);
    assert.equal(erasePhoto(db, dataDir, id), true);
    assert.equal(existsSync(join(dataDir, 'trash', id)), false);
    assert.equal(restorePhoto(db, dataDir, id), 'not_found');

    const second = await ingest(db, dataDir, await jpeg('#993366'), 'b.jpg');
    trashPhoto(db, dataDir, second.id);
    assert.equal(emptyTrash(db, dataDir), 1);
    assert.equal(trashList(db).length, 0);
  });

  it('erases on its own after 30 days, and not before', async () => {
    const { db, dataDir, id } = await setup();
    trashPhoto(db, dataDir, id);
    const day = 24 * 60 * 60 * 1000;
    assert.equal(purgeTrash(db, dataDir, Date.now() + 29 * day), 0);
    assert.equal(purgeTrash(db, dataDir, Date.now() + 31 * day), 1);
    assert.equal(existsSync(join(dataDir, 'trash', id)), false);
  });

  it('the bulk Delete moves to the trash, and the trash pages need a session', async () => {
    const { app, db, dataDir, id } = await setup();
    const sid = await login(app);
    const headers = { cookie: sid, origin: 'http://localhost:3000', 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' };
    const anon = { 'cf-connecting-ip': '1.1.1.1' };
    assert.equal((await app.request('/admin/api/photos/bulk', { method: 'POST', headers, body: JSON.stringify({ ids: [id], action: 'delete' }) })).status, 200);
    assert.equal(trashList(db).length, 1);

    const page = await (await app.request('/admin/trash', { headers })).text();
    assert.ok(page.includes('a.jpg') && page.includes('Erased for good in 30 days'));
    const thumb = await app.request(`/admin/trash/${id}/thumb`, { headers });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    assert.equal((await app.request(`/trash/${id}/original`)).status, 404);

    assert.equal((await app.request('/admin/trash', { headers: anon })).status, 302);
    assert.equal((await app.request(`/admin/trash/${id}/thumb`, { headers: anon })).status, 302);
    assert.equal((await app.request('/admin/api/trash/empty', { method: 'POST', headers: { origin: 'http://localhost:3000', ...anon } })).status, 401);
    assert.equal(trashList(db).length, 1);

    assert.equal((await app.request(`/admin/api/trash/${id}`, { method: 'POST', headers, body: JSON.stringify({ action: 'restore' }) })).status, 200);
    assert.equal(db.prepare('SELECT status FROM photos').get().status, 'pending');
    assert.equal((await app.request(`/admin/api/trash/${id}`, { method: 'POST', headers, body: JSON.stringify({ action: 'restore' }) })).status, 404);
  });
});
