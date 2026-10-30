import { processPhoto, encodeAvif, ensurePreview } from './images.js';
import { scanPhoto, blurBoxes } from './privacy.js';
import { aiEnabled } from './settings.js';
import { logEvent } from './stats.js';
import { loadWatermark } from './watermark.js';

const SCAN_PAUSE_MS = 5 * 60 * 1000;

export function startWorker(db, dataDir, { intervalMs = 2000, config = null, fetchFn = fetch } = {}) {
  // Reset stuck processing rows on start
  db.prepare("UPDATE photos SET status = 'pending' WHERE status = 'processing'").run();

  let running = false;
  let stopped = false;
  let scansPausedUntil = 0;

  const canScan = () => Date.now() >= scansPausedUntil && aiEnabled(db, config, 'ai_privacy');

  async function scan(id) {
    try {
      return await scanPhoto(db, dataDir, config, id, fetchFn);
    } catch (err) {
      // One odd answer is that photo's problem; only an outage stops the queue
      if (!err.badAnswer) scansPausedUntil = Date.now() + SCAN_PAUSE_MS;
      return null;
    }
  }

  async function encodePending(row) {
    await ensurePreview(dataDir, row).catch(() => {});
    if (row.privacy_scan === 'new' && !row.privacy_reviewed && canScan()) await scan(row.id);

    const started = Date.now();
    await processPhoto(db, dataDir, row.id);
    const done = db.prepare('SELECT status, error, original_name FROM photos WHERE id = ?').get(row.id);
    if (done?.status === 'ready') {
      db.prepare('UPDATE photos SET process_ms = ? WHERE id = ?').run(Date.now() - started, row.id);
    } else if (done?.status === 'failed') {
      logEvent(db, 'photo_failed', `${done.original_name}: ${done.error}`);
    }
  }

  // Photos already on the site, or uploaded while the AI was off or down
  async function scanFinished(id) {
    const before = db.prepare('SELECT privacy_boxes FROM photos WHERE id = ?').get(id);
    const boxes = await scan(id);
    if (!boxes) return;
    const after = db.prepare('SELECT privacy_boxes FROM photos WHERE id = ?').get(id);
    if (JSON.stringify(blurBoxes(before)) !== JSON.stringify(blurBoxes(after))) {
      db.prepare("UPDATE photos SET status = 'pending', image_version = image_version + 1 WHERE id = ?").run(id);
    }
  }

  // Runs only while no new photo is waiting
  async function encodeNextAvif(next) {
    try {
      await encodeAvif(db, dataDir, next.id);
    } catch (err) {
      db.prepare('UPDATE photos SET avif_ready = -1 WHERE id = ?').run(next.id);
      logEvent(db, 'avif_failed', `${next.original_name}: ${err.message}`);
    }
  }

  async function workOnce() {
    const pending = db.prepare(
      "SELECT id, original_ext, privacy_scan, privacy_reviewed FROM photos WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
    ).get();
    if (pending) {
      await encodePending(pending);
      return true;
    }

    if (canScan()) {
      const unscanned = db.prepare(
        "SELECT id FROM photos WHERE status = 'ready' AND privacy_scan = 'new' AND privacy_reviewed = 0 ORDER BY is_published DESC, created_at ASC LIMIT 1"
      ).get();
      if (unscanned) {
        await scanFinished(unscanned.id);
        return true;
      }
    }

    // One at a time, so a changed watermark never takes the whole site offline. Newest first,
    // because those are the photos people see.
    const stamp = (await loadWatermark(db, dataDir))?.stamp ?? '';
    const stale = db.prepare(
      "SELECT id FROM photos WHERE status = 'ready' AND watermark != ? ORDER BY is_published DESC, COALESCE(published_at, created_at) DESC LIMIT 1"
    ).get(stamp);
    if (stale) {
      db.prepare("UPDATE photos SET status = 'pending', image_version = image_version + 1 WHERE id = ?").run(stale.id);
      return true;
    }

    const avif = db.prepare(
      "SELECT id, original_name FROM photos WHERE status = 'ready' AND avif_ready = 0 ORDER BY is_published DESC, created_at ASC LIMIT 1"
    ).get();
    if (avif) {
      await encodeNextAvif(avif);
      return true;
    }
    return false;
  }

  async function tick() {
    if (running || stopped) return;
    running = true;
    let worked = false;
    try {
      worked = await workOnce();
    } catch { /* shutting down, or the next tick retries */ }
    running = false;
    if (worked) tick();
  }

  // Kick off immediately
  tick();

  const timer = setInterval(tick, intervalMs);

  return function stop() {
    stopped = true;
    clearInterval(timer);
  };
}
