import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('driver','dispatcher')),
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UNKNOWN','ONLINE','OFFLINE')),
  last_seen_at    TEXT,   -- server receive time of the last accepted message (drives offline detection)
  last_reading_ts TEXT,   -- device timestamp of the newest reading (event time)
  last_temp_c     REAL,
  last_battery    INTEGER,
  last_door_open  INTEGER,
  last_lat        REAL,
  last_lng        REAL
);

CREATE TABLE IF NOT EXISTS trips (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id),
  driver_id    INTEGER NOT NULL REFERENCES users(id),
  cargo        TEXT,
  origin       TEXT,
  destination  TEXT,
  status       TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED','IN_PROGRESS','COMPLETED')),
  started_at   TEXT,
  delivered_at TEXT,
  completed_at TEXT
);

-- Natural idempotency key: (device_id, ts). ts is normalised to UTC ISO-8601 (ms precision)
-- before insert, so "…:03Z" and "…:03.000Z" are the same reading.
CREATE TABLE IF NOT EXISTS readings (
  device_id   TEXT NOT NULL REFERENCES devices(id),
  ts          TEXT NOT NULL,
  temp_c      REAL NOT NULL,
  door_open   INTEGER NOT NULL,
  battery     INTEGER NOT NULL,
  lat         REAL,
  lng         REAL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

-- client_event_id is generated on the driver's phone; UNIQUE makes replays harmless.
CREATE TABLE IF NOT EXISTS trip_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id         TEXT NOT NULL REFERENCES trips(id),
  type            TEXT NOT NULL,
  client_event_id TEXT NOT NULL UNIQUE,
  ts              TEXT NOT NULL,   -- when the driver actually did it (client clock)
  user_id         INTEGER REFERENCES users(id),
  applied         INTEGER NOT NULL, -- did it change trip state?
  received_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trip_events_trip ON trip_events(trip_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL REFERENCES devices(id),
  trip_id     TEXT REFERENCES trips(id),
  type        TEXT NOT NULL CHECK (type IN ('TEMP_BREACH','DEVICE_OFFLINE')),
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  message     TEXT NOT NULL,
  peak_temp_c REAL,
  opened_at   TEXT NOT NULL,
  resolved_at TEXT,
  acked_by    INTEGER REFERENCES users(id),
  acked_at    TEXT
);
-- At most one OPEN alert per device+type, enforced by the database, not just by code.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_alert ON alerts(device_id, type) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS alerts_trip ON alerts(trip_id);
`;

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return db;
}
