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
    uploads.total += arr.length;
    renderQueue();
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
        if (data.duplicate) return;
        row.remove();
        pollQueue();
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
          uploads.done += 1;
          renderQueue();
        }
      }
      await Promise.all(workers);
    }

    runQueue();
  }

  // --- Processing numbers ---
  const queuePanel = document.getElementById('queue-panel');
  const uploads = { done: 0, total: 0 };
  const jobList = document.getElementById('job-list');
  const STATUS_LABELS = { pending: 'Waiting', processing: 'Processing', ready: 'Ready', failed: 'Failed' };
  let lastQueue = null;

  function formatDuration(seconds) {
    if (seconds < 90) return 'under 2 min';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' min';
    return Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min';
  }

  function renderQueue() {
    if (!queuePanel) return;
    const q = lastQueue;
    const uploading = uploads.done < uploads.total;
    if (!q || (!q.total && !uploading)) return;
    const processed = q.ready + q.failed;
    const parts = [];
    if (uploading) parts.push('Uploading ' + (uploads.done + 1) + ' of ' + uploads.total);
    if (q.processing) parts.push(q.processing + ' processing');
    if (q.pending) parts.push(q.pending + ' waiting');
    if (q.failed) parts.push(q.failed + ' failed');
    if (q.secondsPerPhoto && (q.pending || q.processing)) parts.push(q.secondsPerPhoto + ' s per photo');
    if (q.secondsLeft) parts.push('about ' + formatDuration(q.secondsLeft) + ' left');
    if (q.avifLeft) parts.push(q.avifLeft + ' AVIF in background');
    if (q.privacyToReview) parts.push(q.privacyToReview + ' to review in Privacy');
    if (!parts.length) parts.push('All done');
    document.getElementById('queue-title').textContent = processed + ' of ' + q.total + ' processed';
    document.getElementById('queue-detail').textContent = parts.join(' \u00b7 ');
    document.getElementById('queue-bar').style.width = (q.total ? Math.round((processed / q.total) * 100) : 0) + '%';
    queuePanel.classList.remove('hidden');
    renderJobs(q.jobs);
  }

  function renderJobs(jobs) {
    if (!jobList) return;
    jobList.replaceChildren(...jobs.map((job) => {
      const row = document.createElement('div');
      row.className = 'upload-row job-row job-' + job.status;
      const name = document.createElement('span');
      name.textContent = job.original_name;
      const status = document.createElement('span');
      status.className = 'up-status';
      status.textContent = STATUS_LABELS[job.status] || job.status;
      row.append(name, status);
      return row;
    }));
  }

  async function pollQueue() {
    try {
      const res = await fetch('/admin/api/queue');
      if (res.ok) lastQueue = await res.json();
      renderQueue();
    } catch { /* next tick retries */ }
  }

  if (queuePanel) {
    pollQueue();
    setInterval(pollQueue, 3000);
    window.addEventListener('beforeunload', (e) => {
      if (uploads.done < uploads.total) e.preventDefault();
    });
  }

  // --- Settings switches ---
  document.querySelectorAll('[data-setting]').forEach((input) => {
    input.addEventListener('change', async () => {
      const res = await fetch('/admin/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: input.dataset.setting, value: input.checked })
      }).catch(() => null);
      if (!res || !res.ok) input.checked = !input.checked;
    });
  });

  // The slider only moves the preview. Apply saves it, because saving rebuilds every photo.
  document.querySelectorAll('[data-number-setting]').forEach((input) => {
    let saved = input.value;
    let photo = 0;
    let timer = null;
    const output = input.parentElement.querySelector('output');
    const preview = document.getElementById('watermark-preview');
    const apply = document.getElementById('watermark-apply');
    const showPreview = () => {
      if (preview) preview.src = `/admin/watermark-preview?opacity=${input.value}&photo=${photo}`;
    };
    const refresh = () => {
      output.textContent = `${input.value}%`;
      apply.disabled = input.value === saved;
    };
    input.addEventListener('input', () => {
      refresh();
      clearTimeout(timer);
      timer = setTimeout(showPreview, 250);
    });
    document.getElementById('watermark-preview-next')?.addEventListener('click', () => {
      photo += 1;
      showPreview();
    });
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      const res = await fetch('/admin/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: input.dataset.numberSetting, value: Number(input.value) })
      }).catch(() => null);
      if (res && res.ok) saved = input.value;
      else {
        input.value = saved;
        showPreview();
      }
      refresh();
    });
  });

  // --- Privacy page ---
  const privacyListEl = document.getElementById('privacy-list');
  if (privacyListEl) {
    const countEl = document.getElementById('privacy-count');
    const percent = (v) => (v * 100).toFixed(2) + '%';

    function placeBox(el, box) {
      el.style.left = percent(box.x1);
      el.style.top = percent(box.y1);
      el.style.width = percent(box.x2 - box.x1);
      el.style.height = percent(box.y2 - box.y1);
    }

    function addBox(stage, box) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'privacy-box privacy-' + box.type;
      el.classList.toggle('is-off', !box.blur);
      el.setAttribute('aria-label', box.type + ' blur');
      placeBox(el, box);
      el.addEventListener('click', () => {
        box.blur = !box.blur;
        el.classList.toggle('is-off', !box.blur);
      });
      stage.append(el);
    }

    privacyListEl.querySelectorAll('.privacy-stage').forEach((stage) => {
      stage.boxes = JSON.parse(stage.dataset.boxes);
      stage.boxes.forEach((box) => addBox(stage, box));

      let drawing = null;
      stage.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.privacy-box')) return;
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        const start = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
        const el = document.createElement('div');
        el.className = 'privacy-box privacy-manual';
        stage.append(el);
        drawing = { rect, start, el, box: null };
        stage.setPointerCapture(e.pointerId);
      });
      stage.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        const { rect, start, el } = drawing;
        const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
        drawing.box = { type: 'manual', blur: true, x1: Math.min(start.x, x), y1: Math.min(start.y, y), x2: Math.max(start.x, x), y2: Math.max(start.y, y) };
        placeBox(el, drawing.box);
      });
      stage.addEventListener('pointerup', () => {
        if (!drawing) return;
        const { el, box } = drawing;
        drawing = null;
        el.remove();
        if (box && box.x2 - box.x1 > 0.01 && box.y2 - box.y1 > 0.01) {
          stage.boxes.push(box);
          addBox(stage, box);
        }
      });
    });

    function sendPrivacy(row, action) {
      return fetch('/admin/api/privacy/' + row.dataset.id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, boxes: row.querySelector('.privacy-stage').boxes })
      }).catch(() => null);
    }

    function dropPrivacyRow(row) {
      row.remove();
      if (countEl) countEl.textContent = privacyListEl.querySelectorAll('.privacy-row').length + ' to review';
    }

    privacyListEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-privacy-action]');
      if (!btn) return;
      const row = btn.closest('.privacy-row');
      const action = btn.dataset.privacyAction;
      btn.disabled = true;
      const res = await sendPrivacy(row, action);
      btn.disabled = false;
      if (!res || !res.ok) btn.textContent = 'Failed, retry';
      else if (action === 'rescan') btn.textContent = 'Queued';
      else if (privacyListEl.dataset.view === 'reviewed') btn.textContent = 'Saved';
      else dropPrivacyRow(row);
    });

    const approveAllPrivacy = document.getElementById('privacy-approve-all');
    if (approveAllPrivacy) {
      approveAllPrivacy.addEventListener('click', async () => {
        approveAllPrivacy.disabled = true;
        for (const row of privacyListEl.querySelectorAll('.privacy-row')) {
          const res = await sendPrivacy(row, 'approve');
          if (res && res.ok) dropPrivacyRow(row);
        }
        location.reload();
      });
    }
  }

  // --- Captions page ---
  const captionList = document.getElementById('caption-list');
  if (captionList) {
    const countEl = document.getElementById('caption-count');

    function splitLabels(text) {
      return text.split(',').map((v) => v.trim()).filter(Boolean);
    }

    function dropRow(row) {
      row.remove();
      const left = captionList.querySelectorAll('.caption-draft').length;
      if (countEl) countEl.textContent = left + ' to review';
    }

    function sendCaption(row, action) {
      return fetch('/admin/api/captions/' + row.dataset.id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          caption: row.querySelector('.draft-title').value,
          description: row.querySelector('.draft-description').value,
          tags: splitLabels(row.querySelector('.draft-tags').value),
          moods: splitLabels(row.querySelector('.draft-moods').value),
          details: splitLabels(row.querySelector('.draft-details').value)
        })
      }).catch(() => null);
    }

    captionList.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-caption-action]');
      if (!btn) return;
      const row = btn.closest('.caption-draft');
      btn.disabled = true;
      const res = await sendCaption(row, btn.dataset.captionAction);
      btn.disabled = false;
      if (!res || !res.ok) btn.textContent = 'Failed, retry';
      else if (captionList.dataset.view === 'approved') btn.textContent = 'Saved';
      else dropRow(row);
    });

    const approveAll = document.getElementById('caption-approve-all');
    if (approveAll) {
      approveAll.addEventListener('click', async () => {
        // Sends each row as shown, so your edits count and drafts written meanwhile wait for review
        approveAll.disabled = true;
        for (const row of captionList.querySelectorAll('.caption-draft')) {
          const res = await sendCaption(row, 'approve');
          if (res && res.ok) dropRow(row);
        }
        location.reload();
      });
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
      syncSelection();
    });

    function syncSelection() {
      if (selected.size) { actionBar.classList.remove('hidden'); selCount.textContent = selected.size + ' selected'; }
      else { actionBar.classList.add('hidden'); }
      const selectAll = document.getElementById('select-all');
      if (selectAll) selectAll.checked = selected.size > 0 && selected.size === photoGrid.querySelectorAll('.photo-card').length;
    }

    const selectAll = document.getElementById('select-all');
    if (selectAll) {
      selectAll.addEventListener('change', () => {
        photoGrid.querySelectorAll('.photo-card').forEach((card) => {
          card.classList.toggle('selected', selectAll.checked);
          if (selectAll.checked) selected.add(card.dataset.id);
          else selected.delete(card.dataset.id);
        });
        syncSelection();
      });
    }

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
      if (e.target.dataset.field) saveAlbumField(e.target);
    });

    // The description also saves while you type, so leaving the page cannot lose it
    let descTimer = null;
    albumTable.addEventListener('input', (e) => {
      if (!e.target.classList.contains('album-desc')) return;
      const state = e.target.closest('td').querySelector('.album-save-state');
      state.textContent = 'Saving\u2026';
      clearTimeout(descTimer);
      descTimer = setTimeout(() => saveAlbumField(e.target), 800);
    });

    async function saveAlbumField(input) {
      const field = input.dataset.field;
      const id = input.closest('tr').dataset.id;
      const state = input.closest('td').querySelector('.album-save-state');
      const body = {};
      body[field] = input.type === 'checkbox' ? input.checked : input.value;
      const res = await fetch('/admin/api/albums/' + id, {
        method: 'PATCH',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
        body: JSON.stringify(body)
      }).catch(() => null);
      if (state) state.textContent = res && res.ok ? 'Saved' : 'Not saved, try again';
    }

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
      if (btn.classList.contains('btn-publish-album')) {
        btn.disabled = true;
        const res = await fetch('/admin/api/albums/' + id + '/publish', { method: 'POST' }).catch(() => null);
        if (res && res.ok) location.reload();
        else { btn.disabled = false; btn.textContent = 'Failed, retry'; }
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

