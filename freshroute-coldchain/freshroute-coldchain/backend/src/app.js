import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRouter } from './routes.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(deps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.use('/api', createRouter(deps));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Dispatcher dashboard at /, driver PWA at /driver/
  app.use('/driver', express.static(join(publicDir, 'driver'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  app.use('/', express.static(join(publicDir, 'dashboard'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
