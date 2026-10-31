import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import sharp from 'sharp';
import { openDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { blurAreas, ingest, processPhoto, encodeAvif } from '../lib/images.js';
import { privacyView } from '../views/admin.js';
import { cleanBoxes, parseScanReply, scanPhoto, reviewPhoto, privacyList } from '../lib/privacy.js';
import { aiCalls, aiEnabled, getSetting, setSetting } from '../lib/settings.js';
import { startWorker } from '../lib/worker.js';
import { startCaptionWorker } from '../lib/captions.js';
import { adminRoutes } from '../routes/admin.js';
import { publicRoutes } from '../routes/public.js';

const api = { captionApiUrl: 'https://api.example.com/v1', captionApiKey: 'k', captionModel: 'm' };
const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const CHECKER = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ffffff' } })
  .composite([{ input: await sharp({ create: { width: 40, height: 40, channels: 3, background: '#000000' } }).png().toBuffer(), left: 100, top: 100 }])
  .jpeg({ quality: 95 }).toBuffer();

function setup() {
  const dataDir = join(tmpdir(), 'privacy-test-' + Math.random().toString(36).slice(2));
  mkdirSync(join(dataDir, 'originals'), { recursive: true });
  mkdirSync(join(dataDir, 'derived'), { recursive: true });
  const db = openDb(':memory:');
  const config = {
    dataDir, port: 3000, siteUrl: 'http://localhost:3000', adminPasswordHash: hashPassword('pw'), adminUsername: 'admin',
    sessionSecret: 'test-session-secret-32chars-long!!', visitorSecret: 'v', turnstileSiteKey: '', turnstileSecret: 'x',
    trustCf: true, isProd: false, siteTitle: 'T', siteTagline: 'S', blogUrl: '',
  };
  const app = new Hono();
  app.route('/admin', adminRoutes({ db, config, dataDir }));
  app.route('/', publicRoutes({ db, config, dataDir }));
  return { db, dataDir, app };
}

async function login(app) {
  const res = await app.request('/admin/login', {
    method: 'POST',
    body: new URLSearchParams({ username: 'admin', password: 'pw' }),
    headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '9.9.9.9' },
  });
  return res.headers.get('set-cookie').match(/sid=[^;]+/)[0];
}

