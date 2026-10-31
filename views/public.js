import { assets } from '../lib/assets.js';
import { escapeHtml } from './html.js';
import { derivedWidths } from '../lib/images.js';

const GRID_SIZES = '(max-width:640px) 33vw, 320px';
const MAIN_SIZES = 'min(100vw, 1600px)';
const CARD_SIZES = '(max-width:640px) 180px, 240px';

function formatDate(iso) {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(String(iso));
  if (!day) return '';
  // taken_at is the camera's wall clock, so the date must not pass through a timezone
  return new Date(`${day[0]}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function photoMeta(photo) {
  try {
    return JSON.parse(photo.meta) || {};
  } catch {
    return {};
  }
}

function pictureTag(photo, { isMain = false, sizes } = {}) {
  const widths = derivedWidths(photo.width || 960);
  const aspect = photo.width && photo.height ? (photo.width / photo.height) : 1.5;
  const alt = escapeHtml(photoMeta(photo).description || photo.caption || 'Photo');
  const loading = isMain ? '' : ' loading="lazy"';
  const sizesAttr = sizes || (isMain ? MAIN_SIZES : GRID_SIZES);
  const placeholder = photo.placeholder
    ? ` style="background-image:url('${escapeHtml(photo.placeholder)}');background-size:cover;background-position:center;"`
    : '';

  const version = photo.image_version ? `?v=${photo.image_version}` : '';
  const avifSrcset = widths.map((w) => {
    return `/img/${photo.id}/${w}.avif${version} ${w}w`;
  }).join(', ');

  const webpSrcset = widths.map((w) => {
    return `/img/${photo.id}/${w}.webp${version} ${w}w`;
  }).join(', ');

  const jpgSrcset = widths.map((w) => {
    return `/img/${photo.id}/${w}.jpg${version} ${w}w`;
  }).join(', ');

  const fallbackW = widths[0];
  const fallbackH = Math.round(fallbackW / aspect);

  return `<picture${placeholder}>${photo.avif_ready === 1 ? `<source type="image/avif" srcset="${avifSrcset}" sizes="${sizesAttr}">` : ''}<source type="image/webp" srcset="${webpSrcset}" sizes="${sizesAttr}"><img src="/img/${photo.id}/${fallbackW}.jpg${version}" srcset="${jpgSrcset}" sizes="${sizesAttr}" width="${fallbackW}" height="${fallbackH}"${loading} decoding="async" alt="${alt}"></picture>`;
}

function photoCell(photo, query = '') {
  const count = photo.like_count || 0;
  const overlay = count > 0
    ? `<span class="cell-overlay"><svg class="heart-icon" width="18" height="18" viewBox="0 0 24 24" fill="#f4611e" stroke="none" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg><span class="cell-like-count">${count}</span></span>`
    : '';
  return `<a href="/p/${photo.id}${query}" class="grid-cell">${pictureTag(photo)}${overlay}</a>`;
}

function albumCard(album, cardSizes) {
  let inner = '';
  if (album.cover) {
    inner += pictureTag(album.cover, { sizes: cardSizes });
  }
  inner += `<span class="card-overlay"><span class="card-title">${escapeHtml(album.title)}</span><span class="card-count">${album.photo_count} photo${album.photo_count !== 1 ? 's' : ''}</span></span>`;
  const flipThrough = album.previews && album.previews.length ? [...album.previews, album.cover] : [];
  const previews = flipThrough.map((p) => {
    const sizes = derivedWidths(p.width || 960);
    const width = sizes.filter((w) => w <= 960).at(-1) ?? sizes[0];
    return `/img/${escapeHtml(p.id)}/${width}.webp`;
  }).join(' ');
  const previewAttr = previews ? ` data-previews="${previews}"` : '';
  return `<a href="/a/${escapeHtml(album.slug)}" class="album-card"${previewAttr}>${inner}</a>`;
}

export function publicViews({ config }) {
const siteTitle = escapeHtml(config.siteTitle || 'Photos');
const siteTagline = escapeHtml(config.siteTagline || 'Photographs');
const blogLink = config.blogUrl ? `<a href="${escapeHtml(config.blogUrl)}">Blog</a>` : '';

function header(opts = {}) {
  const titleAttr = opts.hideTitle ? '' : `<a class="site-title" href="/">${siteTitle}</a>`;
  return `<header class="site-header">${titleAttr}<nav class="site-nav"><a href="/albums">Albums</a><a href="/explore">Explore</a>${blogLink}</nav></header>`;
}

function footer() {
  return `<footer class="site-footer"><p>© ${new Date().getFullYear()} ${siteTitle}</p></footer>`;
}

function shell(title, bodyContent, opts = {}) {
  const preloads = `<link rel="preload" href="/fonts/instrument-serif-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='12' fill='%23f4611e'/%3E%3C/svg%3E"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} \u2014 ${siteTitle}</title>${preloads}<link rel="stylesheet" href="${assets.siteCss}"></head><body>${header(opts)}<main>${bodyContent}</main>${footer()}<script src="${assets.siteJs}" defer></script></body></html>`;
}

  return {
    home({ albums, photos, page, totalPages }) {
      const masthead = `<section class="masthead"><h1 class="masthead-title">${siteTitle}</h1><p class="masthead-sub">${siteTagline}</p></section>`;

      let albumStrip = '';
      if (albums.length) {
        albumStrip = `<section class="album-strip-wrap"><div class="album-strip">`;
        for (const a of albums) {
          albumStrip += albumCard(a, CARD_SIZES);
        }
        albumStrip += '</div></section>';
      }

      let grid = '<div class="photo-grid">';
      if (photos.length) {
        grid += photos.map((p) => photoCell(p, '?from=latest')).join('');
      } else {
        grid += '<p class="empty">No photos yet.</p>';
      }
      grid += '</div>';

      let pagination = '';
      if (totalPages > 1) {
        pagination = '<nav class="pagination">';
        if (page > 1) pagination += `<a href="/?page=${page - 1}" rel="prev" class="pag-link">Previous</a>`;
        if (page < totalPages) pagination += `<a href="/?page=${page + 1}" rel="next" class="pag-link">Next</a>`;
        pagination += '</nav>';
      }

      return shell('Photos', masthead + albumStrip + grid + pagination, { hideTitle: true });
    },

    albums({ albums }) {
      let content = '<h1 class="page-title">Albums</h1>';
      if (albums.length) {
        content += '<div class="album-grid">';
        for (const a of albums) {
          content += albumCard(a, CARD_SIZES);
        }
        content += '</div>';
      } else {
        content += '<p class="empty">No albums yet.</p>';
      }
      return shell('Albums', content);
    },

    explore({ moods, details, colors, tags }) {
      const group = (title, rows) => rows.length
        ? `<h2 class="explore-heading">${title}</h2><p class="photo-labels">${rows.map((r) => `<a href="/tag/${encodeURIComponent(r.value)}">${escapeHtml(r.value)} <span>${r.n}</span></a>`).join('')}</p>`
        : '';
      const body = group('Moods', moods) + group('Light and scene', details) + group('Colors', colors) + group('Subjects', tags);
      return shell('Explore', `<h1 class="page-title">Explore</h1><div class="explore">${body || '<p class="empty">Nothing here yet.</p>'}</div>`);
    },

    albumDetail({ album, photos, photoCount }) {
      let content = `<h1 class="page-title">${escapeHtml(album.title)}</h1>`;
      if (album.description) content += `<p class="album-desc">${escapeHtml(album.description)}</p>`;
      if (photoCount != null) content += `<p class="album-count">${photoCount} photo${photoCount !== 1 ? 's' : ''}</p>`;
      content += '<div class="photo-grid">';
      if (photos.length) {
        content += photos.map((p) => photoCell(p)).join('');
      } else {
        content += '<p class="empty">No photos in this album.</p>';
      }
      content += '</div>';
      return shell(album.title, content);
    },

    photoDetail({ photo, album, liked, likeCount, comments, prev, next, navQuery = '', turnstileSiteKey, showComments = true, showLikes = true, showFullSize = true }) {
      const takenAt = photo.taken_at ? formatDate(photo.taken_at) : null;

      // EXIF definition list
      const exifItems = [];
      if (photo.camera) exifItems.push(['Camera', photo.camera]);
      if (photo.lens) exifItems.push(['Lens', photo.lens]);
      if (photo.focal) exifItems.push(['Focal length', photo.focal]);
      if (photo.aperture) exifItems.push(['Aperture', photo.aperture]);
      if (photo.shutter) exifItems.push(['Shutter', photo.shutter]);
      if (photo.iso) exifItems.push(['ISO', String(photo.iso)]);
      if (photo.mode) exifItems.push(['Mode', photo.mode]);
      if (photo.software) exifItems.push(['Edited in', photo.software]);
      if (photo.cropped) exifItems.push(['Cropped', photo.cropped]);
      const exifDl = exifItems.length
        ? `<dl class="exif-dl">${exifItems.map(([k, v]) => `<div class="exif-item"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`
        : '';

      // Album link and date
      let metaLine = '';
      const parts = [];
      if (album) parts.push(`<a href="/a/${escapeHtml(album.slug)}">${escapeHtml(album.title)}</a>`);
      if (takenAt) parts.push(escapeHtml(takenAt));
      if (parts.length) metaLine = `<p class="photo-meta">${parts.join(' \u00B7 ')}</p>`;

      const meta = photoMeta(photo);
      const labels = [...(meta.tags || []), ...(meta.moods || []), ...(meta.details || []), ...(meta.colors || [])];
      const palette = (meta.palette || []).filter((hex) => /^#[0-9a-f]{6}$/.test(hex));
      const caption = [
        photo.caption ? `<p class="photo-caption">${escapeHtml(photo.caption)}</p>` : '',
        meta.description ? `<p class="photo-description">${escapeHtml(meta.description)}</p>` : '',
        palette.length ? `<p class="photo-palette">${palette.map((hex) => `<span style="background:${hex}" title="${hex}"></span>`).join('')}</p>` : '',
        labels.length ? `<p class="photo-labels">${labels.map((l) => `<a href="/tag/${encodeURIComponent(l)}">${escapeHtml(l)}</a>`).join('')}</p>` : '',
      ].join('');

      // Like button
      const likedClass = liked ? ' liked' : '';
      const likeBtn = `<button class="like-btn${likedClass}" data-action="like" data-photo-id="${escapeHtml(photo.id)}" type="button" aria-pressed="${liked ? 'true' : 'false'}"><svg class="like-svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg> <span class="like-count">${likeCount}</span></button>`;
      const fullSize = `<a class="full-size" href="/img/${escapeHtml(photo.id)}/${derivedWidths(photo.width || 960).at(-1)}.jpg${photo.image_version ? `?v=${photo.image_version}` : ''}" target="_blank" rel="noopener">Full size</a>`;

      // Prev/Next nav
      const chevronLeft = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;
      const chevronRight = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>`;
      let navHtml = '';
      if (prev) navHtml += `<a href="/p/${escapeHtml(prev.id)}${navQuery}" class="photo-nav-btn prev-btn" aria-label="Previous photo">${chevronLeft}</a>`;
      if (next) navHtml += `<a href="/p/${escapeHtml(next.id)}${navQuery}" class="photo-nav-btn next-btn" aria-label="Next photo">${chevronRight}</a>`;
      const touchNav = `<div class="touch-nav">${prev ? `<a href="/p/${escapeHtml(prev.id)}${navQuery}" class="touch-nav-btn" aria-label="Previous photo">${chevronLeft}</a>` : ''}${next ? `<a href="/p/${escapeHtml(next.id)}${navQuery}" class="touch-nav-btn" aria-label="Next photo">${chevronRight}</a>` : ''}</div>`;

      // Back link
      const backHref = album ? `/a/${escapeHtml(album.slug)}` : '/';
      const backText = album ? escapeHtml(album.title) : 'All photos';
      const backLinkChevron = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;
      const backLink = `<div class="back-row"><a href="${backHref}" class="back-link" aria-label="Go back">${backLinkChevron}<span>${backText}</span></a></div>`;

      // Stage
      const stage = `<div class="photo-stage">${pictureTag(photo, { isMain: true })}${navHtml}</div>`;

      // Comments
      let commentsHtml = '';
      if (comments.length) {
        commentsHtml = '<section class="comments"><h2 class="section-heading">Comments</h2>';
        for (const cm of comments) {
          const cDate = cm.created_at ? formatDate(cm.created_at) : '';
          commentsHtml += `<div class="comment"><span class="comment-author">${escapeHtml(cm.author)}</span>${cDate ? `<span class="comment-date">${escapeHtml(cDate)}</span>` : ''}<p class="comment-body">${escapeHtml(cm.body)}</p></div>`;
        }
        commentsHtml += '</section>';
      }

      // Comment form
      const commentForm = `<section class="comment-form" data-action="comment" data-photo-id="${escapeHtml(photo.id)}" data-sitekey="${escapeHtml(turnstileSiteKey || '')}">
<h2 class="section-heading">Leave a comment</h2>
<form method="post" action="/api/photos/${escapeHtml(photo.id)}/comments">
<label class="form-label">Name<input name="author" type="text" maxlength="40" required autocomplete="name"></label>
<label class="form-label">Email (optional)<input name="email" type="email" maxlength="254" autocomplete="email"></label>
<label class="form-label">Comment<textarea name="body" maxlength="1000" required></textarea></label>
<div class="hp-field"><input name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true"></div>
<div id="turnstile-container"></div>
<button type="submit" class="submit-btn">Post</button>
<p class="form-msg" aria-live="polite"></p>
</form>
<p class="review-note">Comments are reviewed before they appear. Your email is only for replying to you and is never shown on the site.</p>
</section>`;

      // Left column
      const leftCol = `<div class="photo-left">${caption}${metaLine}${exifDl}<div class="photo-actions">${showLikes ? likeBtn : ''}${showFullSize ? fullSize : ''}</div></div>`;

      // Right column
      const rightCol = `<div class="photo-right">${commentsHtml}${showComments ? commentForm : ''}</div>`;

      const content = `<article class="photo-page">${backLink}${stage}${touchNav}<div class="photo-columns">${leftCol}${rightCol}</div></article>`;

      return shell(photo.caption || 'Photo', content);
    },

    notFound() {
      const content = `<section class="not-found"><h1 class="nf-title">404</h1><p class="nf-msg">This page does not exist.</p><p><a href="/" class="nf-link">Back home</a></p></section>`;
      return shell('Not found', content);
    },
  };
}
