import { escapeHtml } from './html.js';
import { assets } from '../lib/assets.js';

export const IMG_ID_RE = /^[a-f0-9]{16}$/;
export const IMG_FILE_RE = /^(\d+)\.(avif|webp|jpg)$/;

const queuePanel = `<section id="queue-panel" class="queue-panel hidden" aria-live="polite">
  <div class="queue-head"><strong id="queue-title"></strong><span id="queue-detail"></span></div>
  <div class="progress"><div class="progress-bar" id="queue-bar"></div></div>
</section>`;

const EVENT_LABELS = {
  login_failed: 'Failed login',
  login_blocked: 'Login blocked',
  comment_blocked: 'Comment blocked',
  upload_failed: 'Upload failed',
  photo_failed: 'Processing failed',
  server_error: 'Server error',
  caption_failed: 'Caption failed',
  avif_failed: 'AVIF failed',
  privacy_failed: 'Privacy scan failed',
};

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function statCard(label, value, note = '') {
  return `<div class="stat-card"><span class="stat-label">${escapeHtml(label)}</span><strong class="stat-value">${escapeHtml(String(value))}</strong>${note ? `<span class="stat-note">${escapeHtml(note)}</span>` : ''}</div>`;
}

function statList(title, rows, empty) {
  const items = rows.map(([label, value]) => `<li><span>${escapeHtml(label)}</span><strong>${value}</strong></li>`).join('');
  return `<div class="stat-list"><h2>${escapeHtml(title)}</h2>${items ? `<ol>${items}</ol>` : `<p>${escapeHtml(empty)}</p>`}</div>`;
}

function settingSwitch(key, on, label, note = '') {
  return `<div class="ai-panel">
  <label class="ai-switch"><span class="switch"><input type="checkbox" data-setting="${escapeHtml(key)}"${on ? ' checked' : ''}><span></span></span> ${escapeHtml(label)}</label>
  ${note ? `<span class="ai-calls">${escapeHtml(note)}</span>` : ''}
</div>`;
}

function aiStatus(on, label) {
  return `<p class="ai-panel"><span>${escapeHtml(label)} ${on ? 'on' : 'off'}</span><a href="/admin/settings">Settings</a></p>`;
}

function nav(pendingCount = 0) {
  return `<nav class="admin-nav">
  <a href="/admin">Upload</a>
  <a href="/admin/photos">Photos</a>
  <a href="/admin/albums">Albums</a>
  <a href="/admin/comments">Comments${pendingCount ? ` <span class="badge">${pendingCount}</span>` : ''}</a>
  <a href="/admin/captions">Captions</a>
  <a href="/admin/privacy">Privacy</a>
  <a href="/admin/stats">Stats</a>
  <a href="/admin/settings">Settings</a>
  <form method="POST" action="/admin/logout" class="inline-form"><button type="submit" class="btn btn-sm">Logout</button></form>
</nav>`;
}

export function loginView(msg) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login</title><link rel="stylesheet" href="${assets.adminCss}"></head>
<body class="admin-body"><div class="login-wrap">
<h1>Sign in</h1>
${msg ? `<p class="alert">${escapeHtml(msg)}</p>` : ''}
<form method="POST" action="/admin/login">
  <label for="user">Username</label>
  <input type="text" id="user" name="username" maxlength="100" autocomplete="username" required>
  <label for="pw">Password</label>
  <input type="password" id="pw" name="password" maxlength="200" autocomplete="current-password" required>
  <button type="submit" class="btn">Sign in</button>
</form>
</div></body></html>`;
}

export function adminView(albums, pendingCount = 0) {
  const opts = albums.map(a => `<option value="${a.id}">${escapeHtml(a.title)}</option>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload</title><link rel="stylesheet" href="${assets.adminCss}"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main">
<h1>Upload Photos</h1>
${queuePanel}
<div class="upload-controls">
  <select id="album-select"><option value="">No album</option>${opts}<option value="__new">New album…</option></select>
  <input type="text" id="new-album-name" placeholder="Album name" class="hidden">