const post = (app, sid, path, body) => app.request(path, {
  method: 'POST',
  headers: { origin: 'http://localhost:3000', cookie: sid, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const until = async (check) => {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail('timed out');
};

async function pixelAt(path, x, y) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
  return data[i];
}

describe('scan replies', () => {
  it('turns model boxes into padded 0 to 1 boxes', () => {
    const [box] = parseScanReply('```json\n{"items":[{"type":"face","box":[100,100,200,300]}]}\n```');
    assert.equal(box.type, 'face');
    assert.ok(Math.abs(box.x1 - 0.085) < 1e-9);
    assert.ok(Math.abs(box.y2 - 0.33) < 1e-9);
    assert.equal(box.blur, true);
  });

  it('accepts no findings and rejects a broken answer', () => {
    assert.deepEqual(parseScanReply('{"items":[]}'), []);
    assert.equal(parseScanReply('no idea'), null);
  });

  it('reads the other shapes the model answers in', () => {
    const boxes = parseScanReply('```json\n[\n\t{"bbox_2d": [0, 31, 17, 62], "type": "face"},\n\t{"bbox_2d": [5, 955, 180, 989], "type": "plate"}\n]\n```');
    assert.deepEqual(boxes.map((b) => b.type), ['face', 'plate']);
    assert.deepEqual(parseScanReply('```json\n[]\n```'), []);
  });

  it('drops invalid boxes and keeps others inside the image', () => {
    const out = cleanBoxes([{ x1: 0.5, y1: 0.5, x2: 0.2, y2: 0.9 }, { x1: 'x' }, null, { type: 'evil', x1: -1, y1: 0, x2: 2, y2: 0.5 }]);
    assert.deepEqual(out, [{ type: 'manual', x1: 0, y1: 0, x2: 1, y2: 0.5, blur: true }]);
  });
});

describe('blur', () => {
  it('is baked into every format and size, and the original is untouched', async () => {
    const { db, dataDir } = setup();
    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg');
    db.prepare('UPDATE photos SET privacy_boxes = ? WHERE id = ?').run(JSON.stringify([{ type: 'face', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.25, blur: true }]), id);
    await processPhoto(db, dataDir, id);
    await encodeAvif(db, dataDir, id);
    for (const file of ['480.jpg', '480.webp', '480.avif', '800.jpg']) {
      const scale = file.startsWith('480') ? 0.6 : 1;
      const value = await pixelAt(join(dataDir, 'derived', id, file), 120 * scale, 120 * scale);
      assert.ok(value > 40, `${file} still shows the dark square (${value})`);
    }
    assert.ok(await pixelAt(join(dataDir, 'originals', `${id}.jpg`), 120, 120) < 30);
  });

  it('skips a box you turned off', async () => {
    const { db, dataDir } = setup();
    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg');
    db.prepare('UPDATE photos SET privacy_boxes = ? WHERE id = ?').run(JSON.stringify([{ type: 'face', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.25, blur: false }]), id);
    await processPhoto(db, dataDir, id);
    assert.ok(await pixelAt(join(dataDir, 'derived', id, '800.jpg'), 120, 120) < 30);
  });
});

describe('publishing gate', () => {
  async function published() {
    const ctx = setup();
    const { id } = await ingest(ctx.db, ctx.dataDir, CHECKER, 'a.jpg');
    await processPhoto(ctx.db, ctx.dataDir, id);
    ctx.db.prepare('UPDATE photos SET is_published = 1 WHERE id = ?').run(id);
    return { ...ctx, id };
  }

  it('keeps a new photo off every public path until reviewed', async () => {
    const { app, db, id } = await published();
    assert.equal((await app.request(`/p/${id}`)).status, 404);
    assert.equal((await app.request(`/img/${id}/480.jpg`)).status, 404);
    assert.doesNotMatch(await (await app.request('/')).text(), new RegExp(id));
    reviewPhoto(db, id, []);
    assert.equal((await app.request(`/p/${id}`)).status, 200);
    assert.equal((await app.request(`/img/${id}/480.jpg`)).status, 200);
  });

  it('a changed blur re-encodes under a new image address, an unchanged one does not', async () => {
    const { app, db, dataDir, id } = await published();
    reviewPhoto(db, id, []);
    assert.equal(db.prepare('SELECT image_version FROM photos').get().image_version, 0);
    reviewPhoto(db, id, [{ type: 'manual', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.25 }]);
    assert.deepEqual({ ...db.prepare('SELECT image_version, status FROM photos').get() }, { image_version: 1, status: 'pending' });
    await processPhoto(db, dataDir, id);
    assert.match(await (await app.request(`/p/${id}`)).text(), /480\.jpg\?v=1/);
    reviewPhoto(db, id, [{ type: 'manual', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.25 }]);
    assert.equal(db.prepare('SELECT image_version FROM photos').get().image_version, 1);
  });

  it('fades the edge outside the box and keeps the inside fully covered', async () => {
    const raw = { width: 400, height: 300, channels: 3 };
    const before = Buffer.alloc(400 * 300 * 3);
    for (let i = 0; i < before.length; i += 3) before.fill((i / 3) % 2 ? 255 : 0, i, i + 3);
    const { data, info } = await blurAreas(before, raw, [{ x1: 0.25, y1: 1 / 3, x2: 0.5, y2: 0.6 }]);
    assert.equal(info.channels, 3);
    const at = (buf, x, y) => buf[(y * 400 + x) * 3];

    const inside = [];
    for (let y = 100; y < 180; y += 1) for (let x = 100; x < 200; x += 1) inside.push(at(data, x, y));
    assert.ok(Math.max(...inside) - Math.min(...inside) < 40);

    // 28 pixels of fade: part way there the stripes show at reduced contrast, past it they are untouched
    const stripes = (buf, x, y) => Math.abs(at(buf, x, y) - at(buf, x + 1, y));
    assert.ok(stripes(data, 90, 140) > 40 && stripes(data, 90, 140) < 215);
    assert.equal(stripes(data, 70, 140), 255);
    assert.equal(at(data, 300, 250), at(before, 300, 250));
  });

  it('bakes a blur as small as a few pixels', async () => {
    const { db, dataDir, id } = await published();
    reviewPhoto(db, id, [{ type: 'manual', x1: 0.5, y1: 0.5, x2: 0.501, y2: 0.501 }]);
    await processPhoto(db, dataDir, id);
    assert.equal(db.prepare('SELECT status FROM photos').get().status, 'ready');
  });

  it('never serves the review copy publicly, and needs a session in the admin', async () => {
    const { app, id } = await published();
    assert.equal((await app.request(`/previews/${id}.jpg`)).status, 404);
    assert.equal((await app.request(`/admin/preview/${id}`, { headers: { 'cf-connecting-ip': '1.1.1.1' } })).status, 302);
  });

  it('makes the enlarged copy from the original, never stores it, and needs a session', async () => {
    const { app, db, dataDir } = setup();
    const sid = await login(app);
    const big = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: '#556677' } }).jpeg().toBuffer();
    const { id } = await ingest(db, dataDir, big, 'big.jpg');
    const get = (path, cookie = sid) => app.request(path, { headers: { cookie, 'cf-connecting-ip': '1.1.1.1' } });

    assert.equal((await get(`/admin/preview/${id}/large`, '')).status, 302);
    assert.equal((await get('/admin/preview/0000000000000000/large')).status, 404);
    assert.equal((await get('/admin/preview/nope/large')).status, 404);

    const res = await get(`/admin/preview/${id}/large`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { width, height } = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.deepEqual([width, height], [3200, 1600]);
    assert.ok(!existsSync(join(dataDir, 'previews', `${id}-large.jpg`)));
  });
});

