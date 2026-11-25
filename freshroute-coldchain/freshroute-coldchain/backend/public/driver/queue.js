// Offline outbox for the driver app. Deliberately free of DOM/browser APIs so the same
// file runs in the browser and in the Node test-suite.
//
// Why duplicates cannot happen:
//   1. Every action gets a clientEventId (UUID) ONCE, when the driver taps the button.
//   2. The item stays in the outbox until the server acknowledges it (2xx).
//   3. If the request succeeded but the response was lost, the retry carries the SAME
//      clientEventId; the server's UNIQUE constraint turns it into a no-op.

export function newId(c = globalThis.crypto) {
  if (c?.randomUUID) return c.randomUUID();
  // crypto.randomUUID is unavailable on non-HTTPS origins (e.g. testing from a phone over LAN).
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

export function createOutbox(storage, key = 'outbox') {
  const read = () => {
    try {
      return JSON.parse(storage.getItem(key) || '[]');
    } catch {
      return [];
    }
  };
  const write = (list) => storage.setItem(key, JSON.stringify(list));
  return {
    locked: false,
    list: read,
    size: () => read().length,
    add({ tripId, type, ts }) {
      const item = { clientEventId: newId(), tripId, type, ts: ts || new Date().toISOString() };
      write([...read(), item]);
      return item;
    },
    remove(clientEventId) {
      write(read().filter((i) => i.clientEventId !== clientEventId));
    },
  };
}

/**
 * Send queued items in the order they were created, one at a time.
 * `send(item)` must resolve to one of:
 *   { ok: true }                    server has it (including "already had it") -> remove
 *   { drop: true, reason }          server permanently rejected it            -> remove + report
 *   { retry: true, reason? }        network/5xx/auth problem                  -> keep, stop, try later
 * Stopping at the first retryable failure preserves ordering (START before COMPLETE).
 */
export async function syncOutbox(outbox, send) {
  if (outbox.locked) return { skipped: true, sent: 0, dropped: [], stopped: false, stopReason: null, remaining: outbox.size() };
  outbox.locked = true; // single flight: overlapping timers/online events can't double-send
  const out = { skipped: false, sent: 0, dropped: [], stopped: false, stopReason: null };
  try {
    for (const item of outbox.list()) {
      const res = await send(item);
      if (res.ok) {
        outbox.remove(item.clientEventId);
        out.sent += 1;
      } else if (res.drop) {
        outbox.remove(item.clientEventId);
        out.dropped.push({ item, reason: res.reason });
      } else {
        out.stopped = true;
        out.stopReason = res.reason || 'network';
        break;
      }
    }
  } finally {
    outbox.locked = false;
  }
  out.remaining = outbox.size();
  return out;
}

/**
 * Optimistic UI: overlay not-yet-synced events on the last server snapshot of a trip.
 * Mirrors the server's transition rules (engine.recordTripEvent) so the screen matches
 * what the server will end up with.
 */
export function applyPending(trip, items) {
  const t = { ...trip, pending: 0 };
  for (const e of items) {
    if (e.tripId !== t.id) continue;
    t.pending += 1;
    if (e.type === 'TRIP_STARTED' && t.status === 'ASSIGNED') {
      t.status = 'IN_PROGRESS';
      t.startedAt = e.ts;
    } else if (e.type === 'DELIVERY_CONFIRMED' && t.status !== 'ASSIGNED' && !t.deliveredAt) {
      t.deliveredAt = e.ts;
    } else if (e.type === 'TRIP_COMPLETED' && t.status === 'IN_PROGRESS') {
      t.status = 'COMPLETED';
      t.completedAt = e.ts;
    }
  }
  return t;
}
