import { dayKey } from './stats.js';

const DEFAULTS = { ai_captions: '1', ai_privacy: '0' };
export const SETTING_KEYS = Object.keys(DEFAULTS);

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key];
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function aiConfigured(config) {
  return Boolean(config?.captionApiUrl && config?.captionModel);
}

export function aiEnabled(db, config, key) {
  return aiConfigured(config) && getSetting(db, key) === '1';
}

export function countAiCall(db, lane) {
  db.prepare(`
    INSERT INTO daily_traffic (day, dimension, value, count) VALUES (?, 'ai_calls', ?, 1)
    ON CONFLICT (day, dimension, value) DO UPDATE SET count = count + 1
  `).run(dayKey(), lane);
}

export function aiCalls(db, lane) {
  const since = (day) => db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM daily_traffic WHERE dimension = 'ai_calls' AND value = ? AND day >= ?").get(lane, day).n;
  const today = dayKey();
  return { today: since(today), month: since(`${today.slice(0, 7)}-01`) };
}
