import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { newPhotoId, nowIso } from './db.js';
import { applyWatermark, loadWatermark } from './watermark.js';

sharp.concurrency(1);
sharp.cache(false);

export const WIDTHS = [480, 960, 1600, 2400, 3200];
export const FORMATS = ['avif', 'webp', 'jpg'];

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'];

export function sniffExt(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) return 'png';

  // WebP: RIFF....WEBP
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'webp';

  // HEIC/HEIF: ftyp at offset 4, brand at offset 8
  if (buffer.length >= 12 &&
      buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    const brand = buffer.slice(8, 12).toString('ascii');
    if (HEIC_BRANDS.includes(brand)) return 'heic';
  }

  // TIFF: II*\0 or MM\0*
  if (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A && buffer[3] === 0x00) return 'tiff';
  if (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A) return 'tiff';

  return null;
}

export function derivedWidths(realWidth) {
  const w = Math.round(realWidth);
  const fits = WIDTHS.filter(target => target <= w);
  if (w < WIDTHS[WIDTHS.length - 1] && !fits.includes(w)) fits.push(w);
  return fits;
}

// The largest file at or under this width, because a narrow photo has only its real width
export function thumbWidth(realWidth, wanted) {
  const sizes = derivedWidths(realWidth || wanted);
  return sizes.filter((w) => w <= wanted).at(-1) ?? sizes[0];
}

function formatShutter(seconds) {
  const val = Number(seconds);
  if (!val || val <= 0) return null;
  if (val >= 1) {
    return Number.isInteger(val) ? `${val}s` : `${parseFloat(val.toFixed(4))}s`;
  }
  const denom = Math.round(1 / val);
  return `1/${denom}`;
}

function formatAperture(fNumber) {
  const val = Number(fNumber);
  if (!val) return null;
  return `f/${parseFloat(val.toFixed(2))}`;
}

function formatFocal(focalLength, focalLength35) {
  const fl = Number(focalLength);
  if (!fl) return null;
  const fl35 = focalLength35 != null ? Number(focalLength35) : null;
  const flStr = parseFloat(fl.toFixed(2));
  if (fl35 && fl35 !== fl) {
    const fl35Str = parseFloat(fl35.toFixed(2));
    return `${flStr}mm (35mm eq. ${fl35Str}mm)`;
  }
  return `${flStr}mm`;
}

function buildCamera(make, model) {
  if (!make && !model) return null;
  if (!make) return String(model);
  if (!model) return String(make);
  const firstWord = String(make).split(/\s+/)[0].toLowerCase();
  if (String(model).toLowerCase().startsWith(firstWord)) {
    return String(model);
  }
  return `${make} ${model}`;
}

function formatTakenAt(dateTimeOriginal, offsetTimeOriginal) {
  if (!dateTimeOriginal) return null;
  const match = String(dateTimeOriginal).match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (!match) return null;
  const [, year, month, day, time] = match;
  let result = `${year}-${month}-${day}T${time}`;
  if (offsetTimeOriginal) {
    result += String(offsetTimeOriginal);
  }
  return result;
}

