import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { openDb } from '../lib/db.js';
import { ingest, processPhoto, readExif, sniffExt, derivedWidths } from '../lib/images.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

let tmpDir;
let db;
let dataDir;

before(async () => {
  tmpDir = join(tmpdir(), `photos-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dataDir = join(tmpDir, 'data');
  mkdirSync(join(dataDir, 'originals'), { recursive: true });
  db = openDb(join(dataDir, 'photos.sqlite'));
});

after(async () => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- readExif unit tests with fake execFn ---

function fakeExecFn(jsonData) {
  return async (cmd, args, opts) => {
    return JSON.stringify([jsonData]);
  };
}

test('readExif Canon: Model starts with Make first word → Model alone', async () => {
  const data = {
    SourceFile: '/tmp/test.jpg',
    Make: 'Canon',
    Model: 'Canon EOS R5',
    DateTimeOriginal: '2026:05:01 12:00:00',
    OffsetTimeOriginal: '+03:00',
    LensModel: 'RF 24-70mm f/2.8L',
    LensID: 'RF 24-70',
    FocalLength: 35,
    FocalLengthIn35mmFormat: 35,
    FNumber: 2.8,
    ExposureTime: 0.004,
    ISO: 400,
  };

  const result = await readExif('/tmp/test.jpg', fakeExecFn(data));

  assert.equal(result.camera, 'Canon EOS R5');
  assert.equal(result.lens, 'RF 24-70mm f/2.8L');
  assert.equal(result.focal, '35mm');
  assert.equal(result.aperture, 'f/2.8');
  assert.equal(result.shutter, '1/250');
  assert.equal(result.iso, 400);
  assert.equal(result.taken_at, '2026-05-01T12:00:00+03:00');
});

test('readExif Nikon: Model starts with Make first word → Model alone', async () => {
  const data = {
    SourceFile: '/tmp/nikon.jpg',
    Make: 'NIKON CORPORATION',
    Model: 'NIKON Z 6',
    DateTimeOriginal: '2025:12:25 08:30:00',
    OffsetTimeOriginal: '-05:00',
    LensModel: 'NIKKOR Z 50mm f/1.8 S',
    FocalLength: 50,
    FocalLengthIn35mmFormat: 50,
    FNumber: 1.8,
    ExposureTime: 2,
    ISO: 1600,
  };

  const result = await readExif('/tmp/nikon.jpg', fakeExecFn(data));

  assert.equal(result.camera, 'NIKON Z 6');
  assert.equal(result.lens, 'NIKKOR Z 50mm f/1.8 S');
  assert.equal(result.focal, '50mm');
  assert.equal(result.aperture, 'f/1.8');
  assert.equal(result.shutter, '2s');
  assert.equal(result.iso, 1600);
  assert.equal(result.taken_at, '2025-12-25T08:30:00-05:00');
});

test('readExif focal with 35mm equivalent differs', async () => {
  const data = {
    SourceFile: '/tmp/crop.jpg',
    Make: 'Sony',
    Model: 'ILCE-7CR',
    FocalLength: 26,
    FocalLengthIn35mmFormat: 28,
    FNumber: 4,
    ExposureTime: 0.002,
    ISO: 200,
  };

  const result = await readExif('/tmp/crop.jpg', fakeExecFn(data));

  assert.equal(result.focal, '26mm (35mm eq. 28mm)');
  assert.equal(result.camera, 'Sony ILCE-7CR');
  assert.equal(result.shutter, '1/500');
  assert.equal(result.aperture, 'f/4');
});

test('readExif missing tags returns nulls for absent fields', async () => {
  const data = {
    SourceFile: '/tmp/phone.jpg',
    Make: 'Apple',
    Model: 'iPhone 15',
  };

  const result = await readExif('/tmp/phone.jpg', fakeExecFn(data));

  assert.equal(result.camera, 'Apple iPhone 15');
  assert.equal(result.taken_at, null);
  assert.equal(result.lens, null);
  assert.equal(result.focal, null);
  assert.equal(result.aperture, null);
  assert.equal(result.shutter, null);
  assert.equal(result.iso, null);
});

test('readExif lens falls back to LensID when LensModel absent', async () => {
  const data = {
    SourceFile: '/tmp/old.jpg',
    Make: 'Nikon',
    Model: 'D300',
    LensID: '18-55mm f/3.5-5.6G',
  };

  const result = await readExif('/tmp/old.jpg', fakeExecFn(data));

  assert.equal(result.lens, '18-55mm f/3.5-5.6G');
});

test('readExif taken_at without OffsetTimeOriginal has no timezone suffix', async () => {
  const data = {
    SourceFile: '/tmp/nooffset.jpg',
    DateTimeOriginal: '2024:01:15 18:45:30',
  };

  const result = await readExif('/tmp/nooffset.jpg', fakeExecFn(data));

  assert.equal(result.taken_at, '2024-01-15T18:45:30');
});

test('readExif exec error returns all nulls, never throws', async () => {
  const failingExec = async () => { throw new Error('exiftool not found'); };

  const result = await readExif('/tmp/broken.jpg', failingExec);

  assert.equal(result.taken_at, null);
  assert.equal(result.camera, null);
  assert.equal(result.lens, null);
  assert.equal(result.focal, null);
  assert.equal(result.aperture, null);
  assert.equal(result.shutter, null);
  assert.equal(result.iso, null);
});

test('readExif invalid JSON from exiftool returns all nulls', async () => {
  const badJsonExec = async () => 'not json at all';

  const result = await readExif('/tmp/bad.jpg', badJsonExec);

  assert.equal(result.camera, null);
  assert.equal(result.taken_at, null);
});

test('readExif empty array result returns all nulls', async () => {
  const emptyExec = async () => '[]';

  const result = await readExif('/tmp/empty.jpg', emptyExec);

  assert.equal(result.camera, null);
});

test('readExif passes correct args to execFn', async () => {
  let capturedCmd, capturedArgs, capturedOpts;
  const spyExec = async (cmd, args, opts) => {
    capturedCmd = cmd;
    capturedArgs = args;
    capturedOpts = opts;
    return '[{"SourceFile":"/x/y.jpg"}]';
  };

  await readExif('/x/y.jpg', spyExec);

  assert.equal(capturedCmd, 'exiftool');
  assert.equal(capturedArgs[capturedArgs.length - 1], '/x/y.jpg');
  assert.equal(capturedArgs[capturedArgs.length - 2], '--');
  assert.ok(capturedArgs.includes('-json'));
  assert.ok(capturedArgs.includes('-n'));
  assert.ok(capturedArgs.includes('-DateTimeOriginal'));
  assert.ok(capturedArgs.includes('-OffsetTimeOriginal'));
  assert.ok(capturedArgs.includes('-Make'));
  assert.ok(capturedArgs.includes('-Model'));
  assert.ok(capturedArgs.includes('-LensModel'));
  assert.ok(capturedArgs.includes('-LensID'));
  assert.ok(capturedArgs.includes('-FocalLength'));
  assert.ok(capturedArgs.includes('-FocalLengthIn35mmFormat'));
  assert.ok(capturedArgs.includes('-FNumber'));
  assert.ok(capturedArgs.includes('-ExposureTime'));
  assert.ok(capturedArgs.includes('-ISO'));
  // GPS tags must never be requested
  assert.ok(!capturedArgs.some(a => a.toLowerCase().includes('gps')));
  assert.ok(!capturedArgs.some(a => a.toLowerCase().includes('latitude')));
  assert.ok(!capturedArgs.some(a => a.toLowerCase().includes('longitude')));
  assert.equal(capturedOpts.timeout, 15000);
});

// --- existing unit tests ---

test('sniffExt detects jpeg, png, webp, heic, tiff and rejects garbage', () => {
  assert.equal(sniffExt(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
  assert.equal(sniffExt(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])), 'png');
  const webp = Buffer.alloc(12);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  assert.equal(sniffExt(webp), 'webp');
  const heic = Buffer.alloc(12);
  heic.write('ftyp', 4, 'ascii');
  heic.write('heic', 8, 'ascii');
  assert.equal(sniffExt(heic), 'heic');
  const tiff = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffExt(tiff), 'tiff');
  assert.equal(sniffExt(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B])), null);
  assert.equal(sniffExt(null), null);
  assert.equal(sniffExt(Buffer.alloc(4)), null);
});

test('derivedWidths filters and handles small images', () => {
  assert.deepEqual(derivedWidths(300), [300]);
  assert.deepEqual(derivedWidths(480), [480]);
  assert.deepEqual(derivedWidths(700), [480, 700]);
  assert.deepEqual(derivedWidths(960), [480, 960]);
  assert.deepEqual(derivedWidths(2400), [480, 960, 1600, 2400]);
  assert.deepEqual(derivedWidths(5000), [480, 960, 1600, 2400, 3200]);
  assert.deepEqual(derivedWidths(3000), [480, 960, 1600, 2400, 3000]);
});

test('landscape 3000x2000 JPEG with EXIF orientation 6 → portrait 2000x3000', async () => {
  const buf = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: '#ff0000' },
  }).jpeg({ quality: 85 }).withMetadata({ orientation: 6 }).toBuffer();

  const { id } = await ingest(db, dataDir, buf, 'landscape.jpg');
  await processPhoto(db, dataDir, id);

  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  assert.equal(row.status, 'ready');
  assert.equal(row.width, 2000);
  assert.equal(row.height, 3000);
});

test('300px wide image makes only one width and is not upscaled', async () => {
  const buf = await sharp({
    create: { width: 300, height: 200, channels: 3, background: '#00ff00' },
  }).jpeg().toBuffer();

  const { id } = await ingest(db, dataDir, buf, 'small.jpg');
  await processPhoto(db, dataDir, id);

  const derivedDir = join(dataDir, 'derived', id);
  const files = readdirSync(derivedDir).sort();
  assert.equal(files.length, 3);
  assert.deepEqual(files, ['300.avif', '300.jpg', '300.webp']);

  const meta = await sharp(join(derivedDir, '300.jpg')).metadata();
  assert.equal(meta.width, 300);
});

test('all three formats exist for each width', async () => {
  const buf = await sharp({
    create: { width: 2000, height: 1500, channels: 3, background: '#0000ff' },
  }).jpeg().toBuffer();

  const { id } = await ingest(db, dataDir, buf, 'large.jpg');
  await processPhoto(db, dataDir, id);

  const derivedDir = join(dataDir, 'derived', id);
  const widths = derivedWidths(2000);
  const formats = ['avif', 'webp', 'jpg'];

  for (const w of widths) {
    for (const fmt of formats) {
      assert.ok(existsSync(join(derivedDir, `${w}.${fmt}`)), `${w}.${fmt} should exist`);
    }
  }
});

test('derived JPEG has no EXIF', async () => {
  const buf = await sharp({
    create: { width: 600, height: 400, channels: 3, background: '#ff00ff' },
  }).jpeg().withMetadata({ orientation: 1, exif: { IFD0: { Make: 'TestCam' } } }).toBuffer();

  const { id } = await ingest(db, dataDir, buf, 'exif.jpg');
  await processPhoto(db, dataDir, id);

  const derivedDir = join(dataDir, 'derived', id);
  const derivedBuf = await sharp(join(derivedDir, derivedWidths(600)[0] + '.jpg')).toBuffer();
  const meta = await sharp(derivedBuf).metadata();
  assert.equal(meta.exif, undefined);
});

test('re-ingesting the same bytes returns duplicate', async () => {
  const buf = await sharp({
    create: { width: 500, height: 400, channels: 3, background: '#00ffff' },
  }).jpeg().toBuffer();

  const r1 = await ingest(db, dataDir, buf, 'dup.jpg');
  assert.equal(r1.duplicate, false);

  const r2 = await ingest(db, dataDir, buf, 'dup2.jpg');
  assert.equal(r2.duplicate, true);
  assert.equal(r2.id, r1.id);
});

test('garbage bytes give UNSUPPORTED error', async () => {
  const buf = Buffer.from('this is not an image at all, just text padding padding');

  await assert.rejects(
    () => ingest(db, dataDir, buf, 'garbage.bin'),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED');
      return true;
    },
  );
});

test('corrupt JPEG with valid magic bytes ends as failed with no leftover derived dir', async () => {
  const corrupt = Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]),
    Buffer.alloc(200, 0xDE),
  ]);

  const { id } = await ingest(db, dataDir, corrupt, 'corrupt.jpg');
  await processPhoto(db, dataDir, id);

  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  assert.equal(row.status, 'failed');
  assert.ok(row.error, 'error message should be set');

  const derivedDir = join(dataDir, 'derived', id);
  assert.equal(existsSync(derivedDir), false, 'derived dir should not exist after failure');
});

test('JPEG fixture with EXIF/GPS: correct dimensions, camera, shutter, aperture, iso; no GPS; no EXIF in derived', async () => {
  const buf = readFileSync(join(fixturesDir, 'exif-gps.jpg'));

  const { id } = await ingest(db, dataDir, buf, 'exif-gps.jpg');
  await processPhoto(db, dataDir, id);

  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  assert.equal(row.status, 'ready');
  assert.equal(row.width, 800);
  assert.equal(row.height, 1200);
  assert.equal(row.camera, 'TestCam X1');
  assert.equal(row.shutter, '1/250');
  assert.equal(row.aperture, 'f/2.8');
  assert.equal(row.iso, 400);
  assert.equal(row.focal, '35mm');
  assert.ok(row.taken_at);
  assert.match(row.taken_at, /^\d{4}-\d{2}-\d{2}T/);

  // No GPS data in any column
  for (const key of Object.keys(row)) {
    const lower = key.toLowerCase();
    if (lower.includes('gps') || lower.includes('latitude') || lower.includes('longitude')) {
      assert.equal(row[key], null, `GPS column ${key} should be null`);
    }
  }

  // No derived file has EXIF
  const derivedDir = join(dataDir, 'derived', id);
  const files = readdirSync(derivedDir);
  for (const file of files) {
    const fileBuf = readFileSync(join(derivedDir, file));
    const meta = await sharp(fileBuf).metadata();
    assert.ok(!meta.exif || meta.exif.length === 0, `${file} should have no EXIF`);
  }
});

test('HEIC fixture with EXIF/GPS: correct dimensions 800x1200, camera, shutter, aperture, iso; no GPS; no EXIF in derived', async () => {
  const buf = readFileSync(join(fixturesDir, 'exif-gps.heic'));

  const { id } = await ingest(db, dataDir, buf, 'exif-gps.heic');
  await processPhoto(db, dataDir, id);

  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  assert.equal(row.status, 'ready');
  assert.equal(row.width, 800);
  assert.equal(row.height, 1200);
  assert.equal(row.camera, 'TestCam X1');
  assert.equal(row.shutter, '1/250');
  assert.equal(row.aperture, 'f/2.8');
  assert.equal(row.iso, 400);
  assert.equal(row.focal, '35mm');
  assert.ok(row.taken_at);
  assert.match(row.taken_at, /^\d{4}-\d{2}-\d{2}T/);

  // No GPS data in any column
  for (const key of Object.keys(row)) {
    const lower = key.toLowerCase();
    if (lower.includes('gps') || lower.includes('latitude') || lower.includes('longitude')) {
      assert.equal(row[key], null, `GPS column ${key} should be null`);
    }
  }

  // No derived file has EXIF
  const derivedDir = join(dataDir, 'derived', id);
  const files = readdirSync(derivedDir);
  for (const file of files) {
    const fileBuf = readFileSync(join(derivedDir, file));
    const meta = await sharp(fileBuf).metadata();
    assert.ok(!meta.exif || meta.exif.length === 0, `${file} should have no EXIF`);
  }
});
