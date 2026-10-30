import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function versioned(url, file) {
  const content = readFileSync(fileURLToPath(new URL(`../public/${file}`, import.meta.url)));
  return `${url}?v=${createHash('sha256').update(content).digest('hex').slice(0, 10)}`;
}

// Hashed URLs, so no browser or CDN can serve an old file after a deploy
export const assets = {
  siteCss: versioned('/site.css', 'site.css'),
  siteJs: versioned('/site.js', 'site.js'),
  adminCss: versioned('/static/admin.css', 'admin.css'),
  adminJs: versioned('/static/admin.js', 'admin.js'),
};