function defaultExecFile(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

const EXPOSURE_MODES = { 1: 'Manual', 2: 'Program', 3: 'Aperture priority', 4: 'Shutter priority' };

// "Adobe Photoshop Lightroom Classic 14.5.1 (Windows)" -> "Lightroom Classic"
function formatSoftware(value) {
  if (!value || /firmware/i.test(String(value))) return null;
  const name = String(value)
    .replace(/^Adobe Photoshop (?=Lightroom)/i, '')
    .replace(/\s*\(.*$/, '')
    .replace(/\s+v?\d[\d.]*.*$/, '')
    .trim();
  return /[a-z]/i.test(name) ? name : null;
}

// Native resolution per camera, for files that carry no editor crop data. Add yours here.
const SENSOR_SIZES = { 'Canon EOS R8': [6000, 4000], 'Canon EOS M50': [6000, 4000] };

// A smaller file can be a crop or a resized export; they look identical. Below this share
// of the sensor's long edge it is more likely a resize, so the field stays unknown.
const MIN_LONG_EDGE_SHARE = 0.7;

function croppedFromResolution(d, camera) {
  const sensor = SENSOR_SIZES[camera];
  if (!sensor || !d.ImageWidth || !d.ImageHeight) return null;
  const long = Math.max(d.ImageWidth, d.ImageHeight);
  const short = Math.min(d.ImageWidth, d.ImageHeight);
  if (long > sensor[0] || short > sensor[1] || long < sensor[0] * MIN_LONG_EDGE_SHARE) return null;
  const removed = (1 - (long * short) / (sensor[0] * sensor[1])) * 100;
  return removed < 0.05 ? 'None' : `\u2248${removed.toFixed(1)}%`;
}

// Exact when the editor recorded the crop, approximate (\u2248) from resolution otherwise
function formatCropped(d, camera) {
  if (d.HasCrop == null) return croppedFromResolution(d, camera);
  if (d.HasCrop === false || d.HasCrop === 'False' || d.HasCrop === 0) return 'None';
  const sides = [d.CropTop, d.CropLeft, d.CropBottom, d.CropRight].map(Number);
  if (sides.some(Number.isNaN)) return null;
  const [top, left, bottom, right] = sides;
  const removed = (1 - (right - left) * (bottom - top)) * 100;
  if (removed < 0 || removed > 100) return null;
  return removed < 0.05 ? 'None' : `${removed.toFixed(1)}%`;
}

export async function readExif(filePath, execFn) {
  const empty = { taken_at: null, camera: null, lens: null, focal: null, aperture: null, shutter: null, iso: null, mode: null, software: null, cropped: null };
  try {
    const args = [
      '-json', '-n',
      '-DateTimeOriginal', '-OffsetTimeOriginal',
      '-Make', '-Model',
      '-LensModel', '-LensID',
      '-FocalLength', '-FocalLengthIn35mmFormat',
      '-FNumber', '-ExposureTime', '-ISO',
      '-ExposureProgram', '-Software',
      '-ImageWidth', '-ImageHeight',
      '-HasCrop', '-CropTop', '-CropLeft', '-CropBottom', '-CropRight',
      '--', filePath,
    ];
    const exec = execFn || defaultExecFile;
    const stdout = await exec('exiftool', args, { timeout: 15000 });
    const arr = JSON.parse(stdout);
    if (!Array.isArray(arr) || arr.length === 0) return empty;
    const d = arr[0];
    if (!d) return empty;

    const taken_at = formatTakenAt(d.DateTimeOriginal, d.OffsetTimeOriginal);
    const camera = buildCamera(d.Make, d.Model);
    const lens = d.LensModel ? String(d.LensModel) : (d.LensID ? String(d.LensID) : null);
    const focal = formatFocal(d.FocalLength, d.FocalLengthIn35mmFormat);
    const aperture = formatAperture(d.FNumber);
    const shutter = formatShutter(d.ExposureTime);
    let iso = null;
    if (d.ISO != null) {
      iso = Number(d.ISO) || null;
    }

    return {
      taken_at, camera, lens, focal, aperture, shutter, iso,
      mode: EXPOSURE_MODES[d.ExposureProgram] ?? null,
      software: formatSoftware(d.Software),
      cropped: formatCropped(d, camera),
    };
  } catch {
    return empty;
  }
}

export async function ingest(db, dataDir, buffer, originalName, { albumId = null } = {}) {
  const ext = sniffExt(buffer);
  if (!ext) {
    const err = new Error('Unsupported image format');
    err.code = 'UNSUPPORTED';
    throw err;
  }

  const id = newPhotoId();
  const hash = createHash('sha256').update(buffer).digest('hex');

  const existing = db.prepare('SELECT id FROM photos WHERE original_sha256 = ?').get(hash);
  if (existing) {
    return { id: existing.id, duplicate: true };
  }

  const origDir = join(dataDir, 'originals');
  mkdirSync(origDir, { recursive: true });
  writeFileSync(join(origDir, `${id}.${ext}`), buffer);

  db.prepare(`
    INSERT INTO photos (id, album_id, original_name, original_ext, original_sha256, status, privacy_ok, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
  `).run(id, albumId, originalName, ext, hash, nowIso());

  return { id, duplicate: false };
}

async function loadInput(dataDir, row) {
  const input = await readFile(join(dataDir, 'originals', `${row.id}.${row.original_ext}`));
  if (row.original_ext !== 'heic') return input;

  // HEIC → JPEG conversion. It rotates the pixels itself and drops EXIF, so this needs no second pass.
  return Buffer.from(await heicConvert({ buffer: input, format: 'JPEG', quality: 1 }));
}

function blurList(row) {
  return JSON.parse(row.privacy_boxes || '[]').filter((box) => box.blur);
}

// The private copy used for the AI scan and the admin review. Never blurred, never public.
export function previewPath(dataDir, id) {
  return join(dataDir, 'previews', `${id}.jpg`);
}

export async function ensurePreview(dataDir, row) {
  const path = previewPath(dataDir, row.id);
  if (existsSync(path)) return;
  mkdirSync(join(dataDir, 'previews'), { recursive: true });
  const input = await loadInput(dataDir, row);
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  await sharp(input, { limitInputPixels: 120_000_000 }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(tmp);
  renameSync(tmp, path);
}

// Made fresh from the original for the enlarged review, so it never sits on disk
export async function largePreview(dataDir, row) {
  const input = await loadInput(dataDir, row);
  return sharp(input, { limitInputPixels: 120_000_000 }).rotate().resize(3200, 3200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}

// Width of the soft edge, as a share of the box's shorter side
const FADE = 0.35;

// Shrinks each area to a few pixels first, so no blur setting can leave a face readable
export async function blurAreas(data, raw, boxes) {
  const patches = await Promise.all(boxes.map(async (box) => {
    const left = Math.floor(box.x1 * raw.width);
    const top = Math.floor(box.y1 * raw.height);
    const width = Math.min(raw.width - left, Math.max(1, Math.ceil((box.x2 - box.x1) * raw.width)));
    const height = Math.min(raw.height - top, Math.max(1, Math.ceil((box.y2 - box.y1) * raw.height)));

    // The fade runs outside the box, so everything inside it stays fully covered
    const fade = Math.max(2, Math.round(Math.min(width, height) * FADE));
    const outerLeft = Math.max(0, left - fade);
    const outerTop = Math.max(0, top - fade);
    const outerWidth = Math.min(raw.width, left + width + fade) - outerLeft;
    const outerHeight = Math.min(raw.height, top + height + fade) - outerTop;
    const tiny = await sharp(data, { raw }).extract({ left: outerLeft, top: outerTop, width: outerWidth, height: outerHeight }).resize(6, 6, { fit: 'fill' }).png().toBuffer();
    const { data: patch, info } = await sharp(tiny).resize(outerWidth, outerHeight, { fit: 'fill', kernel: 'cubic' })
      .blur(Math.max(1, Math.min(width, height) / 6)).removeAlpha().ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    for (let y = 0; y < outerHeight; y += 1) {
      const dy = Math.max(top - (y + outerTop), y + outerTop - (top + height - 1), 0);
      for (let x = 0; x < outerWidth; x += 1) {
        const dx = Math.max(left - (x + outerLeft), x + outerLeft - (left + width - 1), 0);
        const t = Math.min(1, Math.hypot(dx, dy) / fade);
        patch[(y * outerWidth + x) * 4 + 3] = Math.round(255 * (1 - t * t * (3 - 2 * t)));
      }
    }
    const input = await sharp(patch, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    return { input, left: outerLeft, top: outerTop };
  }));
  // The soft patches carry alpha, which must not add a channel to an opaque photo
  const blurred = sharp(data, { raw }).composite(patches);
  return (raw.channels === 3 ? blurred.removeAlpha() : blurred).raw().toBuffer({ resolveWithObject: true });
}

// Decodes the file once at the largest size, so each resize skips the full-size decode
async function decodedBase(input, width, boxes = [], watermark = null, fields = null) {
  let { data, info } = await sharp(input, { limitInputPixels: 120_000_000 })
    .rotate()
    .toColourspace('srgb')
    .resize({ width, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rawOf = (i) => ({ width: i.width, height: i.height, channels: i.channels });
  if (boxes.length) ({ data, info } = await blurAreas(data, rawOf(info), boxes));
  // After the blur, so the watermark is never part of what gets blurred
  if (watermark) ({ data, info } = await applyWatermark(data, rawOf(info), watermark, fields));
  return sharp(data, { raw: rawOf(info) });
}

async function writeDerived(pipeline, dir, name) {
  const tmp = join(dir, `${name}.tmp-${randomBytes(4).toString('hex')}`);
  await pipeline.toFile(tmp);
  renameSync(tmp, join(dir, name));
}

// AVIF is about 80% of the encoding time, so it runs after the photo is already live
export async function encodeAvif(db, dataDir, id) {
  const row = db.prepare("SELECT * FROM photos WHERE id = ? AND status = 'ready'").get(id);
  if (!row) return;

  const derivedDir = join(dataDir, 'derived', id);
  const widths = derivedWidths(row.width);
  const watermark = await loadWatermark(db, dataDir);
  const base = await decodedBase(await loadInput(dataDir, row), widths.at(-1), blurList(row), watermark, row);

  for (const w of widths) {
    await writeDerived(base.clone().resize(w).avif({ quality: 64, effort: 4 }), derivedDir, `${w}.avif`);
  }

  db.prepare("UPDATE photos SET avif_ready = 1 WHERE id = ? AND status = 'ready'").run(id);
}

export async function processPhoto(db, dataDir, id) {
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!row) return;

  db.prepare("UPDATE photos SET status = 'processing' WHERE id = ?").run(id);

  const derivedDir = join(dataDir, 'derived', id);

  try {
    const origPath = join(dataDir, 'originals', `${id}.${row.original_ext}`);

    // Read EXIF from the original file path via exiftool binary (no GPS)
    const exifFields = await readExif(origPath);

    const inputBuffer = await loadInput(dataDir, row);

    const img = sharp(inputBuffer, { limitInputPixels: 120_000_000 });
    const meta = await img.metadata();

    // Determine real dimensions after auto-rotate
    const orient = meta.orientation || 1;
    const swapped = orient >= 5 && orient <= 8;
    const realWidth = swapped ? meta.height : meta.width;
    const realHeight = swapped ? meta.width : meta.height;

    mkdirSync(derivedDir, { recursive: true });

    // AVIFs come later, so an older one must not outlive a new blur
    for (const file of readdirSync(derivedDir)) {
      if (file.endsWith('.avif')) rmSync(join(derivedDir, file), { force: true });
    }

    const widths = derivedWidths(realWidth);
    const watermark = await loadWatermark(db, dataDir);
    const base = await decodedBase(inputBuffer, widths.at(-1), blurList(row), watermark, exifFields);

    for (const w of widths) {
      await writeDerived(base.clone().resize(w).webp({ quality: 84, smartSubsample: true, preset: 'photo' }), derivedDir, `${w}.webp`);
      await writeDerived(base.clone().resize(w).jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:4:4' }), derivedDir, `${w}.jpg`);
    }

    // Placeholder: 24px wide webp data URI
    const placeholderBuf = await base.clone().resize(24).webp({ quality: 60 }).toBuffer();
    const placeholder = `data:image/webp;base64,${placeholderBuf.toString('base64')}`;

    db.prepare(`
      UPDATE photos
      SET status = 'ready', width = ?, height = ?, placeholder = ?,
          taken_at = ?, camera = ?, lens = ?, focal = ?, aperture = ?, shutter = ?, iso = ?,
          mode = ?, software = ?, cropped = ?,
          error = NULL, avif_ready = 0, watermark = ?
      WHERE id = ? AND image_version = ?
    `).run(
      realWidth, realHeight, placeholder,
      exifFields.taken_at, exifFields.camera, exifFields.lens,
      exifFields.focal, exifFields.aperture, exifFields.shutter, exifFields.iso,
      exifFields.mode, exifFields.software, exifFields.cropped,
      watermark?.stamp ?? '',
      id, row.image_version,
    );
  } catch (err) {
    rmSync(derivedDir, { recursive: true, force: true });
    db.prepare("UPDATE photos SET status = 'failed', error = ? WHERE id = ?").run(
      err.message || String(err), id
    );
  }
}
