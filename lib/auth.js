import { scryptSync, randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export function hashPassword(pw) {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(pw, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  let salt, hash;
  try {
    salt = Buffer.from(parts[1], 'hex');
    hash = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }

  if (salt.length === 0 || hash.length !== KEY_LEN) return false;
  if (parts[1].length !== SALT_LEN * 2 || parts[2].length !== KEY_LEN * 2) return false;

  const derived = scryptSync(pw, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });

  return timingSafeEqual(derived, hash);
}

export function verifyLogin(username, password, config) {
  const pw = typeof password === 'string' ? password : '';
  const pwOk = verifyPassword(pw, config.adminPasswordHash);

  if (typeof username !== 'string' || typeof password !== 'string') return false;

  const expected = createHash('sha256').update(config.adminUsername).digest();
  const provided = createHash('sha256').update(username).digest();
  const userOk = timingSafeEqual(expected, provided);

  return pwOk && userOk;
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function sessionHmac(secret, timestamp) {
  return createHmac('sha256', secret).update(timestamp).digest('hex');
}

export function signSession(secret, nowMs = Date.now()) {
  const ts = String(nowMs);
  const sig = sessionHmac(secret, ts);
  return `${ts}.${sig}`;
}

export function verifySession(secret, token, nowMs = Date.now()) {
  if (typeof token !== 'string') return false;

  const dot = token.indexOf('.');
  if (dot === -1 || dot !== token.lastIndexOf('.')) return false;

  const ts = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  if (!/^\d+$/.test(ts) || sig.length !== 64) return false;

  const expected = sessionHmac(secret, ts);

  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }

  if (sigBuf.length !== 32 || expBuf.length !== 32) return false;

  if (!timingSafeEqual(sigBuf, expBuf)) return false;

  const issuedAt = Number(ts);
  if (nowMs - issuedAt > FOURTEEN_DAYS_MS || issuedAt > nowMs + 1000) return false;

  return true;
}

export function originOk(originHeader, siteUrl) {
  if (!originHeader || typeof originHeader !== 'string') return false;

  try {
    const site = new URL(siteUrl);
    const origin = new URL(originHeader);

    return origin.origin === site.origin;
  } catch {
    return false;
  }
}
