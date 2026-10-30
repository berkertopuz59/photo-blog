import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { openDb } from '../lib/db.js';
import { hashPassword, verifyLogin } from '../lib/auth.js';
import { adminRoutes } from '../routes/admin.js';
import { publicRoutes } from '../routes/public.js';

function makeApp(overrides = {}) {
  const tmpData = join(tmpdir(), 'hardening-test-' + Math.random().toString(36).slice(2));
  mkdirSync(join(tmpData, 'originals'), { recursive: true });
  mkdirSync(join(tmpData, 'derived'), { recursive: true });
  const db = openDb(':memory:');
  const pwHash = hashPassword('correct-horse');
  const config = {
    dataDir: tmpData,
    port: 3000,
    siteUrl: 'http://localhost:3000',
    adminPasswordHash: pwHash,
    adminUsername: 'admin',
    sessionSecret: 'test-session-secret-32chars-long!!',
    visitorSecret: 'test-visitor-secret',
    turnstileSiteKey: '',
    turnstileSecret: '',
    trustCf: true,
    isProd: false,
    ...overrides,
  };
  const root = new Hono();
  root.route('/admin', adminRoutes({ db, config, dataDir: tmpData }));
  root.route('/', publicRoutes({ db, config, dataDir: tmpData, fetchFn: globalThis.fetch }));
  return { app: root, db, config, dataDir: tmpData };
}

function getCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/sid=([^;]+)/);
  return m ? m[1] : null;
}

function sessionHeaders(cookie, origin = 'http://localhost:3000') {
  return { cookie: `sid=${cookie}`, origin };
}

function cfIp(ip) {
  return { 'CF-Connecting-IP': ip };
}

function insertPhoto(db, { id, albumId = null, published = false, status = 'ready' } = {}) {
  const now = new Date().toISOString();
  const photoId = id || generateId();
  db.prepare(
    `INSERT INTO photos (id, album_id, status, is_published, created_at, published_at, original_name, original_ext, original_sha256, width, height)
     VALUES (?, ?, ?, ?, ?, ?, 'x.jpg', 'jpg', ?, 800, 600)`
  ).run(photoId, albumId, status, published ? 1 : 0, now, published ? now : null, photoId);
  return photoId;
}

function insertAlbum(db, { id, slug, published = false } = {}) {
  return db.prepare(
    `INSERT INTO albums (id, slug, title, is_published, created_at) VALUES (?, ?, 'Test Album', ?, ?)`
  ).run(id ?? null, slug || 'test', published ? 1 : 0, new Date().toISOString()).lastInsertRowid;
}

let _idCounter = 0;
function generateId() {
  _idCounter++;
  return String(_idCounter).padStart(16, '0');
}

// ─── Login: identical responses for wrong-user vs wrong-password ───
describe('Login: identical rejection for wrong username vs wrong password', () => {
  it('returns same status and body for wrong-username and wrong-password', async () => {
    const { app } = makeApp();

    const r1 = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'Origin': 'http://localhost:3000', ...cfIp('10.0.0.1') },
      body: new URLSearchParams({ username: 'wronguser', password: 'correct-horse' }),
    });

    const r2 = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'Origin': 'http://localhost:3000', ...cfIp('10.0.0.2') },
      body: new URLSearchParams({ username: 'admin', password: 'wrongpassword' }),
    });

    assert.equal(r1.status, r2.status);
    assert.equal(await r1.text(), await r2.text());
  });
});

// ─── verifyLogin: false on non-string input ───
describe('verifyLogin: rejects non-string input', () => {
  it('returns false for number username', () => {
    assert.equal(verifyLogin(123, 'correct-horse', 'test-secret'), false);
  });
  it('returns false for number password', () => {
    assert.equal(verifyLogin('admin', 12345, 'test-secret'), false);
  });
  it('returns false for null', () => {
    assert.equal(verifyLogin(null, null, 'test-secret'), false);
  });
  it('returns false for undefined', () => {
    assert.equal(verifyLogin(undefined, undefined, 'test-secret'), false);
  });
});

