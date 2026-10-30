import { nowIso } from './db.js';

const BOT_RE = /bot|crawl|spider|slurp|preview|fetch|monitor|uptime|curl|wget|python|httpclient|headless|facebookexternalhit|lighthouse/i;
const COUNTRY_RE = /^[A-Z]{2}$/;
const HOST_RE = /^[a-z0-9.-]{1,100}$/;
const MAX_VALUES_PER_DAY = 200;
const MAX_SEEN = 100_000;
const EVENT_DAYS = 30;
const EVENT_ROWS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(n, now) {
  return dayKey(new Date(now.getTime() - n * DAY_MS));
}

function externalHost(referrer, siteUrl) {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    if (!HOST_RE.test(host)) return null;
    return host === new URL(siteUrl).hostname ? null : host;
  } catch {
    return null;
  }
}

// Counts one view per visitor, page and day. Visitor hashes stay in memory only.
export function viewCounter(db, { siteUrl }) {
  const addView = db.prepare(`
    INSERT INTO daily_views (day, kind, ref, views) VALUES (?, ?, ?, 1)
    ON CONFLICT (day, kind, ref) DO UPDATE SET views = views + 1
  `);
  const addTraffic = db.prepare(`
    INSERT INTO daily_traffic (day, dimension, value, count) VALUES (?, ?, ?, 1)
    ON CONFLICT (day, dimension, value) DO UPDATE SET count = count + 1
  `);
  const known = db.prepare('SELECT 1 FROM daily_traffic WHERE day = ? AND dimension = ? AND value = ?');
  const distinct = db.prepare('SELECT COUNT(*) AS n FROM daily_traffic WHERE day = ? AND dimension = ?');

  function bump(day, dimension, value) {
    if (!known.get(day, dimension, value) && distinct.get(day, dimension).n >= MAX_VALUES_PER_DAY) return;
    addTraffic.run(day, dimension, value);
  }

  let seenDay = '';
  let seen = new Set();

  return function count({ kind, ref, visitor, userAgent, purpose, referrer, country, owner, now = new Date() }) {
    if (owner || !userAgent || BOT_RE.test(userAgent) || /prefetch|prerender/i.test(purpose || '')) return;

    const day = dayKey(now);
    if (day !== seenDay || seen.size > MAX_SEEN) {
      seenDay = day;
      seen = new Set();
    }

    const pageKey = `${visitor}|${kind}|${ref}`;
    if (seen.has(pageKey)) return;
    seen.add(pageKey);
    addView.run(day, kind, ref);

    const host = externalHost(referrer, siteUrl);
    if (host) bump(day, 'referrer', host);

    if (seen.has(visitor)) return;
    seen.add(visitor);
    bump(day, 'visitors', '');
    if (COUNTRY_RE.test(country || '') && country !== 'XX' && country !== 'T1') bump(day, 'country', country);
  };
}

export function logEvent(db, kind, detail = '') {
  const cutoff = new Date(Date.now() - EVENT_DAYS * DAY_MS).toISOString();
  db.prepare('INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)').run(nowIso(), kind, String(detail).slice(0, 300));
  db.prepare('DELETE FROM events WHERE at < ? OR id <= (SELECT MAX(id) FROM events) - ?').run(cutoff, EVENT_ROWS);
}

