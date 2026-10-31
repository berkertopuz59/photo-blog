import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { getSetting, isOn } from './settings.js';
// Outlines of Inter 500 for the shooting line, because the container has no fonts
import glyphs from './watermark-glyphs.json' with { type: 'json' };

// Raise this when the layout changes, so finished photos are rebuilt
const LAYOUT = 1;

// Below this a signature is an unreadable smudge, so the photo goes unsigned
const MIN_SIGN_WIDTH = 16;

const INK = { light: { r: 255, g: 255, b: 255 }, dark: { r: 20, g: 20, b: 20 } };

// The art stays out of the code on purpose: no file, no watermark
export async function loadWatermark(db, dataDir) {
  if (!isOn(db, 'watermark_on')) return null;
  const svg = await readFile(join(dataDir, 'watermark.svg')).catch(() => null);
  if (!svg) return null;
  // A broken file must not fail every photo
  const valid = await sharp(svg).metadata().then((meta) => meta.format === 'svg', () => false);
  if (!valid) return null;
  const showExif = isOn(db, 'watermark_exif');
  const opacity = Number(getSetting(db, 'watermark_opacity')) / 100;
  return { svg, showExif, opacity, stamp: createHash('sha256').update(`${LAYOUT}:${showExif}:${opacity}:`).update(svg).digest('hex').slice(0, 16) };
}

export function shootingLine({ camera, focal, aperture, shutter, iso }) {
  return [camera, focal?.replace(/\s*\(.*$/, ''), aperture, shutter, iso && `ISO ${iso}`].filter(Boolean).join(' · ');
}

// Characters without an outline are dropped, so EXIF text never reaches the SVG as text
function lineSvg(text, height) {
  const scale = height / 1000;
  const tracking = 60;
  let x = 0;
  const paths = [];
  for (const char of text) {
    const glyph = glyphs[char];
    if (!glyph) continue;
    if (glyph.d) paths.push(`<path transform="translate(${x} 780)" d="${glyph.d}"/>`);
    x += glyph.a + tracking;
  }
  const width = Math.max(1, Math.ceil(x * scale));
  return { width, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.ceil(height)}"><g transform="scale(${scale})" fill="#fff">${paths.join('')}</g></svg>` };
}

async function alphaOf(input, options, width) {
  const { data, info } = await sharp(input, options).resize({ width }).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function stamp(canvas, mask, left, top) {
  for (let row = 0; row < mask.height; row++) {
    mask.data.copy(canvas.data, (top + row) * canvas.width + left, row * mask.width, (row + 1) * mask.width);
  }
}

// Bottom corners only. The calmer one wins, and bright areas get dark ink.
async function readCorner(data, raw, box) {
  const area = (left) => sharp(data, { raw }).extract({ left, top: box.top, width: box.width, height: box.height }).raw().toBuffer();
  const measure = async (left) => {
    const { channels } = await sharp(await area(left), { raw: { ...raw, width: box.width, height: box.height } }).stats();
    const rgb = channels.slice(0, 3);
    return { left, busy: rgb.reduce((sum, c) => sum + c.stdev, 0) / rgb.length, brightness: rgb.reduce((sum, c) => sum + c.mean, 0) / rgb.length };
  };
  const right = await measure(box.right);
  const left = await measure(box.left);
  return left.busy < right.busy * 0.8 ? left : right;
}

async function tinted(mask, colour, opacity, blur = 0) {
  const raw = { width: mask.width, height: mask.height, channels: 1 };
  let alpha = sharp(mask.data, { raw });
  if (blur) alpha = alpha.blur(blur);
  const alphaData = await alpha.linear(opacity, 0).extractChannel(0).raw().toBuffer();
  return sharp({ create: { ...raw, channels: 3, background: colour } }).joinChannel(alphaData, { raw }).png().toBuffer();
}

// A close-up for the admin, signed by the same code as the public images
export async function watermarkPreview(path, watermark, fields) {
  const { data, info } = await sharp(path).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };
  const signed = await applyWatermark(data, raw, watermark, fields);
  const { area } = signed;
  if (!area) return sharp(data, { raw }).jpeg({ quality: 88 }).toBuffer();
  const left = Math.max(0, area.left - Math.round(area.width * 0.15));
  const top = Math.max(0, area.top - Math.round(area.height * 0.5));
  const crop = {
    left,
    top,
    width: Math.min(raw.width - left, Math.round(area.width * 1.3)),
    height: Math.min(raw.height - top, Math.round(area.height * 2)),
  };
  return sharp(signed.data, { raw: { width: signed.info.width, height: signed.info.height, channels: signed.info.channels } }).extract(crop).jpeg({ quality: 88 }).toBuffer();
}

export async function applyWatermark(data, raw, watermark, fields) {
  const long = Math.max(raw.width, raw.height);
  const { width: artWidth, height: artHeight } = await sharp(watermark.svg).metadata();
  // The height limit is for panoramas, where the width alone would make it taller than the photo
  const signWidth = Math.min(Math.round(long * 0.24), Math.round(raw.width * 0.62), Math.round((raw.height * 0.6) / (artHeight / artWidth + 0.3)));
  if (signWidth < MIN_SIGN_WIDTH) return { data, info: raw, area: null };
  const density = Math.max(36, Math.min(1200, (72 * signWidth * 2) / artWidth));
  const sign = await alphaOf(watermark.svg, { density }, signWidth);

  const text = watermark.showExif ? shootingLine(fields) : '';
  let lineHeight = Math.round(signWidth * 0.052);
  let line = lineSvg(text, lineHeight);
  if (line.width > signWidth) {
    lineHeight = Math.floor((lineHeight * signWidth) / line.width);
    line = lineSvg(text, lineHeight);
  }
  const shooting = text && lineHeight >= 4 ? await alphaOf(Buffer.from(line.svg), {}, line.width) : null;

  const pad = Math.round(signWidth * 0.08);
  const gap = shooting ? Math.round(signWidth * 0.02) : 0;
  const canvas = { width: signWidth + pad * 2, height: sign.height + gap + (shooting?.height ?? 0) + pad * 2 };
  canvas.data = Buffer.alloc(canvas.width * canvas.height);
  stamp(canvas, sign, pad, pad);
  if (shooting) stamp(canvas, shooting, Math.round((canvas.width - shooting.width) / 2), pad + sign.height + gap);

  const margin = Math.round(long * 0.022);
  const top = Math.max(0, raw.height - canvas.height - margin + pad);
  const corner = await readCorner(data, raw, {
    top,
    width: Math.min(canvas.width, raw.width),
    height: Math.min(canvas.height, raw.height - top),
    left: Math.max(0, margin - pad),
    right: Math.max(0, raw.width - canvas.width - margin + pad),
  });

  const bright = corner.brightness > 165;
  // The glow fades with the ink, or a faint signature would leave a dark smudge
  const halo = await tinted(canvas, bright ? INK.light : INK.dark, watermark.opacity * 1.5, Math.max(1, signWidth * 0.012));
  const ink = await tinted(canvas, bright ? INK.dark : INK.light, watermark.opacity);
  const signed = await sharp(data, { raw }).composite([
    { input: halo, left: corner.left, top },
    { input: ink, left: corner.left, top },
  ]).raw().toBuffer({ resolveWithObject: true });
  return { ...signed, area: { left: corner.left, top, width: canvas.width, height: canvas.height } };
}
