import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import sharp from 'sharp';
import { openDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { ingest, processPhoto } from '../lib/images.js';
import { captionNext } from '../lib/captions.js';
import { reviewPhoto, scanPhoto } from '../lib/privacy.js';
import { adminRoutes } from '../routes/admin.js';
import { publicRoutes } from '../routes/public.js';
import { commentsView, privacyView } from '../views/admin.js';

const ART = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100" width="400" height="100"><rect width="400" height="100" fill="#fff"/></svg>';
const api = { captionApiUrl: 'https://api.example.com/v1', captionApiKey: 'k', captionModel: 'm' };
const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const solid = (width, height, background = '#778899') => sharp({ create: { width, height, channels: 3, background } });

describe('regressions', () => {
  let dataDir, db, config, app;

  beforeEach(() => {
    dataDir = join(tmpdir(), `photos-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dataDir, 'originals'), { recursive: true });
    mkdirSync(join(dataDir, 'derived'), { recursive: true });
    db = openDb(':memory:');
    config = {
      dataDir, port: 3000, siteUrl: 'https://photos.example.com', adminPasswordHash: hashPassword('pw'), adminUsername: 'admin',
      sessionSecret: 'test-session-secret-32chars-long!!', visitorSecret: 'v', turnstileSiteKey: 'k', turnstileSecret: 'x',
      trustCf: true, isProd: false, siteTitle: 'Some Name', siteTagline: 'Photographs', blogUrl: '',
    };
    app = new Hono();
    app.route('/admin', adminRoutes({ db, config, dataDir }));
    app.route('/', publicRoutes({ db, config, dataDir }));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function addPhoto(buffer, name = 'a.jpg') {
    const { id } = await ingest(db, dataDir, buffer, name);
    await processPhoto(db, dataDir, id);
    return id;
  }

  function goLive(id, extra = '') {
    db.prepare(`UPDATE photos SET is_published = 1, privacy_ok = 1, privacy_reviewed = 1, published_at = '2026-01-01T00:00:00Z' ${extra} WHERE id = ?`).run(id);
  }

  async function sid() {
    const res = await app.request('/admin/login', {
      method: 'POST',
      body: new URLSearchParams({ username: 'admin', password: 'pw' }),
      headers: { origin: config.siteUrl, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '9.9.9.9' },
    });
    return res.headers.get('set-cookie').match(/sid=[^;]+/)[0];
  }

  const post = (cookie, path, body) => app.request(path, {
    method: 'POST',
    headers: { origin: config.siteUrl, cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  describe('privacy', () => {
    const FACE = { type: 'face', x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3, blur: true };

    it('a new scan that misses a face keeps the blur you approved', async () => {
      const id = await addPhoto(await solid(800, 600).jpeg().toBuffer());
      goLive(id);
      reviewPhoto(db, id, [FACE]);
      await processPhoto(db, dataDir, id);
      const cookie = await sid();
      await post(cookie, `/admin/api/privacy/${id}`, { action: 'rescan' });

      await scanPhoto(db, dataDir, api, id, reply('{"items":[]}'));

      const boxes = JSON.parse(db.prepare('SELECT privacy_boxes FROM photos WHERE id = ?').get(id).privacy_boxes);
      assert.equal(boxes.filter((b) => b.blur).length, 1);
    });

    it('a new scan adds what it finds without doubling a kept blur', async () => {
      const id = await addPhoto(await solid(800, 600).jpeg().toBuffer());
      reviewPhoto(db, id, [FACE]);
      await post(await sid(), `/admin/api/privacy/${id}`, { action: 'rescan' });

      // One box on the same face, one somewhere new
      await scanPhoto(db, dataDir, api, id, reply('{"items":[{"type":"face","box":[110,110,290,290]},{"type":"face","box":[600,600,800,800]}]}'));

      const boxes = JSON.parse(db.prepare('SELECT privacy_boxes FROM photos WHERE id = ?').get(id).privacy_boxes);
      assert.equal(boxes.length, 2);
    });

    it('Approve all can tell which photos the AI has not looked at yet', () => {
      const row = { id: 'a'.repeat(16), original_name: 'a.jpg', boxes: [], privacy_scan: 'new' };
      assert.ok(privacyView([row], { aiOn: true, reviewed: false }).includes('data-unscanned'));
      assert.ok(!privacyView([row], { aiOn: false, reviewed: false }).includes('data-unscanned'));
      assert.ok(!privacyView([{ ...row, privacy_scan: 'done' }], { aiOn: true, reviewed: false }).includes('data-unscanned'));
    });
  });

  describe('album previews', () => {
    async function album() {
      const { lastInsertRowid } = db.prepare("INSERT INTO albums (slug, title, is_published, created_at) VALUES ('a', 'A', 1, '2026-01-01')").run();
      return lastInsertRowid;
    }

    it('leave out photos waiting for privacy review', async () => {
      const albumId = await album();
      const live = await addPhoto(await solid(1200, 800).jpeg().toBuffer());
      const other = await addPhoto(await solid(1200, 800, '#112233').jpeg().toBuffer());
      const waiting = await addPhoto(await solid(1200, 800, '#445566').jpeg().toBuffer());
      goLive(live);
      goLive(other);
      db.prepare('UPDATE photos SET album_id = ?').run(albumId);
      db.prepare('UPDATE photos SET is_published = 1 WHERE id = ?').run(waiting);

      const html = await (await app.request('/albums')).text();
      assert.ok(!html.includes(`/img/${waiting}/`));
    });

    it('ask for the current image version, so a new blur reaches them', async () => {
      const albumId = await album();
      const cover = await addPhoto(await solid(1200, 800).jpeg().toBuffer());
      const blurred = await addPhoto(await solid(1200, 800, '#112233').jpeg().toBuffer());
      goLive(cover);
      goLive(blurred, ', image_version = 3');
      db.prepare('UPDATE photos SET album_id = ?').run(albumId);

      const html = await (await app.request('/albums')).text();
      const previews = /data-previews="([^"]*)"/.exec(html)[1];
      assert.ok(previews.split(' ').some((url) => url.startsWith(`/img/${blurred}/`) && url.endsWith('?v=3')), previews);
    });
  });

  describe('unusual photos', () => {
    const wide = { 'very wide panorama': () => solid(6000, 400), 'very tall strip': () => solid(400, 6000), 'tiny': () => solid(40, 30), 'one pixel tall': () => solid(800, 1) };
    for (const [name, make] of Object.entries(wide)) {
      it(`a ${name} still finishes with a watermark`, async () => {
        writeFileSync(join(dataDir, 'watermark.svg'), ART);
        const id = await addPhoto(await make().png().toBuffer());
        const row = db.prepare('SELECT status, error FROM photos WHERE id = ?').get(id);
        assert.equal(row.status, 'ready', row.error);
      });
    }

    const kinds = {
      grayscale: async () => solid(1200, 800).toColourspace('b-w').jpeg().toBuffer(),
      cmyk: async () => solid(1200, 800).toColourspace('cmyk').jpeg().toBuffer(),
      '16-bit png': async () => solid(1200, 800).toColourspace('rgb16').png().toBuffer(),
      'png with transparency': async () => sharp({ create: { width: 1200, height: 800, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer(),
    };
    for (const [name, make] of Object.entries(kinds)) {
      it(`a ${name} file finishes with a watermark and a blur`, async () => {
        writeFileSync(join(dataDir, 'watermark.svg'), ART);
        const { id } = await ingest(db, dataDir, await make(), 'a.png');
        db.prepare('UPDATE photos SET privacy_boxes = ? WHERE id = ?').run(JSON.stringify([{ type: 'face', x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3, blur: true }]), id);
        await processPhoto(db, dataDir, id);
        const row = db.prepare('SELECT status, error FROM photos WHERE id = ?').get(id);
        assert.equal(row.status, 'ready', row.error);
      });
    }

    it('a photo narrower than 960 pixels still gets a caption draft', async () => {
      const id = await addPhoto(await solid(700, 1000).jpeg().toBuffer());
      await captionNext(db, dataDir, api, reply('{"title":"Slow Water","description":"Water.","tags":["water"],"moods":["calm"],"details":["minimal"]}'));
      assert.equal(db.prepare('SELECT caption_draft FROM photos WHERE id = ?').get(id).caption_draft, 'Slow Water');
    });

    it('a photo narrower than 480 pixels has a thumbnail in the admin', async () => {
      const id = await addPhoto(await solid(300, 400).jpeg().toBuffer());
      const cookie = await sid();
      const html = await (await app.request('/admin/photos', { headers: { cookie } })).text();
      const src = new RegExp(`/admin/img/${id}/[^"]+`).exec(html)[0];
      assert.equal((await app.request(src, { headers: { cookie } })).status, 200, src);
    });
  });

  describe('photo jobs', () => {
    it('a failed photo can be tried again', async () => {
      const id = await addPhoto(await solid(1200, 800).jpeg().toBuffer());
      db.prepare("UPDATE photos SET status = 'failed', error = 'x' WHERE id = ?").run(id);
      const res = await post(await sid(), '/admin/api/photos/bulk', { ids: [id], action: 'retry' });
      assert.equal(res.status, 200);
      assert.equal(db.prepare('SELECT status FROM photos WHERE id = ?').get(id).status, 'pending');
    });

    it('a photo can become its album cover from the Photos page', async () => {
      const { lastInsertRowid: albumId } = db.prepare("INSERT INTO albums (slug, title, created_at) VALUES ('a', 'A', '2026-01-01')").run();
      const id = await addPhoto(await solid(1200, 800).jpeg().toBuffer());
      db.prepare('UPDATE photos SET album_id = ? WHERE id = ?').run(albumId, id);
      const res = await post(await sid(), '/admin/api/photos/bulk', { ids: [id], action: 'cover' });
      assert.equal(res.status, 200);
      assert.equal(db.prepare('SELECT cover_photo_id FROM albums WHERE id = ?').get(albumId).cover_photo_id, id);
    });
  });

  describe('comments', () => {
    it('an approved comment can still be removed', () => {
      const html = commentsView([], [{ id: 7, pid: 'a'.repeat(16), author: 'A', body: 'B', status: 'approved', created_at: '2026-01-01' }]);
      assert.ok(/btn-delete-comment[^>]*data-id="7"/.test(html));
    });

    it('a malformed honeypot field is refused, not a server error', async () => {
      const id = await addPhoto(await solid(1200, 800).jpeg().toBuffer());
      goLive(id);
      const res = await app.request(`/api/photos/${id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: 'A', body: 'B', website: 1, token: 't' }),
      });
      assert.ok(res.status < 500, `status ${res.status}`);
    });
  });

  describe('public pages', () => {
    it('an unknown address gets the site 404 page', async () => {
      const res = await app.request('/nope');
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(res.headers.get('content-security-policy'), /default-src/);
      assert.ok((await res.text()).includes('This page does not exist'));
    });

    it('a shared photo link has a title, description and picture', async () => {
      const id = await addPhoto(await solid(2000, 1000).jpeg().toBuffer());
      goLive(id, ", caption = 'Slow \"Water\"', meta = '{\"description\":\"A quiet river.\"}', image_version = 2");
      const html = await (await app.request(`/p/${id}?from=latest`)).text();
      assert.ok(html.includes('<meta property="og:title" content="Slow &quot;Water&quot;">'), 'title');
      assert.ok(html.includes('<meta name="description" content="A quiet river.">'), 'description');
      assert.ok(html.includes(`<meta property="og:image" content="https://photos.example.com/img/${id}/1600.jpg?v=2">`), 'image');
      assert.ok(html.includes('<meta property="og:image:height" content="800">'), 'height');
      assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'), 'card');
      assert.ok(html.includes(`<link rel="canonical" href="https://photos.example.com/p/${id}">`), 'canonical');
    });

    it('the sitemap and feed list only what is public', async () => {
      const live = await addPhoto(await solid(1200, 800).jpeg().toBuffer());
      const hidden = await addPhoto(await solid(1200, 800, '#112233').jpeg().toBuffer());
      goLive(live, ", caption = 'Tom & Jerry'");
      db.prepare('UPDATE photos SET is_published = 1, privacy_ok = 0 WHERE id = ?').run(hidden);

      const sitemap = await app.request('/sitemap.xml');
      assert.match(sitemap.headers.get('content-type'), /xml/);
      const map = await sitemap.text();
      assert.ok(map.includes(`https://photos.example.com/p/${live}`));
      assert.ok(!map.includes(hidden));

      const feed = await (await app.request('/feed.xml')).text();
      assert.ok(feed.includes(`https://photos.example.com/p/${live}`));
      assert.ok(feed.includes('Tom &amp; Jerry'));
      assert.ok(!feed.includes(hidden));

      const robots = await (await app.request('/robots.txt')).text();
      assert.ok(robots.includes('Disallow: /admin'));
      assert.ok(robots.includes('Sitemap: https://photos.example.com/sitemap.xml'));
    });

    it('the main photo loads first, and portrait photos ask for a fitting size', async () => {
      const id = await addPhoto(await solid(1000, 2000).jpeg().toBuffer());
      goLive(id);
      const html = await (await app.request(`/p/${id}`)).text();
      assert.ok(html.includes('fetchpriority="high"'));
      assert.ok(html.includes('sizes="min(100vw, 50vh)"'), html.match(/sizes="[^"]*"/)?.[0]);
    });

    it('hashed assets stay cached, and the edge forgets an image within a day', async () => {
      const hashed = await app.request('/site.css?v=abc');
      assert.match(hashed.headers.get('cache-control'), /immutable/);
      assert.equal((await app.request('/site.css')).headers.get('cache-control'), 'no-cache');

      const id = await addPhoto(await solid(1200, 800).jpeg().toBuffer());
      goLive(id);
      const image = await app.request(`/img/${id}/960.jpg`);
      assert.match(image.headers.get('cache-control'), /s-maxage=86400/);
    });
  });
});