// ─── Rate limit: 5 attempts from one IP → 429 with Retry-After 900 ───
describe('Login rate limit: 5 attempts per IP', () => {
  it('blocks 6th attempt with 429 and Retry-After 900 even with correct credentials', async () => {
    const { app } = makeApp();
    const ip = '10.1.0.1';

    for (let i = 0; i < 5; i++) {
      await app.request('/admin/login', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', ...cfIp(ip) },
        body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
      });
    }

    const res = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'Origin': 'http://localhost:3000', ...cfIp(ip) },
      body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
    });

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '900');
  });
});

// ─── Blocked IP doesn't consume login-all: new IP can still log in ───
describe('Login rate limit: blocked IP does not consume global quota', () => {
  it('new IP can still log in after another IP is blocked', async () => {
    const { app } = makeApp();
    const blockedIp = '10.2.0.1';

    // Exhaust the blocked IP
    for (let i = 0; i < 5; i++) {
      await app.request('/admin/login', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', ...cfIp(blockedIp) },
        body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
      });
    }

    // Hammer the blocked IP 40 more times
    for (let i = 0; i < 40; i++) {
      await app.request('/admin/login', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', ...cfIp(blockedIp) },
        body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
      });
    }

    // New IP should still work
    const res = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'Origin': 'http://localhost:3000', ...cfIp('10.2.99.1') },
      body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
    });

    assert.equal(res.status, 302);
  });
});

// ─── 30 different IPs → new IP blocked ───
describe('Login rate limit: 30 IPs exhaust global bucket', () => {
  it('31st distinct IP gets 429 with correct credentials', async () => {
    const { app } = makeApp();

    for (let i = 0; i < 30; i++) {
      await app.request('/admin/login', {
        method: 'POST',
        headers: { 'Origin': 'http://localhost:3000', ...cfIp(`10.3.${i}.1`) },
        body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
      });
    }

    const res = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'Origin': 'http://localhost:3000', ...cfIp('10.3.99.1') },
      body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
    });

    assert.equal(res.status, 429);
  });
});

// ─── Anonymous GET /admin rate limited: 61 in a minute → 429 Retry-After 60; valid session 200 ───
describe('Admin anonymous rate limit: 61 GET /admin in a minute', () => {
  it('61st request is 429 Retry-After 60; valid session from same IP gets 200', async () => {
    const { app } = makeApp();
    const ip = '10.4.0.1';

    // 60 allowed
    for (let i = 0; i < 60; i++) {
      await app.request('/admin', { headers: { ...cfIp(ip) } });
    }

    // 61st blocked
    const blocked = await app.request('/admin', { headers: { ...cfIp(ip) } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('Retry-After'), '60');

    // Get a valid session from a different IP first
    const loginRes = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'Origin': 'http://localhost:3000', ...cfIp('10.4.99.1') },
      body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
    });
    const cookie = getCookie(loginRes);
    assert.ok(cookie, 'expected session cookie');

    // Same blocked IP but with valid session → 200
    const authed = await app.request('/admin', {
      headers: { ...cfIp(ip), cookie: `sid=${cookie}`, Origin: 'http://localhost:3000' },
    });
    assert.equal(authed.status, 200);
  });
});

// ─── Publishing already-published photo in unpublished album publishes the album ───
describe('Admin: publish photo promotes album', () => {
  it('publishing an already-published photo that sits in an unpublished album publishes the album', async () => {
    const { app, db } = makeApp();

    const albumId = generateId();
    insertAlbum(db, { id: albumId, slug: 'my-album', published: false });

    const photoId = generateId();
    insertPhoto(db, { id: photoId, albumId, published: true });

    const loginRes = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'Origin': 'http://localhost:3000', ...cfIp('10.5.0.1') },
      body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
    });
    const cookie = getCookie(loginRes);

    // PATCH publish
    const res = await app.request('/admin/api/photos/bulk', {
      method: 'POST',
      headers: { ...sessionHeaders(cookie), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [photoId], action: 'publish' }),
    });

    assert.equal(res.status, 200);

    const album = db.prepare('SELECT is_published FROM albums WHERE id = ?').get(albumId);
    assert.equal(album.is_published, 1);
  });
});

