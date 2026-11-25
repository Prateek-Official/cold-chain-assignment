import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { seedIfEmpty } from './seed.js';
import { createHub } from './sse.js';
import { createRepo } from './repo.js';
import { createEngine } from './engine.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(config.dbPath);
if (seedIfEmpty(db)) console.log('[seed] created demo users, 10 devices and 10 trips');

const hub = createHub();
const repo = createRepo(db);
const engine = createEngine({ db, config, hub, repo });
const app = createApp({ db, config, engine, hub, repo });

const server = app.listen(config.port, () => {
  console.log(`[api] listening on :${config.port}  (db: ${config.dbPath})`);
  console.log(`[api] rules: >${config.tempThresholdC}°C for ${config.breachSeconds}s => alert; silent ${config.offlineSeconds}s => offline`);
});

// Offline detection runs on a timer because a silent device, by definition, sends nothing to react to.
const sweepTimer = setInterval(() => {
  try {
    engine.sweep();
  } catch (err) {
    console.error('[sweep] failed', err);
  }
}, config.sweepMs);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(sweepTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
