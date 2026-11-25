import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { signToken, verifyToken } from '../src/auth.js';

let t;
before(async () => { t = await startTestApp(); });
after(() => t.close());

test('login: wrong password and unknown user get the same 401', async () => {
  const a = await t.call('/api/auth/login', { method: 'POST', body: { username: 'driver1', password: 'nope' } });
  const b = await t.call('/api/auth/login', { method: 'POST', body: { username: 'ghost', password: 'nope' } });
  assert.equal(a.status, 401);
  assert.deepEqual(a.body, b.body);
});

test('protected endpoints require a valid token; tampered/expired tokens are rejected', async () => {
  assert.equal((await t.call('/api/trips')).status, 401);
  assert.equal((await t.call('/api/trips', { token: 'garbage' })).status, 401);

  const good = await t.login('driver1');
  const [h, p] = good.split('.');
  assert.equal((await t.call('/api/trips', { token: `${h}.${p}.AAAA` })).status, 401);

  const expired = signToken({ sub: 2, role: 'driver' }, t.config.jwtSecret, { ttlSeconds: 10, nowMs: Date.now() - 60_000 });
  assert.equal(verifyToken(expired, t.config.jwtSecret), null);
  assert.equal((await t.call('/api/trips', { token: expired })).status, 401);
});

test('ROLES: a driver sees only their own trips; a dispatcher sees all', async () => {
  const asha = await t.login('driver1');
  const ravi = await t.login('driver2');
  const dispatcher = await t.login('dispatcher');

  const ashaTrips = (await t.call('/api/trips', { token: asha })).body.trips;
  const raviTrips = (await t.call('/api/trips', { token: ravi })).body.trips;
  const allTrips = (await t.call('/api/trips', { token: dispatcher })).body.trips;

  assert.deepEqual(ashaTrips.map((x) => x.id), ['T-1', 'T-2', 'T-3', 'T-4', 'T-5']);
  assert.deepEqual(raviTrips.map((x) => x.id), ['T-6', 'T-7', 'T-8', 'T-9', 'T-10']);
  assert.equal(allTrips.length, 10);
});

test('ROLES: a driver cannot read, event, or chart another driver\'s trip', async () => {
  const asha = await t.login('driver1');
  for (const path of ['/api/trips/T-6', '/api/trips/T-6/readings', '/api/trips/T-6/timeline']) {
    assert.equal((await t.call(path, { token: asha })).status, 403, path);
  }
  const ev = await t.call('/api/trips/T-6/events', {
    method: 'POST', token: asha,
    body: { type: 'TRIP_STARTED', clientEventId: 'evt-forbidden-1', ts: t.iso() },
  });
  assert.equal(ev.status, 403);
  assert.equal((await t.call('/api/trips/T-999', { token: asha })).status, 404);
});

test('ROLES: drivers cannot use dispatcher-only endpoints', async () => {
  const asha = await t.login('driver1');
  for (const path of ['/api/devices', '/api/alerts', '/api/stream']) {
    assert.equal((await t.call(path, { token: asha })).status, 403, path);
  }
  assert.equal((await t.call('/api/alerts/1/ack', { method: 'POST', token: asha })).status, 403);
});

test('trip detail exposes live cargo temperature from the device', async () => {
  await t.ingest({ deviceId: 'TRK-03', ts: t.iso(), tempC: 5.8, battery: 66 });
  const asha = await t.login('driver1');
  const { body } = await t.call('/api/trips/T-3', { token: asha });
  assert.equal(body.trip.tempC, 5.8);
  assert.equal(body.trip.battery, 66);
});

// ---- driver events / offline sync ---------------------------------------------------
const ev = (type, id, ts) => ({ type, clientEventId: id, ts: ts ?? t.iso() });

