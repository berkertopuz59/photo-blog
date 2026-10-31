(function () {
  'use strict';

  function lightboxOpen() {
    return document.body.classList.contains('lightbox-open');
  }

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

  function restoreBackLink() {
    var saved = safeGetStorage('list-return');
    if (!saved) return;
    try {
      var parsed = JSON.parse(saved);
      if (parsed && parsed.url) {
        document.querySelector('.back-link').setAttribute('href', parsed.url);
      }
    } catch (e) { /* malformed, leave href alone */ }
  }

  if (backLink) {
    restoreBackLink();

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || lightboxOpen()) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      window.location.href = document.querySelector('.back-link').getAttribute('href');
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
  if (backLink) {
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (lightboxOpen() || tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      var prevLink = document.querySelector('.photo-nav-btn.prev-btn') || document.querySelector('.touch-nav-btn[aria-label="Previous photo"]');
      var nextLink = document.querySelector('.photo-nav-btn.next-btn') || document.querySelector('.touch-nav-btn[aria-label="Next photo"]');
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

  function renderTurnstile(container) {
    var sitekey = container.closest('[data-action="comment"]').getAttribute('data-sitekey');
    if (sitekey) {
      widgetId = window.turnstile.render('#turnstile-container', { sitekey: sitekey });
    }
  }

  function loadTurnstile(container) {
    if (window.turnstile) {
      renderTurnstile(container);
      return;
    }
    if (turnstileLoaded) return;
    turnstileLoaded = true;

    var script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload = function () {
      if (window.turnstile) renderTurnstile(document.getElementById('turnstile-container'));
    };
    document.head.appendChild(script);
  }

  function setupComments() {
    var commentSection = document.querySelector('[data-action="comment"]');
    if (window.turnstile && widgetId !== null) window.turnstile.remove(widgetId);
    widgetId = null;
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
          email: formData.get('email'),
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
            cform.querySelector('[name="email"]').value = '';
          })
          .catch(function (err) {
            var messages = {
              links: 'Links are not allowed in comments.',
              author: 'Please add a name, 40 characters at most.',
              body: 'Please write a comment, 1000 characters at most.',
              email: 'That email address does not look right.',
              'rate limited': 'Too many comments for now. Please try again later.',
              'queue full': 'Comments are paused for a moment. Please try again later.',
              'turnstile failed': 'The spam check failed. Please try again.',
            };
            msgEl.textContent = messages[err.message] || 'Something went wrong.';
            if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
          });
      });
    }
  }
  setupComments();

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

  // --- Full-screen view: tap to open, tap or Escape or swipe down to close, arrows and swipes move ---
  if (swipeStage) {
    var box = null;
    var shown = null;
    var openedAt = '';
    var stepping = false;

    function readPage(doc, url) {
      var prev = doc.querySelector('.prev-btn');
      var next = doc.querySelector('.next-btn');
      return {
        url: url,
        doc: doc,
        picture: doc.querySelector('.photo-stage picture'),
        like: doc.querySelector('.photo-actions .like-btn'),
        prev: prev && prev.getAttribute('href'),
        next: next && next.getAttribute('href'),
      };
    }

    function render() {
      var picture = shown.picture.cloneNode(true);
      picture.removeAttribute('style');
      picture.querySelectorAll('source, img').forEach(function (el) { el.setAttribute('sizes', '100vw'); });
      var old = box.querySelector('picture');
      if (old) old.replaceWith(picture);
      else box.prepend(picture);
      box.querySelector('.lb-prev').hidden = !shown.prev;
      box.querySelector('.lb-next').hidden = !shown.next;

      var oldLike = box.querySelector('.lb-like');
      if (oldLike) oldLike.remove();
      if (shown.like) {
        var like = shown.like.cloneNode(true);
        like.classList.add('lb-like');
        like.setAttribute('aria-label', 'Like this photo');
        box.append(like);
      }
    }

    function step(direction) {
      var href = direction < 0 ? shown.prev : shown.next;
      if (!href || stepping) return;
      stepping = true;
      fetch(href)
        .then(function (res) {
          if (!res.ok) throw new Error('fail');
          return res.text();
        })
        .then(function (html) {
          stepping = false;
          if (!box) return;
          shown = readPage(new DOMParser().parseFromString(html, 'text/html'), href);
          render();
          history.replaceState(null, '', href);
        })
        .catch(function () {
          stepping = false;
          if (box) window.location.href = href;
        });
    }

    // Puts the photo you stopped on into the page behind the viewer, so closing needs no reload
    function swapPage(doc) {
      var page = document.querySelector('.photo-page');
      var fresh = doc.querySelector('.photo-page');
      var freshStage = fresh.querySelector('.photo-stage');
      var pastStage = false;

      swipeStage.replaceChildren.apply(swipeStage, Array.from(freshStage.childNodes));
      Array.from(page.children).forEach(function (el) {
        if (el !== swipeStage) el.remove();
      });
      Array.from(fresh.children).forEach(function (el) {
        if (el === freshStage) pastStage = true;
        else if (pastStage) page.append(el);
        else swipeStage.before(el);
      });

      document.title = doc.title;
      restoreBackLink();
      setupComments();
      prepareStageImage();
    }

    function closeBox() {
      var like = box.querySelector('.lb-like');
      if (location.href !== openedAt) swapPage(shown.doc);

      var pageLike = document.querySelector('.photo-actions .like-btn');
      if (like && pageLike) {
        pageLike.classList.toggle('liked', like.classList.contains('liked'));
        pageLike.setAttribute('aria-pressed', like.getAttribute('aria-pressed'));
        pageLike.querySelector('.like-count').textContent = like.querySelector('.like-count').textContent;
      }

      box.remove();
      box = null;
      document.body.classList.remove('lightbox-open');
      swipeStage.querySelector('img').focus({ preventScroll: true });
    }

    function button(cls, label, text, onClick) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'lb-btn ' + cls;
      el.setAttribute('aria-label', label);
      el.textContent = text;
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        onClick();
      });
      return el;
    }

    function openBox() {
      if (box) return;
      openedAt = location.href;
      shown = readPage(document, location.href);
      box = document.createElement('div');
      box.className = 'lightbox';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', 'Full-screen photo');
      box.append(
        button('lb-close', 'Close', '\u00d7', closeBox),
        button('lb-prev', 'Previous photo', '\u2039', function () { step(-1); }),
        button('lb-next', 'Next photo', '\u203a', function () { step(1); })
      );
      box.addEventListener('click', function (e) {
        if (!e.target.closest('.lb-like')) closeBox();
      });

      var boxX = 0, boxY = 0, boxTracking = false;
      box.addEventListener('touchstart', function (e) {
        boxTracking = e.touches.length === 1 && !(window.visualViewport && window.visualViewport.scale > 1);
        if (boxTracking) { boxX = e.touches[0].clientX; boxY = e.touches[0].clientY; }
      }, { passive: true });
      box.addEventListener('touchmove', function (e) {
        if (e.touches.length > 1) boxTracking = false;
      }, { passive: true });
      box.addEventListener('touchend', function (e) {
        if (!boxTracking) return;
        boxTracking = false;
        var dx = e.changedTouches[0].clientX - boxX;
        var dy = e.changedTouches[0].clientY - boxY;
        if (Math.abs(dx) >= 60 && Math.abs(dy) < Math.abs(dx) / 2) {
          e.preventDefault();
          step(dx < 0 ? 1 : -1);
        } else if (dy >= 80 && Math.abs(dx) < dy / 2) {
          e.preventDefault();
          closeBox();
        }
      });

      document.body.append(box);
      document.body.classList.add('lightbox-open');
      render();
      box.querySelector('.lb-close').focus({ preventScroll: true });
    }

    function prepareStageImage() {
      var stageImg = swipeStage.querySelector('img');
      stageImg.tabIndex = 0;
      stageImg.setAttribute('role', 'button');
      stageImg.setAttribute('aria-label', 'Open full screen: ' + stageImg.alt);
    }
    prepareStageImage();

    swipeStage.addEventListener('click', function (e) {
      if (e.target.tagName === 'IMG') openBox();
    });
    swipeStage.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'IMG' && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openBox();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (!box) return;
      if (e.key === 'Escape') closeBox();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });
  }

  // --- Album cards flip through their photos on hover ---
  var canHover = window.matchMedia('(hover: hover)').matches;
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (canHover && !calm) {
    document.querySelectorAll('.album-card[data-previews]').forEach(function (card) {
      var urls = card.getAttribute('data-previews').split(' ');
      var timer = null;
      var delay = null;
      var step = 0;

      function show() {
        var layer = document.createElement('img');
        layer.className = 'album-preview';
        layer.alt = '';
        layer.src = urls[step % urls.length];
        step += 1;
        layer.onload = function () {
          if (!timer) return;
          var older = card.querySelectorAll('.album-preview');
          (older.length ? older[older.length - 1] : card.querySelector('picture')).after(layer);
          requestAnimationFrame(function () { layer.classList.add('is-visible'); });
          for (var i = 0; i < older.length - 1; i++) older[i].remove();
        };
      }

      function start() {
        if (timer) return;
        urls.forEach(function (url) { new Image().src = url; });
        step = 0;
        timer = setInterval(show, 2200);
        delay = setTimeout(show, 500);
      }

      function stop() {
        clearInterval(timer);
        clearTimeout(delay);
        timer = null;
        card.querySelectorAll('.album-preview').forEach(function (layer) {
          layer.classList.remove('is-visible');
          setTimeout(function () { layer.remove(); }, 900);
        });
      }

      card.addEventListener('pointerenter', start);
      card.addEventListener('pointerleave', stop);
      card.addEventListener('focusin', start);
      card.addEventListener('focusout', stop);
    });
  }
})();