describe('re-encoding races', () => {
  it('drops the old AVIF and does not let a stale encode go ready', async () => {
    const { db, dataDir } = setup();
    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg');
    await processPhoto(db, dataDir, id);
    await encodeAvif(db, dataDir, id);
    const file = join(dataDir, 'derived', id, '480.avif');
    assert.ok(existsSync(file));

    reviewPhoto(db, id, [{ type: 'manual', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.25 }]);
    const run = processPhoto(db, dataDir, id);
    reviewPhoto(db, id, [{ type: 'manual', x1: 0.5, y1: 0.5, x2: 0.6, y2: 0.6 }]);
    await run;
    assert.equal(existsSync(file), false);
    assert.equal(db.prepare('SELECT status FROM photos').get().status, 'pending');
  });

  it('keeps boxes you drew when the AI scans again', async () => {
    const { db, dataDir } = setup();
    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg');
    reviewPhoto(db, id, [{ type: 'manual', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.25 }]);
    const boxes = await scanPhoto(db, dataDir, api, id, reply('{"items":[{"type":"face","box":[500,500,600,600]}]}'));
    assert.deepEqual(boxes.map((b) => b.type), ['face', 'manual']);
  });
});

describe('album description', () => {
  it('saves and shows on the public album page', async () => {
    const { app, db } = setup();
    const sid = await login(app);
    db.prepare("INSERT INTO albums (id, slug, title, description, position, is_published, created_at) VALUES (1, 'a', 'A', '', 0, 1, 'now')").run();
    const res = await app.request('/admin/api/albums/1', {
      method: 'PATCH',
      headers: { origin: 'http://localhost:3000', cookie: sid, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Autumn walks' }),
    });
    assert.equal(res.status, 200);
    assert.match(await (await app.request('/admin/albums', { headers: { cookie: sid } })).text(), />Autumn walks<\/textarea>/);
    assert.match(await (await app.request('/a/a')).text(), /Autumn walks/);
  });
});

describe('publishing an album', () => {
  it('publishes its ready photos, which still wait for privacy', async () => {
    const { app, db, dataDir } = setup();
    const sid = await login(app);
    db.prepare("INSERT INTO albums (id, slug, title, description, position, is_published, created_at) VALUES (1, 'a', 'A', '', 0, 0, 'now')").run();
    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg', { albumId: 1 });
    await processPhoto(db, dataDir, id);

    assert.match(await (await app.request('/admin/albums', { headers: { cookie: sid } })).text(), /Publish all 1/);
    const res = await post(app, sid, '/admin/api/albums/1/publish', {});
    assert.equal((await res.json()).changed, 1);
    assert.equal(db.prepare('SELECT is_published FROM albums').get().is_published, 1);
    assert.equal((await app.request(`/p/${id}`)).status, 404);
    assert.match(await (await app.request('/admin/albums', { headers: { cookie: sid } })).text(), /1 waiting for privacy/);

    reviewPhoto(db, id, []);
    assert.equal((await app.request(`/p/${id}`)).status, 200);
    assert.equal((await post(app, '', '/admin/api/albums/1/publish', {})).status, 401);
  });
});

describe('AI switches', () => {
  it('sends nothing to the API while off, and picks photos up when turned on', async () => {
    const { db, dataDir } = setup();
    let calls = 0;
    const fetchFn = async () => { calls += 1; return reply('{"items":[{"type":"plate","box":[100,100,200,200]}]}')(); };
    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg');
    const stop = startWorker(db, dataDir, { intervalMs: 20, config: api, fetchFn });
    await until(() => db.prepare('SELECT status FROM photos').get().status === 'ready');
    assert.equal(calls, 0);
    assert.equal(db.prepare('SELECT privacy_scan FROM photos').get().privacy_scan, 'new');

    setSetting(db, 'ai_privacy', '1');
    await until(() => db.prepare('SELECT image_version FROM photos').get().image_version === 1);
    stop();
    assert.equal(calls, 1);
    assert.equal(db.prepare('SELECT privacy_scan FROM photos').get().privacy_scan, 'done');
    assert.equal(db.prepare('SELECT privacy_ok FROM photos').get().privacy_ok, 0);
    assert.deepEqual(aiCalls(db, 'privacy'), { today: 1, month: 1 });
    assert.ok(existsSync(join(dataDir, 'previews', `${id}.jpg`)));
  });

  it('keeps encoding when the AI is down and still holds the photo back', async () => {
    const { db, dataDir } = setup();
    setSetting(db, 'ai_privacy', '1');
    await ingest(db, dataDir, CHECKER, 'a.jpg');
    const stop = startWorker(db, dataDir, { intervalMs: 20, config: api, fetchFn: async () => ({ ok: false, status: 503 }) });
    await until(() => db.prepare('SELECT status FROM photos').get().status === 'ready');
    stop();
    const row = db.prepare('SELECT privacy_ok, privacy_scan, privacy_attempts FROM photos').get();
    assert.deepEqual({ ...row }, { privacy_ok: 0, privacy_scan: 'new', privacy_attempts: 1 });
  });

  it('one bad answer does not hold up the rest of the queue', async () => {
    const { db, dataDir } = setup();
    setSetting(db, 'ai_privacy', '1');
    const good = await ingest(db, dataDir, CHECKER, 'a.jpg');
    const bad = await ingest(db, dataDir, Buffer.concat([CHECKER, Buffer.from([0])]), 'b.jpg');
    await processPhoto(db, dataDir, good.id);
    await processPhoto(db, dataDir, bad.id);
    let calls = 0;
    const fetchFn = async () => { calls += 1; return reply(calls === 1 ? 'no idea' : '{"items":[]}')(); };
    const stop = startWorker(db, dataDir, { intervalMs: 20, config: api, fetchFn });
    await until(() => db.prepare("SELECT COUNT(*) AS n FROM photos WHERE privacy_scan = 'done'").get().n === 2);
    stop();
  });

  it('treats a cut-off reply as failed, so it cannot look like a finished scan', async () => {
    const { db, dataDir } = setup();
    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg');
    const fetchFn = async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"items":[{"type":"face","box":[1,2,30,40]},' } }] }) });
    await assert.rejects(scanPhoto(db, dataDir, api, id, fetchFn), (err) => err.badAnswer);
    assert.equal(db.prepare('SELECT privacy_scan FROM photos').get().privacy_scan, 'new');
  });

  it('never scans a photo you approved, even when your blur re-encodes it', async () => {
    const { db, dataDir } = setup();
    setSetting(db, 'ai_privacy', '1');
    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg');
    await processPhoto(db, dataDir, id);
    reviewPhoto(db, id, [{ type: 'manual', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.25 }]);
    let calls = 0;
    const stop = startWorker(db, dataDir, { intervalMs: 20, config: api, fetchFn: async () => { calls += 1; return reply('{"items":[]}')(); } });
    await until(() => db.prepare('SELECT status FROM photos').get().status === 'ready');
    await new Promise((r) => setTimeout(r, 100));
    stop();
    assert.equal(calls, 0);
  });

  it('marks a photo for hand review after three failed scans', async () => {
    const { db, dataDir } = setup();
    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg');
    for (let i = 0; i < 3; i++) await assert.rejects(scanPhoto(db, dataDir, api, id, reply('nope')));
    assert.equal(db.prepare('SELECT privacy_scan FROM photos').get().privacy_scan, 'failed');
    assert.equal(privacyList(db, { reviewed: false }).length, 1);
  });

  it('the caption switch stops its worker too', async () => {
    const { db, dataDir } = setup();
    setSetting(db, 'ai_captions', '0');
    assert.equal(aiEnabled(db, api, 'ai_captions'), false);
    assert.equal(aiEnabled(db, api, 'ai_privacy'), false);
    setSetting(db, 'ai_privacy', '1');
    assert.equal(aiEnabled(db, api, 'ai_privacy'), true);
    assert.equal(aiEnabled(db, {}, 'ai_privacy'), false);
    const stop = startCaptionWorker(db, dataDir, api, { intervalMs: 5 });
    stop();
  });

  it('review pages render with photos in them', async () => {
    const { app, db, dataDir } = setup();
    const sid = await login(app);
    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg');
    await processPhoto(db, dataDir, id);
    db.prepare("UPDATE photos SET caption_draft = 'Draft' WHERE id = ?").run(id);
    for (const path of ['/admin/privacy', '/admin/privacy?view=reviewed', '/admin/captions', '/admin/captions?view=approved', '/admin/photos', '/admin/albums', '/admin/settings', '/admin/stats', '/admin/comments']) {
      assert.equal((await app.request(path, { headers: { cookie: sid } })).status, 200, path);
    }
    const page = await (await app.request('/admin/privacy', { headers: { cookie: sid } })).text();
    assert.ok(page.includes('a.jpg'));
    assert.ok(!page.includes('data-privacy-action="rescan"'), 'no rescan button while the scan is off');

    const list = privacyList(db, { reviewed: false });
    assert.ok(privacyView(list, { aiOn: true, reviewed: false }).includes('data-privacy-action="rescan"'));
  });

  it('settings page loads and the preview tries an opacity without saving it', async () => {
    const { app, db, dataDir } = setup();
    const sid = await login(app);
    const get = (path, cookie = sid) => app.request(path, { headers: { cookie } });
    assert.equal((await get('/admin/settings')).status, 200);
    assert.equal((await get('/admin/watermark-preview')).status, 404);

    writeFileSync(join(dataDir, 'watermark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100" width="400" height="100"><rect width="400" height="100" fill="#fff"/></svg>');
    assert.equal((await get('/admin/watermark-preview')).status, 404);

    const { id } = await ingest(db, dataDir, CHECKER, 'a.jpg');
    await processPhoto(db, dataDir, id);
    const image = async (query) => {
      const res = await get(`/admin/watermark-preview?${query}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      return Buffer.from(await res.arrayBuffer());
    };
    assert.ok(!(await image('opacity=1')).equals(await image('opacity=100')));
    assert.ok((await image('opacity=0')).equals(await image('')), 'out of range falls back to the saved value');
    assert.ok((await image('photo=7')).length > 0);
    assert.equal(getSetting(db, 'watermark_opacity'), '35');
    assert.equal((await get('/admin/watermark-preview', '')).status, 302);
  });

  it('switch route accepts only known settings and needs a session', async () => {
    const { app, db } = setup();
    const sid = await login(app);
    assert.equal((await post(app, sid, '/admin/api/settings', { key: 'ai_privacy', value: false })).status, 200);
    assert.equal(getSetting(db, 'ai_privacy'), '0');
    assert.equal((await post(app, sid, '/admin/api/settings', { key: 'admin', value: true })).status, 400);
    assert.equal((await post(app, sid, '/admin/api/settings', { key: 'watermark_opacity', value: 25 })).status, 200);
    assert.equal(getSetting(db, 'watermark_opacity'), '25');
    for (const value of [0, 101, 40.5, '40', true]) {
      assert.equal((await post(app, sid, '/admin/api/settings', { key: 'watermark_opacity', value })).status, 400);
    }
    assert.equal((await post(app, '', '/admin/api/settings', { key: 'ai_privacy', value: true })).status, 401);
    assert.equal((await app.request('/admin/privacy', { headers: { cookie: sid } })).status, 200);
  });
});
