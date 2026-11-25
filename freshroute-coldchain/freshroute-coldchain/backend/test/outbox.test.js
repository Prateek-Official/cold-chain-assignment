// Tests the driver app's real offline queue (public/driver/queue.js) against the real server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { createOutbox, syncOutbox, applyPending, newId } from '../public/driver/queue.js';

let t;
before(async () => { t = await startTestApp(); });
after(() => t.close());

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

/** Same decision table as the real app: 2xx ok, 401/5xx/network retry, other 4xx drop. */
function makeSender(token, { loseResponseFor = new Set(), offline = () => false } = {}) {
  const attempts = [];
  const send = async (item) => {
    attempts.push(item.clientEventId);
    if (offline()) return { retry: true };
    const res = await t.call(`/api/trips/${item.tripId}/events`, {
      method: 'POST', token,
      body: { type: item.type, clientEventId: item.clientEventId, ts: item.ts },
    });
    // the server processed it, but the phone never saw the response (tunnel, airplane mode…)
    if (loseResponseFor.delete(item.clientEventId)) return { retry: true }; // only the first attempt loses its response
    if (res.status < 300) return { ok: true };
    if (res.status === 401 || res.status >= 500) return { retry: true };
    return { drop: true, reason: res.body.error };
  };
  return { send, attempts };
}

test('airplane mode: actions queue locally, then sync once back online with no duplicates', async () => {
  const token = await t.login('driver1');
  const outbox = createOutbox(memoryStorage());
  let offline = true;
  const { send } = makeSender(token, { offline: () => offline });

  outbox.add({ tripId: 'T-3', type: 'TRIP_STARTED', ts: t.iso(-300) });
  outbox.add({ tripId: 'T-3', type: 'DELIVERY_CONFIRMED', ts: t.iso(-100) });

  let r = await syncOutbox(outbox, send);
  assert.equal(r.sent, 0);
  assert.equal(r.stopped, true);
  assert.equal(outbox.size(), 2, 'nothing is lost while offline');

  offline = false;
  r = await syncOutbox(outbox, send);
  assert.equal(r.sent, 2);
  assert.equal(outbox.size(), 0);

  const trip = (await t.call('/api/trips/T-3', { token })).body.trip;
  assert.equal(trip.status, 'IN_PROGRESS');
  assert.ok(trip.deliveredAt);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM trip_events WHERE trip_id = 'T-3'").get().n, 2);
});

test('lost response: the server got the event but the phone did not hear back -> retry is safe', async () => {
  const token = await t.login('driver1');
  const outbox = createOutbox(memoryStorage());
  const item = outbox.add({ tripId: 'T-4', type: 'TRIP_STARTED', ts: t.iso() });
  const { send, attempts } = makeSender(token, { loseResponseFor: new Set([item.clientEventId]) });

  const first = await syncOutbox(outbox, send);
  assert.equal(first.sent, 0);
  assert.equal(outbox.size(), 1, 'kept because we never saw the ack');

  const second = await syncOutbox(outbox, send);
  assert.equal(second.sent, 1);
  assert.equal(attempts.filter((id) => id === item.clientEventId).length, 2, 'it really was sent twice');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM trip_events WHERE client_event_id = ?').get(item.clientEventId).n, 1, '...but stored once');
});

test('overlapping sync triggers (timer + "online" event) are single-flight', async () => {
  const token = await t.login('driver1');
  const outbox = createOutbox(memoryStorage());
  outbox.add({ tripId: 'T-5', type: 'TRIP_STARTED', ts: t.iso() });
  const { send, attempts } = makeSender(token);

  const [a, b] = await Promise.all([syncOutbox(outbox, send), syncOutbox(outbox, send)]);
  assert.equal(attempts.length, 1);
  assert.equal([a, b].filter((x) => x.skipped).length, 1);
});

test('a permanently rejected event is dropped and reported instead of blocking the queue forever', async () => {
  const token = await t.login('driver1');
  const outbox = createOutbox(memoryStorage());
  outbox.add({ tripId: 'T-6', type: 'TRIP_STARTED', ts: t.iso() }); // belongs to driver2 => 403
  outbox.add({ tripId: 'T-1', type: 'DELIVERY_CONFIRMED', ts: t.iso() });
  const { send } = makeSender(token);
  const r = await syncOutbox(outbox, send);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.sent, 1);
  assert.equal(outbox.size(), 0);
});

test('applyPending gives the driver instant feedback that matches what the server will do', () => {
  const trip = { id: 'T-9', status: 'ASSIGNED', startedAt: null, deliveredAt: null, completedAt: null };
  const items = [
    { tripId: 'T-9', type: 'TRIP_STARTED', ts: 'a' },
    { tripId: 'T-9', type: 'DELIVERY_CONFIRMED', ts: 'b' },
    { tripId: 'OTHER', type: 'TRIP_COMPLETED', ts: 'c' },
  ];
  const v = applyPending(trip, items);
  assert.equal(v.status, 'IN_PROGRESS');
  assert.equal(v.deliveredAt, 'b');
  assert.equal(v.pending, 2);
  assert.equal(trip.status, 'ASSIGNED', 'input is not mutated');
});

test('newId makes valid, unique UUIDs even without crypto.randomUUID', () => {
  const fallback = { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); return b; } };
  const ids = new Set(Array.from({ length: 200 }, () => newId(fallback)));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
