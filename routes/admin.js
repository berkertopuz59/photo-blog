import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { verifyLogin, signSession, verifySession, originOk } from '../lib/auth.js';
import { clientIp, visitorHash, rateLimit } from '../lib/guard.js';
import { ingest } from '../lib/images.js';
import { slugify } from '../lib/slug.js';
import { nowIso } from '../lib/db.js';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConnInfo } from '@hono/node-server/conninfo';
import { adminView, loginView, photosView, albumsView, commentsView, IMG_ID_RE, IMG_FILE_RE } from '../views/admin.js';
import { escapeHtml } from '../views/html.js';

const PHOTO_ID_RE = /^[a-f0-9]{16}$/;

const ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function deletePhotoHelper(db, dataDir, id) {
  const row = db.prepare('SELECT original_ext FROM photos WHERE id = ?').get(id);
  const ext = row ? row.original_ext : null;
  if (ext) {
    try { rmSync(join(dataDir, 'originals', `${id}.${ext}`), { force: true }); } catch {}
  }
  rmSync(join(dataDir, 'derived', id), { recursive: true, force: true });
  db.prepare('UPDATE albums SET cover_photo_id = NULL WHERE cover_photo_id = ?').run(id);
  db.prepare('DELETE FROM photos WHERE id = ?').run(id);
}

function validateAlbumId(value) {
  if (value === null || value === undefined || value === '') return { ok: true, id: null };
  const n = Number(value);
  if (!Number.isInteger(n)) return { ok: false, reason: 'non_integer' };
  return { ok: true, id: n };
}

