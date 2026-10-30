import { escapeHtml } from './html.js';

export const IMG_ID_RE = /^[a-f0-9]{16}$/;
export const IMG_FILE_RE = /^(\d+)\.(avif|webp|jpg)$/;

function nav(pendingCount = 0) {
  return `<nav class="admin-nav">
  <a href="/admin">Upload</a>
  <a href="/admin/photos">Photos</a>
  <a href="/admin/albums">Albums</a>
  <a href="/admin/comments">Comments${pendingCount ? ` <span class="badge">${pendingCount}</span>` : ''}</a>
  <form method="POST" action="/admin/logout" class="inline-form"><button type="submit" class="btn btn-sm">Logout</button></form>
</nav>`;
}

export function loginView(msg) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login</title><link rel="stylesheet" href="/static/admin.css"></head>
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
<title>Upload</title><link rel="stylesheet" href="/static/admin.css"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main">
<h1>Upload Photos</h1>
<div class="upload-controls">
  <select id="album-select"><option value="">No album</option>${opts}<option value="__new">New album…</option></select>
  <input type="text" id="new-album-name" placeholder="Album name" class="hidden">
</div>
<div id="dropzone" class="dropzone"><p>Drop photos here, or tap to choose</p></div>
<input type="file" id="file-input" accept="image/*" multiple class="hidden">
<div id="upload-list"></div>
</main>
<script src="/static/admin.js" defer></script>
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
        ${p.is_published ? '<span class="badge badge-live">live</span>' : ''}
        ${p.album_title ? `<span class="album-tag">${escapeHtml(p.album_title)}</span>` : ''}
        <input class="caption-input" data-id="${escapeHtml(p.id)}" value="${escapeHtml(p.caption)}" placeholder="Add caption…" maxlength="5000">
      </div>
    </div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Photos</title><link rel="stylesheet" href="/static/admin.css"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main">
<h1>Photos</h1>
<div class="filters">
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
<script src="/static/admin.js" defer></script>
</body></html>`;
}

export function albumsView(albums, pendingCount = 0) {
  const items = albums.map(a => `
    <tr data-id="${a.id}">
      <td><input class="album-title" value="${escapeHtml(a.title)}" data-field="title" maxlength="200"></td>
      <td><input class="album-desc" value="${escapeHtml(a.description)}" data-field="description" maxlength="2000"></td>
      <td>${a.photo_count}</td>
      <td><label class="switch"><input type="checkbox" data-field="is_published" ${a.is_published ? 'checked' : ''}><span></span></label></td>
      <td>${escapeHtml(a.cover_photo_id || '—')}</td>
      <td>
        <button class="btn btn-sm btn-set-cover">Set cover</button>
        <button class="btn btn-sm btn-danger btn-del-album">Delete</button>
      </td>
    </tr>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Albums</title><link rel="stylesheet" href="/static/admin.css"></head>
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
<script src="/static/admin.js" defer></script>
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
<title>Comments</title><link rel="stylesheet" href="/static/admin.css"></head>
<body class="admin-body">
${nav(pendingCount)}
<main class="admin-main">
<h1>Comments</h1>
<h2>Pending (${pendingCount})</h2>
<div id="pending-list">${pending.map(c => item(c, true)).join('') || '<p>No pending comments.</p>'}</div>
<h2>Other</h2>
<div id="all-list">${all.map(c => item(c, false)).join('') || '<p>None.</p>'}</div>
</main>
<script src="/static/admin.js" defer></script>
</body></html>`;
}