test('OFFLINE SYNC: replaying the same clientEventId is a no-op (no duplicates)', async () => {
  const asha = await t.login('driver1');
  const body = ev('TRIP_STARTED', 'a1b2c3d4-0000-4000-8000-000000000001');
  const first = await t.call('/api/trips/T-3/events', { method: 'POST', token: asha, body });
  const replay = await t.call('/api/trips/T-3/events', { method: 'POST', token: asha, body });
  const replay2 = await t.call('/api/trips/T-3/events', { method: 'POST', token: asha, body });
  assert.deepEqual([first.status, replay.status, replay2.status], [201, 200, 200]);
  assert.equal(replay.body.status, 'duplicate');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM trip_events WHERE client_event_id = ?").get(body.clientEventId).n, 1);
  assert.equal(first.body.trip.status, 'IN_PROGRESS');
});

test('OFFLINE SYNC: a full queued sequence (start → deliver → complete) applies in order, with the driver\'s own timestamps', async () => {
  const asha = await t.login('driver1');
  const T4 = t.iso(-600), T5 = t.iso(-300), T6 = t.iso(-60); // happened while offline, synced now
  const post = (b) => t.call('/api/trips/T-4/events', { method: 'POST', token: asha, body: b });
  await post(ev('TRIP_STARTED', 'queued-evt-0001', T4));
  await post(ev('DELIVERY_CONFIRMED', 'queued-evt-0002', T5));
  const done = await post(ev('TRIP_COMPLETED', 'queued-evt-0003', T6));

  const trip = done.body.trip;
  assert.equal(trip.status, 'COMPLETED');
  assert.equal(trip.startedAt, T4);
  assert.equal(trip.deliveredAt, T5);
  assert.equal(trip.completedAt, T6);

  const timeline = (await t.call('/api/trips/T-4/timeline', { token: asha })).body.timeline;
  assert.deepEqual(timeline.map((x) => x.type), ['TRIP_STARTED', 'DELIVERY_CONFIRMED', 'TRIP_COMPLETED']);
  assert.ok(timeline.every((x) => x.syncedLate), 'events received long after they happened are flagged as synced-late');
});

test('OFFLINE SYNC: a stale event is recorded but does not corrupt state, and never blocks the queue', async () => {
  const asha = await t.login('driver1');
  // T-4 is already COMPLETED; a leftover START with a fresh id must not reopen it.
  const r = await t.call('/api/trips/T-4/events', { method: 'POST', token: asha, body: ev('TRIP_STARTED', 'stale-evt-00001') });
  assert.equal(r.status, 201);
  assert.equal(r.body.applied, false);
  assert.equal(r.body.trip.status, 'COMPLETED');
});

test('delivery can be confirmed once; a second confirmation (new id) does not move the timestamp', async () => {
  const asha = await t.login('driver1');
  await t.call('/api/trips/T-5/events', { method: 'POST', token: asha, body: ev('TRIP_STARTED', 'evt-t5-start-1') });
  const first = await t.call('/api/trips/T-5/events', { method: 'POST', token: asha, body: ev('DELIVERY_CONFIRMED', 'evt-t5-deliv-1', t.iso(-20)) });
  const second = await t.call('/api/trips/T-5/events', { method: 'POST', token: asha, body: ev('DELIVERY_CONFIRMED', 'evt-t5-deliv-2', t.iso(-5)) });
  assert.equal(first.body.applied, true);
  assert.equal(second.body.applied, false);
  assert.equal(second.body.trip.deliveredAt, first.body.trip.deliveredAt);
});

test('event payload is validated; a clientEventId cannot be reused on another trip; flat /api/events works', async () => {
  const asha = await t.login('driver1');
  assert.equal((await t.call('/api/trips/T-1/events', { method: 'POST', token: asha, body: { type: 'NOPE', clientEventId: 'x', ts: 'y' } })).status, 422);

  const body = ev('DELIVERY_CONFIRMED', 'cross-trip-evt-1');
  assert.equal((await t.call('/api/trips/T-1/events', { method: 'POST', token: asha, body })).status, 201);
  assert.equal((await t.call('/api/trips/T-2/events', { method: 'POST', token: asha, body })).status, 409);

  // the exact sample shape from the brief
  const flat = await t.call('/api/events', { method: 'POST', token: asha, body: { tripId: 'T-2', ...ev('DELIVERY_CONFIRMED', 'flat-sample-evt-1') } });
  assert.equal(flat.status, 201);
});
