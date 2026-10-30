import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { config } from './lib/config.js';
import { openDb } from './lib/db.js';
import { startWorker } from './lib/worker.js';
import { adminRoutes } from './routes/admin.js';
import { publicRoutes } from './routes/public.js';

const dataDir = config.dataDir;
mkdirSync(join(dataDir, 'originals'), { recursive: true });
mkdirSync(join(dataDir, 'derived'), { recursive: true });

const dbPath = join(dataDir, 'photos.sqlite');
const db = openDb(dbPath);

const stopWorker = startWorker(db, dataDir);

const root = new Hono();
root.route('/admin', adminRoutes({ db, config, dataDir }));
root.route('/', publicRoutes({ db, config, dataDir }));

const server = serve({ fetch: root.fetch, port: config.port });

console.log(`Listening on port ${config.port}`);

function shutdown() {
  console.log('Shutting down…');
  stopWorker();
  server.close();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
