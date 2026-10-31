import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from './db.js';
import { previewPath } from './images.js';

export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const trashDir = (dataDir, id) => join(dataDir, 'trash', id);
const originalPath = (dataDir, id, ext) => join(dataDir, 'originals', `${id}.${ext}`);

function moveIfThere(from, to) {
  if (existsSync(from)) renameSync(from, to);
}

function insertRow(db, table, row) {
  const known = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const keys = Object.keys(row).filter((key) => known.has(key));
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((key) => row[key]));
}

// Takes the photo out of the photos table, so every public and admin list loses it at once
export function trashPhoto(db, dataDir, id) {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!photo) return false;

  const dir = trashDir(dataDir, id);
  mkdirSync(dir, { recursive: true });
  moveIfThere(originalPath(dataDir, id, photo.original_ext), join(dir, 'original'));
  moveIfThere(previewPath(dataDir, id), join(dir, 'preview.jpg'));
  moveIfThere(join(dataDir, 'derived', id, '480.jpg'), join(dir, 'thumb.jpg'));
  rmSync(join(dataDir, 'derived', id), { recursive: true, force: true });

  const comments = db.prepare('SELECT * FROM comments WHERE photo_id = ?').all(id);
  const likes = db.prepare('SELECT * FROM likes WHERE photo_id = ?').all(id);
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO trash (id, original_name, deleted_at, photo, comments, likes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, photo.original_name, nowIso(), JSON.stringify(photo), JSON.stringify(comments), JSON.stringify(likes));
    db.prepare('UPDATE albums SET cover_photo_id = NULL WHERE cover_photo_id = ?').run(id);
    db.prepare('DELETE FROM photos WHERE id = ?').run(id);
  })();
  return true;
}

export function trashList(db) {
  return db.prepare('SELECT id, original_name, deleted_at FROM trash ORDER BY deleted_at DESC').all().map((row) => ({
    ...row,
    days_left: Math.max(0, Math.ceil((Date.parse(row.deleted_at) + TRASH_DAYS * DAY_MS - Date.now()) / DAY_MS)),
  }));
}

export function trashThumb(dataDir, id) {
  return ['thumb.jpg', 'preview.jpg'].map((file) => join(trashDir(dataDir, id), file)).find(existsSync) ?? null;
}

// Comes back through the worker, which rebuilds every image with the current blurs and watermark
export function restorePhoto(db, dataDir, id) {
  const row = db.prepare('SELECT * FROM trash WHERE id = ?').get(id);
  if (!row) return 'not_found';

  const photo = JSON.parse(row.photo);
  const dir = trashDir(dataDir, id);
  if (!existsSync(join(dir, 'original'))) return 'missing_original';
  if (db.prepare('SELECT 1 FROM photos WHERE original_sha256 = ?').get(photo.original_sha256)) return 'duplicate';

  const album = photo.album_id && db.prepare('SELECT id FROM albums WHERE id = ?').get(photo.album_id);
  const restored = { ...photo, status: 'pending', error: null, avif_ready: 0, album_id: album ? photo.album_id : null, image_version: photo.image_version + 1 };

  mkdirSync(join(dataDir, 'originals'), { recursive: true });
  mkdirSync(join(dataDir, 'previews'), { recursive: true });
  db.transaction(() => {
    insertRow(db, 'photos', restored);
    for (const { id: _id, ...comment } of JSON.parse(row.comments)) insertRow(db, 'comments', comment);
    for (const like of JSON.parse(row.likes)) insertRow(db, 'likes', like);
    db.prepare('DELETE FROM trash WHERE id = ?').run(id);
  })();
  moveIfThere(join(dir, 'original'), originalPath(dataDir, id, photo.original_ext));
  moveIfThere(join(dir, 'preview.jpg'), previewPath(dataDir, id));
  rmSync(dir, { recursive: true, force: true });
  return 'ok';
}

export function erasePhoto(db, dataDir, id) {
  rmSync(trashDir(dataDir, id), { recursive: true, force: true });
  return db.prepare('DELETE FROM trash WHERE id = ?').run(id).changes > 0;
}

export function emptyTrash(db, dataDir) {
  const rows = db.prepare('SELECT id FROM trash').all();
  rows.forEach(({ id }) => erasePhoto(db, dataDir, id));
  return rows.length;
}

export function purgeTrash(db, dataDir, now = Date.now()) {
  const cutoff = new Date(now - TRASH_DAYS * DAY_MS).toISOString();
  const rows = db.prepare('SELECT id FROM trash WHERE deleted_at < ?').all(cutoff);
  rows.forEach(({ id }) => erasePhoto(db, dataDir, id));
  return rows.length;
}
