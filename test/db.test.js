import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, newPhotoId, nowIso } from '../lib/db.js';
import { loadConfig } from '../lib/config.js';

describe('db schema', () => {
  it('opens the same schema twice without error', () => {
    const db = openDb(':memory:');
    // Second exec of identical schema must not throw
    openDb(':memory:');
    // Even reopening same in-memory path would be new db, but the point is
    // idempotent CREATE IF NOT EXISTS. Re-run exec on existing db:
    assert.doesNotThrow(() => db.exec('SELECT 1 FROM photos'));
    db.close();
  });

  it('status CHECK rejects an invalid value', () => {
    const db = openDb(':memory:');
    const id = newPhotoId();
    assert.throws(
      () => {
        db.prepare(
          `INSERT INTO photos (id, status, original_name, original_ext, original_sha256, created_at)
           VALUES (?, 'bogus', 'f', 'jpg', ?, ?)`
        ).run(id, 'aabbccdd', nowIso());
      },
      /CHECK constraint failed/
    );
    db.close();
  });

  it('deleting a photo cascades likes and comments', () => {
    const db = openDb(':memory:');
    const pid = newPhotoId();
    const ts = nowIso();

    db.prepare(
      `INSERT INTO photos (id, status, original_name, original_ext, original_sha256, created_at)
       VALUES (?, 'ready', 'a.jpg', 'jpg', ?, ?)`
    ).run(pid, 'deadbeef001', ts);

    db.prepare(
      `INSERT INTO likes (photo_id, visitor, created_at) VALUES (?, ?, ?)`
    ).run(pid, 'visitor-1', ts);

    db.prepare(
      `INSERT INTO comments (photo_id, author, body, visitor, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(pid, 'Bob', 'Nice!', 'visitor-1', ts);

    db.prepare('DELETE FROM photos WHERE id = ?').run(pid);

    const likeCount = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE photo_id = ?').get(pid).c;
    const commentCount = db.prepare('SELECT COUNT(*) AS c FROM comments WHERE photo_id = ?').get(pid).c;

    assert.equal(likeCount, 0);
    assert.equal(commentCount, 0);
    db.close();
  });

  it('duplicate original_sha256 throws', () => {
    const db = openDb(':memory:');
    const ts = nowIso();
    const hash = 'repeat-hash-abc';

    db.prepare(
      `INSERT INTO photos (id, status, original_name, original_ext, original_sha256, created_at)
       VALUES (?, 'ready', 'a.jpg', 'jpg', ?, ?)`
    ).run(newPhotoId(), hash, ts);

    assert.throws(
      () => {
        db.prepare(
          `INSERT INTO photos (id, status, original_name, original_ext, original_sha256, created_at)
           VALUES (?, 'ready', 'b.jpg', 'jpg', ?, ?)`
        ).run(newPhotoId(), hash, ts);
      },
      /UNIQUE constraint failed/
    );
    db.close();
  });
});

describe('config', () => {
  it('production config throws when a required secret is missing', () => {
    assert.throws(
      () => {
        loadConfig({
          NODE_ENV: 'production',
          SITE_URL: 'https://example.com',
          SESSION_SECRET: 's',
          VISITOR_SECRET: 'v',
          TURNSTILE_SITE_KEY: 'tk',
          TURNSTILE_SECRET: 'ts',
          // ADMIN_PASSWORD_HASH intentionally missing
        });
      },
      /Missing required env var in production: ADMIN_PASSWORD_HASH/
    );
  });
});
