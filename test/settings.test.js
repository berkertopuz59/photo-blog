import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, nowIso } from '../lib/db.js';
import { loadConfig } from '../lib/config.js';
import { setSetting } from '../lib/settings.js';
import { publicRoutes } from '../routes/public.js';
import { settingsView } from '../views/admin.js';

const ID = 'aaaaaaaaaaaaaaaa';
const on = { watermark_on: true, watermark_exif: false, ai_captions: true, ai_privacy: false, comments_on: true, likes_on: true, full_size_on: true };
const site = { title: 'Name', tagline: 'Photos', url: 'https://example.com', blog: '', testKeys: false };
const ai = { configured: false, model: '', captions: { today: 0, month: 0 }, privacy: { today: 0, month: 0 } };
const page = (over = {}) => settingsView({ switches: on, watermark: { hasFile: true, opacity: 35, done: 3, total: 9 }, ai, site, ...over });

describe('settings page', () => {
  it('shows watermark progress, and switches only with a file', () => {
    assert.ok(page().includes('3 of 9 photos'));
    assert.ok(page().includes('data-setting="watermark_on" checked'));
    const empty = page({ watermark: { hasFile: false, opacity: 35, done: 0, total: 9 } });
    assert.ok(empty.includes('data/watermark.svg'));
    assert.ok(!empty.includes('data-setting="watermark_on"'));
  });

  it('shows the opacity slider with its value', () => {
    assert.ok(page().includes('value="35" data-number-setting="watermark_opacity"'));
    assert.ok(page().includes('35%'));
  });

  it('shows AI switches only when AI is set up', () => {
    assert.ok(!page().includes('data-setting="ai_captions"'));
    assert.ok(page({ ai: { ...ai, configured: true, model: 'vision-<1>' } }).includes('data-setting="ai_captions" checked'));
    assert.ok(page({ ai: { ...ai, configured: true, model: 'vision-<1>' } }).includes('vision-&lt;1&gt;'));
  });

  it('warns about test bot keys', () => {
    assert.ok(!page().includes('test keys'));
    assert.ok(page({ site: { ...site, testKeys: true } }).includes('test keys'));
    assert.equal(loadConfig({}).turnstileTestKeys, true);
    assert.equal(loadConfig({ TURNSTILE_SITE_KEY: 'real' }).turnstileTestKeys, false);
  });
});

describe('visitor switches', () => {
  let dir, db, app;

  beforeEach(() => {
    dir = join(tmpdir(), `photos-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    db = openDb(join(dir, 'photos.sqlite'));
    db.prepare(`INSERT INTO photos (id, original_name, original_ext, original_sha256, status, is_published, privacy_ok, width, height, created_at)
      VALUES (?, 'a.jpg', 'jpg', 'hash', 'ready', 1, 1, 960, 640, ?)`).run(ID, nowIso());
    db.prepare('INSERT INTO likes (photo_id, visitor, created_at) VALUES (?, ?, ?)').run(ID, 'someone', nowIso());
    app = publicRoutes({ db, config: loadConfig({ DATA_DIR: dir }), dataDir: dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const html = async (path) => (await app.request(path)).text();
  const post = (path, body) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('everything shows by default', async () => {
    const photo = await html(`/p/${ID}`);
    assert.ok(photo.includes('like-btn'));
    assert.ok(photo.includes('Full size'));
    assert.ok(photo.includes('Leave a comment'));
    assert.ok((await html('/')).includes('cell-like-count'));
  });

  it('likes off hides the button and grid hearts and refuses new likes', async () => {
    setSetting(db, 'likes_on', '0');
    assert.ok(!(await html(`/p/${ID}`)).includes('like-btn'));
    assert.ok(!(await html('/')).includes('cell-like-count'));
    assert.equal((await post(`/api/photos/${ID}/like`, {})).status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM likes').get().n, 1);
  });

  it('comments off hides the form, keeps approved comments and refuses new ones', async () => {
    db.prepare("INSERT INTO comments (photo_id, author, body, status, visitor, created_at) VALUES (?, 'Ada', 'Lovely', 'approved', 'v', ?)").run(ID, nowIso());
    setSetting(db, 'comments_on', '0');
    const photo = await html(`/p/${ID}`);
    assert.ok(!photo.includes('Leave a comment'));
    assert.ok(photo.includes('Lovely'));
    assert.equal((await post(`/api/photos/${ID}/comments`, { author: 'A', body: 'Hi' })).status, 403);
  });

  it('full size off hides the link', async () => {
    setSetting(db, 'full_size_on', '0');
    assert.ok(!(await html(`/p/${ID}`)).includes('Full size'));
  });
});
