import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import {
  clientIp,
  visitorHash,
  rateLimit,
  verifyTurnstile,
  validateComment,
  canAcceptComment,
} from '../lib/guard.js';

describe('clientIp', () => {
  it('uses CF-Connecting-IP when trustCf', () => {
    const headers = (name) => (name === 'cf-connecting-ip' ? '1.2.3.4' : undefined);
    const config = { trustCf: true };
    assert.equal(clientIp(headers, config, '10.0.0.1'), '1.2.3.4');
  });

  it('uses socketIp when not trustCf even if CF header present', () => {
    const headers = (name) => (name === 'cf-connecting-ip' ? '1.2.3.4' : undefined);
    const config = { trustCf: false };
    assert.equal(clientIp(headers, config, '10.0.0.1'), '10.0.0.1');
  });

  it('ignores X-Forwarded-For entirely', () => {
    const headers = (name) => (name === 'x-forwarded-for' ? '99.99.99.99' : undefined);
    const config = { trustCf: false };
    assert.equal(clientIp(headers, config, '10.0.0.1'), '10.0.0.1');
  });

  it('does not read X-Forwarded-For even when trustCf is true', () => {
    const headers = (name) => {
      if (name === 'x-forwarded-for') return '99.99.99.99';
      return undefined;
    };
    const config = { trustCf: true };
    assert.equal(clientIp(headers, config, '10.0.0.1'), 'unknown');
  });

  it('returns unknown when trustCf and CF header missing', () => {
    const headers = () => undefined;
    const config = { trustCf: true };
    assert.equal(clientIp(headers, config, undefined), 'unknown');
  });

  it('returns unknown when not trustCf and no socketIp', () => {
    const headers = () => undefined;
    const config = { trustCf: false };
    assert.equal(clientIp(headers, config, undefined), 'unknown');
  });

  it('visitorHash works with unknown from clientIp', () => {
    const headers = () => undefined;
    const config = { trustCf: true };
    const ip = clientIp(headers, config, undefined);
    const hash = visitorHash('secret', ip);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});

describe('visitorHash', () => {
  it('produces deterministic hex', () => {
    const a = visitorHash('secret', '1.2.3.4');
    const b = visitorHash('secret', '1.2.3.4');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('differs for different IPs', () => {
    assert.notEqual(visitorHash('secret', '1.1.1.1'), visitorHash('secret', '2.2.2.2'));
  });
});

describe('rateLimit', () => {
  it('allows up to max then blocks', () => {
    const db = openDb(':memory:');
    const now = 1700000000000;
    assert.equal(rateLimit(db, 'test', 'v1', 3, 3600000, now), true);
    assert.equal(rateLimit(db, 'test', 'v1', 3, 3600000, now), true);
    assert.equal(rateLimit(db, 'test', 'v1', 3, 3600000, now), true);
    assert.equal(rateLimit(db, 'test', 'v1', 3, 3600000, now), false);
  });

  it('does not record denied events', () => {
    const db = openDb(':memory:');
    const now = 1700000000000;
    rateLimit(db, 'test', 'v1', 1, 3600000, now);
    rateLimit(db, 'test', 'v1', 1, 3600000, now); // denied
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM rate_events').get();
    assert.equal(row.cnt, 1);
  });

  it('allows again after window passes', () => {
    const db = openDb(':memory:');
    const now = 1700000000000;
    const windowMs = 3600000;
    rateLimit(db, 'test', 'v1', 1, windowMs, now);
    assert.equal(rateLimit(db, 'test', 'v1', 1, windowMs, now), false);
    assert.equal(rateLimit(db, 'test', 'v1', 1, windowMs, now + windowMs + 1), true);
  });

  it('prunes events older than 2 days', () => {
    const db = openDb(':memory:');
    const now = 1700000000000;
    db.prepare('INSERT INTO rate_events (bucket, key, at) VALUES (?,?,?)').run('old', 'v1', now - 49 * 3600000);
    rateLimit(db, 'other', 'v1', 10, 3600000, now);
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM rate_events WHERE bucket='old'").get();
    assert.equal(row.cnt, 0);
  });
});

describe('verifyTurnstile', () => {
  it('returns false for empty token without calling fetch', async () => {
    let called = false;
    const result = await verifyTurnstile('sec', '', '1.2.3.4', () => { called = true; });
    assert.equal(result, false);
    assert.equal(called, false);
  });

  it('returns true on success response', async () => {
    const fetchFn = async () => ({ json: async () => ({ success: true }) });
    assert.equal(await verifyTurnstile('sec', 'token123', '1.2.3.4', fetchFn), true);
  });

  it('returns false on failure response', async () => {
    const fetchFn = async () => ({ json: async () => ({ success: false }) });
    assert.equal(await verifyTurnstile('sec', 'token123', '1.2.3.4', fetchFn), false);
  });

  it('returns false on thrown fetch (network error)', async () => {
    const fetchFn = async () => { throw new Error('network down'); };
    assert.equal(await verifyTurnstile('sec', 'token123', '1.2.3.4', fetchFn), false);
  });

  it('returns false on bad JSON', async () => {
    const fetchFn = async () => ({ json: async () => { throw new SyntaxError('bad'); } });
    assert.equal(await verifyTurnstile('sec', 'token123', '1.2.3.4', fetchFn), false);
  });

  it('returns false when fetch rejects', async () => {
    const fetchFn = () => Promise.reject(new Error('timeout'));
    assert.equal(await verifyTurnstile('sec', 'tok', '1.1.1.1', fetchFn), false);
  });

  it('returns false when fetchFn throws synchronously', async () => {
    const fetchFn = () => { throw new TypeError('fetch is not a function'); };
    assert.equal(await verifyTurnstile('sec', 'token123', '1.2.3.4', fetchFn), false);
  });
});

describe('validateComment', () => {
  it('accepts valid comment and trims', () => {
    const r = validateComment({ author: '  Alice  ', body: '  Nice photo!  ', website: '' });
    assert.equal(r.ok, true);
    assert.equal(r.author, 'Alice');
    assert.equal(r.body, 'Nice photo!');
  });

  it('takes an optional email and turns away a bad one', () => {
    assert.equal(validateComment({ author: 'A', body: 'Hi' }).email, '');
    assert.equal(validateComment({ author: 'A', body: 'Hi', email: '  a.b+c@mail.example.org ' }).email, 'a.b+c@mail.example.org');
    for (const email of ['nope', 'a@b', 'a b@c.de', 'a@b@c.de', 'a@b..de', '<a@b.de>', `${'a'.repeat(250)}@b.de`, 'a@b.de\nBcc: x@y.de']) {
      assert.equal(validateComment({ author: 'A', body: 'Hi', email }).error, 'email', email);
    }
  });

  it('rejects honeypot filled', () => {
    const r = validateComment({ author: 'A', body: 'Hi', website: 'spam.com' });
    assert.deepEqual(r, { ok: false, error: 'honeypot' });
  });

  it('rejects empty author', () => {
    const r = validateComment({ author: '', body: 'Hi', website: '' });
    assert.deepEqual(r, { ok: false, error: 'author' });
  });

  it('rejects author over 40 chars', () => {
    const r = validateComment({ author: 'a'.repeat(41), body: 'Hi', website: '' });
    assert.deepEqual(r, { ok: false, error: 'author' });
  });

  it('rejects empty body', () => {
    const r = validateComment({ author: 'A', body: '   ', website: '' });
    assert.deepEqual(r, { ok: false, error: 'body' });
  });

  it('rejects body over 1000 chars', () => {
    const r = validateComment({ author: 'A', body: 'x'.repeat(1001), website: '' });
    assert.deepEqual(r, { ok: false, error: 'body' });
  });

  it('counts user-perceived chars (emoji = 1)', () => {
    const r = validateComment({ author: '🧑'.repeat(40), body: 'Hi', website: '' });
    assert.equal(r.ok, true);
  });

  it('strips control characters', () => {
    const r = validateComment({ author: 'A\x00B', body: 'ok\x1f!', website: '' });
    assert.equal(r.author, 'AB');
    assert.equal(r.body, 'ok!');
  });

  it('keeps newlines normalised', () => {
    const r = validateComment({ author: 'A', body: 'line1\r\nline2\nline3', website: '' });
    assert.equal(r.ok, true);
    assert.equal(r.body, 'line1\nline2\nline3');
  });

  it('caps consecutive newlines at 3', () => {
    const r = validateComment({ author: 'A', body: 'a\n\n\n\n\nb', website: '' });
    assert.equal(r.ok, true);
    assert.equal(r.body, 'a\n\n\nb');
  });

  it('strips zero-width characters', () => {
    const r = validateComment({ author: 'A\u200BB', body: 'hello\uFEFFworld', website: '' });
    assert.equal(r.author, 'AB');
    assert.equal(r.body, 'helloworld');
  });

  it('strips bidi characters before link check', () => {
    // U+202E (RLO) inserted into a link to evade detection
    const r = validateComment({ author: 'A', body: 'go spam\u202E.com now', website: '' });
    assert.deepEqual(r, { ok: false, error: 'links' });
  });

  describe('link detection — must flag', () => {
    it('http://x.co', () => {
      assert.deepEqual(validateComment({ author: 'A', body: 'go http://x.co now', website: '' }), { ok: false, error: 'links' });
    });
    it('www.spam.net', () => {
      assert.deepEqual(validateComment({ author: 'A', body: 'see www.spam.net ok', website: '' }), { ok: false, error: 'links' });
    });
    it('buy.cheap-pills.ru/now', () => {
      assert.deepEqual(validateComment({ author: 'A', body: 'buy.cheap-pills.ru/now', website: '' }), { ok: false, error: 'links' });
    });
    it('EXAMPLE.COM', () => {
      assert.deepEqual(validateComment({ author: 'A', body: 'visit EXAMPLE.COM please', website: '' }), { ok: false, error: 'links' });
    });
    it('spam.com with trailing dot', () => {
      assert.deepEqual(validateComment({ author: 'A', body: 'go spam.com. now', website: '' }), { ok: false, error: 'links' });
    });
    it('(spam.com) in parentheses', () => {
      assert.deepEqual(validateComment({ author: 'A', body: 'see (spam.com) here', website: '' }), { ok: false, error: 'links' });
    });
    it('spam.com, with trailing comma', () => {
      assert.deepEqual(validateComment({ author: 'A', body: 'go spam.com, ok', website: '' }), { ok: false, error: 'links' });
    });
    it('Spam.Com/x capitalised TLD with path', () => {
      assert.deepEqual(validateComment({ author: 'A', body: 'visit Spam.Com/x please', website: '' }), { ok: false, error: 'links' });
    });
  });

  describe('link detection — must NOT flag', () => {
    it('f/2.8', () => {
      assert.equal(validateComment({ author: 'A', body: 'shot at f/2.8', website: '' }).ok, true);
    });
    it('1.5 stops', () => {
      assert.equal(validateComment({ author: 'A', body: '1.5 stops underexposed', website: '' }).ok, true);
    });
    it('Nice shot.Love it', () => {
      assert.equal(validateComment({ author: 'A', body: 'Nice shot.Love it', website: '' }).ok, true);
    });
    it('3.14', () => {
      assert.equal(validateComment({ author: 'A', body: 'pi is 3.14', website: '' }).ok, true);
    });
  });
});

describe('canAcceptComment', () => {
  it('allows when fewer than 50 pending', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO photos (id, original_name, original_ext, original_sha256, created_at) VALUES (?,?,?,?,?)').run('p1', 'f', 'jpg', 'sha1', '2024-01-01T00:00:00Z');
    for (let i = 0; i < 49; i++) {
      db.prepare("INSERT INTO comments (photo_id, author, body, status, visitor, created_at) VALUES (?,?,?,?,?,?)").run('p1', 'a', 'b', 'pending', 'v' + i, '2024-01-01T00:00:00Z');
    }
    assert.equal(canAcceptComment(db), true);
  });

  it('blocks at 50 pending', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO photos (id, original_name, original_ext, original_sha256, created_at) VALUES (?,?,?,?,?)').run('p1', 'f', 'jpg', 'sha2', '2024-01-01T00:00:00Z');
    for (let i = 0; i < 50; i++) {
      db.prepare("INSERT INTO comments (photo_id, author, body, status, visitor, created_at) VALUES (?,?,?,?,?,?)").run('p1', 'a', 'b', 'pending', 'v' + i, '2024-01-01T00:00:00Z');
    }
    assert.equal(canAcceptComment(db), false);
  });

  it('ignores non-pending statuses', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO photos (id, original_name, original_ext, original_sha256, created_at) VALUES (?,?,?,?,?)').run('p1', 'f', 'jpg', 'sha3', '2024-01-01T00:00:00Z');
    for (let i = 0; i < 50; i++) {
      db.prepare("INSERT INTO comments (photo_id, author, body, status, visitor, created_at) VALUES (?,?,?,?,?,?)").run('p1', 'a', 'b', 'approved', 'v' + i, '2024-01-01T00:00:00Z');
    }
    assert.equal(canAcceptComment(db), true);
  });
});
