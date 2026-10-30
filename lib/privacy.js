import { readFile } from 'node:fs/promises';
import { previewPath, ensurePreview } from './images.js';
import { countAiCall } from './settings.js';
import { logEvent } from './stats.js';

const MAX_ATTEMPTS = 3;
const MAX_BOXES = 200;
const PADDING = 0.3;
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const TYPES = new Set(['face', 'plate', 'manual']);

const PROMPT = 'Find every recognizable human face and every readable vehicle license plate in this image. Include small faces in crowds. Faces on posters or banners do not count. Reply with JSON only: {"items":[{"type":"face"|"plate","box":[x1,y1,x2,y2]}]} with coordinates normalized 0 to 1000 relative to image width and height. Reply {"items":[]} if there are none.';

const clamp = (v) => Math.min(1, Math.max(0, v));

export function cleanBoxes(values) {
  if (!Array.isArray(values)) return [];
  const boxes = [];
  for (const box of values.slice(0, MAX_BOXES)) {
    const [x1, y1, x2, y2] = [box?.x1, box?.y1, box?.x2, box?.y2].map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const clean = { type: TYPES.has(box.type) ? box.type : 'manual', x1: clamp(x1), y1: clamp(y1), x2: clamp(x2), y2: clamp(y2), blur: box.blur !== false };
    if (clean.x2 > clean.x1 && clean.y2 > clean.y1) boxes.push(clean);
  }
  return boxes;
}

export function parseScanReply(text) {
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
  if (!Array.isArray(data.items)) return null;

  // Model boxes run tight and a little off, so each grows by 30%
  return cleanBoxes(data.items.map((item) => {
    if (!Array.isArray(item?.box) || item.box.length !== 4) return null;
    const [x1, y1, x2, y2] = item.box.map((v) => Number(v) / 1000);
    const padX = (x2 - x1) * PADDING / 2;
    const padY = (y2 - y1) * PADDING / 2;
    return { type: item.type, x1: x1 - padX, y1: y1 - padY, x2: x2 + padX, y2: y2 + padY };
  }));
}

export async function scanPhoto(db, dataDir, config, id, fetchFn = fetch) {
  const photo = db.prepare('SELECT id, original_name, original_ext, privacy_attempts, privacy_boxes FROM photos WHERE id = ?').get(id);
  if (!photo) return null;

  try {
    await ensurePreview(dataDir, photo);
    const image = await readFile(previewPath(dataDir, id));
    countAiCall(db, 'privacy');
    const res = await fetchFn(`${config.captionApiUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.captionApiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: config.captionModel,
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`Privacy API returned ${res.status}`);
    const data = await res.json();
    const boxes = parseScanReply(data.choices?.[0]?.message?.content);
    if (!boxes) throw new Error('Privacy API returned no usable answer');

    const manual = cleanBoxes(JSON.parse(photo.privacy_boxes || '[]')).filter((box) => box.type === 'manual');
    const merged = [...boxes, ...manual];
    db.prepare("UPDATE photos SET privacy_scan = 'done', privacy_boxes = ? WHERE id = ?").run(JSON.stringify(merged), id);
    return merged;
  } catch (err) {
    const gaveUp = photo.privacy_attempts + 1 >= MAX_ATTEMPTS;
    db.prepare('UPDATE photos SET privacy_attempts = privacy_attempts + 1, privacy_scan = ? WHERE id = ?').run(gaveUp ? 'failed' : 'new', id);
    logEvent(db, 'privacy_failed', `${photo.original_name}: ${err.message}`);
    throw err;
  }
}

export function blurBoxes(row) {
  return cleanBoxes(JSON.parse(row.privacy_boxes || '[]')).filter((box) => box.blur);
}

export function privacyList(db, { reviewed }) {
  return db.prepare(`
    SELECT p.id, p.original_name, p.privacy_boxes, p.privacy_scan, p.is_published, p.privacy_ok, p.status, a.title AS album_title
    FROM photos p LEFT JOIN albums a ON a.id = p.album_id
    WHERE p.privacy_reviewed = ? AND p.status <> 'failed'
    ORDER BY p.created_at ASC
  `).all(reviewed ? 1 : 0).map((row) => ({ ...row, boxes: cleanBoxes(JSON.parse(row.privacy_boxes || '[]')) }));
}

// Saves your decision. A changed blur re-encodes the photo under a new image version.
export function reviewPhoto(db, id, boxes) {
  const row = db.prepare('SELECT privacy_boxes FROM photos WHERE id = ?').get(id);
  if (!row) return false;
  const clean = cleanBoxes(boxes);
  const changed = JSON.stringify(blurBoxes({ privacy_boxes: JSON.stringify(clean) })) !== JSON.stringify(blurBoxes(row));
  db.prepare(`
    UPDATE photos SET privacy_boxes = ?, privacy_ok = 1, privacy_reviewed = 1,
      image_version = image_version + ?, status = CASE WHEN ? THEN 'pending' ELSE status END
    WHERE id = ?
  `).run(JSON.stringify(clean), changed ? 1 : 0, changed ? 1 : 0, id);
  return true;
}