</div>
<div id="dropzone" class="dropzone"><p>Drop photos here, or tap to choose</p></div>
<input type="file" id="file-input" accept="image/*" multiple class="hidden">
<div id="upload-list"></div>
<div id="job-list"></div>
</main>
<script src="${assets.adminJs}" defer></script>
</body></html>`;
}

export function photosView(photos, albums, filters, pendingCount = 0) {
  const albumOpts = albums.map(a =>
    `<option value="${a.id}"${filters.albumId == a.id ? ' selected' : ''}>${escapeHtml(a.title)}</option>`
  ).join('');
  const rows = photos.map(p => `
    <div class="photo-card" data-id="${escapeHtml(p.id)}" data-status="${escapeHtml(p.status)}" data-published="${p.is_published}">
      <div class="photo-thumb">${p.status === 'ready' && p.width ? `<img src="/admin/img/${escapeHtml(p.id)}/480.webp" alt="" loading="lazy">` : '<span class="ph-thumb">no preview</span>'}</div>
      <div class="photo-meta">
        <span class="badge badge-${escapeHtml(p.status)}">${escapeHtml(p.status)}</span>
        ${p.is_published ? (p.privacy_ok ? '<span class="badge badge-live">live</span>' : '<span class="badge badge-pending">waiting for privacy</span>') : ''}
        ${p.album_title ? `<span class="album-tag">${escapeHtml(p.album_title)}</span>` : ''}
        <input class="caption-input" data-id="${escapeHtml(p.id)}" value="${escapeHtml(p.caption)}" placeholder="Add caption…" maxlength="5000">
      </div>
    </div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Photos</title><link rel="stylesheet" href="${assets.adminCss}"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main">
<h1>Photos</h1>
<div class="filters">
  <label><input type="checkbox" id="select-all"> Select all</label>
  <label><input type="checkbox" id="filter-unpub" ${filters.unpublished ? 'checked' : ''}> Unpublished only</label>
  <label>Album: <select id="filter-album"><option value="">All</option>${albumOpts}</select></label>
  <button class="btn btn-sm" id="filter-apply">Apply</button>
</div>
<div class="action-bar hidden" id="action-bar">
  <span id="sel-count"></span>
  <button class="btn btn-sm" data-action="publish">Publish</button>
  <button class="btn btn-sm" data-action="unpublish">Unpublish</button>
  <button class="btn btn-sm" data-action="move">Move to…</button>
  <select id="move-album-select"><option value="">—</option>${albums.map(a=>`<option value="${a.id}">${escapeHtml(a.title)}</option>`).join('')}<option value="null">No album</option></select>
  <button class="btn btn-sm btn-danger" data-action="delete">Delete</button>
</div>
<div class="photo-grid">${rows || '<p>No photos yet.</p>'}</div>
</main>
<script src="${assets.adminJs}" defer></script>
</body></html>`;
}

export function albumsView(albums, pendingCount = 0) {
  const items = albums.map(a => `
    <tr data-id="${a.id}">
      <td><input class="album-title" value="${escapeHtml(a.title)}" data-field="title" maxlength="200"></td>
      <td class="album-desc-cell">
        <textarea class="album-desc" data-field="description" rows="3" maxlength="2000" aria-label="Description">${escapeHtml(a.description)}</textarea>
        <span class="album-save-state" role="status"></span>
      </td>
      <td class="album-count">${a.live_count} of ${a.photo_count} live${a.waiting_count ? `<a href="/admin/privacy">${a.waiting_count} waiting for privacy</a>` : ''}</td>
      <td><label class="switch"><input type="checkbox" data-field="is_published" ${a.is_published ? 'checked' : ''}><span></span></label></td>
      <td>${escapeHtml(a.cover_photo_id || '—')}</td>
      <td>
        ${a.unpublished_count ? `<button class="btn btn-sm btn-publish-album">Publish all ${a.unpublished_count}</button>` : ''}
        <button class="btn btn-sm btn-set-cover">Set cover</button>
        <button class="btn btn-sm btn-danger btn-del-album">Delete</button>
      </td>
    </tr>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Albums</title><link rel="stylesheet" href="${assets.adminCss}"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main">
<h1>Albums</h1>
<form id="create-album-form" class="inline-form">
  <input type="text" id="new-title" placeholder="Album title" required maxlength="200">
  <button type="submit" class="btn btn-sm">Create</button>
</form>
<table class="admin-table">
<thead><tr><th>Title</th><th>Description</th><th>Photos</th><th>Published</th><th>Cover</th><th></th></tr></thead>
<tbody>${items}</tbody>
</table>
</main>
<script src="${assets.adminJs}" defer></script>
</body></html>`;
}

export function commentsView(pending, all) {
  const pendingCount = pending.length;
  const item = (c, showActions) => `
    <div class="comment-item" data-id="${c.id}">
      <div class="comment-thumb">${c.pid ? `<img src="/admin/img/${escapeHtml(c.pid)}/480.webp" alt="" loading="lazy">` : '<span>?</span>'}</div>
      <div class="comment-body">
        <strong>${escapeHtml(c.author)}</strong>
        <p>${escapeHtml(c.body)}</p>
        <small>${escapeHtml(c.created_at)}</small>
      </div>
      ${showActions ? `<div class="comment-actions">
        <button class="btn btn-sm btn-approve" data-id="${c.id}">Approve</button>
        <button class="btn btn-sm" data-id="${c.id}">Reject</button>
        <button class="btn btn-sm btn-danger btn-delete-comment" data-id="${c.id}">Delete</button>
      </div>` : `<span class="badge">${escapeHtml(c.status)}</span>`}
    </div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comments</title><link rel="stylesheet" href="${assets.adminCss}"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main">
