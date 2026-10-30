import { processPhoto } from './images.js';

export function startWorker(db, dataDir, { intervalMs = 2000 } = {}) {
  // Reset stuck processing rows on start
  db.prepare("UPDATE photos SET status = 'pending' WHERE status = 'processing'").run();

  let running = false;
  let stopped = false;

  function tick() {
    if (running || stopped) return;
    running = true;

    const row = db.prepare(
      "SELECT id FROM photos WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
    ).get();

    if (row) {
      processPhoto(db, dataDir, row.id).finally(() => { running = false; });
    } else {
      running = false;
    }
  }

  // Kick off immediately
  tick();

  const timer = setInterval(tick, intervalMs);

  return function stop() {
    stopped = true;
    clearInterval(timer);
  };
}
