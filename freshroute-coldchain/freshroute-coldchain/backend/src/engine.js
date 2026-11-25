// The write-side core: ingestion, alert lifecycle, offline sweep and driver events.
// All state changes happen in a transaction; SSE events are published only after COMMIT
// so subscribers never see something that later rolled back.
import { evaluateBreach, isStale } from './rules.js';

export function createEngine({ db, config, hub, repo, now = () => Date.now() }) {
  const q = {
    device: db.prepare('SELECT * FROM devices WHERE id = ?'),
    insertReading: db.prepare(
      'INSERT OR IGNORE INTO readings (device_id, ts, temp_c, door_open, battery, lat, lng, received_at) VALUES (?,?,?,?,?,?,?,?)',
    ),
    touchDevice: db.prepare("UPDATE devices SET status = 'ONLINE', last_seen_at = ? WHERE id = ?"),
    setLatest: db.prepare(
      `UPDATE devices SET last_reading_ts = ?, last_temp_c = ?, last_battery = ?, last_door_open = ?,
         last_lat = COALESCE(?, last_lat), last_lng = COALESCE(?, last_lng) WHERE id = ?`,
    ),
    newest: db.prepare('SELECT ts, temp_c AS tempC FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1'),
    window: db.prepare('SELECT ts, temp_c AS tempC FROM readings WHERE device_id = ? AND ts >= ? ORDER BY ts ASC'),
    openAlert: db.prepare("SELECT id FROM alerts WHERE device_id = ? AND type = ? AND status = 'OPEN'"),
    insertAlert: db.prepare(
      'INSERT INTO alerts (device_id, trip_id, type, message, peak_temp_c, opened_at) VALUES (?,?,?,?,?,?)',
    ),
    resolveAlert: db.prepare("UPDATE alerts SET status = 'RESOLVED', resolved_at = ? WHERE id = ?"),
    ackAlert: db.prepare('UPDATE alerts SET acked_by = ?, acked_at = ? WHERE id = ? AND acked_at IS NULL'),
    activeTrip: db.prepare("SELECT id FROM trips WHERE device_id = ? AND status = 'IN_PROGRESS' LIMIT 1"),
    staleDevices: db.prepare("SELECT id FROM devices WHERE status = 'ONLINE' AND last_seen_at <= ?"),
    setOffline: db.prepare("UPDATE devices SET status = 'OFFLINE' WHERE id = ?"),
    trip: db.prepare('SELECT * FROM trips WHERE id = ?'),
    eventByClientId: db.prepare('SELECT trip_id, applied FROM trip_events WHERE client_event_id = ?'),
    insertEvent: db.prepare(
      'INSERT INTO trip_events (trip_id, type, client_event_id, ts, user_id, applied, received_at) VALUES (?,?,?,?,?,?,?)',
    ),
  };

  // Node's sqlite is synchronous and single-connection, so BEGIN..COMMIT around sync code is atomic.
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const nowIso = () => new Date(now()).toISOString();
  const flush = (events) => events.forEach((e) => hub.publish(e));

  // ---- alert helpers (call inside a tx) -------------------------------------
  function raiseAlert(events, { deviceId, type, message, peakC = null }) {
    if (q.openAlert.get(deviceId, type)) return; // already open: never duplicate
    const trip = q.activeTrip.get(deviceId);
    const { lastInsertRowid } = q.insertAlert.run(deviceId, trip?.id ?? null, type, message, peakC, nowIso());
    events.push({ type: 'alert', data: repo.getAlert(Number(lastInsertRowid)) });
  }

  function resolveAlerts(events, deviceId, type) {
    const open = q.openAlert.get(deviceId, type);
    if (!open) return;
    q.resolveAlert.run(nowIso(), open.id);
    events.push({ type: 'alert', data: repo.getAlert(open.id) });
  }

  // ---- ingestion -------------------------------------------------------------
  /**
   * Store one already-validated reading.
   * Returns { status: 'stored' | 'duplicate' | 'unknown_device', late?: boolean }.
   */
  function ingest(r) {
    const device = q.device.get(r.deviceId);
    if (!device) return { status: 'unknown_device' };

    const events = [];
    let result;

    tx(() => {
      const inserted = q.insertReading.run(r.deviceId, r.ts, r.tempC, r.doorOpen ? 1 : 0, r.battery, r.lat, r.lng, nowIso()).changes === 1;

      // Any message we *receive* proves the link is alive (even a duplicate or a late one).
      const statusChanged = device.status !== 'ONLINE';
      q.touchDevice.run(nowIso(), r.deviceId);
      if (statusChanged) resolveAlerts(events, r.deviceId, 'DEVICE_OFFLINE');

      let isNewest = false;
      if (inserted) {
        // "Latest" state only moves forward in event time, so a late message can't rewind the dashboard.
        isNewest = !device.last_reading_ts || r.ts > device.last_reading_ts;
        if (isNewest) q.setLatest.run(r.ts, r.tempC, r.battery, r.doorOpen ? 1 : 0, r.lat, r.lng, r.deviceId);
        evaluateTemperature(events, r.deviceId);
      }

      result = { status: inserted ? 'stored' : 'duplicate', late: inserted && !isNewest };

      if (isNewest) {
        events.push({
          type: 'reading',
          data: {
            point: { deviceId: r.deviceId, ts: r.ts, tempC: r.tempC, doorOpen: r.doorOpen, battery: r.battery, lat: r.lat, lng: r.lng },
            device: repo.getDevice(r.deviceId),
          },
        });
      } else if (statusChanged) {
        events.push({ type: 'device', data: repo.getDevice(r.deviceId) });
      }
    });

    flush(events);
    return result;
  }

  function evaluateTemperature(events, deviceId) {
    const newest = q.newest.get(deviceId);
    if (!newest) return;
    const from = new Date(Date.parse(newest.ts) - (config.breachSeconds + 60) * 1000).toISOString();
    const verdict = evaluateBreach(q.window.all(deviceId, from), {
      thresholdC: config.tempThresholdC,
      windowSeconds: config.breachSeconds,
    });

    if (verdict.breached) {
      raiseAlert(events, {
        deviceId,
        type: 'TEMP_BREACH',
        peakC: verdict.peakC,
        message: `Temperature above ${config.tempThresholdC}°C for ${Math.round(verdict.durationSec)}s (peak ${verdict.peakC.toFixed(1)}°C)`,
      });
    } else if (newest.tempC <= config.tempThresholdC) {
      resolveAlerts(events, deviceId, 'TEMP_BREACH');
    }
  }

  // ---- offline sweep (run on a timer) ----------------------------------------
  function sweep() {
    const cutoff = new Date(now() - config.offlineSeconds * 1000).toISOString();
    const events = [];
    for (const { id } of q.staleDevices.all(cutoff)) {
      tx(() => {
        q.setOffline.run(id);
        raiseAlert(events, {
          deviceId: id,
          type: 'DEVICE_OFFLINE',
          message: `No data from ${id} for over ${config.offlineSeconds}s`,
        });
        events.push({ type: 'device', data: repo.getDevice(id) });
      });
    }
    flush(events);
    return events.length;
  }

  // ---- alerts -----------------------------------------------------------------
  function acknowledge(alertId, userId) {
    const events = [];
    tx(() => {
      q.ackAlert.run(userId, nowIso(), alertId);
      events.push({ type: 'alert', data: repo.getAlert(alertId) });
    });
    flush(events);
    return events[0].data;
  }

  // ---- driver events (offline-safe) -------------------------------------------
  /**
   * Record a driver event idempotently, keyed by clientEventId.
   * - Replays return { status: 'duplicate' } and change nothing.
   * - An event that is no longer applicable (e.g. START on an already-started trip) is still
   *   recorded as history with applied=false, so a stale offline queue can never get "stuck".
   */
  function recordTripEvent({ tripId, userId, type, clientEventId, ts }) {
    let result;
    tx(() => {
      const existing = q.eventByClientId.get(clientEventId);
      if (existing) {
        result = { status: existing.trip_id === tripId ? 'duplicate' : 'conflict', applied: !!existing.applied };
        return;
      }
      const trip = q.trip.get(tripId);
      let applied = false;
      if (type === 'TRIP_STARTED' && trip.status === 'ASSIGNED') {
        db.prepare("UPDATE trips SET status = 'IN_PROGRESS', started_at = ? WHERE id = ?").run(ts, tripId);
        applied = true;
      } else if (type === 'DELIVERY_CONFIRMED' && trip.status !== 'ASSIGNED' && !trip.delivered_at) {
        db.prepare('UPDATE trips SET delivered_at = ? WHERE id = ?').run(ts, tripId);
        applied = true;
      } else if (type === 'TRIP_COMPLETED' && trip.status === 'IN_PROGRESS') {
        db.prepare("UPDATE trips SET status = 'COMPLETED', completed_at = ? WHERE id = ?").run(ts, tripId);
        applied = true;
      }
      q.insertEvent.run(tripId, type, clientEventId, ts, userId, applied ? 1 : 0, nowIso());
      result = { status: 'recorded', applied };
    });

    if (result.status === 'recorded') hub.publish({ type: 'trip', data: repo.getTrip(tripId) });
    return result;
  }

  return { ingest, sweep, acknowledge, recordTripEvent, now };
}
