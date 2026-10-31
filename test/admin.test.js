import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { openDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { adminRoutes } from '../routes/admin.js';
import { startWorker } from '../lib/worker.js';

function makeJpeg() {
  const buf = Buffer.alloc(20);
  buf[0] = 0xFF; buf[1] = 0xD8; buf[2] = 0xFF;
  buf.write('test data!', 3);
  return buf;
}

function makeTextFile() {
  return Buffer.from('this is not an image, just text content here');
}

function makeApp(overrides = {}) {
  const tmpData = join(tmpdir(), 'admin-test-' + Math.random().toString(36).slice(2));
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
    trustCf: false,
    isProd: false,
    ...overrides,
  };
  const root = new Hono();
  root.route('/admin', adminRoutes({ db, config, dataDir: tmpData }));
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

describe('Admin routes', () => {
  describe('Login', () => {
    it('rejects wrong password', async () => {
      const { app } = makeApp();
      const res = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
      });
      assert.equal(res.status, 401);
    });

    it('accepts correct password and sets cookie on 302', async () => {
      const { app } = makeApp();
      const res = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      assert.equal(res.status, 302);
      const cookie = getCookie(res);
      assert.ok(cookie, 'Set-Cookie header must contain sid on the 302');
    });

    it('6th login attempt is blocked', async () => {
      const { app } = makeApp();
      for (let i = 0; i < 5; i++) {
        await app.request('/admin/login', {
          method: 'POST',
          headers: { origin: 'http://localhost:3000' },
          body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
        });
      }
      const res = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      assert.equal(res.status, 429);
    });

    it('forged X-Forwarded-For cannot dodge login rate limit', async () => {
      const { app } = makeApp();
      for (let i = 0; i < 5; i++) {
        await app.request('/admin/login', {
          method: 'POST',
          headers: { origin: 'http://localhost:3000', 'x-forwarded-for': `10.0.0.${i}` },
          body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
        });
      }
      const res = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'x-forwarded-for': '192.168.1.99' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      assert.equal(res.status, 429);
    });
  });

  describe('Session guard', () => {
    it('redirects HTML without session', async () => {
      const { app } = makeApp();
      const res = await app.request('/admin/');
      assert.equal(res.status, 302);
      assert.ok(res.headers.get('location').includes('/admin/login'));
    });

    it('/admin redirects to /admin/login', async () => {
      const { app } = makeApp();
      const res = await app.request('/admin');
      assert.equal(res.status, 302);
      assert.ok(res.headers.get('location').includes('/admin/login'));
    });

    it('401 for API without session', async () => {
      const { app } = makeApp();
      const res = await app.request('/admin/api/albums');
      assert.equal(res.status, 401);
    });

    it('POST without Origin gets 403 even with session', async () => {
      const { app, config } = makeApp();
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const cookie = getCookie(loginRes);
      const res = await app.request('/admin/api/albums', {
        method: 'POST',
        headers: { cookie: `sid=${cookie}` },
        body: JSON.stringify({ title: 'Test' }),
      });
      assert.equal(res.status, 403);
    });
  });

  describe('Upload', () => {
    it('uploads a valid JPEG', async () => {
      const { app } = makeApp();
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const cookie = getCookie(loginRes);

      const jpeg = makeJpeg();
      const form = new FormData();
      form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'test.jpg');

      const res = await app.request('/admin/api/upload', {
        method: 'POST',
        headers: { cookie: `sid=${cookie}`, origin: 'http://localhost:3000' },
        body: form,
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.ok(data.id);
      assert.equal(data.duplicate, false);
    });

    it('rejects text file with 415', async () => {
      const { app } = makeApp();
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const cookie = getCookie(loginRes);

      const txt = makeTextFile();
      const form = new FormData();
      form.append('file', new Blob([txt], { type: 'text/plain' }), 'test.txt');

      const res = await app.request('/admin/api/upload', {
        method: 'POST',
        headers: { cookie: `sid=${cookie}`, origin: 'http://localhost:3000' },
        body: form,
      });
      assert.equal(res.status, 415);
    });
  });

  describe('Publish', () => {
    it('publish of pending photo does nothing', async () => {
      const { app, db } = makeApp();
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const cookie = getCookie(loginRes);

      db.prepare(`INSERT INTO photos (id, original_name, original_ext, original_sha256, status, created_at)
        VALUES ('abcdef1234567890', 'x.jpg', 'jpg', 'deadbeef', 'pending', '2024-01-01T00:00:00Z')`).run();

      const res = await app.request('/admin/api/photos/bulk', {
        method: 'POST',
        headers: { cookie: `sid=${cookie}`, origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['abcdef1234567890'], action: 'publish' }),
      });
      const data = await res.json();
      assert.equal(data.changed, 0);
      const row = db.prepare('SELECT is_published FROM photos WHERE id = ?').get('abcdef1234567890');
      assert.equal(row.is_published, 0);
    });
  });

  describe('Delete', () => {
    it('delete removes row, original file on disk, and derived dir', async () => {
      const { app, db, dataDir } = makeApp();
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const cookie = getCookie(loginRes);

      const id = 'aabb112233445566';
      writeFileSync(join(dataDir, 'originals', id + '.jpg'), Buffer.alloc(4));
      const derivedDir = join(dataDir, 'derived', id);
      mkdirSync(derivedDir, { recursive: true });
      writeFileSync(join(derivedDir, '480.jpg'), Buffer.alloc(4));

      db.prepare(`INSERT INTO photos (id, original_name, original_ext, original_sha256, status, created_at)
        VALUES (?, 'x.jpg', 'jpg', 'abc', 'ready', '2024-01-01T00:00:00Z')`).run(id);

      const res = await app.request('/admin/api/photos/bulk', {
        method: 'POST',
        headers: { cookie: `sid=${cookie}`, origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], action: 'delete' }),
      });
      assert.equal(res.status, 200);

      const row = db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id);
      assert.equal(row, undefined);
      assert.equal(existsSync(join(dataDir, 'originals', id + '.jpg')), false, 'original file must be deleted');
      assert.equal(existsSync(derivedDir), false);
    });

    it('delete clears album cover_photo_id', async () => {
      const { app, db, dataDir } = makeApp();
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const cookie = getCookie(loginRes);

      const id = 'aabb112233445577';
      writeFileSync(join(dataDir, 'originals', id + '.png'), Buffer.alloc(4));
      const derivedDir = join(dataDir, 'derived', id);
      mkdirSync(derivedDir, { recursive: true });

      db.prepare(`INSERT INTO photos (id, original_name, original_ext, original_sha256, status, created_at)
        VALUES (?, 'x.png', 'png', 'def', 'ready', '2024-01-01T00:00:00Z')`).run(id);
      db.prepare(`INSERT INTO albums (slug, title, cover_photo_id, position, is_published, created_at)
        VALUES ('test', 'Test', ?, 0, 1, '2024-01-01T00:00:00Z')`).run(id);

      const res = await app.request('/admin/api/photos/bulk', {
        method: 'POST',
        headers: { cookie: `sid=${cookie}`, origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], action: 'delete' }),
      });
      assert.equal(res.status, 200);

      const album = db.prepare('SELECT cover_photo_id FROM albums WHERE slug = ?').get('test');
      assert.equal(album.cover_photo_id, null);
    });
  });

  describe('Comments', () => {
    it('approve changes status', async () => {
      const { app, db } = makeApp();
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const cookie = getCookie(loginRes);

      db.prepare(`INSERT INTO photos (id, original_name, original_ext, original_sha256, status, created_at)
        VALUES ('abcdef1234567890', 'x.jpg', 'jpg', 'sha1', 'ready', '2024-01-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO comments (photo_id, author, body, status, visitor, created_at)
        VALUES ('abcdef1234567890', 'Jane', 'Nice', 'pending', 'v', '2024-01-01T00:00:00Z')`).run();

      const res = await app.request('/admin/api/comments/1', {
        method: 'POST',
        headers: { cookie: `sid=${cookie}`, origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      assert.equal(res.status, 200);
      const row = db.prepare('SELECT status FROM comments WHERE id = 1').get();
      assert.equal(row.status, 'approved');
    });
  });

  describe('Logout', () => {
    const login = async (app) => getCookie(await app.request('/admin/login', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
    }));
    const logout = (app, headers = {}) => app.request('/admin/logout', { method: 'POST', headers: { origin: 'http://localhost:3000', ...headers } });
    const page = (app, cookie) => app.request('/admin/comments', { headers: { cookie: `sid=${cookie}` } });

    it('ends every session, and a new login works', async () => {
      const { app } = makeApp();
      const copied = await login(app);
      assert.equal((await page(app, copied)).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 2));

      assert.equal((await logout(app, { cookie: `sid=${copied}` })).status, 302);
      assert.equal((await page(app, copied)).status, 302);

      await new Promise((resolve) => setTimeout(resolve, 2));
      assert.equal((await page(app, await login(app))).status, 200);
    });

    it('a stranger calling logout changes nothing', async () => {
      const { app, db } = makeApp();
      const session = await login(app);
      await logout(app);
      await logout(app, { cookie: 'sid=123.456' });
      assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'sessions_after'").get(), undefined);
      assert.equal((await page(app, session)).status, 200);
    });
  });

  describe('Comment email', () => {
    it('offers a reply link, escapes it, and forgets the address on rejection', async () => {
      const { app, db } = makeApp();
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const cookie = getCookie(loginRes);
      db.prepare(`INSERT INTO photos (id, original_name, original_ext, original_sha256, status, created_at)
        VALUES ('abcdef1234567890', 'x.jpg', 'jpg', 'sha1', 'ready', '2024-01-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO comments (photo_id, author, body, email, status, visitor, created_at)
        VALUES ('abcdef1234567890', 'Jane', 'Nice', ?, 'pending', 'v', '2024-01-01T00:00:00Z')`).run('jane+"x@example.org');

      const page = await (await app.request('/admin/comments', { headers: { cookie: `sid=${cookie}` } })).text();
      assert.ok(page.includes('href="mailto:jane%2B%22x@example.org?subject=Your%20comment"'));
      assert.ok(page.includes('Reply to jane+&quot;x@example.org'));

      const res = await app.request('/admin/api/comments/1', {
        method: 'POST',
        headers: { cookie: `sid=${cookie}`, origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject' }),
      });
      assert.equal(res.status, 200);
      assert.equal(db.prepare('SELECT email FROM comments WHERE id = 1').get().email, '');
    });
  });

  describe('Tab icon', () => {
    it('is on the login page and on signed-in pages', async () => {
      const { app } = makeApp();
      const icon = 'rel="icon" type="image/svg+xml" href="/favicon.svg"';
      assert.ok((await (await app.request('/admin/login')).text()).includes(icon));
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const headers = { cookie: `sid=${getCookie(loginRes)}` };
      for (const path of ['/admin', '/admin/photos', '/admin/albums', '/admin/comments', '/admin/trash', '/admin/settings', '/admin/stats', '/admin/captions', '/admin/privacy']) {
        assert.ok((await (await app.request(path, { headers })).text()).includes(icon), path);
      }
    });
  });

  describe('CSP', () => {
    it('admin pages carry the required CSP', async () => {
      const { app } = makeApp();
      const res = await app.request('/admin/login');
      const csp = res.headers.get('Content-Security-Policy');
      assert.ok(csp);
      assert.ok(csp.includes("default-src 'none'"));
      assert.ok(csp.includes("script-src 'self'"));
      assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"));
      assert.ok(csp.includes("img-src 'self' data:"));
      assert.ok(csp.includes("connect-src 'self'"));
      assert.ok(csp.includes("form-action 'self'"));
      assert.ok(csp.includes("base-uri 'none'"));
      assert.ok(csp.includes("frame-ancestors 'none'"));
    });
  });

  describe('XSS prevention', () => {
    it('escapes XSS in caption on admin page', async () => {
      const { app, db } = makeApp();
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const cookie = getCookie(loginRes);

      const xssCaption = '<script>alert("xss")</script>';
      db.prepare(`INSERT INTO photos (id, original_name, original_ext, original_sha256, status, caption, created_at)
        VALUES ('abcdef1234567890', 'x.jpg', 'jpg', 'sha1', 'ready', ?, '2024-01-01T00:00:00Z')`).run(xssCaption);

      const res = await app.request('/admin/photos', { headers: { cookie: `sid=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<script>alert("xss")</script>'));
      assert.ok(html.includes('&lt;script&gt;'));
    });

    it('escapes XSS in comment on admin page', async () => {
      const { app, db } = makeApp();
      const loginRes = await app.request('/admin/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: new URLSearchParams({ username: 'admin', password: 'correct-horse' }),
      });
      const cookie = getCookie(loginRes);

      db.prepare(`INSERT INTO photos (id, original_name, original_ext, original_sha256, status, created_at)
        VALUES ('abcdef1234567890', 'x.jpg', 'jpg', 'sha1', 'ready', '2024-01-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO comments (photo_id, author, body, status, visitor, created_at)
        VALUES ('abcdef1234567890', '<img onerror=x>', '<b>hi</b><script>evil()</script>', 'pending', 'v', '2024-01-01T00:00:00Z')`).run();

      const res = await app.request('/admin/comments', { headers: { cookie: `sid=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<script>evil()</script>'));
      assert.ok(!html.includes('<img onerror=x>'));
      assert.ok(html.includes('&lt;script&gt;'));
      assert.ok(html.includes('&lt;img onerror=x&gt;'));
    });
  });
});
