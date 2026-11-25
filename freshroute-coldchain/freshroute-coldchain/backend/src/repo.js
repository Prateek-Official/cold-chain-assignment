// Read-side queries. Keeping SQL out of the route handlers keeps them thin.
import { serializeAlert, serializeDevice, serializeReading, serializeTrip } from './serializers.js';

const DEVICE_SQL = `
  SELECT d.*, (SELECT COUNT(*) FROM alerts a WHERE a.device_id = d.id AND a.status = 'OPEN') AS open_alerts
  FROM devices d`;

const TRIP_SQL = `
  SELECT t.*, u.name AS driver_name,
         d.status AS device_status, d.last_temp_c, d.last_battery, d.last_door_open,
         d.last_reading_ts, d.last_seen_at,
         (SELECT COUNT(*) FROM alerts a WHERE a.device_id = t.device_id AND a.status = 'OPEN') AS open_alerts
  FROM trips t
  JOIN users u ON u.id = t.driver_id
  JOIN devices d ON d.id = t.device_id`;

const ALERT_SQL = `
  SELECT a.*, u.name AS acked_by_name
  FROM alerts a LEFT JOIN users u ON u.id = a.acked_by`;

export function createRepo(db) {
  const repo = {
    listDevices: () => db.prepare(`${DEVICE_SQL} ORDER BY d.id`).all().map(serializeDevice),

    getDevice(id) {
      const row = db.prepare(`${DEVICE_SQL} WHERE d.id = ?`).get(id);
      return row ? serializeDevice(row) : null;
    },

    listTrips(driverId = null) {
      const order = ' ORDER BY CAST(SUBSTR(t.id, 3) AS INTEGER)';
      const rows = driverId
        ? db.prepare(`${TRIP_SQL} WHERE t.driver_id = ?${order}`).all(driverId)
        : db.prepare(`${TRIP_SQL}${order}`).all();
      return rows.map(serializeTrip);
    },

    getTrip(id) {
      const row = db.prepare(`${TRIP_SQL} WHERE t.id = ?`).get(id);
      return row ? serializeTrip(row) : null;
    },

    getAlert(id) {
      const row = db.prepare(`${ALERT_SQL} WHERE a.id = ?`).get(id);
      return row ? serializeAlert(row) : null;
    },

    listAlerts({ status = 'all', limit = 50 } = {}) {
      const where = status === 'OPEN' || status === 'RESOLVED' ? 'WHERE a.status = ?' : '';
      const args = where ? [status, limit] : [limit];
      return db
        .prepare(`${ALERT_SQL} ${where} ORDER BY a.opened_at DESC, a.id DESC LIMIT ?`)
        .all(...args)
        .map(serializeAlert);
    },

    /** Newest `limit` readings in [from, to], returned oldest-first (chart order). */
    readings(deviceId, { from = '0000', to = '9999', limit = 200 } = {}) {
      return db
        .prepare('SELECT * FROM readings WHERE device_id = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?')
        .all(deviceId, from, to, limit)
        .reverse()
        .map(serializeReading);
    },

    /** Readings relevant to a trip: from its start (or the last 30 min if not started) to its end. */
    tripReadings(trip, { limit = 600, nowMs = Date.now() } = {}) {
      const from = trip.startedAt ?? new Date(nowMs - 30 * 60 * 1000).toISOString();
      return repo.readings(trip.deviceId, { from, to: trip.completedAt ?? '9999', limit });
    },

    /** Driver events + sensor alerts for one trip, merged and ordered by event time. */
    timeline(tripId) {
      const events = db
        .prepare(
          `SELECT e.*, u.name AS user_name FROM trip_events e
           LEFT JOIN users u ON u.id = e.user_id WHERE e.trip_id = ?`,
        )
        .all(tripId);
      const alerts = db.prepare('SELECT * FROM alerts WHERE trip_id = ?').all(tripId);

      const items = [];
      for (const e of events) {
        items.push({
          at: e.ts,
          source: 'driver',
          type: e.type,
          by: e.user_name,
          applied: !!e.applied,
          receivedAt: e.received_at,
          // received long after it happened => it was queued offline on the phone
          syncedLate: Date.parse(e.received_at) - Date.parse(e.ts) > 30_000,
        });
      }
      for (const a of alerts) {
        items.push({ at: a.opened_at, source: 'sensor', type: 'ALERT_OPENED', alertId: a.id, alertType: a.type, message: a.message });
        if (a.resolved_at)
          items.push({ at: a.resolved_at, source: 'sensor', type: 'ALERT_RESOLVED', alertId: a.id, alertType: a.type, message: a.message });
      }
      return items.sort((x, y) => x.at.localeCompare(y.at));
    },
  };
  return repo;
}
