import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { openDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { viewCounter, logEvent, queueStats, trafficStats, recentEvents } from '../lib/stats.js';
import { adminRoutes } from '../routes/admin.js';
import { publicRoutes } from '../routes/public.js';

const BROWSER = 'Mozilla/5.0 (Macintosh) Safari/605.1.15';
const views = (db) => db.prepare('SELECT COALESCE(SUM(views), 0) AS n FROM daily_views').get().n;
const traffic = (db, dimension) => db.prepare('SELECT value, count FROM daily_traffic WHERE dimension = ? ORDER BY value').all(dimension);

function addPhoto(db, id, fields = {}) {
  const row = { status: 'ready', is_published: 1, ...fields };
  db.prepare(`INSERT INTO photos (id, status, is_published, original_name, original_ext, original_sha256, created_at, process_ms)
    VALUES (?, ?, ?, ?, 'jpg', ?, '2026-10-30T00:00:00Z', ?)`).run(id, row.status, row.is_published, `${id}.jpg`, id, row.process_ms ?? null);
}

function makeApp() {
  const dataDir = join(tmpdir(), 'stats-test-' + Math.random().toString(36).slice(2));
  mkdirSync(join(dataDir, 'originals'), { recursive: true });
  mkdirSync(join(dataDir, 'derived'), { recursive: true });
  const db = openDb(':memory:');
  const config = {
    dataDir, port: 3000, siteUrl: 'http://localhost:3000', adminPasswordHash: hashPassword('pw'), adminUsername: 'admin',
    sessionSecret: 'test-session-secret-32chars-long!!', visitorSecret: 'v', turnstileSiteKey: '', turnstileSecret: 'x',
    trustCf: true, isProd: false, siteTitle: 'T', siteTagline: 'S', blogUrl: '',
  };
  const app = new Hono();
  app.route('/admin', adminRoutes({ db, config, dataDir }));
  app.route('/', publicRoutes({ db, config, dataDir, fetchFn: async () => ({ json: async () => ({ success: false }) }) }));
  return { app, db };
}

async function login(app) {
  const form = new URLSearchParams({ username: 'admin', password: 'pw' });
  const res = await app.request('/admin/login', { method: 'POST', body: form, headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '9.9.9.9' } });
  return res.headers.get('set-cookie').match(/sid=[^;]+/)[0];
}

describe('view counter', () => {
  const setup = () => {
    const db = openDb(':memory:');
    const count = viewCounter(db, { siteUrl: 'https://photos.example.com' });
    const hit = (over = {}) => count({ kind: 'photo', ref: 'a', visitor: 'v1', userAgent: BROWSER, ...over });
    return { db, hit };
  };

  it('counts a visitor once per page and day, and again on a new day', () => {
    const { db, hit } = setup();
    hit(); hit(); hit({ ref: 'b' });
    assert.equal(views(db), 2);
    assert.equal(traffic(db, 'visitors')[0].count, 1);
    hit({ now: new Date(Date.now() + 2 * 86400000) });
    assert.equal(views(db), 3);
  });

  it('skips bots, empty agents, prefetches and the owner', () => {
    const { db, hit } = setup();
    hit({ userAgent: 'Googlebot/2.1' });
    hit({ userAgent: '' });
    hit({ purpose: 'prefetch' });
    hit({ owner: true });
    assert.equal(views(db), 0);
  });

  it('keeps only outside hostnames as referrers', () => {
    const { db, hit } = setup();
    hit({ referrer: 'https://www.reddit.com/r/photos?x=secret' });
    hit({ ref: 'b', referrer: 'https://photos.example.com/albums' });
    hit({ ref: 'c', referrer: 'not a url' });
    assert.deepEqual(traffic(db, 'referrer'), [{ value: 'reddit.com', count: 1 }]);
  });

  it('accepts only real country codes', () => {
    const { db, hit } = setup();
    hit({ country: 'DE' });
    hit({ visitor: 'v2', country: 'XX' });
    hit({ visitor: 'v3', country: '<script>' });
    assert.deepEqual(traffic(db, 'country'), [{ value: 'DE', count: 1 }]);
  });

  it('caps distinct referrers per day so fake ones cannot grow the database', () => {
    const { db, hit } = setup();
    for (let i = 0; i < 250; i++) hit({ ref: `p${i}`, referrer: `https://site${i}.example.org/` });
    assert.equal(traffic(db, 'referrer').length, 200);
    assert.equal(views(db), 250);
  });
});

