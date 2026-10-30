import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import sharp from 'sharp';
import { openDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { parseCaptionReply, cleanLabels, dominantColors, captionPrompt, captionNext, nextForCaption, captionDrafts, startCaptionWorker } from '../lib/captions.js';
import { recentEvents, queueStats } from '../lib/stats.js';
import { adminRoutes } from '../routes/admin.js';
import { publicRoutes } from '../routes/public.js';

const ID = 'aaaaaaaaaaaaaaaa';
const IMAGE = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#d2691e' } }).jpeg().toBuffer();
const REPLY = JSON.stringify({ title: 'Slow Water', description: 'A duck on a pond', tags: ['Duck', 'pond'], moods: ['calm', 'quiet', 'furious'], details: ['autumn', 'overcast', 'made up'] });
const apiConfig = { captionApiUrl: 'https://api.example.com/v1/', captionApiKey: 'k', captionModel: 'm' };

function setup() {
  const dataDir = join(tmpdir(), 'captions-test-' + Math.random().toString(36).slice(2));
  mkdirSync(join(dataDir, 'derived', ID), { recursive: true });
  mkdirSync(join(dataDir, 'originals'), { recursive: true });
  writeFileSync(join(dataDir, 'derived', ID, '960.jpg'), IMAGE);
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO photos (id, status, is_published, original_name, original_ext, original_sha256, created_at)
    VALUES (?, 'ready', 1, 'x.jpg', 'jpg', 'h', '2026-10-30T00:00:00Z')`).run(ID);
  return { db, dataDir };
}

const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

function makeApp({ db, dataDir }) {
  const config = {
    dataDir, port: 3000, siteUrl: 'http://localhost:3000', adminPasswordHash: hashPassword('pw'), adminUsername: 'admin',
    sessionSecret: 'test-session-secret-32chars-long!!', visitorSecret: 'v', turnstileSiteKey: '', turnstileSecret: 'x',
    trustCf: true, isProd: false, siteTitle: 'T', siteTagline: 'S', blogUrl: '',
  };
  const app = new Hono();
  app.route('/admin', adminRoutes({ db, config, dataDir }));
  app.route('/', publicRoutes({ db, config, dataDir }));
  return app;
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
  body: JSON.stringify(body || {}),
});

describe('parseCaptionReply', () => {
  it('reads JSON around thinking and code fences, and keeps several moods', () => {
    const out = parseCaptionReply('<think>{"title":"no"}</think>```json\n' + REPLY + '\n```');
    assert.deepEqual(out, { title: 'Slow Water', description: 'A duck on a pond', tags: ['duck', 'pond'], moods: ['calm', 'quiet'], details: ['autumn', 'overcast'] });
  });

  it('rejects broken JSON, a missing title and a sentence posing as a title', () => {
    assert.equal(parseCaptionReply('not json'), null);
    assert.equal(parseCaptionReply('{"description":"x"}'), null);
    assert.equal(parseCaptionReply(JSON.stringify({ title: 'one two three four five six seven' })), null);
  });

  it('drops labels that are not plain words', () => {
    assert.deepEqual(cleanLabels(['Good', '<script>', 'a'.repeat(40), 'good', 7]), ['good', '7']);
  });
});

describe('colors', () => {
  it('measures them from the pixels', async () => {
    const measured = await dominantColors(IMAGE);
    assert.deepEqual(measured.colors, ['orange']);
    assert.match(measured.palette[0], /^#[0-9a-f]{6}$/);
    const half = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#1040c0' } })
      .extend({ bottom: 32, background: '#111111' }).jpeg().toBuffer();
    assert.deepEqual((await dominantColors(half)).colors.sort(), ['black', 'blue']);
  });
});

describe('caption lane', () => {
  it('stores a draft and leaves the public caption empty', async () => {
    const { db, dataDir } = setup();
    assert.equal(await captionNext(db, dataDir, apiConfig, reply(REPLY)), true);
    const row = db.prepare('SELECT caption, caption_draft, meta FROM photos').get();
    assert.deepEqual({ ...row }, { caption: '', caption_draft: 'Slow Water', meta: null });
    assert.deepEqual(captionDrafts(db)[0].meta.colors, ['orange']);
    assert.deepEqual(captionDrafts(db)[0].meta.moods, ['calm', 'quiet']);
    assert.equal(nextForCaption(db), undefined);
  });

  it('sends the model the image, and calls the right address', async () => {
    const { db, dataDir } = setup();
    let seen;
    await captionNext(db, dataDir, apiConfig, async (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return reply(REPLY)();
    });
    assert.equal(seen.url, 'https://api.example.com/v1/chat/completions');
    assert.match(seen.body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  });

  it('gives up on a photo after three failures and logs them', async () => {
    const { db, dataDir } = setup();
    const down = async () => ({ ok: false, status: 503 });
    for (let i = 0; i < 3; i++) await assert.rejects(captionNext(db, dataDir, apiConfig, down));
    assert.equal(await captionNext(db, dataDir, apiConfig, down), false);
    assert.equal(recentEvents(db).items.length, 3);
    assert.equal(recentEvents(db).items[0].kind, 'caption_failed');
  });

  it('skips photos with a caption, dismissed ones and unfinished ones', () => {
    const { db } = setup();
    for (const sql of ["UPDATE photos SET caption = 'mine'", "UPDATE photos SET caption = '', caption_dismissed = 1", "UPDATE photos SET caption_dismissed = 0, status = 'pending'"]) {
      db.exec(sql);
      assert.equal(nextForCaption(db), undefined);
    }
  });

  it('stays off without settings', () => {
    const { db, dataDir } = setup();
    assert.equal(typeof startCaptionWorker(db, dataDir, {}), 'function');
  });
});

describe('approval', () => {
  const withDraft = () => {
    const ctx = setup();
    ctx.db.exec(`UPDATE photos SET caption_draft = 'Draft <b>text</b>', draft_meta = '{"description":"desc","tags":["duck"],"moods":["calm","quiet"],"colors":["gray"]}'`);
    ctx.app = makeApp(ctx);
    return ctx;
  };
  const row = (db) => ({ ...db.prepare('SELECT caption, caption_draft, caption_dismissed FROM photos').get() });

  it('keeps a draft off the public page until approved, with your edit', async () => {
    const { app, db } = withDraft();
    assert.doesNotMatch(await (await app.request(`/p/${ID}`)).text(), /Draft/);
    const sid = await login(app);
    assert.equal((await post(app, sid, `/admin/api/captions/${ID}`, { action: 'approve', caption: 'My edit', description: 'Seen', tags: ['Duck', '<x>'], moods: ['calm', 'quiet', 'tender'], details: ['overcast'] })).status, 200);
    assert.deepEqual(row(db), { caption: 'My edit', caption_draft: null, caption_dismissed: 0 });
    const html = await (await app.request(`/p/${ID}`)).text();
    assert.match(html, /My edit/);
    assert.match(html, /Seen/);
    for (const label of ['duck', 'calm', 'quiet', 'tender', 'overcast', 'gray']) assert.match(html, new RegExp(`/tag/${label}"`));
    assert.doesNotMatch(html, /&lt;x&gt;/);
    assert.equal((await app.request('/tag/quiet')).status, 200);
    assert.equal((await app.request('/tag/overcast')).status, 200);
    assert.match(await (await app.request('/explore')).text(), /Light and scene[\s\S]*overcast/);
    assert.equal((await app.request('/tag/nothing')).status, 404);
    assert.equal((await app.request('/tag/%3Cb%3E')).status, 404);
  });

  it('escapes drafts on the review page', async () => {
    const { app } = withDraft();
    const sid = await login(app);
    const html = await (await app.request('/admin/captions', { headers: { cookie: sid } })).text();
    assert.match(html, /Draft &lt;b&gt;text/);
    assert.match(html, /value="calm, quiet"/);
  });

  it('dismiss stops it and try again queues it', async () => {
    const { app, db } = withDraft();
    const sid = await login(app);
    await post(app, sid, `/admin/api/captions/${ID}`, { action: 'dismiss' });
    assert.deepEqual(row(db), { caption: '', caption_draft: null, caption_dismissed: 1 });
    await post(app, sid, `/admin/api/captions/${ID}`, { action: 'regenerate' });
    assert.ok(nextForCaption(db));
  });

  it('lets you edit an approved photo later and keeps its measured colors', async () => {
    const { app, db } = withDraft();
    const sid = await login(app);
    await post(app, sid, `/admin/api/captions/${ID}`, { action: 'approve', caption: 'First', description: 'One', tags: ['duck'], moods: ['calm'] });
    await post(app, sid, `/admin/api/captions/${ID}`, { action: 'approve', caption: 'Second', description: 'Two', tags: ['swan'], moods: ['quiet'], details: ['autumn'] });
    const meta = JSON.parse(db.prepare('SELECT meta FROM photos').get().meta);
    assert.deepEqual(meta, { description: 'Two', tags: ['swan'], moods: ['quiet'], details: ['autumn'], colors: ['gray'], palette: [] });
    const html = await (await app.request('/admin/captions?view=approved', { headers: { cookie: sid } })).text();
    assert.match(html, /value="Second"/);
    assert.match(html, />Save</);
    assert.doesNotMatch(html, /Approve all/);
  });

  it('refuses an empty approval and any request without a session', async () => {
    const { app, db } = withDraft();
    const sid = await login(app);
    assert.equal((await post(app, sid, `/admin/api/captions/${ID}`, { action: 'approve', caption: '  ' })).status, 400);
    assert.equal((await post(app, '', `/admin/api/captions/${ID}`, { action: 'approve', caption: 'x' })).status, 401);
    assert.equal(row(db).caption, '');
  });
});

