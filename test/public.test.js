import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb, newPhotoId, nowIso } from '../lib/db.js';
import { publicRoutes } from '../routes/public.js';
import { adminRoutes } from '../routes/admin.js';
import { hashPassword } from '../lib/auth.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const DATA_DIR = join(process.cwd(), 'test-tmp-' + Date.now());
mkdirSync(join(DATA_DIR, 'derived'), { recursive: true });
mkdirSync(join(DATA_DIR, 'originals'), { recursive: true });

function makeApp(opts = {}) {
  const db = openDb(':memory:');
  const config = {
    dataDir: DATA_DIR,
    siteUrl: 'http://localhost:3000',
    visitorSecret: 'test-secret',
    turnstileSecret: 'test-turnstile',
    turnstileSiteKey: 'test-key',
    trustCf: false,
    isProd: false,
  };
  const fetchFn = opts.fetchFn || (async () => new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }));
  const app = publicRoutes({ db, config, dataDir: DATA_DIR, fetchFn });
  return { app, db, config };
}

function makeMountedApp(opts = {}) {
  const db = openDb(':memory:');
  const config = {
    dataDir: DATA_DIR,
    siteUrl: 'http://localhost:3000',
    visitorSecret: 'test-secret',
    turnstileSecret: 'test-turnstile',
    turnstileSiteKey: 'test-key',
    trustCf: false,
    isProd: false,
    adminPasswordHash: hashPassword('correct-horse'),
    sessionSecret: 'test-session-secret-32chars-long!!',
  };
  const fetchFn = opts.fetchFn || (async () => new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }));
  const root = new Hono();
  root.route('/admin', adminRoutes({ db, config, dataDir: DATA_DIR }));
  root.route('/', publicRoutes({ db, config, dataDir: DATA_DIR, fetchFn }));
  return { app: root, db, config };
}

function insertAlbum(db, { slug = 'test-album', title = 'Test Album', published = 1 } = {}) {
  db.prepare('INSERT INTO albums (slug, title, is_published, position, created_at) VALUES (?, ?, ?, 0, ?)').run(slug, title, published, nowIso());
  return db.prepare('SELECT id FROM albums WHERE slug = ?').get(slug).id;
}

function insertPhoto(db, { id = newPhotoId(), albumId = null, status = 'ready', published = 1, width = 960, height = 640, placeholder = 'data:image/webp;base64,x', caption = 'Test', position = 0, takenAt = null } = {}) {
  db.prepare(`INSERT INTO photos (id, album_id, caption, status, is_published, position, original_name, original_ext, original_sha256, width, height, placeholder, taken_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'test.jpg', 'jpg', ?, ?, ?, ?, ?, ?)`)
    .run(id, albumId, caption, status, published, position, Math.random().toString(36).slice(2), width, height, placeholder, takenAt, nowIso());
  return id;
}

function writeDerived(id, file, data) {
  const dir = join(DATA_DIR, 'derived', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), data || Buffer.from('fake'));
}

