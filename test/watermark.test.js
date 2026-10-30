import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../lib/db.js';
import { ingest, processPhoto, encodeAvif } from '../lib/images.js';
import { startWorker } from '../lib/worker.js';
import { applyWatermark, loadWatermark, shootingLine } from '../lib/watermark.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { photosView } from '../views/admin.js';

const ART = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100" width="400" height="100"><rect width="400" height="100" fill="#fff"/></svg>';

async function grey(value) {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: value, g: value, b: value } } }).jpeg({ quality: 95 }).toBuffer();
}

// Mean brightness of an area of a finished file
async function brightness(file, left, top, width, height) {
  const { channels } = await sharp(await sharp(file).extract({ left, top, width, height }).toBuffer()).stats();
  return channels[0].mean;
}

describe('watermark', () => {
  let tmpDir, dataDir, db;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `photos-wm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dataDir = join(tmpDir, 'data');
    mkdirSync(join(dataDir, 'originals'), { recursive: true });
    db = openDb(join(dataDir, 'photos.sqlite'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const addPhoto = async (value = 60) => (await ingest(db, dataDir, await grey(value), 'a.jpg')).id;
  const row = (id) => db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  const file = (id, name = '960.jpg') => join(dataDir, 'derived', id, name);

  test('without the file a photo stays untouched', async () => {
    const id = await addPhoto();
    await processPhoto(db, dataDir, id);
    assert.equal(row(id).watermark, '');
    assert.ok(await brightness(file(id), 500, 560, 460, 80) < 70);
  });

  test('a broken file is ignored and the photo still finishes', async () => {
    writeFileSync(join(dataDir, 'watermark.svg'), 'not an svg');
    const id = await addPhoto();
    await processPhoto(db, dataDir, id);
    assert.equal(await loadWatermark(db, dataDir), null);
    assert.equal(row(id).status, 'ready');
  });

  test('marks the bottom corner of every format and leaves the rest alone', async () => {
    writeFileSync(join(dataDir, 'watermark.svg'), ART);
    const id = await addPhoto();
    await processPhoto(db, dataDir, id);
    await encodeAvif(db, dataDir, id);

    assert.equal(row(id).watermark, (await loadWatermark(db, dataDir)).stamp);
    for (const name of ['960.jpg', '960.webp', '960.avif']) {
      assert.ok(await brightness(file(id, name), 700, 540, 220, 60) > 100, `${name} has no mark`);
      assert.ok(await brightness(file(id, name), 100, 100, 400, 200) < 70, `${name} changed elsewhere`);
    }
  });

  test('bright photos get dark ink', async () => {
    writeFileSync(join(dataDir, 'watermark.svg'), ART);
    const id = await addPhoto(235);
    await processPhoto(db, dataDir, id);
    assert.ok(await brightness(file(id), 700, 540, 220, 60) < 180);
  });

  test('the worker adds it to finished photos, and takes it off again', async () => {
    const id = await addPhoto();
    await processPhoto(db, dataDir, id);
    const before = row(id).image_version;

    const settle = async (want) => {
      const stop = startWorker(db, dataDir, { intervalMs: 10 });
      for (let i = 0; i < 500 && !(row(id).status === 'ready' && row(id).watermark === want); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    writeFileSync(join(dataDir, 'watermark.svg'), ART);
    const { stamp } = await loadWatermark(db, dataDir);
    await settle(stamp);
    assert.equal(row(id).watermark, stamp);
    assert.ok(row(id).image_version > before, 'a new version so caches refresh');

    rmSync(join(dataDir, 'watermark.svg'));
    await settle('');
    assert.equal(row(id).watermark, '');
    assert.ok(await brightness(file(id), 700, 540, 220, 60) < 70);
  });

  test('camera settings are off by default and the switch changes the stamp', async () => {
    writeFileSync(join(dataDir, 'watermark.svg'), ART);
    const off = await loadWatermark(db, dataDir);
    assert.equal(getSetting(db, 'watermark_exif'), '0');
    assert.equal(off.showExif, false);

    setSetting(db, 'watermark_exif', '1');
    const on = await loadWatermark(db, dataDir);
    assert.equal(on.showExif, true);
    assert.notEqual(on.stamp, off.stamp);
  });

  test('the camera line is drawn only when switched on', async () => {
    writeFileSync(join(dataDir, 'watermark.svg'), ART);
    const raw = { width: 1200, height: 800, channels: 3 };
    const pixels = Buffer.alloc(1200 * 800 * 3, 60);
    const fields = { camera: 'Canon EOS R8', aperture: 'f/8', iso: 100 };
    const render = async (showExif) => {
      const out = await applyWatermark(pixels, raw, { ...(await loadWatermark(db, dataDir)), showExif }, fields);
      return out.data.reduce((sum, value) => sum + value, 0);
    };
    assert.notEqual(await render(true), await render(false));
    const off = await applyWatermark(pixels, raw, { ...(await loadWatermark(db, dataDir)), showExif: false }, { camera: 'Other' });
    assert.equal(off.data.reduce((sum, value) => sum + value, 0), await render(false));
  });

  test('the admin switch appears only with a watermark in place', () => {
    const filters = { albumId: '', unpublished: false };
    assert.ok(!photosView([], [], filters, 0, null).includes('watermark_exif'));
    assert.ok(photosView([], [], filters, 0, { showExif: false }).includes('data-setting="watermark_exif"'));
    assert.ok(photosView([], [], filters, 0, { showExif: true }).includes('data-setting="watermark_exif" checked'));
  });

  test('the shooting line drops what is missing and any crop factor note', () => {
    assert.equal(
      shootingLine({ camera: 'Canon EOS R8', focal: '65mm (35mm eq. 104mm)', aperture: 'f/13', shutter: '1/200', iso: 100 }),
      'Canon EOS R8 · 65mm · f/13 · 1/200 · ISO 100',
    );
    assert.equal(shootingLine({ camera: null, focal: null, aperture: 'f/2', shutter: null, iso: null }), 'f/2');
    assert.equal(shootingLine({}), '');
  });
});
