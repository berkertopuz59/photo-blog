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

  return db;
}

export function newPhotoId() {
  return randomBytes(8).toString('hex');
}

export function nowIso() {
  return new Date().toISOString();
}
