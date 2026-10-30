import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { logEvent } from './stats.js';
import { aiEnabled, countAiCall } from './settings.js';

const MAX_ATTEMPTS = 3;
const MAX_TITLE = 60;
const MAX_DESCRIPTION = 300;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const FAILURE_PAUSE_MS = 60 * 1000;

export const MOODS = ['calm', 'quiet', 'joyful', 'playful', 'melancholic', 'nostalgic', 'lonely', 'warm', 'serene', 'dramatic', 'mysterious', 'tender', 'energetic', 'hopeful', 'somber'];

export const SCENES = ['golden hour', 'blue hour', 'overcast', 'soft light', 'harsh light', 'backlit', 'low light', 'night', 'fog', 'rain', 'snow',
  'spring', 'summer', 'autumn', 'winter',
  'close-up', 'wide view', 'minimal', 'symmetry', 'leading lines', 'silhouette', 'reflection', 'street', 'landscape', 'wildlife', 'portrait', 'architecture'];

const LABEL_RE = /^[a-z0-9][a-z0-9 -]{0,29}$/;

export function captionPrompt({ albumTitle, usedTitles = [] }) {
  return [
    'You title photographs for a personal photo blog. Reply with JSON only, with these keys:',
    '"title": 2 to 4 words, the way a photographer names a print. Evocative and understated, not a literal list of what is visible. Examples of the style: "Slow Water", "Last Light", "Waiting Room". Never use a person\'s name.',
    '"description": one plain sentence saying what is visible, at most 14 words.',
    '"tags": 3 to 6 lowercase subject words.',
    `"moods": 1 to 3 from this list, the ones the photo truly conveys: ${MOODS.join(', ')}.`,
    `"details": 2 to 5 from this list that clearly apply, covering the light, the season if visible, and the kind of picture: ${SCENES.join(', ')}.`,
    albumTitle ? `The album is "${albumTitle}". That is context, not a fact about this photo.` : '',
    usedTitles.length ? `Do not reuse or echo these titles: ${usedTitles.join('; ')}.` : '',
    'Do not invent places, names or dates.',
  ].filter(Boolean).join(' ');
}

export function cleanLabels(values, max = 6) {
  const list = Array.isArray(values) ? values : [];
  const clean = list.map((v) => String(v).trim().toLowerCase()).filter((v) => LABEL_RE.test(v));
  return [...new Set(clean)].slice(0, max);
}

function cleanLine(text, maxLength) {
  const line = String(text || '').trim().split('\n')[0];
  const clean = line.trim().replace(/^["\'“”‘’]+|["\'“”‘’.]+$/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > 0 && clean.length <= maxLength ? clean : null;
}

export function parseCaptionReply(text) {
  const raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;

  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }

  const title = cleanLine(data.title, MAX_TITLE);
  if (!title || title.split(' ').length > 6) return null;
  return {
    title,
    description: cleanLine(data.description, MAX_DESCRIPTION) || '',
    tags: cleanLabels(data.tags),
    moods: cleanLabels(data.moods, 3).filter((m) => MOODS.includes(m)),
    details: cleanLabels(data.details, 5).filter((d) => SCENES.includes(d)),
  };
}

function colorName(r, g, b) {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  const value = max / 255;
  if (value < 0.18) return 'black';
  if (delta / max < 0.14) return value > 0.85 ? 'white' : 'gray';

  let hue;
  if (max === r) hue = ((g - b) / delta + 6) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;

  if (hue < 15 || hue >= 340) return 'red';
  if (hue < 40) return value < 0.6 ? 'brown' : 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 170) return 'green';
  if (hue < 200) return 'teal';
  if (hue < 255) return 'blue';
  return hue < 290 ? 'purple' : 'pink';
}

const NEUTRALS = new Set(['black', 'gray', 'white']);