export function queueStats(db) {
  const counts = { pending: 0, processing: 0, ready: 0, failed: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM photos GROUP BY status').all()) {
    counts[row.status] = row.n;
  }
  const { ms } = db.prepare(
    'SELECT AVG(process_ms) AS ms FROM (SELECT process_ms FROM photos WHERE process_ms IS NOT NULL ORDER BY rowid DESC LIMIT 20)'
  ).get();
  const waiting = counts.pending + counts.processing;
  const avifLeft = db.prepare("SELECT COUNT(*) AS n FROM photos WHERE status = 'ready' AND avif_ready = 0").get().n;
  const privacyToReview = db.prepare("SELECT COUNT(*) AS n FROM photos WHERE privacy_reviewed = 0 AND status <> 'failed'").get().n;
  return {
    ...counts,
    total: waiting + counts.ready + counts.failed,
    avifLeft,
    privacyToReview,
    secondsPerPhoto: ms ? Math.round(ms / 1000) : null,
    secondsLeft: ms && waiting ? Math.round((waiting * ms) / 1000) : (waiting ? null : 0),
    jobs: [
      ...db.prepare("SELECT id, original_name, status FROM photos WHERE status IN ('pending', 'processing') ORDER BY status = 'processing' DESC, created_at ASC LIMIT 100").all(),
      ...db.prepare("SELECT id, original_name, status FROM photos WHERE status IN ('ready', 'failed') ORDER BY created_at DESC LIMIT 20").all(),
    ],
  };
}

export function libraryStats(db) {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    published: one('SELECT COUNT(*) AS n FROM photos WHERE is_published = 1'),
    unpublished: one('SELECT COUNT(*) AS n FROM photos WHERE is_published = 0'),
    albums: one('SELECT COUNT(*) AS n FROM albums'),
    likes: one('SELECT COUNT(*) AS n FROM likes'),
    commentsApproved: one("SELECT COUNT(*) AS n FROM comments WHERE status = 'approved'"),
    commentsPending: one("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'"),
    failed: db.prepare("SELECT id, original_name, error FROM photos WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20").all(),
  };
}

export function trafficStats(db, now = new Date()) {
  const week = daysAgo(6, now);
  const month = daysAgo(29, now);
  const views = (from) => db.prepare('SELECT COALESCE(SUM(views), 0) AS n FROM daily_views WHERE day >= ?').get(from).n;
  const visitors = (from) => db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM daily_traffic WHERE dimension = 'visitors' AND day >= ?").get(from).n;
  const top = (dimension) => db.prepare(
    'SELECT value, SUM(count) AS n FROM daily_traffic WHERE dimension = ? AND day >= ? GROUP BY value ORDER BY n DESC, value LIMIT 10'
  ).all(dimension, month);

  const byDay = new Map(db.prepare('SELECT day, SUM(views) AS n FROM daily_views WHERE day >= ? GROUP BY day').all(daysAgo(13, now)).map((r) => [r.day, r.n]));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = daysAgo(i, now);
    days.push({ day, views: byDay.get(day) || 0 });
  }

  return {
    viewsToday: views(dayKey(now)),
    views7: views(week),
    views30: views(month),
    visitorsToday: visitors(dayKey(now)),
    visitors7: visitors(week),
    visitors30: visitors(month),
    days,
    photos: db.prepare(`
      SELECT p.id, p.caption, p.original_name, p.status, a.title AS album_title, SUM(v.views) AS views,
        (SELECT COUNT(*) FROM likes l WHERE l.photo_id = p.id) AS likes,
        (SELECT COUNT(*) FROM comments c WHERE c.photo_id = p.id AND c.status = 'approved') AS comments
      FROM daily_views v
      JOIN photos p ON p.id = v.ref
      LEFT JOIN albums a ON a.id = p.album_id
      WHERE v.kind = 'photo' AND v.day >= ?
      GROUP BY p.id ORDER BY views DESC, p.id LIMIT 10
    `).all(month),
    albums: db.prepare(`
      SELECT a.title, a.slug, SUM(v.views) AS views
      FROM daily_views v
      JOIN albums a ON a.id = CAST(v.ref AS INTEGER)
      WHERE v.kind = 'album' AND v.day >= ?
      GROUP BY a.id ORDER BY views DESC, a.id LIMIT 10
    `).all(month),
    countries: top('country'),
    referrers: top('referrer'),
  };
}

export function recentEvents(db, limit = 50) {
  return {
    items: db.prepare('SELECT at, kind, detail FROM events ORDER BY id DESC LIMIT ?').all(limit),
    counts: db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC').all(),
  };
}
