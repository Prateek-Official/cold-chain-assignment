import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { authenticate, requireRole, signToken, verifyPassword } from './auth.js';
import { validateReading, validateTripEvent } from './validation.js';

const safeEqual = (a = '', b = '') => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createRouter({ db, config, engine, hub, repo }) {
  const router = express.Router();
  const auth = authenticate(config);
  const dispatcherOnly = [auth, requireRole('dispatcher')];
  const vctx = () => ({ nowMs: engine.now(), maxFutureSeconds: config.maxFutureSeconds });

  // ---- public ----------------------------------------------------------------
  router.get('/health', (_req, res) => res.json({ ok: true, time: new Date(engine.now()).toISOString() }));

  router.get('/config', (_req, res) =>
    res.json({
      tempThresholdC: config.tempThresholdC,
      breachSeconds: config.breachSeconds,
      offlineSeconds: config.offlineSeconds,
    }),
  );

  router.post('/auth/login', (req, res) => {
    const { username, password } = req.body ?? {};
    const user =
      typeof username === 'string' ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
    // Same error for unknown user and wrong password (no user enumeration).
    if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid username or password' });
    const profile = { id: user.id, username: user.username, name: user.name, role: user.role };
    const token = signToken({ sub: user.id, ...profile }, config.jwtSecret);
    res.json({ token, user: profile });
  });

  // ---- device ingestion (device key, not user login) --------------------------
  router.post('/ingest', (req, res) => {
    if (!safeEqual(req.get('x-device-key'), config.deviceKey))
      return res.status(401).json({ error: 'Invalid device key' });

    const batch = Array.isArray(req.body);
    const items = batch ? req.body : [req.body];
    if (items.length > config.maxBatch) return res.status(413).json({ error: `Batch limited to ${config.maxBatch}` });

    const results = items.map((item) => {
      const v = validateReading(item, vctx());
      if (!v.ok) return { status: 'rejected', errors: v.errors };
      const r = engine.ingest(v.value);
      return r.status === 'unknown_device' ? { status: 'rejected', errors: [`unknown device ${v.value.deviceId}`] } : r;
    });

    if (batch) return res.json({ results });
    const [one] = results;
    res.status(one.status === 'rejected' ? 422 : one.status === 'stored' ? 201 : 200).json(one);
  });

  // ---- everything below needs a user token -------------------------------------
  router.get('/me', auth, (req, res) => res.json({ user: req.user }));

  // Live stream for the dispatcher dashboard
  router.get('/stream', ...dispatcherOnly, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    hub.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => clearInterval(ping));
  });

  // Devices (dispatcher)
  router.get('/devices', ...dispatcherOnly, (_req, res) => res.json({ devices: repo.listDevices() }));

  router.get('/devices/:id', ...dispatcherOnly, (req, res) => {
    const device = repo.getDevice(req.params.id);
    return device ? res.json({ device }) : res.status(404).json({ error: 'Device not found' });
  });

  router.get('/devices/:id/readings', ...dispatcherOnly, (req, res) => {
    if (!repo.getDevice(req.params.id)) return res.status(404).json({ error: 'Device not found' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 150, 1), 2000);
    res.json({ readings: repo.readings(req.params.id, { from: req.query.from, to: req.query.to, limit }) });
  });

  // Alerts (dispatcher)
  router.get('/alerts', ...dispatcherOnly, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    res.json({ alerts: repo.listAlerts({ status: req.query.status, limit }) });
  });

  router.post('/alerts/:id/ack', ...dispatcherOnly, (req, res) => {
    const id = Number(req.params.id);
    if (!repo.getAlert(id)) return res.status(404).json({ error: 'Alert not found' });
    res.json({ alert: engine.acknowledge(id, req.user.id) });
  });

  // Trips: dispatcher sees all, driver only their own.
  router.get('/trips', auth, (req, res) =>
    res.json({ trips: repo.listTrips(req.user.role === 'driver' ? req.user.id : null) }),
  );

  /** Loads :id and enforces ownership. Drivers get 403 for trips that are not theirs. */
  function tripAccess(req, res, next) {
    const trip = repo.getTrip(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (req.user.role === 'driver' && trip.driverId !== req.user.id)
      return res.status(403).json({ error: 'This trip is not assigned to you' });
    req.trip = trip;
    next();
  }

  router.get('/trips/:id', auth, tripAccess, (req, res) => res.json({ trip: req.trip }));

  router.get('/trips/:id/readings', auth, tripAccess, (req, res) =>
    res.json({ readings: repo.tripReadings(req.trip, { nowMs: engine.now() }) }),
  );

  router.get('/trips/:id/timeline', auth, tripAccess, (req, res) =>
    res.json({ timeline: repo.timeline(req.trip.id) }),
  );

  // Driver event, idempotent on clientEventId. Registered at two paths: nested, and the flat
  // shape from the case-study sample ({ tripId, type, clientEventId, ts }).
  function postEvent(req, res, tripId) {
    const trip = repo.getTrip(tripId);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (req.user.role === 'driver' && trip.driverId !== req.user.id)
      return res.status(403).json({ error: 'This trip is not assigned to you' });

    const v = validateTripEvent(req.body, vctx());
    if (!v.ok) return res.status(422).json({ error: v.errors.join('; '), errors: v.errors });

    const r = engine.recordTripEvent({ tripId, userId: req.user.id, ...v.value });
    if (r.status === 'conflict') return res.status(409).json({ error: 'clientEventId already used for another trip' });
    res.status(r.status === 'recorded' ? 201 : 200).json({ ...r, trip: repo.getTrip(tripId) });
  }
  router.post('/trips/:id/events', auth, (req, res) => postEvent(req, res, req.params.id));
  router.post('/events', auth, (req, res) => postEvent(req, res, String(req.body?.tripId ?? '')));

  // ---- demo helper: dashboard buttons -> simulator control port ------------------
  router.post('/demo/fault', ...dispatcherOnly, async (req, res) => {
    try {
      const r = await fetch(`${config.simUrl}/fault`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(3000),
      });
      res.status(r.ok ? 200 : 502).json(await r.json().catch(() => ({})));
    } catch {
      res.status(502).json({ error: 'Simulator is not reachable' });
    }
  });

  return router;
}