export function adminRoutes({ db, config, dataDir }) {
  const app = new Hono();

  function visitorKey(c) {
    let socketIp = 'unknown';
    try {
      const info = getConnInfo(c);
      if (info && info.remote && info.remote.address) socketIp = info.remote.address;
    } catch { /* app.request does not support getConnInfo */ }
    return visitorHash(config.visitorSecret, clientIp((h) => c.req.header(h), config, socketIp));
  }

  const pendingCount = () => db.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'").get().n;
  const publishAlbumOf = db.prepare('UPDATE albums SET is_published = 1 WHERE id = (SELECT album_id FROM photos WHERE id = ? AND is_published = 1)');

  // Global: security headers + no-store + noindex for all admin HTML
  app.use('*', async (c, next) => {
    await next();
    const path = c.req.path;
    if (path.startsWith('/admin') && !path.startsWith('/admin/api') && !path.startsWith('/admin/img')) {
      c.res.headers.set('Cache-Control', 'no-store');
      c.res.headers.set('X-Robots-Tag', 'noindex');
      c.res.headers.set('Content-Security-Policy', ADMIN_CSP);
    }
  });

  // Origin check on all non-GET
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET') {
      if (!originOk(c.req.header('origin'), config.siteUrl)) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    await next();
  });

  // Session guard + admin-anon rate limit for everyone without a valid session
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const cookie = c.req.header('cookie') || '';
    const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
    const token = match ? match[1] : null;
    if (token && verifySession(config.sessionSecret, token)) {
      await next();
      return;
    }
    if (!rateLimit(db, 'admin-anon', visitorKey(c), 60, 60 * 1000)) {
      c.header('Retry-After', '60');
      return c.text('Too many requests.', 429);
    }
    if (path === '/admin/login' || path === '/admin/logout') {
      await next();
      return;
    }
    if (path.startsWith('/admin/api')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.redirect('/admin/login');
  });

  // 64 KB body limit on all admin API routes except upload
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/admin/api/upload') return next();
    return bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) })(c, next);
  });

  // --- Login ---
  app.get('/login', (c) => {
    return c.html(loginView(''));
  });

  app.post('/login', async (c) => {
    // Origin check already done by middleware

    // Rate limits (before parsing body). Short-circuits on purpose: a visitor who is
    // already blocked must not keep spending the shared login-all budget.
    const key = visitorKey(c);
    const allowed = rateLimit(db, 'login', key, 5, 15 * 60 * 1000)
      && rateLimit(db, 'login-day', key, 20, 24 * 60 * 60 * 1000)
      && rateLimit(db, 'login-all', 'all', 30, 15 * 60 * 1000);
    if (!allowed) {
      c.header('Retry-After', '900');
      return c.html(loginView('Too many attempts. Try again later.'), 429);
    }

    // Parse body
    const body = await c.req.formData().catch(() => null);
    if (!body) return c.html(loginView('Invalid login.'), 401);
    let username = String(body.get('username') || '');
    if (username.length > 100) username = username.slice(0, 100);
    let pw = String(body.get('password') || '');
    if (pw.length > 200) pw = pw.slice(0, 200);

    // Verify
    if (!verifyLogin(username, pw, config)) {
      return c.html(loginView('Invalid login.'), 401);
    }

    const token = signSession(config.sessionSecret);
    const secure = config.isProd ? '; Secure' : '';
    c.header('Set-Cookie', `sid=${token}; Path=/admin; HttpOnly; SameSite=Strict${secure}; Max-Age=${14 * 24 * 60 * 60}`);
    return c.redirect('/admin');
  });

  // --- Logout ---
  app.post('/logout', (c) => {
    const secure = config.isProd ? '; Secure' : '';
    c.header('Set-Cookie', `sid=; Path=/admin; HttpOnly; SameSite=Strict${secure}; Max-Age=0`);
    return c.redirect('/admin/login');
  });

  // --- Pages ---
  app.get('/', async (c) => {
    const albums = db.prepare('SELECT id, title FROM albums ORDER BY title').all();
    return c.html(adminView(albums, pendingCount()));
  });

  app.get('/photos', async (c) => {
    const albumId = c.req.query('album');
    const unpublished = c.req.query('unpublished') === '1';
    let sql = 'SELECT p.*, a.title AS album_title FROM photos p LEFT JOIN albums a ON p.album_id = a.id';
    const params = [];
    const conds = [];
    if (albumId) { conds.push('p.album_id = ?'); params.push(Number(albumId)); }
    if (unpublished) { conds.push('p.is_published = 0'); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY p.created_at DESC';
    const photos = db.prepare(sql).all(...params);
    const albums = db.prepare('SELECT id, title FROM albums ORDER BY title').all();
    return c.html(photosView(photos, albums, { albumId, unpublished }, pendingCount()));
  });

  app.get('/albums', async (c) => {
    const albums = db.prepare('SELECT a.*, (SELECT COUNT(*) FROM photos WHERE album_id = a.id) AS photo_count FROM albums a ORDER BY a.position, a.id').all();
    return c.html(albumsView(albums, pendingCount()));
  });

  app.get('/comments', async (c) => {
    const pending = db.prepare(
      `SELECT c.*, p.id AS pid FROM comments c LEFT JOIN photos p ON c.photo_id = p.id WHERE c.status = 'pending' ORDER BY c.created_at DESC`
    ).all();
    const all = db.prepare(
      `SELECT c.*, p.id AS pid FROM comments c LEFT JOIN photos p ON c.photo_id = p.id WHERE c.status != 'pending' ORDER BY c.created_at DESC LIMIT 100`
    ).all();
    return c.html(commentsView(pending, all));
  });

  // --- Serve images (admin, any status) ---
  app.get('/img/:id/:file', async (c) => {
    const id = c.req.param('id');
    const file = c.req.param('file');
    if (!PHOTO_ID_RE.test(id)) return c.text('Not found', 404);
    const m = file.match(/^(\d{1,5})\.(avif|webp|jpg)$/);
    if (!m) return c.text('Not found', 404);
    const width = m[1];
    const fmt = m[2];
    const filePath = join(dataDir, 'derived', id, `${width}.${fmt}`);
    try {
      const buf = await readFile(filePath);
      const mime = fmt === 'avif' ? 'image/avif' : fmt === 'webp' ? 'image/webp' : 'image/jpeg';
      c.header('Content-Type', mime);
      c.header('Cache-Control', 'private, no-store');
      return c.body(buf);
    } catch {
      return c.text('Not found', 404);
    }
  });

  // --- API ---

  // Upload (60 MB + 1 MB body limit)
  app.post('/api/upload', bodyLimit({ maxSize: 61 * 1024 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
    try {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') {
        return c.json({ error: 'no_file' }, 400);
      }
      const albumIdRaw = form.get('album_id');
      const check = validateAlbumId(albumIdRaw);
      if (!check.ok) return c.json({ error: 'invalid_album_id' }, 400);
      let albumId = check.id;
      if (albumId !== null) {
        const exists = db.prepare('SELECT 1 FROM albums WHERE id = ?').get(albumId);
        if (!exists) return c.json({ error: 'album_not_found' }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const result = await ingest(db, dataDir, buf, file.name || 'photo.jpg', { albumId });
      return c.json(result, 201);
    } catch (err) {
      if (err.code === 'UNSUPPORTED') {
        return c.json({ error: 'unsupported' }, 415);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  // Status polling
  app.get('/api/photos/status', (c) => {
    const idsStr = c.req.query('ids') || '';
    const ids = idsStr.split(',').filter((id) => PHOTO_ID_RE.test(id));
    if (!ids.length) return c.json({ photos: [] });
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, status, is_published FROM photos WHERE id IN (${placeholders})`).all(...ids);
    return c.json({ photos: rows });
  });

  // Patch photo
  app.patch('/api/photos/:id', async (c) => {
    const id = c.req.param('id');
    if (!PHOTO_ID_RE.test(id)) return c.json({ error: 'not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const fields = [];
    const vals = [];
    if (body.caption !== undefined) { fields.push('caption = ?'); vals.push(String(body.caption).slice(0, 5000)); }
    if (body.album_id !== undefined) {
      const check = validateAlbumId(body.album_id);
      if (!check.ok) return c.json({ error: 'invalid_album_id' }, 400);
      const albumId = check.id;
      if (albumId !== null) {
        const exists = db.prepare('SELECT 1 FROM albums WHERE id = ?').get(albumId);
        if (!exists) return c.json({ error: 'album_not_found' }, 400);
      }
      fields.push('album_id = ?'); vals.push(albumId);
    }
    if (!fields.length) return c.json({ error: 'no_fields' }, 400);
    vals.push(id);
    db.prepare(`UPDATE photos SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    return c.json({ ok: true });
  });

  // Bulk actions
  app.post('/api/photos/bulk', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id) => PHOTO_ID_RE.test(id));
    const action = body.action;
    if (!ids.length || !['publish', 'unpublish', 'delete', 'move'].includes(action)) {
      return c.json({ error: 'bad_request' }, 400);
    }

    if (action === 'delete') {
      for (const id of ids) {
        deletePhotoHelper(db, dataDir, id);
      }
      return c.json({ ok: true, deleted: ids.length });
    }

    if (action === 'publish') {
      const stmt = db.prepare("UPDATE photos SET is_published = 1, published_at = COALESCE(published_at, ?) WHERE id = ? AND status = 'ready' AND is_published = 0");
      const now = nowIso();
      let count = 0;
      for (const id of ids) {
        count += stmt.run(now, id).changes;
        publishAlbumOf.run(id);
      }
      return c.json({ ok: true, changed: count });
    }

    if (action === 'unpublish') {
      const stmt = db.prepare('UPDATE photos SET is_published = 0 WHERE id = ?');
      let count = 0;
      for (const id of ids) { count += stmt.run(id).changes; }
      return c.json({ ok: true, changed: count });
    }

    if (action === 'move') {
      const check = validateAlbumId(body.album_id);
      if (!check.ok) return c.json({ error: 'invalid_album_id' }, 400);
      const albumId = check.id;
      if (albumId !== null) {
        const exists = db.prepare('SELECT 1 FROM albums WHERE id = ?').get(albumId);
        if (!exists) return c.json({ error: 'album_not_found' }, 400);
      }
      const stmt = db.prepare('UPDATE photos SET album_id = ? WHERE id = ?');
      for (const id of ids) { stmt.run(albumId, id); }
      for (const id of ids) publishAlbumOf.run(id);
      return c.json({ ok: true });
    }
  });

  // Albums CRUD
  app.get('/api/albums', (c) => {
    const albums = db.prepare('SELECT * FROM albums ORDER BY position, id').all();
    return c.json({ albums });
  });

  app.post('/api/albums', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const title = String(body.title || '').trim().slice(0, 200);
    if (!title) return c.json({ error: 'title_required' }, 400);
    const baseSlug = slugify(title);
    let slug = baseSlug;
    let n = 1;
    while (db.prepare('SELECT 1 FROM albums WHERE slug = ?').get(slug)) {
      n++;
      slug = `${baseSlug}-${n}`;
    }
    db.prepare('INSERT INTO albums (slug, title, description, position, is_published, created_at) VALUES (?,?,?,0,0,?)')
      .run(slug, title, String(body.description || ''), nowIso());
    const album = db.prepare('SELECT * FROM albums WHERE slug = ?').get(slug);
    return c.json({ album }, 201);
  });

  app.patch('/api/albums/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(id);
    if (!album) return c.json({ error: 'not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const fields = [];
    const vals = [];
    if (body.title !== undefined) {
      const title = String(body.title).trim().slice(0, 200);
      fields.push('title = ?'); vals.push(title);
      const baseSlug = slugify(title);
      let slug = baseSlug; let n = 1;
      while (db.prepare('SELECT 1 FROM albums WHERE slug = ? AND id != ?').get(slug, id)) {
        n++; slug = `${baseSlug}-${n}`;
      }
      fields.push('slug = ?'); vals.push(slug);
    }
    if (body.description !== undefined) { fields.push('description = ?'); vals.push(String(body.description).slice(0, 2000)); }
    if (body.is_published !== undefined) { fields.push('is_published = ?'); vals.push(body.is_published ? 1 : 0); }
    if (body.cover_photo_id !== undefined) { fields.push('cover_photo_id = ?'); vals.push(body.cover_photo_id ? String(body.cover_photo_id) : null); }
    if (!fields.length) return c.json({ error: 'no_fields' }, 400);
    vals.push(id);
    db.prepare(`UPDATE albums SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    return c.json({ ok: true });
  });

  app.delete('/api/albums/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(id);
    if (!album) return c.json({ error: 'not_found' }, 404);
    db.prepare('UPDATE photos SET album_id = NULL WHERE album_id = ?').run(id);
    db.prepare('DELETE FROM albums WHERE id = ?').run(id);
    return c.json({ ok: true });
  });

  // Comments
  app.post('/api/comments/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
    if (!comment) return c.json({ error: 'not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const action = body.action;
    if (!['approve', 'reject', 'delete'].includes(action)) {
      return c.json({ error: 'bad_action' }, 400);
    }
    if (action === 'delete') {
      db.prepare('DELETE FROM comments WHERE id = ?').run(id);
    } else {
      const status = action === 'approve' ? 'approved' : 'rejected';
      db.prepare('UPDATE comments SET status = ? WHERE id = ?').run(status, id);
    }
    return c.json({ ok: true });
  });

  return app;
}
