(function () {
  'use strict';

  // --- List-return persistence ---
  function safeSetStorage(key, val) {
    try { sessionStorage.setItem(key, val); } catch (e) { /* blocked */ }
  }
  function safeGetStorage(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function safeRemoveStorage(key) {
    try { sessionStorage.removeItem(key); } catch (e) { /* blocked */ }
  }

  // Click handler: any a.grid-cell saves current list position
  document.addEventListener('click', function (e) {
    var cell = e.target.closest('a.grid-cell');
    if (!cell) return;
    var payload = JSON.stringify({ url: location.pathname + location.search, y: window.scrollY });
    safeSetStorage('list-return', payload);
  });

  // Photo page: restore back-link href from saved value; Escape follows back-link
  var backLink = document.querySelector('.back-link');
  if (backLink) {
    var saved = safeGetStorage('list-return');
    if (saved) {
      try {
        var parsed = JSON.parse(saved);
        if (parsed && parsed.url) {
          backLink.setAttribute('href', parsed.url);
        }
      } catch (e) { /* malformed, leave href alone */ }
    }

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      window.location.href = backLink.getAttribute('href');
    });
  }

  // List page at load: restore scroll if saved url matches
  if (!backLink) {
    var saved2 = safeGetStorage('list-return');
    if (saved2) {
      try {
        var d = JSON.parse(saved2);
        if (d && d.url === (location.pathname + location.search)) {
          window.scrollTo(0, d.y || 0);
          safeRemoveStorage('list-return');
        }
      } catch (e) { /* malformed */ }
    }
  }

  // --- Like button ---
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="like"]');
    if (!btn) return;
    e.preventDefault();

    var photoId = btn.getAttribute('data-photo-id');
    var isLiked = btn.getAttribute('aria-pressed') === 'true';
    var countEl = btn.querySelector('.like-count');
    var oldCount = parseInt(countEl.textContent, 10) || 0;

    if (isLiked) {
      btn.setAttribute('aria-pressed', 'false');
      btn.classList.remove('liked');
      countEl.textContent = String(Math.max(0, oldCount - 1));
    } else {
      btn.setAttribute('aria-pressed', 'true');
      btn.classList.add('liked');
      countEl.textContent = String(oldCount + 1);
    }

    var method = isLiked ? 'DELETE' : 'POST';
    fetch('/api/photos/' + photoId + '/like', { method: method })
      .then(function (res) {
        if (!res.ok) throw new Error('fail');
        return res.json();
      })
      .then(function (data) {
        countEl.textContent = String(data.count);
        btn.setAttribute('aria-pressed', data.liked ? 'true' : 'false');
        if (data.liked) btn.classList.add('liked');
        else btn.classList.remove('liked');
      })
      .catch(function () {
        countEl.textContent = String(oldCount);
        btn.setAttribute('aria-pressed', isLiked ? 'true' : 'false');
        if (isLiked) btn.classList.add('liked');
        else btn.classList.remove('liked');
      });
  });

  // --- Keyboard navigation (arrow keys) ---
  var prevLink = document.querySelector('.photo-nav-btn.prev-btn') || document.querySelector('.touch-nav-btn[aria-label="Previous photo"]');
  var nextLink = document.querySelector('.photo-nav-btn.next-btn') || document.querySelector('.touch-nav-btn[aria-label="Next photo"]');

  if (prevLink || nextLink) {
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      if (e.key === 'ArrowLeft' && prevLink) {
        e.preventDefault();
        window.location.href = prevLink.getAttribute('href');
      } else if (e.key === 'ArrowRight' && nextLink) {
        e.preventDefault();
        window.location.href = nextLink.getAttribute('href');
      }
    });
  }

  // --- Turnstile lazy load ---
  var turnstileLoaded = false;
  var widgetId = null;

  function loadTurnstile(container) {
    if (turnstileLoaded) return;
    turnstileLoaded = true;

    var script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload = function () {
      window.onloadTurnstileCallback = function () {
        if (window.turnstile) {
          var sitekey = container.closest('[data-action="comment"]').getAttribute('data-sitekey');
          if (sitekey) {
            widgetId = window.turnstile.render('#turnstile-container', { sitekey: sitekey });
          }
        }
      };
      window.onloadTurnstileCallback();
    };
    document.head.appendChild(script);
  }

  var commentSection = document.querySelector('[data-action="comment"]');
  if (commentSection) {
    var form = commentSection.querySelector('form');
    var turnstileContainer = document.getElementById('turnstile-container');
    var focusedOnce = false;

    function onFocusIn() {
      if (focusedOnce) return;
      focusedOnce = true;
      if (turnstileContainer) loadTurnstile(turnstileContainer);
    }

    form.addEventListener('focusin', onFocusIn);
  }

  // --- Comment form ---
  if (commentSection) {
    var cform = commentSection.querySelector('form');
    var msgEl = commentSection.querySelector('.form-msg');
    var photoId = commentSection.getAttribute('data-photo-id');

    cform.addEventListener('submit', function (e) {
      e.preventDefault();

      var formData = new FormData(cform);
      var payload = {
        author: formData.get('author'),
        body: formData.get('body'),
        website: formData.get('website'),
        token: '',
      };

      if (window.turnstile && widgetId !== null) {
        payload.token = window.turnstile.getResponse(widgetId) || '';
      }
      if (!payload.token) {
        msgEl.textContent = 'One moment, the spam check is still running. Try again in a few seconds.';
        return;
      }

      msgEl.textContent = 'Submitting\u2026';

      fetch('/api/photos/' + photoId + '/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          if (!res.ok) return res.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || 'error'); });
          return res.json();
        })
        .then(function () {
          msgEl.textContent = 'Thanks, your comment will appear after review.';
          cform.querySelector('[name="author"]').value = '';
          cform.querySelector('[name="body"]').value = '';
        })
        .catch(function (err) {
          var messages = {
            links: 'Links are not allowed in comments.',
            author: 'Please add a name, 40 characters at most.',
            body: 'Please write a comment, 1000 characters at most.',
            'rate limited': 'Too many comments for now. Please try again later.',
            'queue full': 'Comments are paused for a moment. Please try again later.',
            'turnstile failed': 'The spam check failed. Please try again.',
          };
          msgEl.textContent = messages[err.message] || 'Something went wrong.';
          if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
        });
    });
  }

  // --- Swipe between photos ---
  var swipeStage = document.querySelector('.photo-stage');
  if (swipeStage) {
    var startX = 0, startY = 0, tracking = false;
    swipeStage.addEventListener('touchstart', function (e) {
      tracking = e.touches.length === 1 && !(window.visualViewport && window.visualViewport.scale > 1);
      if (tracking) { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }
    }, { passive: true });
    swipeStage.addEventListener('touchmove', function (e) {
      if (e.touches.length > 1) tracking = false;
    }, { passive: true });
    swipeStage.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      var dx = e.changedTouches[0].clientX - startX;
      var dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) / 2) return;
      var target = document.querySelector(dx < 0 ? '.next-btn' : '.prev-btn');
      if (target) window.location.href = target.getAttribute('href');
    }, { passive: true });
  }

  // --- Album cards flip through their photos on hover ---
  var canHover = window.matchMedia('(hover: hover)').matches;
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (canHover && !calm) {
    document.querySelectorAll('.album-card[data-previews]').forEach(function (card) {
      var urls = card.getAttribute('data-previews').split(' ');
      var timer = null;
      var step = 0;

      function show() {
        var layer = document.createElement('img');
        layer.className = 'album-preview';
        layer.alt = '';
        layer.src = urls[step % urls.length];
        step += 1;
        layer.onload = function () {
          card.querySelector('picture').after(layer);
          requestAnimationFrame(function () { layer.classList.add('is-visible'); });
          var older = card.querySelectorAll('.album-preview');
          for (var i = 0; i < older.length - 2; i++) older[i].remove();
        };
      }

      function start() {
        if (timer) return;
        urls.forEach(function (url) { new Image().src = url; });
        step = 0;
        show();
        timer = setInterval(show, 700);
      }

      function stop() {
        clearInterval(timer);
        timer = null;
        card.querySelectorAll('.album-preview').forEach(function (layer) {
          layer.classList.remove('is-visible');
          setTimeout(function () { layer.remove(); }, 200);
        });
      }

      card.addEventListener('pointerenter', start);
      card.addEventListener('pointerleave', stop);
      card.addEventListener('focusin', start);
      card.addEventListener('focusout', stop);
    });
  }
})();
