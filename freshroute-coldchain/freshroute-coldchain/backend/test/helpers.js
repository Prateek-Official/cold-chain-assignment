// Test harness: real Express app + real SQLite (in-memory) on an ephemeral port,
// with a controllable clock so time-based rules run instantly and deterministically.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/seed.js';
import { createHub } from '../src/sse.js';
import { createRepo } from '../src/repo.js';
import { createEngine } from '../src/engine.js';
import { createApp } from '../src/app.js';

export const T0 = Date.parse('2026-11-20T08:00:00Z');

export async function startTestApp(envOverrides = {}) {
  const clock = { t: T0, now: () => clock.t, advance(sec) { clock.t += sec * 1000; } };
  const config = loadConfig({ DB_PATH: ':memory:', ...envOverrides });
  const db = openDb(':memory:');
  seedIfEmpty(db, clock.t);
  const hub = createHub();
  const repo = createRepo(db);
  const engine = createEngine({ db, config, hub, repo, now: clock.now });
  const app = createApp({ db, config, engine, hub, repo });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const tokens = {};
  async function login(username, password) {
    const pw = password ?? (username === 'dispatcher' ? 'dispatch123' : 'driver123');
    const r = await call('/api/auth/login', { method: 'POST', body: { username, password: pw } });
    if (r.status !== 200) throw new Error(`login failed for ${username}: ${r.status}`);
    return (tokens[username] = r.body.token);
  }

  const iso = (offsetSec = 0) => new Date(clock.t + offsetSec * 1000).toISOString();

  /** POST one reading as the device would. Defaults to "now" on the test clock. */
  const ingest = (overrides = {}) =>
    call('/api/ingest', {
      method: 'POST',
      headers: { 'x-device-key': config.deviceKey },
      body: { deviceId: 'TRK-01', ts: iso(), tempC: 5, doorOpen: false, battery: 90, ...overrides },
    });

  return {
    baseUrl, call, login, tokens, clock, iso, ingest, db, config, engine,
    close: () => new Promise((resolve) => { server.close(() => { db.close(); resolve(); }); }),
  };
}
