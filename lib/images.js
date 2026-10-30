import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { newPhotoId, nowIso } from './db.js';

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
    INSERT INTO photos (id, album_id, original_name, original_ext, original_sha256, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, albumId, originalName, ext, hash, nowIso());

  return { id, duplicate: false };
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

    const originalBuffer = await readFile(origPath);
    let inputBuffer = originalBuffer;

    // HEIC → JPEG conversion (does not preserve EXIF)
    if (row.original_ext === 'heic') {
      const converted = Buffer.from(await heicConvert({
        buffer: inputBuffer,
        format: 'JPEG',
        quality: 1,
      }));
      // Normalize orientation: heic-convert physically rotates pixels
      inputBuffer = await sharp(converted).rotate().toBuffer();
    }

    const img = sharp(inputBuffer, { limitInputPixels: 120_000_000 });
    const meta = await img.metadata();

    // Determine real dimensions after auto-rotate
    const orient = meta.orientation || 1;
    const swapped = orient >= 5 && orient <= 8;
    const realWidth = swapped ? meta.height : meta.width;
    const realHeight = swapped ? meta.width : meta.height;

    // Prepare base pipeline: auto-rotate, sRGB
    const basePipeline = sharp(inputBuffer, { limitInputPixels: 120_000_000 })
      .rotate()
      .toColourspace('srgb');

    mkdirSync(derivedDir, { recursive: true });

    const widths = derivedWidths(realWidth);

    for (const w of widths) {
      for (const fmt of FORMATS) {
        let tmpName, finalName;
        const tmpSuffix = `.tmp-${randomBytes(4).toString('hex')}`;

        if (fmt === 'avif') {
          tmpName = join(derivedDir, `${w}.avif${tmpSuffix}`);
          finalName = join(derivedDir, `${w}.avif`);
          await basePipeline.clone().resize(w).avif({ quality: 64, effort: 4 }).toFile(tmpName);
        } else if (fmt === 'webp') {
          tmpName = join(derivedDir, `${w}.webp${tmpSuffix}`);
          finalName = join(derivedDir, `${w}.webp`);
          await basePipeline.clone().resize(w).webp({ quality: 84, smartSubsample: true, preset: 'photo' }).toFile(tmpName);
        } else {
          tmpName = join(derivedDir, `${w}.jpg${tmpSuffix}`);
          finalName = join(derivedDir, `${w}.jpg`);
          await basePipeline.clone().resize(w).jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:4:4' }).toFile(tmpName);
        }

        renameSync(tmpName, finalName);
      }
    }

    // Placeholder: 24px wide webp data URI
    const placeholderBuf = await basePipeline.clone().resize(24).webp({ quality: 60 }).toBuffer();
    const placeholder = `data:image/webp;base64,${placeholderBuf.toString('base64')}`;

    db.prepare(`
      UPDATE photos
      SET status = 'ready', width = ?, height = ?, placeholder = ?,
          taken_at = ?, camera = ?, lens = ?, focal = ?, aperture = ?, shutter = ?, iso = ?,
          mode = ?, software = ?, cropped = ?,
          error = NULL
      WHERE id = ?
    `).run(
      realWidth, realHeight, placeholder,
      exifFields.taken_at, exifFields.camera, exifFields.lens,
      exifFields.focal, exifFields.aperture, exifFields.shutter, exifFields.iso,
      exifFields.mode, exifFields.software, exifFields.cropped,
      id,
    );
  } catch (err) {
    rmSync(derivedDir, { recursive: true, force: true });
    db.prepare("UPDATE photos SET status = 'failed', error = ? WHERE id = ?").run(
      err.message || String(err), id
    );
  }
}
