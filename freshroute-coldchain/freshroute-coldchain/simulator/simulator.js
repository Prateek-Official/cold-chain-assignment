// IoT simulator: 10 trucks, one reading each every 5 s, POSTed to the ingestion endpoint.
// Injects the three required faults: temperature spike, device offline, duplicate/late messages.
//
//   node simulator.js                       # scripted faults + light random duplicates/late
//   curl -X POST localhost:4100/fault -d '{"deviceId":"TRK-03","fault":"spike"}' -H 'content-type: application/json'
//
// Faults: spike {seconds=180} | offline {seconds=90} | duplicate | late | clear
import http from 'node:http';

const cfg = {
  apiUrl: process.env.API_URL || 'http://localhost:3000',
  deviceKey: process.env.DEVICE_API_KEY || 'dev-device-key',
  intervalMs: Number(process.env.INTERVAL_MS || 5000),
  deviceCount: Number(process.env.DEVICE_COUNT || 10),
  controlPort: Number(process.env.CONTROL_PORT || 4100),
  autoFaults: process.env.AUTO_FAULTS !== 'false',
  dupRate: Number(process.env.DUP_RATE || 0.06), // chance a reading is also sent twice
  lateRate: Number(process.env.LATE_RATE || 0.05), // chance a reading is held back 25-45 s
};

const rnd = (a, b) => a + Math.random() * (b - a);
const round1 = (n) => Math.round(n * 10) / 10;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[sim]', ...a);

const ids = Array.from({ length: cfg.deviceCount }, (_, i) => `TRK-${String(i + 1).padStart(2, '0')}`);
const devices = new Map(
  ids.map((id) => {
    const base = rnd(3.5, 5.5);
    return [id, { id, base, temp: base, battery: rnd(70, 100), lat: 18.5 + rnd(-0.3, 0.3), lng: 73.8 + rnd(-0.3, 0.3), heading: rnd(0, 6.28),
      doorOpenUntil: 0, spikeUntil: 0, offlineUntil: 0, forceDuplicate: false, forceLate: false }];
  }),
);

function nextReading(d, nowMs) {
  // Door opens now and then, which nudges the temperature up a little.
  if (!d.doorOpenUntil && Math.random() < 0.015) d.doorOpenUntil = nowMs + rnd(10_000, 20_000);
  if (d.doorOpenUntil && nowMs > d.doorOpenUntil) d.doorOpenUntil = 0;
  const doorOpen = d.doorOpenUntil > 0;

  const target = d.spikeUntil > nowMs ? 11.5 : d.base + (doorOpen ? 1.5 : 0);
  d.temp += (target - d.temp) * (d.spikeUntil > nowMs ? 0.25 : 0.2) + rnd(-0.15, 0.15);
  d.battery = Math.max(1, d.battery - rnd(0.01, 0.05));
  d.heading += rnd(-0.2, 0.2);
  d.lat += Math.sin(d.heading) * 0.0004;
  d.lng += Math.cos(d.heading) * 0.0004;

  return {
    deviceId: d.id,
    ts: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tempC: round1(d.temp),
    doorOpen,
    battery: Math.round(d.battery),
    lat: Math.round(d.lat * 1e5) / 1e5,
    lng: Math.round(d.lng * 1e5) / 1e5,
  };
}

let failures = 0;
async function send(reading, tag = '') {
  try {
    const res = await fetch(`${cfg.apiUrl}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-key': cfg.deviceKey },
      body: JSON.stringify(reading),
      signal: AbortSignal.timeout(4000),
    });
    if (failures) log('API reachable again');
    failures = 0;
    if (res.status >= 400) log(`rejected ${reading.deviceId} ${tag} -> HTTP ${res.status} ${await res.text()}`);
  } catch (err) {
    if (failures++ % 6 === 0) log(`cannot reach API at ${cfg.apiUrl} (${err.cause?.code || err.message}); will keep trying`);
  }
}

function tick() {
  const nowMs = Date.now();
  for (const d of devices.values()) {
    if (d.offlineUntil > nowMs) continue; // device is "dead": sends nothing at all
    const reading = nextReading(d, nowMs);

    if (d.forceLate || Math.random() < cfg.lateRate) {
      d.forceLate = false;
      const delay = rnd(25_000, 45_000);
      log(`LATE      ${d.id} reading from ${reading.ts} delivered in ${Math.round(delay / 1000)}s`);
      setTimeout(() => send(reading, '(late)'), delay);
      continue;
    }
    send(reading);
    if (d.forceDuplicate || Math.random() < cfg.dupRate) {
      d.forceDuplicate = false;
      log(`DUPLICATE ${d.id} ${reading.ts} sent 3 extra times`);
      for (let i = 1; i <= 3; i++) setTimeout(() => send(reading, '(dup)'), i * 400);
    }
  }
}

function applyFault({ deviceId, fault, seconds }) {
  const d = devices.get(deviceId);
  if (fault === 'clear') {
    for (const x of devices.values()) { x.spikeUntil = 0; x.offlineUntil = 0; }
    return 'all faults cleared';
  }
  if (!d) throw new Error(`unknown device ${deviceId}`);
  const nowMs = Date.now();
  switch (fault) {
    case 'spike': d.spikeUntil = nowMs + (seconds ?? 180) * 1000; return `${d.id}: temperature spike for ${seconds ?? 180}s`;
    case 'offline': d.offlineUntil = nowMs + (seconds ?? 90) * 1000; return `${d.id}: offline for ${seconds ?? 90}s`;
    case 'duplicate': d.forceDuplicate = true; return `${d.id}: next reading will be duplicated`;
    case 'late': d.forceLate = true; return `${d.id}: next reading will be delivered late`;
    default: throw new Error(`unknown fault "${fault}" (spike | offline | duplicate | late | clear)`);
  }
}

// ---- control server (used by the dashboard's demo panel, or curl) ------------------
http
  .createServer((req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
    if (req.method === 'GET' && req.url === '/state') {
      const now = Date.now();
      return reply(200, [...devices.values()].map((d) => ({ id: d.id, tempC: round1(d.temp), spiking: d.spikeUntil > now, offline: d.offlineUntil > now })));
    }
    if (req.method === 'POST' && req.url === '/fault') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          const message = applyFault(JSON.parse(raw || '{}'));
          log(`FAULT     ${message}`);
          reply(200, { ok: true, message });
        } catch (err) {
          reply(400, { ok: false, error: err.message });
        }
      });
      return;
    }
    reply(404, { error: 'not found' });
  })
  .listen(cfg.controlPort, () => log(`control API on :${cfg.controlPort}`));

// ---- scripted faults so a fresh `docker compose up` demos itself ---------------------
if (cfg.autoFaults) {
  setTimeout(() => log('FAULT    ', applyFault({ deviceId: 'TRK-02', fault: 'spike', seconds: 240 })), 40_000);
  setTimeout(() => log('FAULT    ', applyFault({ deviceId: 'TRK-07', fault: 'offline', seconds: 100 })), 70_000);
  setInterval(() => {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const fault = Math.random() < 0.5 ? 'spike' : 'offline';
    log('FAULT    ', applyFault({ deviceId: id, fault, seconds: fault === 'spike' ? 170 : 80 }));
  }, 4 * 60_000);
}

log(`starting: ${ids.length} devices every ${cfg.intervalMs / 1000}s -> ${cfg.apiUrl}  (auto faults: ${cfg.autoFaults})`);
tick();
setInterval(tick, cfg.intervalMs);