<h1>Comments</h1>
<h2>Pending (${pendingCount})</h2>
<div id="pending-list">${pending.map(c => item(c, true)).join('') || '<p>No pending comments.</p>'}</div>
<h2>Other</h2>
<div id="all-list">${all.map(c => item(c, false)).join('') || '<p>None.</p>'}</div>
</main>
<script src="${assets.adminJs}" defer></script>
</body></html>`;
}

function siteRow(label, value) {
  return value ? `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>` : '';
}

export function settingsView({ switches, watermark, ai, site }, pendingCount = 0) {
  const calls = ({ today, month }) => `${today} AI calls today \u00b7 ${month} this month`;
  const rebuild = 'Changing this rebuilds your photos one at a time';
  const waterStatus = !watermark.hasFile
    ? '<p class="settings-note">No watermark file yet. Put a transparent SVG at <code>data/watermark.svg</code> to sign your photos.</p>'
    : switches.watermark_on ? `<p class="settings-note">${watermark.done} of ${watermark.total} photos have the current watermark.</p>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Settings</title><link rel="stylesheet" href="${assets.adminCss}"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main">
<h1>Settings</h1>
${site.testKeys ? '<p class="settings-warning">Bot protection is using test keys, so it lets everything through. Add your own TURNSTILE_SITE_KEY and TURNSTILE_SECRET.</p>' : ''}
<h2>Watermark</h2>
${watermark.hasFile ? `${settingSwitch('watermark_on', switches.watermark_on, 'Sign public photos', rebuild)}
${settingSwitch('watermark_exif', switches.watermark_exif, 'Camera settings under the signature', rebuild)}
<div class="ai-panel">
  <label class="ai-switch">Opacity <input type="range" min="10" max="100" step="5" value="${watermark.opacity}" data-number-setting="watermark_opacity"> <output>${watermark.opacity}%</output></label>
  <span class="ai-calls">${rebuild}</span>
</div>` : ''}
${waterStatus}
<h2>AI</h2>
${ai.configured ? `<p class="settings-note">Model: ${escapeHtml(ai.model)}. Turned-on features send your photos to this API.</p>
${settingSwitch('ai_captions', switches.ai_captions, 'Draft titles and descriptions', calls(ai.captions))}
${settingSwitch('ai_privacy', switches.ai_privacy, 'Scan for faces and license plates', calls(ai.privacy))}` : '<p class="settings-note">AI is not set up. Add CAPTION_API_URL, CAPTION_API_KEY and CAPTION_MODEL to turn it on.</p>'}
<h2>Visitors</h2>
${settingSwitch('comments_on', switches.comments_on, 'Accept comments', 'Approved comments stay visible when this is off')}
${settingSwitch('likes_on', switches.likes_on, 'Show likes', 'Counts are kept when this is off')}
${settingSwitch('full_size_on', switches.full_size_on, 'Show the Full size link', 'Hides the link only, images stay as they are')}
<h2>Site</h2>
<p class="settings-note">These come from your .env file.</p>
<dl class="settings-site">
${siteRow('Title', site.title)}
${siteRow('Tagline', site.tagline)}
${siteRow('Address', site.url)}
${siteRow('Blog', site.blog)}
</dl>
</main>
<script src="${assets.adminJs}" defer></script>
</body></html>`;
}

export function statsView({ library, traffic, events, storage }, pendingCount = 0) {
  const peak = Math.max(1, ...traffic.days.map(d => d.views));
  const bars = traffic.days.map(d => `<div class="day-bar" title="${escapeHtml(d.day)}: ${d.views} views"><span style="height:${Math.round((d.views / peak) * 100)}%"></span><small>${escapeHtml(d.day.slice(8))}</small></div>`).join('');
  const photoRows = traffic.photos.map(p => `
    <tr>
      <td class="stats-thumb">${p.status === 'ready' ? `<img src="/admin/img/${escapeHtml(p.id)}/480.webp" alt="" loading="lazy">` : ''}</td>
      <td><a href="/p/${escapeHtml(p.id)}">${escapeHtml(p.caption || p.original_name)}</a><small>${escapeHtml(p.album_title || 'No album')}</small></td>
      <td>${p.views}</td><td>${p.likes}</td><td>${p.comments}</td>
    </tr>`).join('');
  const failed = library.failed.map(p => `<li><span>${escapeHtml(p.original_name)}</span><small>${escapeHtml(p.error || 'Unknown error')}</small></li>`).join('');
  const eventRows = events.items.map(e => `
    <tr>
      <td>${escapeHtml(e.at.slice(0, 16).replace('T', ' '))}</td>
      <td>${escapeHtml(EVENT_LABELS[e.kind] || e.kind)}</td>
      <td>${escapeHtml(e.detail)}</td>
    </tr>`).join('');
  const eventCounts = events.counts.map(e => `<span class="badge">${escapeHtml(EVENT_LABELS[e.kind] || e.kind)}: ${e.n}</span>`).join(' ');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stats</title><link rel="stylesheet" href="${assets.adminCss}"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main stats-page">
<h1>Stats</h1>
${queuePanel}
<h2>Library</h2>
<div class="stat-grid">
  ${statCard('Published', library.published)}
  ${statCard('Unpublished', library.unpublished)}
  ${statCard('Albums', library.albums)}
  ${statCard('Likes', library.likes)}
  ${statCard('Comments', library.commentsApproved, `${library.commentsPending} waiting`)}
  ${statCard('Originals', formatBytes(storage.originals))}
  ${statCard('Web sizes', formatBytes(storage.derived))}
  ${statCard('Disk free', formatBytes(storage.free))}
</div>
${failed ? `<h2>Failed photos</h2><ul class="failed-list">${failed}</ul>` : ''}
<h2>Traffic</h2>
<div class="stat-grid">
  ${statCard('Views today', traffic.viewsToday, `${traffic.visitorsToday} visitors`)}
  ${statCard('Last 7 days', traffic.views7, `${traffic.visitors7} visitors`)}
  ${statCard('Last 30 days', traffic.views30, `${traffic.visitors30} visitors`)}
</div>
<div class="day-bars" aria-label="Views per day, last 14 days">${bars}</div>
<p class="stats-note">One view per visitor, page and day. Bots and your own browser are left out, and no IP addresses are stored. Visitors are counted once a day, so totals can include the same person on different days.</p>
<h2>Top photos, last 30 days</h2>
${photoRows ? `<div class="stats-scroll"><table class="stats-table"><thead><tr><th></th><th>Photo</th><th>Views</th><th>Likes</th><th>Comments</th></tr></thead><tbody>${photoRows}</tbody></table></div>` : '<p>No photo views yet.</p>'}
<div class="stat-lists">
  ${statList('Top albums', traffic.albums.map(a => [a.title, a.views]), 'No album views yet.')}
  ${statList('Countries', traffic.countries.map(r => [r.value, r.n]), 'No visitors yet.')}
  ${statList('Coming from', traffic.referrers.map(r => [r.value, r.n]), 'No outside links yet.')}
</div>
<h2>Activity log</h2>
${eventCounts ? `<p class="event-counts">${eventCounts}</p>` : ''}
${eventRows ? `<div class="stats-scroll"><table class="stats-table"><thead><tr><th>Time (UTC)</th><th>What</th><th>Detail</th></tr></thead><tbody>${eventRows}</tbody></table></div>` : '<p>Nothing logged yet. Failures and blocked attempts appear here for 30 days.</p>'}
</main>
<script src="${assets.adminJs}" defer></script>
</body></html>`;
}