describe('queue numbers', () => {
  it('reports status counts and time left from recent photos', () => {
    const db = openDb(':memory:');
    addPhoto(db, 'a', { process_ms: 100000 });
    addPhoto(db, 'b', { process_ms: 120000 });
    addPhoto(db, 'c', { status: 'pending' });
    addPhoto(db, 'd', { status: 'processing' });
    addPhoto(db, 'e', { status: 'failed' });
    const q = queueStats(db);
    assert.deepEqual([q.ready, q.pending, q.processing, q.failed, q.total], [2, 1, 1, 1, 5]);
    assert.equal(q.secondsPerPhoto, 110);
    assert.equal(q.secondsLeft, 220);
  });

  it('has no estimate before the first timed photo', () => {
    const db = openDb(':memory:');
    addPhoto(db, 'a', { status: 'pending' });
    assert.equal(queueStats(db).secondsLeft, null);
  });
});

describe('activity log', () => {
  it('drops the oldest rows past the cap and truncates detail', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 5010; i++) logEvent(db, 'login_failed', 'x'.repeat(400));
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM events').get();
    assert.ok(n <= 5001);
    assert.equal(recentEvents(db, 1).items[0].detail.length, 300);
  });

  it('never stores what was typed into a failed login', async () => {
    const { app, db } = makeApp();
    const form = new URLSearchParams({ username: 'typed-user', password: 'typed-password' });
    await app.request('/admin/login', { method: 'POST', body: form, headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' } });
    const rows = recentEvents(db).items;
    assert.equal(rows[0].kind, 'login_failed');
    assert.doesNotMatch(JSON.stringify(rows), /typed/);
  });

  it('records a comment that failed Turnstile', async () => {
    const { app, db } = makeApp();
    const id = 'aaaaaaaaaaaaaaaa';
    addPhoto(db, id);
    const res = await app.request(`/api/photos/${id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' },
      body: JSON.stringify({ author: 'a', body: 'hello', website: '', token: 'bad' }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(recentEvents(db).items.map((e) => [e.kind, e.detail]), [['comment_blocked', 'turnstile failed']]);
  });
});

describe('stats through the app', () => {
  it('counts published pages only, and shows them on the stats page', async () => {
    const { app, db } = makeApp();
    const live = 'aaaaaaaaaaaaaaaa';
    const hidden = 'bbbbbbbbbbbbbbbb';
    addPhoto(db, live);
    addPhoto(db, hidden, { is_published: 0 });
    const headers = { 'user-agent': BROWSER, 'cf-connecting-ip': '1.1.1.1', 'cf-ipcountry': 'DE', referer: 'https://evil.example/<b>' };
    await app.request(`/p/${live}`, { headers });
    await app.request(`/p/${hidden}`, { headers });
    assert.equal(views(db), 1);
    assert.equal(trafficStats(db).photos[0].id, live);

    const sid = await login(app);
    const res = await app.request('/admin/stats', { headers: { cookie: sid } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /aaaaaaaaaaaaaaaa\.jpg/);
    assert.match(html, /evil\.example/);
    assert.match(html, /Germany|DE/);
  });

  it('stats and queue need a session', async () => {
    const { app } = makeApp();
    const page = await app.request('/admin/stats', { headers: { 'cf-connecting-ip': '1.1.1.1' } });
    const api = await app.request('/admin/api/queue', { headers: { 'cf-connecting-ip': '1.1.1.1' } });
    assert.equal(page.status, 302);
    assert.equal(api.status, 401);
  });

  it('a logged-in browser gets the owner cookie and its visits are not counted', async () => {
    const { app, db } = makeApp();
    const id = 'aaaaaaaaaaaaaaaa';
    addPhoto(db, id);
    const sid = await login(app);
    const res = await app.request('/admin/photos', { headers: { cookie: sid } });
    assert.match(res.headers.get('set-cookie'), /owner=1; Path=\//);
    await app.request(`/p/${id}`, { headers: { 'user-agent': BROWSER, cookie: 'owner=1', 'cf-connecting-ip': '1.1.1.1' } });
    assert.equal(views(db), 0);
  });
});
