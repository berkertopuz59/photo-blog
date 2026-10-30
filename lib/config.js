import { resolve } from 'node:path';

const DEV_SESSION_SECRET = 'dev-session-secret-change-me';
const DEV_VISITOR_SECRET = 'dev-visitor-secret-change-me';
const DEV_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
const DEV_TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
const DEV_ADMIN_USERNAME = 'admin';

const REQUIRED_IN_PROD = [
  'SITE_URL',
  'ADMIN_PASSWORD_HASH',
  'ADMIN_USERNAME',
  'SESSION_SECRET',
  'VISITOR_SECRET',
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET',
];

export function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';

  if (isProd) {
    for (const key of REQUIRED_IN_PROD) {
      if (!env[key]) {
        throw new Error(`Missing required env var in production: ${key}`);
      }
    }
  }

  const rawPort = env.PORT;
  const port = rawPort ? parseInt(rawPort, 10) : 3000;
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: "${rawPort}"`);
  }

  return Object.freeze({
    dataDir: resolve(env.DATA_DIR || './data'),
    port,
    siteUrl: env.SITE_URL || 'http://localhost:3000',
    siteTitle: env.SITE_TITLE || 'Photos',
    siteTagline: env.SITE_TAGLINE || 'Photographs',
    blogUrl: env.BLOG_URL || '',
    captionApiUrl: env.CAPTION_API_URL || '',
    captionApiKey: env.CAPTION_API_KEY || '',
    captionModel: env.CAPTION_MODEL || '',
    adminPasswordHash: env.ADMIN_PASSWORD_HASH || 'dev$00$dev',
    adminUsername: env.ADMIN_USERNAME || DEV_ADMIN_USERNAME,
    sessionSecret: env.SESSION_SECRET || DEV_SESSION_SECRET,
    visitorSecret: env.VISITOR_SECRET || DEV_VISITOR_SECRET,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || DEV_TURNSTILE_SITE_KEY,
    turnstileSecret: env.TURNSTILE_SECRET || DEV_TURNSTILE_SECRET,
    trustCf: env.TRUST_CF === '1',
    isProd,
  });
}

export const config = loadConfig();