// Measured from the pixels, so colors are never a model's guess
export async function dominantColors(image) {
  const { data, info } = await sharp(image).resize(64, 64, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const groups = new Map();
  for (let i = 0; i < data.length; i += info.channels) {
    const name = colorName(data[i], data[i + 1], data[i + 2]);
    const group = groups.get(name) || { n: 0, r: 0, g: 0, b: 0 };
    group.n += 1;
    group.r += data[i];
    group.g += data[i + 1];
    group.b += data[i + 2];
    groups.set(name, group);
  }
  const total = data.length / info.channels;
  const top = [...groups]
    .filter(([name, g]) => g.n / total >= (NEUTRALS.has(name) ? 0.2 : 0.04))
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 4);
  const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
  return {
    colors: top.map(([name]) => name),
    palette: top.map(([, g]) => `#${hex(g.r / g.n)}${hex(g.g / g.n)}${hex(g.b / g.n)}`),
  };
}

export async function writeCaption(config, imageBuffer, context = {}, fetchFn = fetch) {
  const res = await fetchFn(`${config.captionApiUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.captionApiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model: config.captionModel,
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: captionPrompt(context) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Caption API returned ${res.status}`);
  const data = await res.json();
  const parsed = parseCaptionReply(data.choices?.[0]?.message?.content);
  if (!parsed) throw new Error('Caption API returned no usable caption');
  return parsed;
}

export function nextForCaption(db) {
  return db.prepare(`
    SELECT p.id, p.album_id, p.original_name, a.title AS album_title
    FROM photos p LEFT JOIN albums a ON a.id = p.album_id
    WHERE p.status = 'ready' AND p.caption = '' AND p.caption_draft IS NULL
      AND p.caption_dismissed = 0 AND p.caption_attempts < ?
    ORDER BY p.created_at ASC LIMIT 1
  `).get(MAX_ATTEMPTS);
}

export async function captionNext(db, dataDir, config, fetchFn = fetch) {
  const photo = nextForCaption(db);
  if (!photo) return false;
  try {
    const image = await readFile(join(dataDir, 'derived', photo.id, '960.jpg'));
    countAiCall(db, 'captions');
    const usedTitles = db.prepare(`
      SELECT COALESCE(NULLIF(caption, ''), caption_draft) AS title FROM photos
      WHERE album_id IS ? AND COALESCE(NULLIF(caption, ''), caption_draft) IS NOT NULL
      ORDER BY created_at DESC LIMIT 15
    `).all(photo.album_id).map((r) => r.title);
    const { title, ...meta } = await writeCaption(config, image, { albumTitle: photo.album_title, usedTitles }, fetchFn);
    const colors = await dominantColors(image);
    db.prepare('UPDATE photos SET caption_draft = ?, draft_meta = ? WHERE id = ?').run(title, JSON.stringify({ ...meta, ...colors }), photo.id);
  } catch (err) {
    db.prepare('UPDATE photos SET caption_attempts = caption_attempts + 1 WHERE id = ?').run(photo.id);
    logEvent(db, 'caption_failed', `${photo.original_name}: ${err.message}`);
    throw err;
  }
  return true;
}

export function captionDrafts(db) {
  return db.prepare(`
    SELECT p.id, p.original_name, p.caption_draft, p.draft_meta, a.title AS album_title
    FROM photos p LEFT JOIN albums a ON a.id = p.album_id
    WHERE p.caption_draft IS NOT NULL AND p.caption = ''
    ORDER BY p.created_at ASC
  `).all().map((row) => ({ ...row, meta: JSON.parse(row.draft_meta || '{}') }));
}

export function approvedCaptions(db) {
  return db.prepare(`
    SELECT p.id, p.original_name, p.caption AS caption_draft, p.meta AS draft_meta, a.title AS album_title
    FROM photos p LEFT JOIN albums a ON a.id = p.album_id
    WHERE p.caption <> ''
    ORDER BY p.created_at DESC
  `).all().map((row) => ({ ...row, meta: JSON.parse(row.draft_meta || '{}') }));
}

// Drafts stay private until approved in the admin. Nothing here touches photos.caption.
export function startCaptionWorker(db, dataDir, config, { intervalMs = 5000 } = {}) {
  if (!config.captionApiUrl || !config.captionModel) return () => {};

  let running = false;
  let pausedUntil = 0;

  async function tick() {
    if (running || Date.now() < pausedUntil || !aiEnabled(db, config, 'ai_captions')) return;
    running = true;
    try {
      await captionNext(db, dataDir, config);
    } catch {
      pausedUntil = Date.now() + FAILURE_PAUSE_MS;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
