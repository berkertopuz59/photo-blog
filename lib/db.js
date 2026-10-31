import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_photo_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
  caption TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed')),
  error TEXT,
  is_published INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  original_name TEXT NOT NULL,
  original_ext TEXT NOT NULL,
  original_sha256 TEXT NOT NULL UNIQUE,
  width INTEGER,
  height INTEGER,
  placeholder TEXT,
  taken_at TEXT,
  camera TEXT,
  lens TEXT,
  focal TEXT,
  aperture TEXT,
  shutter TEXT,
  iso INTEGER,
      mode TEXT,
      software TEXT,
      cropped TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS likes (
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  visitor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (photo_id, visitor)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  visitor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_events (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_views (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, ref)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS daily_traffic (
  day TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dimension, value)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_rate_events_bucket_key_at ON rate_events (bucket, key, at);
CREATE INDEX IF NOT EXISTS idx_photos_album ON photos (album_id, is_published, position);
CREATE INDEX IF NOT EXISTS idx_photos_feed ON photos (is_published, published_at DESC);
`;

export function openDb(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA);

  // Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them
  const photoColumns = new Set(db.prepare('PRAGMA table_info(photos)').all().map((c) => c.name));
  for (const column of ['mode', 'software', 'cropped']) {
    if (!photoColumns.has(column)) db.exec(`ALTER TABLE photos ADD COLUMN ${column} TEXT`);
  }
  if (!photoColumns.has('process_ms')) db.exec('ALTER TABLE photos ADD COLUMN process_ms INTEGER');
  if (!photoColumns.has('avif_ready')) {
    db.exec('ALTER TABLE photos ADD COLUMN avif_ready INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE photos SET avif_ready = 1 WHERE status = 'ready'");
  }
  if (!photoColumns.has('privacy_ok')) {
    // Photos already live stay live; everything else waits for review
    db.exec('ALTER TABLE photos ADD COLUMN privacy_ok INTEGER NOT NULL DEFAULT 1');
    db.exec('UPDATE photos SET privacy_ok = is_published');
    db.exec('ALTER TABLE photos ADD COLUMN privacy_reviewed INTEGER NOT NULL DEFAULT 0');
    db.exec("ALTER TABLE photos ADD COLUMN privacy_scan TEXT NOT NULL DEFAULT 'new'");
    db.exec('ALTER TABLE photos ADD COLUMN privacy_attempts INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE photos ADD COLUMN privacy_boxes TEXT');
    db.exec('ALTER TABLE photos ADD COLUMN image_version INTEGER NOT NULL DEFAULT 0');
  }
  const commentColumns = new Set(db.prepare('PRAGMA table_info(comments)').all().map((c) => c.name));
  if (!commentColumns.has('email')) db.exec("ALTER TABLE comments ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  if (!photoColumns.has('meta')) {
    db.exec('ALTER TABLE photos ADD COLUMN meta TEXT');
    db.exec('ALTER TABLE photos ADD COLUMN draft_meta TEXT');
  }
  if (!photoColumns.has('caption_draft')) {
    db.exec('ALTER TABLE photos ADD COLUMN caption_draft TEXT');
    db.exec('ALTER TABLE photos ADD COLUMN caption_attempts INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE photos ADD COLUMN caption_dismissed INTEGER NOT NULL DEFAULT 0');
  }
  if (!photoColumns.has('watermark')) {
    db.exec("ALTER TABLE photos ADD COLUMN watermark TEXT NOT NULL DEFAULT ''");
  }

  return db;
}

export function newPhotoId() {
  return randomBytes(8).toString('hex');
}

export function nowIso() {
  return new Date().toISOString();
}
