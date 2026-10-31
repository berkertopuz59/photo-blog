import { createHmac } from 'node:crypto';

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 5000;

export function clientIp(headers, config, socketIp) {
  if (config.trustCf) {
    const cf = headers('cf-connecting-ip');
    if (typeof cf === 'string' && cf.length > 0) return cf;
    return 'unknown';
  }
  return socketIp || 'unknown';
}

export function visitorHash(secret, ip) {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

export function rateLimit(db, bucket, key, max, windowMs, nowMs = Date.now()) {
  const pruneBefore = nowMs - 2 * 24 * 60 * 60 * 1000;
  const windowStart = nowMs - windowMs;

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM rate_events WHERE at < ?').run(pruneBefore);

    const row = db
      .prepare('SELECT COUNT(*) AS cnt FROM rate_events WHERE bucket = ? AND key = ? AND at >= ?')
      .get(bucket, key, windowStart);

    if (row.cnt >= max) return false;

    db.prepare('INSERT INTO rate_events (bucket, key, at) VALUES (?, ?, ?)').run(bucket, key, nowMs);
    return true;
  });

  return txn();
}

export async function verifyTurnstile(secret, token, ip, fetchFn = fetch) {
  if (!token) return false;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURNSTILE_TIMEOUT_MS);

  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: ip || '' });

    const res = await fetchFn(TURNSTILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ac.signal,
    });

    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Control characters except \n (0x0A)
const CONTROL_CHARS_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

// Zero-width and bidi characters
const ZERO_WIDTH_BIDI_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function sanitizeText(str) {
  // Normalise \r\n → \n
  let s = str.replace(/\r\n/g, '\n');
  // Strip zero-width and bidi characters
  s = s.replace(ZERO_WIDTH_BIDI_RE, '');
  // Strip other control characters (keep \n)
  s = s.replace(CONTROL_CHARS_RE, '');
  // Cap consecutive newlines at 3
  s = s.replace(/\n{4,}/g, '\n\n\n');
  return s;
}

function stripControl(str) {
  return sanitizeText(str);
}

function charLen(str) {
  return [...str].length;
}

function trimPunctuation(token) {
  return token.replace(/^[^\w/-]+/, '').replace(/[^\w/-]+$/, '');
}

function hasLink(text) {
  if (/https?:\/\//i.test(text)) return true;
  if (/\bwww\./i.test(text)) return true;

  const tokens = text.split(/\s+/);
  for (const raw of tokens) {
    const token = trimPunctuation(raw);
    if (!token) continue;
    const m = token.match(/^([a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)*)\.([a-zA-Z]{2,})(\/.*)?$/);
    if (!m) continue;
    const tld = m[2];
    const hasPath = !!m[3];

    const tldLower = tld === tld.toLowerCase();
    const tldUpper = tld === tld.toUpperCase();
    const tldCapitalised = /^[A-Z][a-z]+$/.test(tld);

    if (tldLower || tldUpper || (tldCapitalised && hasPath)) return true;
  }
  return false;
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>".]+(\.[^\s@<>".]+)+$/;

export function validateComment({ author, body, website, email }) {
  if (website && website.trim().length > 0) {
    return { ok: false, error: 'honeypot' };
  }

  const cleanAuthor = stripControl(String(author || '')).trim();
  const cleanBody = stripControl(String(body || '')).trim();

  const authorLen = charLen(cleanAuthor);
  if (authorLen < 1 || authorLen > 40) {
    return { ok: false, error: 'author' };
  }

  const bodyLen = charLen(cleanBody);
  if (bodyLen < 1 || bodyLen > 1000) {
    return { ok: false, error: 'body' };
  }

  if (hasLink(cleanBody)) {
    return { ok: false, error: 'links' };
  }

  const cleanEmail = stripControl(String(email || '')).trim();
  if (cleanEmail && (cleanEmail.length > 254 || !EMAIL_RE.test(cleanEmail))) {
    return { ok: false, error: 'email' };
  }

  return { ok: true, author: cleanAuthor, body: cleanBody, email: cleanEmail };
}

export function canAcceptComment(db) {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM comments WHERE status = 'pending'").get();
  return row.cnt < 50;
}
