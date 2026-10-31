import { Hono } from 'hono';
import { etag } from 'hono/etag';
import { bodyLimit } from 'hono/body-limit';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import { getConnInfo } from '@hono/node-server/conninfo';
import { clientIp, visitorHash, rateLimit, verifyTurnstile, validateComment, canAcceptComment } from '../lib/guard.js';
import { nowIso } from '../lib/db.js';
import { derivedWidths } from '../lib/images.js';
import { viewCounter, logEvent } from '../lib/stats.js';
import { isOn } from '../lib/settings.js';
import { publicViews } from '../views/public.js';

const ID_RE = /^[0-9a-f]{16}$/;
const FILE_RE = /^\d{1,5}\.(avif|webp|jpg)$/;
const FONT_RE = /^[a-z0-9-]+\.woff2$/;
const TAG_RE = /^[a-z0-9][a-z0-9 -]{0,29}$/;

const DEFAULT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f4611e"/><path fill="#0e0d0c" d="M12.2 8.5h7.6l1.7 2.8H25a2.5 2.5 0 0 1 2.5 2.5v8.7A2.5 2.5 0 0 1 25 25H7a2.5 2.5 0 0 1-2.5-2.5v-8.7A2.5 2.5 0 0 1 7 11.3h3.5z"/><circle cx="16" cy="17.8" r="4.2" fill="#f4611e"/></svg>`;

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'self'; font-src 'self'";