export function captionsView(drafts, { aiOn, approved = false }, pendingCount = 0) {
  const rows = drafts.map(d => `
    <div class="caption-draft" data-id="${escapeHtml(d.id)}">
      <img src="/admin/img/${escapeHtml(d.id)}/480.webp" alt="" loading="lazy">
      <div class="caption-draft-body">
        <small>${escapeHtml(d.album_title || 'No album')} \u00b7 ${escapeHtml(d.original_name)}</small>
        <input type="text" class="draft-title" maxlength="100" aria-label="Title" value="${escapeHtml(d.caption_draft)}">
        <textarea class="draft-description" rows="2" maxlength="300" aria-label="Description">${escapeHtml(d.meta.description || '')}</textarea>
        <label>Tags <input type="text" class="draft-tags" value="${escapeHtml((d.meta.tags || []).join(', '))}"></label>
        <label>Moods <input type="text" class="draft-moods" value="${escapeHtml((d.meta.moods || []).join(', '))}"></label>
        <label>Scene <input type="text" class="draft-details" value="${escapeHtml((d.meta.details || []).join(', '))}"></label>
        ${d.meta.colors?.length ? `<p class="draft-colors">${d.meta.colors.map(c => `<span class="badge">${escapeHtml(c)}</span>`).join(' ')}${(d.meta.palette || []).map(hex => `<span class="swatch" style="background:${escapeHtml(hex)}" title="${escapeHtml(hex)}"></span>`).join('')}</p>` : ''}
        <div class="caption-actions">
          ${approved ? `<button class="btn btn-sm btn-approve" data-caption-action="approve">Save</button>` : `<button class="btn btn-sm btn-approve" data-caption-action="approve">Approve</button>
          <button class="btn btn-sm" data-caption-action="regenerate">Try again</button>
          <button class="btn btn-sm" data-caption-action="dismiss">Dismiss</button>`}
        </div>
      </div>
    </div>`).join('');
  const intro = 'AI drafts a title, description, tags, moods and scene labels for each photo. Colors are measured from the image. Nothing goes public until you approve it.';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Captions</title><link rel="stylesheet" href="${assets.adminCss}"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main">
<h1>Captions</h1>
<p>${escapeHtml(intro)}</p>
${aiStatus(aiOn, 'AI captions are')}
<nav class="caption-tabs"><a href="/admin/captions"${approved ? '' : ' aria-current="page"'}>To review</a><a href="/admin/captions?view=approved"${approved ? ' aria-current="page"' : ''}>Approved</a></nav>
${rows && !approved ? `<div class="caption-toolbar"><span id="caption-count">${drafts.length} to review</span><button class="btn btn-sm" id="caption-approve-all">Approve all</button></div>` : ''}
<div id="caption-list" data-view="${approved ? 'approved' : 'review'}">${rows || `<p class="caption-empty">${approved ? 'Nothing approved yet.' : 'No drafts to review.'}</p>`}</div>
</main>
<script src="${assets.adminJs}" defer></script>
</body></html>`;
}

export function privacyView(photos, { aiOn, reviewed }, pendingCount = 0) {
  const rows = photos.map(p => {
    const scan = p.privacy_scan === 'done' ? `${p.boxes.length} found by AI` : p.privacy_scan === 'failed' ? 'AI scan failed, check by hand' : 'Not scanned';
    return `
    <div class="privacy-row" data-id="${escapeHtml(p.id)}">
      <div class="privacy-stage" data-boxes="${escapeHtml(JSON.stringify(p.boxes))}"><img src="/admin/preview/${escapeHtml(p.id)}" alt="" loading="lazy" draggable="false"></div>
      <div class="privacy-side">
        <small>${escapeHtml(p.album_title || 'No album')} \u00b7 ${escapeHtml(p.original_name)}</small>
        <p class="privacy-scan">${escapeHtml(scan)}${p.is_published && p.privacy_ok ? ' \u00b7 live' : ''}</p>
        <div class="caption-actions">
          <button class="btn btn-sm btn-approve" data-privacy-action="approve">${reviewed ? 'Save' : 'Approve'}</button>
          ${ai.configured && ai.enabled ? '<button class="btn btn-sm" data-privacy-action="rescan">Scan again</button>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy</title><link rel="stylesheet" href="${assets.adminCss}"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main">
<h1>Privacy</h1>
<p>Blurred areas are baked into every public version. Your original stays private. New photos stay offline until you approve them here.</p>
<p class="privacy-help">Click a box to turn its blur off or on. Drag on the photo to add a box.</p>
${aiStatus(aiOn, 'The AI face and plate scan is')}
<nav class="caption-tabs"><a href="/admin/privacy"${reviewed ? '' : ' aria-current="page"'}>To review</a><a href="/admin/privacy?view=reviewed"${reviewed ? ' aria-current="page"' : ''}>Reviewed</a></nav>
${rows && !reviewed ? `<div class="caption-toolbar"><span id="privacy-count">${photos.length} to review</span><button class="btn btn-sm" id="privacy-approve-all">Approve all</button></div>` : ''}
<div id="privacy-list" data-view="${reviewed ? 'reviewed' : 'review'}">${rows || `<p class="caption-empty">${reviewed ? 'Nothing reviewed yet.' : 'All photos are reviewed.'}</p>`}</div>
</main>
<script src="${assets.adminJs}" defer></script>
</body></html>`;
}