// ─── Moving a published photo into an unpublished album publishes the album ───
describe('Admin: move photo to unpublished album', () => {
  it('moving a published photo into an unpublished album publishes the album', async () => {
    const { app, db } = makeApp();

    const albumId = generateId();
    insertAlbum(db, { id: albumId, slug: 'target', published: false });

    const photoId = generateId();
    insertPhoto(db, { id: photoId, albumId: null, published: true });

    const loginRes = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'Origin': 'http://localhost:3000', ...cfIp('10.6.0.1') },
      body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
    });
    const cookie = getCookie(loginRes);

    const res = await app.request('/admin/api/photos/bulk', {
      method: 'POST',
      headers: { ...sessionHeaders(cookie), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [photoId], action: 'move', album_id: Number(albumId) }),
    });

    assert.equal(res.status, 200);
    const album = db.prepare('SELECT is_published FROM albums WHERE id = ?').get(albumId);
    assert.equal(album.is_published, 1);
  });
});

// ─── Moving an unpublished photo does NOT publish the album ───
describe('Admin: move unpublished photo does not publish album', () => {
  it('moving an unpublished photo into an album does not publish it', async () => {
    const { app, db } = makeApp();

    const albumId = generateId();
    insertAlbum(db, { id: albumId, slug: 'target2', published: false });

    const photoId = generateId();
    insertPhoto(db, { id: photoId, albumId: null, published: false });

    const loginRes = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'Origin': 'http://localhost:3000', ...cfIp('10.7.0.1') },
      body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
    });
    const cookie = getCookie(loginRes);

    const res = await app.request('/admin/api/photos/bulk', {
      method: 'POST',
      headers: { ...sessionHeaders(cookie), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [photoId], action: 'move', album_id: Number(albumId) }),
    });

    assert.equal(res.status, 200);
    const album = db.prepare('SELECT is_published FROM albums WHERE id = ?').get(albumId);
    assert.equal(album.is_published, 0);
  });
});

// ─── DELETE like is rate limited after 60 in an hour ───
describe('Public API: DELETE /like rate limited after 60', () => {
  it('61st delete-like in an hour is 429', async () => {
    const { app, db } = makeApp();
    const photoId = generateId();
    insertPhoto(db, { id: photoId, published: true });

    const ip = '10.8.0.1';

    // 60 allowed
    for (let i = 0; i < 60; i++) {
      await app.request(`/api/photos/${photoId}/like`, {
        method: 'DELETE',
        headers: cfIp(ip),
      });
    }

    // 61st blocked
    const res = await app.request(`/api/photos/${photoId}/like`, {
      method: 'DELETE',
      headers: cfIp(ip),
    });
    assert.equal(res.status, 429);
  });
});

// ─── Photo with no album: prev/next when other public photos exist, back link says "All photos" ───
describe('Public /p/:id: no-album photo navigation', () => {
  it('has prev or next link when other public photos exist; back link says All photos', async () => {
    const { app, db } = makeApp();

    const id1 = generateId();
    const id2 = generateId();
    insertPhoto(db, { id: id1, albumId: null, published: true });
    insertPhoto(db, { id: id2, albumId: null, published: true });

    const res = await app.request(`/p/${id1}`, { headers: cfIp('10.9.0.1') });
    assert.equal(res.status, 200);
    const html = await res.text();

    // Should have at least a next link
    const hasNav = /class="photo-nav-btn|aria-label="Next photo"|aria-label="Previous photo"/.test(html);
    assert.ok(hasNav, 'expected prev/next navigation');

    // Back link text should contain "All photos"
    assert.ok(html.includes('All photos'), 'expected back link to say "All photos"');
  });

  it('with a published album shows the album title', async () => {
    const { app, db } = makeApp();

    const albumId = generateId();
    insertAlbum(db, { id: albumId, slug: 'landscapes', published: true });

    const photoId = generateId();
    insertPhoto(db, { id: photoId, albumId, published: true });

    const res = await app.request(`/p/${photoId}`, { headers: cfIp('10.9.1.1') });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('Test Album'), 'expected album title in back link');
  });
});