describe('photo page before AVIF', () => {
  it('offers AVIF only once it exists', async () => {
    const ctx = setup();
    const app = makeApp(ctx);
    ctx.db.exec('UPDATE photos SET width = 480, height = 320');
    assert.doesNotMatch(await (await app.request(`/p/${ID}`)).text(), /image\/avif/);
    ctx.db.exec('UPDATE photos SET avif_ready = 1');
    assert.match(await (await app.request(`/p/${ID}`)).text(), /image\/avif/);
  });
});

describe('photo order', () => {
  it('home shows the newest shot first and arrows follow the page you came from', async () => {
    const { db, dataDir } = setup();
    db.exec("DELETE FROM photos");
    db.exec("INSERT INTO albums (id, slug, title, is_published, created_at) VALUES (1, 'a', 'A', 1, '2026-10-30')");
    const add = db.prepare(`INSERT INTO photos (id, album_id, status, is_published, original_name, original_ext, original_sha256, width, height, taken_at, published_at, created_at)
      VALUES (?, ?, 'ready', 1, 'x.jpg', 'jpg', ?, 480, 320, ?, '2026-10-30T13:10:00Z', '2026-10-30')`);
    const [oldest, middle, newest] = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
    add.run(oldest, 1, oldest, '2026-10-24T13:00:00+01:00');
    add.run(middle, null, middle, '2026-10-24T14:00:00+01:00');
    add.run(newest, 1, newest, '2026-10-24T15:00:00+01:00');
    const app = makeApp({ db, dataDir });

    const home = await (await app.request('/')).text();
    assert.ok(home.indexOf(`/p/${newest}?from=latest`) < home.indexOf(`/p/${oldest}?from=latest`));

    const fromHome = await (await app.request(`/p/${newest}?from=latest`)).text();
    assert.doesNotMatch(fromHome, /prev-btn/);
    assert.match(fromHome, new RegExp(`/p/${middle}\\?from=latest" class="photo-nav-btn next-btn`));

    const fromAlbum = await (await app.request(`/p/${newest}`)).text();
    assert.doesNotMatch(fromAlbum, /prev-btn/);
    assert.match(fromAlbum, new RegExp(`/p/${oldest}" class="photo-nav-btn next-btn`));
  });
});

describe('static files', () => {
  it('are linked by content hash, so no cache can serve an old one', async () => {
    const app = makeApp(setup());
    assert.match(await (await app.request('/albums')).text(), /site\.css\?v=[0-9a-f]{10}/);
    assert.match(await (await app.request('/admin/login')).text(), /admin\.css\?v=[0-9a-f]{10}/);
  });

  it('revalidate, so a deploy shows at once', async () => {
    const app = makeApp(setup());
    const res = await app.request('/static/admin.css');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const again = await app.request('/static/admin.css', { headers: { 'if-none-match': res.headers.get('etag') } });
    assert.equal(again.status, 304);
  });
});

describe('job list', () => {
  it('comes from the server, so a page refresh keeps it', () => {
    const { db } = setup();
    db.exec("UPDATE photos SET status = 'pending'");
    assert.deepEqual(queueStats(db).jobs.map((j) => [j.original_name, j.status]), [['x.jpg', 'pending']]);
  });
});