const MIME = {
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const FONTS_DIR = join(PUBLIC_DIR, 'fonts');

let siteCss = '';
let siteJs = '';
let adminCss = '';
let adminJs = '';
siteCss = await readFile(join(PUBLIC_DIR, 'site.css'), 'utf-8');
siteJs = await readFile(join(PUBLIC_DIR, 'site.js'), 'utf-8');
adminCss = await readFile(join(PUBLIC_DIR, 'admin.css'), 'utf-8');
adminJs = await readFile(join(PUBLIC_DIR, 'admin.js'), 'utf-8');

export function publicRoutes({ db, config, dataDir, fetchFn }) {
  const app = new Hono();
  const views = publicViews({ config });

  function getIp(c) {
    let socketIp = 'unknown';
    try {
      const info = getConnInfo(c);
      if (info && info.remote && info.remote.address) socketIp = info.remote.address;
    } catch { /* app.request does not support getConnInfo */ }
    return clientIp((h) => c.req.header(h), config, socketIp);
  }

  const count = viewCounter(db, config);
  // Grid hearts follow the same switch as the button
  const gridPhotos = (photos) => (isOn(db, 'likes_on') ? photos : photos.map((photo) => ({ ...photo, like_count: 0 })));

  function countView(c, kind, ref) {
    if (c.req.method !== 'GET') return;
    try {
      count({
        kind,
        ref: String(ref),
        visitor: visitorHash(config.visitorSecret, getIp(c)),
        userAgent: c.req.header('user-agent'),
        purpose: c.req.header('sec-purpose') || c.req.header('purpose'),
        referrer: c.req.header('referer'),
        country: config.trustCf ? c.req.header('cf-ipcountry') : null,
        owner: /(?:^|;\s*)owner=1/.test(c.req.header('cookie') || ''),
      });
    } catch { /* stats never break a page */ }
  }

  function listPublicAlbums() {
    const albums = db.prepare(`
      SELECT a.* FROM albums a
      WHERE a.is_published = 1
        AND EXISTS (SELECT 1 FROM photos p WHERE p.album_id = a.id AND p.status = 'ready' AND p.is_published = 1 AND p.privacy_ok = 1)
      ORDER BY a.position ASC
    `).all();

    for (const album of albums) {
      const photoCount = db.prepare(
        "SELECT COUNT(*) AS cnt FROM photos WHERE album_id = ? AND status = 'ready' AND is_published = 1 AND privacy_ok = 1"
      ).get(album.id).cnt;
      album.photo_count = photoCount;

      let cover = null;
      if (album.cover_photo_id) {
        cover = db.prepare(
          "SELECT id, width, height, placeholder, caption, avif_ready, meta, image_version FROM photos WHERE id = ? AND status = 'ready' AND is_published = 1 AND privacy_ok = 1"
        ).get(album.cover_photo_id) || null;
      }
      if (!cover) {
        cover = db.prepare(
          "SELECT id, width, height, placeholder, caption, avif_ready, meta, image_version FROM photos WHERE album_id = ? AND status = 'ready' AND is_published = 1 AND privacy_ok = 1 ORDER BY COALESCE(published_at, created_at) DESC LIMIT 1"
        ).get(album.id) || null;
      }
      album.cover = cover;
      album.previews = db.prepare(`
        SELECT id, width, image_version FROM photos
        WHERE album_id = ? AND status = 'ready' AND is_published = 1 AND privacy_ok = 1 AND id != ?
        ORDER BY position ASC, taken_at DESC
        LIMIT 6
      `).all(album.id, cover ? cover.id : '');
    }
    return albums;
  }

  // Middleware: set common headers
  app.use('*', async (c, next) => {
    await next();
    const ct = c.res.headers.get('Content-Type') || '';
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (ct.includes('text/html')) {
      c.header('Content-Security-Policy', CSP);
      c.header('Cache-Control', 'no-store');
    }
  });

  // Static files (read once at startup, served here)
  for (const path of ['/site.css', '/site.js', '/static/admin.css', '/static/admin.js']) app.use(path, etag());
  // The hashed URLs from lib/assets.js can never change, so only a bare URL revalidates
  const asset = (path, type, body) => app.get(path, (c) => {
    c.header('Content-Type', `${type}; charset=utf-8`);
    c.header('Cache-Control', c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache');
    return c.body(body);
  });
  asset('/site.css', 'text/css', siteCss);
  asset('/site.js', 'application/javascript', siteJs);
  asset('/static/admin.css', 'text/css', adminCss);
  asset('/static/admin.js', 'application/javascript', adminJs);

  // Font serving
  app.get('/fonts/:file', async (c) => {
    const file = c.req.param('file');
    if (!FONT_RE.test(file)) {
      return c.text('Not found', 404);
    }
    const filePath = join(FONTS_DIR, file);
    try {
      const data = await readFile(filePath);
      c.header('Content-Type', 'font/woff2');
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(data);
    } catch {
      return c.text('Not found', 404);
    }
  });

  const LIVE_PHOTOS = "status = 'ready' AND is_published = 1 AND privacy_ok = 1";

  // data/favicon.svg replaces the default, the same way data/watermark.svg adds a signature
  app.get('/favicon.svg', async (c) => {
    const custom = await readFile(join(dataDir, 'favicon.svg'), 'utf-8').catch(() => null);
    c.header('Content-Type', 'image/svg+xml');
    c.header('Cache-Control', 'public, max-age=86400');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return c.body(custom ?? DEFAULT_ICON);
  });

  app.get('/robots.txt', (c) => c.text(views.robots()));

  app.get('/sitemap.xml', (c) => {
    const photos = db.prepare(`SELECT id, published_at FROM photos WHERE ${LIVE_PHOTOS} ORDER BY published_at DESC`).all();
    const albums = listPublicAlbums();
    c.header('Content-Type', 'application/xml; charset=utf-8');
    return c.body(views.sitemap({ albums, photos }));
  });

  app.get('/feed.xml', (c) => {
    const photos = db.prepare(`SELECT * FROM photos WHERE ${LIVE_PHOTOS} ORDER BY COALESCE(published_at, created_at) DESC LIMIT 30`).all();
    c.header('Content-Type', 'application/rss+xml; charset=utf-8');
    return c.body(views.feed({ photos }));
  });

  // Home page
  app.get('/', (c) => {
    const albums = listPublicAlbums();

    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
    const perPage = 60;
    const offset = (page - 1) * perPage;

    const photos = db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM likes l WHERE l.photo_id = p.id) AS like_count
      FROM photos p
      WHERE p.status = 'ready' AND p.is_published = 1 AND p.privacy_ok = 1
      ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.taken_at DESC, p.id ASC
      LIMIT ? OFFSET ?
    `).all(perPage, offset);

    const total = db.prepare("SELECT COUNT(*) AS cnt FROM photos WHERE status = 'ready' AND is_published = 1 AND privacy_ok = 1").get().cnt;
    const totalPages = Math.max(1, Math.ceil(total / perPage));

    countView(c, 'page', 'home');
    const html = views.home({ albums, photos: gridPhotos(photos), page, totalPages });
    return c.html(html);
  });

  // Albums list
  app.get('/albums', (c) => {
    const albums = listPublicAlbums();
    countView(c, 'page', 'albums');
    const html = views.albums({ albums });
    return c.html(html);
  });

  app.get('/explore', (c) => {
    const labels = (key, limit) => db.prepare(`
      SELECT j.value, COUNT(*) AS n
      FROM photos p, json_each(p.meta, ?) j
      WHERE p.status = 'ready' AND p.is_published = 1 AND p.privacy_ok = 1
      GROUP BY j.value ORDER BY n DESC, j.value LIMIT ?
    `).all(`$.${key}`, limit);
    countView(c, 'page', 'explore');
    return c.html(views.explore({ moods: labels('moods', 20), details: labels('details', 30), colors: labels('colors', 15), tags: labels('tags', 60) }));
  });

  // Everything with one label
  app.get('/tag/:tag', (c) => {
    const tag = c.req.param('tag').toLowerCase();
    if (!TAG_RE.test(tag)) return c.html(views.notFound(), 404);

    const photos = db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM likes l WHERE l.photo_id = p.id) AS like_count
      FROM photos p
      WHERE p.status = 'ready' AND p.is_published = 1 AND p.privacy_ok = 1 AND (
        EXISTS (SELECT 1 FROM json_each(p.meta, '$.tags') WHERE value = ?)
        OR EXISTS (SELECT 1 FROM json_each(p.meta, '$.moods') WHERE value = ?)
        OR EXISTS (SELECT 1 FROM json_each(p.meta, '$.colors') WHERE value = ?)
        OR EXISTS (SELECT 1 FROM json_each(p.meta, '$.details') WHERE value = ?)
      )
      ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.taken_at DESC, p.id ASC
    `).all(tag, tag, tag, tag);
    if (!photos.length) return c.html(views.notFound(), 404);

    countView(c, 'tag', tag);
    return c.html(views.albumDetail({ album: { title: tag, description: '' }, photos: gridPhotos(photos), photoCount: photos.length }));
  });

  // Album detail
  app.get('/a/:slug', (c) => {
    const slug = c.req.param('slug');
    const album = db.prepare('SELECT * FROM albums WHERE slug = ? AND is_published = 1').get(slug);
    if (!album) return c.html(views.notFound(), 404);

    const photos = db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM likes l WHERE l.photo_id = p.id) AS like_count
      FROM photos p
      WHERE p.album_id = ? AND p.status = 'ready' AND p.is_published = 1 AND p.privacy_ok = 1
      ORDER BY p.position ASC, p.taken_at DESC, p.id ASC
    `).all(album.id);

    const photoCount = photos.length;
    countView(c, 'album', album.id);
    const html = views.albumDetail({ album, photos: gridPhotos(photos), photoCount });
    return c.html(html);
  });

  // Photo detail
  app.get('/p/:id', (c) => {
    const id = c.req.param('id');
    if (!ID_RE.test(id)) return c.html(views.notFound(), 404);

    const photo = db.prepare("SELECT * FROM photos WHERE id = ? AND status = 'ready' AND is_published = 1 AND privacy_ok = 1").get(id);
    if (!photo) return c.html(views.notFound(), 404);

    const ip = getIp(c);
    const visitor = visitorHash(config.visitorSecret, ip);

    const liked = !!db.prepare('SELECT 1 FROM likes WHERE photo_id = ? AND visitor = ?').get(id, visitor);
    const likeCount = db.prepare('SELECT COUNT(*) AS cnt FROM likes WHERE photo_id = ?').get(id).cnt;

    const comments = db.prepare("SELECT author, body, created_at FROM comments WHERE photo_id = ? AND status = 'approved' ORDER BY created_at ASC").all(id);

    let album = null;
    if (photo.album_id) {
      album = db.prepare('SELECT * FROM albums WHERE id = ? AND is_published = 1').get(photo.album_id);
    }

    // Arrows follow the page you came from
    const fromLatest = c.req.query('from') === 'latest';
    let prev = null, next = null;
    if (album && !fromLatest) {
      // Published album: use album order
      const siblings = db.prepare(`
        SELECT id FROM photos
        WHERE album_id = ? AND status = 'ready' AND is_published = 1 AND privacy_ok = 1
        ORDER BY position ASC, taken_at DESC, id ASC
      `).all(album.id);
      const idx = siblings.findIndex((r) => r.id === id);
      if (idx > 0) prev = { id: siblings[idx - 1].id };
      if (idx >= 0 && idx < siblings.length - 1) next = { id: siblings[idx + 1].id };
    } else {
      // Home feed order (all public photos)
      const siblings = db.prepare(`
        SELECT id FROM photos
        WHERE status = 'ready' AND is_published = 1 AND privacy_ok = 1
        ORDER BY COALESCE(published_at, created_at) DESC, taken_at DESC, id ASC
      `).all();
      const idx = siblings.findIndex((r) => r.id === id);
      if (idx > 0) prev = { id: siblings[idx - 1].id };
      if (idx >= 0 && idx < siblings.length - 1) next = { id: siblings[idx + 1].id };
    }

    countView(c, 'photo', id);
    const html = views.photoDetail({
      photo, album, liked, likeCount, comments, prev, next,
      navQuery: fromLatest ? '?from=latest' : '',
      turnstileSiteKey: config.turnstileSiteKey,
      showComments: isOn(db, 'comments_on'),
      showLikes: isOn(db, 'likes_on'),
      showFullSize: isOn(db, 'full_size_on'),
    });
    return c.html(html);
  });

  // Image serving
  app.get('/img/:id/:file', async (c) => {
    const id = c.req.param('id');
    const file = c.req.param('file');

    if (!ID_RE.test(id) || !FILE_RE.test(file)) {
      return c.text('Not found', 404);
    }

    const photo = db.prepare("SELECT status, is_published, privacy_ok FROM photos WHERE id = ?").get(id);
    if (!photo || photo.status !== 'ready' || !photo.is_published || !photo.privacy_ok) {
      return c.text('Not found', 404);
    }

    const ext = extname(file);
    const mime = MIME[ext];
    if (!mime) return c.text('Not found', 404);

    const filePath = join(dataDir, 'derived', id, file);

    try {
      const data = await readFile(filePath);
      c.header('Content-Type', mime);
      // The edge drops it within a day, so a deleted, unpublished or newly blurred photo can't linger there
      c.header('Cache-Control', 'public, max-age=31536000, s-maxage=86400, immutable');
      return c.body(data);
    } catch {
      return c.text('Not found', 404);
    }
  });

  // Like API
  app.post('/api/photos/:id/like', async (c) => {
    if (!isOn(db, 'likes_on')) return c.json({ error: 'likes are off' }, 403);
    const id = c.req.param('id');
    if (!ID_RE.test(id)) return c.json({ error: 'not found' }, 404);

    const photo = db.prepare("SELECT id FROM photos WHERE id = ? AND status = 'ready' AND is_published = 1 AND privacy_ok = 1").get(id);
    if (!photo) return c.json({ error: 'not found' }, 404);

    const ip = getIp(c);
    const visitor = visitorHash(config.visitorSecret, ip);

    if (!rateLimit(db, 'like', visitor, 60, 60 * 60 * 1000)) {
      return c.json({ error: 'rate limited' }, 429);
    }

    db.prepare('INSERT OR IGNORE INTO likes (photo_id, visitor, created_at) VALUES (?, ?, ?)').run(id, visitor, nowIso());
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM likes WHERE photo_id = ?').get(id).cnt;

    return c.json({ count, liked: true });
  });

  app.delete('/api/photos/:id/like', async (c) => {
    if (!isOn(db, 'likes_on')) return c.json({ error: 'likes are off' }, 403);
    const id = c.req.param('id');
    if (!ID_RE.test(id)) return c.json({ error: 'not found' }, 404);

    const photo = db.prepare("SELECT id FROM photos WHERE id = ? AND status = 'ready' AND is_published = 1 AND privacy_ok = 1").get(id);
    if (!photo) return c.json({ error: 'not found' }, 404);

    const ip = getIp(c);
    const visitor = visitorHash(config.visitorSecret, ip);

    if (!rateLimit(db, 'like', visitor, 60, 60 * 60 * 1000)) {
      return c.json({ error: 'rate limited' }, 429);
    }

    db.prepare('DELETE FROM likes WHERE photo_id = ? AND visitor = ?').run(id, visitor);
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM likes WHERE photo_id = ?').get(id).cnt;

    return c.json({ count, liked: false });
  });

  // Comment API
  app.post('/api/photos/:id/comments',
    bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'too large' }, 413) }),
    async (c) => {
      if (!isOn(db, 'comments_on')) return c.json({ error: 'comments are off' }, 403);
      const id = c.req.param('id');
      if (!ID_RE.test(id)) return c.json({ error: 'not found' }, 404);

      const photo = db.prepare("SELECT id FROM photos WHERE id = ? AND status = 'ready' AND is_published = 1 AND privacy_ok = 1").get(id);
      if (!photo) return c.json({ error: 'not found' }, 404);

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid json' }, 400);
      }

      const { author, body: commentBody, website, email, token } = body || {};

      const validation = validateComment({ author, body: commentBody, website, email });

      if (!validation.ok) {
        logEvent(db, 'comment_blocked', validation.error);
        if (validation.error === 'honeypot') {
          return c.json({ ok: true, pending: true });
        }
        return c.json({ error: validation.error }, 400);
      }

      const ip = getIp(c);
      const visitor = visitorHash(config.visitorSecret, ip);

      if (!rateLimit(db, 'comment', visitor, 5, 60 * 60 * 1000)) {
        logEvent(db, 'comment_blocked', 'rate limited');
        return c.json({ error: 'rate limited' }, 429);
      }

      if (!canAcceptComment(db)) {
        logEvent(db, 'comment_blocked', 'queue full');
        return c.json({ error: 'queue full' }, 429);
      }

      const tsOk = await verifyTurnstile(config.turnstileSecret, token, ip, fetchFn);
      if (!tsOk) {
        logEvent(db, 'comment_blocked', 'turnstile failed');
        return c.json({ error: 'turnstile failed' }, 403);
      }

      db.prepare(
        "INSERT INTO comments (photo_id, author, body, email, status, visitor, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
      ).run(id, validation.author, validation.body, validation.email, visitor, nowIso());

      return c.json({ ok: true, pending: true });
    }
  );

  // A route, not notFound(), because a mounted app's notFound() never runs
  app.all('*', (c) => c.html(views.notFound(), 404));

  return app;
}
