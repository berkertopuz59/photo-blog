(function () {
  'use strict';

  // --- Upload page ---
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const albumSelect = document.getElementById('album-select');
  const newAlbumName = document.getElementById('new-album-name');
  const uploadList = document.getElementById('upload-list');

  if (dropzone) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => handleFiles(fileInput.files));

    if (albumSelect) {
      albumSelect.addEventListener('change', () => {
        newAlbumName.classList.toggle('hidden', albumSelect.value !== '__new');
      });
    }
  }

  async function handleFiles(files) {
    let albumId = albumSelect ? albumSelect.value : '';
    if (albumId === '__new') {
      const name = (newAlbumName.value || '').trim();
      if (!name) return;
      const res = await fetch('/admin/api/albums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
        body: JSON.stringify({ title: name })
      });
      if (res.ok) {
        const data = await res.json();
        albumId = String(data.album.id);
        const opt = document.createElement('option');
        opt.value = albumId; opt.textContent = name;
        albumSelect.insertBefore(opt, albumSelect.lastElementChild);
        albumSelect.value = albumId;
        newAlbumName.classList.add('hidden');
        newAlbumName.value = '';
      } else { return; }
    }

    const arr = Array.from(files);
    const queue = [...arr];
    const concurrency = 2;

    async function uploadOne(file) {
      const row = document.createElement('div');
      row.className = 'upload-row';
      row.innerHTML = `<span>${escapeText(file.name)}</span><div class="progress"><div class="progress-bar"></div></div><span class="up-status">…</span>`;
      uploadList.prepend(row);
      const bar = row.querySelector('.progress-bar');
      const status = row.querySelector('.up-status');

      const form = new FormData();
      form.append('file', file);
      if (albumId) form.append('album_id', albumId);

      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/admin/api/upload');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) bar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
        };
        const result = await new Promise((resolve, reject) => {
          xhr.onload = () => resolve(xhr);
          xhr.onerror = () => reject(new Error('network'));
          xhr.send(form);
        });
        if (result.status === 415) { status.textContent = 'Unsupported'; bar.classList.add('err'); return; }
        if (!xhr.responseText) { status.textContent = 'Error'; bar.classList.add('err'); return; }
        const data = JSON.parse(xhr.responseText);
        bar.style.width = '100%';
        status.textContent = data.duplicate ? 'Duplicate' : 'Uploaded';
        if (!data.duplicate) pollStatus(data.id, row, status);
      } catch {
        status.textContent = 'Error';
        bar.classList.add('err');
      }
    }

    async function runQueue() {
      const workers = [];
      for (let i = 0; i < concurrency; i++) workers.push(next());
      async function next() {
        while (queue.length) {
          await uploadOne(queue.shift());
        }
      }
      await Promise.all(workers);
    }

    runQueue();
  }

  async function pollStatus(id, row, statusEl) {
    for (let i = 0; i < 30; i++) {
      await delay(2000);
      try {
        const res = await fetch('/admin/api/photos/status?ids=' + id);
        if (!res.ok) continue;
        const data = await res.json();
        const p = data.photos.find(x => x.id === id);
        if (!p) continue;
        if (p.status === 'ready') { statusEl.textContent = 'Ready'; return; }
        if (p.status === 'failed') { statusEl.textContent = 'Failed'; row.querySelector('.progress-bar').classList.add('err'); return; }
        statusEl.textContent = p.status;
      } catch {}
    }
  }

  // --- Photos page ---
  const photoGrid = document.querySelector('.photo-grid');
  if (photoGrid) {
    const selected = new Set();
    const actionBar = document.getElementById('action-bar');
    const selCount = document.getElementById('sel-count');

    photoGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.photo-card');
      if (!card || e.target.closest('.caption-input')) return;
      const id = card.dataset.id;
      if (selected.has(id)) { selected.delete(id); card.classList.remove('selected'); }
      else { selected.add(id); card.classList.add('selected'); }
      if (selected.size) { actionBar.classList.remove('hidden'); selCount.textContent = selected.size + ' selected'; }
      else { actionBar.classList.add('hidden'); }
    });

    // Caption blur save
    photoGrid.addEventListener('blur', (e) => {
      if (!e.target.classList.contains('caption-input')) return;
      const id = e.target.dataset.id;
      fetch('/admin/api/photos/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
        body: JSON.stringify({ caption: e.target.value })
      });
    }, true);

    // Action bar buttons
    if (actionBar) {
      actionBar.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const ids = [...selected];
        if (!ids.length) return;
        let body = { ids, action };
        if (action === 'move') {
          const sel = document.getElementById('move-album-select');
          body.album_id = sel.value === 'null' ? null : Number(sel.value) || null;
        }
        const res = await fetch('/admin/api/photos/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
          body: JSON.stringify(body)
        });
        if (res.ok && action === 'delete') {
          ids.forEach(id => { const c = photoGrid.querySelector(`[data-id="${id}"]`); if (c) c.remove(); });
        } else if (res.ok) {
          location.reload();
        }
      });
    }

    // Filter
    const filterApply = document.getElementById('filter-apply');
    if (filterApply) {
      filterApply.addEventListener('click', () => {
        const params = new URLSearchParams();
        const alb = document.getElementById('filter-album');
        const unpub = document.getElementById('filter-unpub');
        if (alb.value) params.set('album', alb.value);
        if (unpub.checked) params.set('unpublished', '1');
        location.href = '/admin/photos?' + params.toString();
      });
    }
  }

  // --- Albums page ---
  const albumTable = document.querySelector('.admin-table');
  if (albumTable) {
    albumTable.addEventListener('change', (e) => {
      const input = e.target;
      const field = input.dataset.field;
      if (!field) return;
      const tr = input.closest('tr');
      const id = tr.dataset.id;
      let body = {};
      body[field] = input.type === 'checkbox' ? input.checked : input.value;
      fetch('/admin/api/albums/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
        body: JSON.stringify(body)
      });
    });

    albumTable.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      if (btn.classList.contains('btn-del-album')) {
        if (!confirm('Delete this album? Photos will remain without an album.')) return;
        const res = await fetch('/admin/api/albums/' + id, {
          method: 'DELETE',
          headers: { 'Origin': location.origin }
        });
        if (res.ok) tr.remove();
      }
      if (btn.classList.contains('btn-set-cover')) {
        // For simplicity, prompt for photo id
        const pid = prompt('Photo ID for cover:');
        if (pid) {
          fetch('/admin/api/albums/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
            body: JSON.stringify({ cover_photo_id: pid })
          }).then(() => location.reload());
        }
      }
    });
  }

  const createForm = document.getElementById('create-album-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('new-title').value.trim();
      if (!title) return;
      const res = await fetch('/admin/api/albums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
        body: JSON.stringify({ title })
      });
      if (res.ok) location.reload();
    });
  }

  // --- Comments page ---
  const commentList = document.getElementById('pending-list');
  if (commentList) {
    commentList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-id]');
      if (!btn) return;
      const id = btn.dataset.id;
      let action = 'approve';
      if (btn.textContent.trim() === 'Reject') action = 'reject';
      if (btn.classList.contains('btn-delete-comment')) action = 'delete';
      const res = await fetch('/admin/api/comments/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
        body: JSON.stringify({ action })
      });
      if (res.ok) {
        const item = btn.closest('.comment-item');
        if (item) item.remove();
      }
    });
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
})();