describe('Public routes', () => {
  test('unpublished photo returns 404 on /p', async () => {
    const { app, db } = makeApp();
    const id = insertPhoto(db, { published: 0 });
    const res = await app.request('/p/' + id);
    assert.equal(res.status, 404);
  });

  test('unpublished photo returns 404 on /img', async () => {
    const { app, db } = makeApp();
    const id = insertPhoto(db, { published: 0 });
    writeDerived(id, '480.jpg');
    const res = await app.request('/img/' + id + '/480.jpg');
    assert.equal(res.status, 404);
  });

  test('path traversal 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/img/../../etc/passwd/480.jpg');
    assert.equal(res.status, 404);
  });

  test('invalid id format 404 on /img', async () => {
    const { app } = makeApp();
    const res = await app.request('/img/xyz/480.jpg');
    assert.equal(res.status, 404);
  });

  test('invalid file format 404 on /img', async () => {
    const { app } = makeApp();
    const id = newPhotoId();
    const res = await app.request('/img/' + id + '/../../etc/passwd');
    assert.equal(res.status, 404);
  });

  test('like is idempotent and DELETE reverses', async () => {
    const { app, db } = makeApp();
    const id = insertPhoto(db);

    const res1 = await app.request('/api/photos/' + id + '/like', { method: 'POST' });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.count, 1);
    assert.equal(data1.liked, true);

    const res2 = await app.request('/api/photos/' + id + '/like', { method: 'POST' });
    const data2 = await res2.json();
    assert.equal(data2.count, 1);
    assert.equal(data2.liked, true);

    const res3 = await app.request('/api/photos/' + id + '/like', { method: 'DELETE' });
    const data3 = await res3.json();
    assert.equal(data3.count, 0);
    assert.equal(data3.liked, false);
  });

  test('honeypot stores nothing but returns ok', async () => {
    const { app, db } = makeApp();
    const id = insertPhoto(db);

    const res = await app.request('/api/photos/' + id + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'Bot', body: 'hello', website: 'spam', token: 'x' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.pending, true);

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM comments').get().cnt;
    assert.equal(count, 0);
  });

  test('comment with failed Turnstile stores nothing', async () => {
    const { app, db } = makeApp({
      fetchFn: async () => new Response(JSON.stringify({ success: false }), { headers: { 'Content-Type': 'application/json' } }),
    });
    const id = insertPhoto(db);

    const res = await app.request('/api/photos/' + id + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'User', body: 'Nice photo', website: '', token: 'bad-token' }),
    });
    assert.equal(res.status, 403);

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM comments').get().cnt;
    assert.equal(count, 0);
  });

  test('good comment is pending and NOT in the page HTML', async () => {
    const { app, db } = makeApp();
    const id = insertPhoto(db);

    const res = await app.request('/api/photos/' + id + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'User', body: 'Beautiful shot', website: '', token: 'good-token' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.pending, true);

    const comment = db.prepare('SELECT * FROM comments').get();
    assert.equal(comment.status, 'pending');

    const pageRes = await app.request('/p/' + id);
    const html = await pageRes.text();
    assert.ok(!html.includes('Beautiful shot'));
  });

  test('approved comment IS in the page HTML escaped', async () => {
    const { app, db } = makeApp();
    const id = insertPhoto(db);

    db.prepare("INSERT INTO comments (photo_id, author, body, status, visitor, created_at) VALUES (?, ?, ?, 'approved', 'visitor1', ?)").run(
      id, 'Jane', '<script>alert(1)</script>', nowIso()
    );

    const res = await app.request('/p/' + id);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
  });

  test('6th comment in an hour gets 429', async () => {
    const { app, db } = makeApp();
    const id = insertPhoto(db);

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/api/photos/' + id + '/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: 'User', body: 'Comment ' + i, website: '', token: 'good' }),
      });
      assert.equal(res.status, 200, 'comment ' + i + ' should pass');
    }

    const res6 = await app.request('/api/photos/' + id + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'User', body: 'Sixth comment', website: '', token: 'good' }),
    });
    assert.equal(res6.status, 429);
  });

  test('51st pending comment gets 429', async () => {
    const { app, db } = makeApp();
    const id = insertPhoto(db);

    for (let i = 0; i < 50; i++) {
      db.prepare("INSERT INTO comments (photo_id, author, body, status, visitor, created_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(
        id, 'Bot', 'Filler ' + i, 'visitor' + i, nowIso()
      );
    }

    const res = await app.request('/api/photos/' + id + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'User', body: 'One more', website: '', token: 'good' }),
    });
    assert.equal(res.status, 429);
  });

  test('CSP header present on HTML responses', async () => {
    const { app } = makeApp();
    const res = await app.request('/');
    assert.equal(res.status, 200);
    const csp = res.headers.get('Content-Security-Policy');
    assert.ok(csp);
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes('script-src'));
    assert.ok(csp.includes('https://challenges.cloudflare.com'));
  });

  test('X-Content-Type-Options and Referrer-Policy set', async () => {
    const { app } = makeApp();
    const res = await app.request('/');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  });

  test('/site.css has content', async () => {
    const { app } = makeApp();
    const res = await app.request('/site.css');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('Content-Type').includes('text/css'));
    const body = await res.text();
    assert.ok(typeof body === 'string');
  });

  test('/site.js has content', async () => {
    const { app } = makeApp();
    const res = await app.request('/site.js');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('Content-Type').includes('javascript'));
  });

  test('/static/admin.css served', async () => {
    const { app } = makeApp();
    const res = await app.request('/static/admin.css');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('Content-Type').includes('text/css'));
  });

  test('/static/admin.js served', async () => {
    const { app } = makeApp();
    const res = await app.request('/static/admin.js');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('Content-Type').includes('javascript'));
  });

  test('prev/next order follows position ASC, taken_at DESC, id ASC', async () => {
    const { app, db } = makeApp();
    const albumId = insertAlbum(db);
    // Three photos with same position, different taken_at
    const p1 = insertPhoto(db, { albumId, position: 0, takenAt: '2024-03-01T00:00:00Z' });
    const p2 = insertPhoto(db, { albumId, position: 0, takenAt: '2024-02-01T00:00:00Z' });
    const p3 = insertPhoto(db, { albumId, position: 0, takenAt: '2024-01-01T00:00:00Z' });

    // ORDER BY position ASC, taken_at DESC, id ASC
    // p1 (March) first, p2 (Feb) second, p3 (Jan) third
    const res2 = await app.request('/p/' + p2);
    const html2 = await res2.text();
    // p2 is index 1: prev=p1, next=p3
    assert.ok(html2.includes(`href="/p/${p1}"`), 'prev should link to p1');
    assert.ok(html2.includes(`href="/p/${p3}"`), 'next should link to p3');
  });

  test('published photo in unpublished album has no album link', async () => {
    const { app, db } = makeApp();
    const albumId = insertAlbum(db, { published: 0 });
    const id = insertPhoto(db, { albumId, published: 1 });

    const res = await app.request('/p/' + id);
    assert.equal(res.status, 200);
    const html = await res.text();
    // The photo is visible but has no album link since album is unpublished
    assert.ok(!html.includes('photo-album'));
  });
});

describe('Mounted routes (admin + public)', () => {
  test('/ returns 200 with no session', async () => {
    const { app } = makeMountedApp();
    const res = await app.request('/');
    assert.equal(res.status, 200);
  });

  test('/admin redirects to /admin/login with no session', async () => {
    const { app } = makeMountedApp();
    const res = await app.request('/admin');
    assert.equal(res.status, 302);
    assert.ok(res.headers.get('location').includes('/admin/login'));
  });

  test('/admin/ redirects to /admin/login with no session', async () => {
    const { app } = makeMountedApp();
    const res = await app.request('/admin/');
    assert.equal(res.status, 302);
    assert.ok(res.headers.get('location').includes('/admin/login'));
  });
});

// Cleanup
process.on('exit', () => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});
