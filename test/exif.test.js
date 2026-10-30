import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { readExif } from '../lib/images.js';
import { openDb } from '../lib/db.js';

const fakeExif = (tags) => async () => JSON.stringify([tags]);

test('crop comes from what the editor recorded', async () => {
  const fuji = await readExif('x.jpg', fakeExif({ HasCrop: true, CropTop: 0.022728, CropLeft: 0, CropBottom: 1, CropRight: 0.977271 }));
  assert.equal(fuji.cropped, '4.5%');
  const full = await readExif('x.jpg', fakeExif({ HasCrop: false, CropTop: 0, CropLeft: 0, CropBottom: 1, CropRight: 1 }));
  assert.equal(full.cropped, 'None');
});

test('no crop data stays unknown instead of guessing', async () => {
  assert.equal((await readExif('x.jpg', fakeExif({ Make: 'Canon', Model: 'Canon EOS R8' }))).cropped, null);
  assert.equal((await readExif('x.jpg', fakeExif({ HasCrop: true, CropTop: 'x' }))).cropped, null);
});

test('mode and editor are readable', async () => {
  const tags = await readExif('x.jpg', fakeExif({ ExposureProgram: 3, Software: 'Adobe Photoshop Lightroom Classic 14.5.1 (Windows)' }));
  assert.equal(tags.mode, 'Aperture priority');
  assert.equal(tags.software, 'Lightroom Classic');
  assert.equal((await readExif('x.jpg', fakeExif({ Software: 'darktable 4.8.1' }))).software, 'darktable');
  assert.equal((await readExif('x.jpg', fakeExif({ Software: 'Firmware Version 1.2.0' }))).software, null);
});

test('real Lightroom-style fixture has no crop tags and hides the field', async () => {
  const tags = await readExif(join(import.meta.dirname, 'fixtures', 'exif-gps.jpg'));
  assert.equal(tags.camera, 'TestCam X1');
  assert.equal(tags.cropped, null);
});

test('an existing database gains the new columns', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'photos-db-')), 'old.sqlite');
  const old = new Database(path);
  old.exec(`CREATE TABLE photos (id TEXT PRIMARY KEY, album_id INTEGER, caption TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
    is_published INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, original_name TEXT NOT NULL, original_ext TEXT NOT NULL,
    original_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, published_at TEXT, taken_at TEXT)`);
  old.close();
  const db = openDb(path);
  const columns = db.prepare('PRAGMA table_info(photos)').all().map((c) => c.name);
  for (const column of ['mode', 'software', 'cropped']) assert.ok(columns.includes(column));
  db.close();
  openDb(path).close();
});

test('without editor data, crop is estimated from my camera resolution', async () => {
  const canon = { Make: 'Canon', Model: 'Canon EOS R8' };
  assert.equal((await readExif('x.jpg', fakeExif({ ...canon, ImageWidth: 5864, ImageHeight: 3909 }))).cropped, '≈4.5%');
  assert.equal((await readExif('x.jpg', fakeExif({ ...canon, ImageWidth: 4000, ImageHeight: 6000 }))).cropped, 'None');
  // Far below full size is probably a resized export, and larger isn't from this sensor
  assert.equal((await readExif('x.jpg', fakeExif({ ...canon, ImageWidth: 2048, ImageHeight: 1365 }))).cropped, null);
  assert.equal((await readExif('x.jpg', fakeExif({ ...canon, ImageWidth: 6022, ImageHeight: 4024 }))).cropped, null);
  // Editor data wins over the estimate
  const both = { ...canon, ImageWidth: 5864, ImageHeight: 3909, HasCrop: false };
  assert.equal((await readExif('x.jpg', fakeExif(both))).cropped, 'None');
});

test('site identity comes from settings, not code', async () => {
  const { loadConfig } = await import('../lib/config.js');
  const { publicViews } = await import('../views/public.js');
  const page = (env) => publicViews({ config: loadConfig(env) }).home({ albums: [], photos: [], page: 1, totalPages: 1 });
  assert.match(page({}), /<h1 class="masthead-title">Photos<\/h1>/);
  assert.doesNotMatch(page({}), />Blog</);
  const mine = page({ SITE_TITLE: 'A & B', SITE_TAGLINE: 'Film', BLOG_URL: 'https://example.com' });
  assert.match(mine, /A &amp; B/);
  assert.match(mine, />Film</);
  assert.match(mine, /href="https:\/\/example\.com">Blog/);
});

test('production refuses to start without SITE_URL', async () => {
  const { loadConfig } = await import('../lib/config.js');
  const env = { NODE_ENV: 'production', ADMIN_PASSWORD_HASH: 'x', ADMIN_USERNAME: 'x', SESSION_SECRET: 'x', VISITOR_SECRET: 'x', TURNSTILE_SITE_KEY: 'x', TURNSTILE_SECRET: 'x' };
  assert.throws(() => loadConfig(env), /SITE_URL/);
});

test('the site name in the header links home', async () => {
  const { loadConfig } = await import('../lib/config.js');
  const { publicViews } = await import('../views/public.js');
  const html = publicViews({ config: loadConfig({ SITE_TITLE: 'Name' }) }).albums({ albums: [] });
  assert.match(html, /<a class="site-title" href="\/">Name<\/a>/);
});
