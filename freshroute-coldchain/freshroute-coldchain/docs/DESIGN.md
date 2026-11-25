# Design note: FreshRoute cold-chain mini platform

## 1. Architecture

```
 ┌────────────┐  POST /api/ingest        ┌───────────────────────── api (Node/Express) ──────────────────────────┐
 │ Simulator  │  (x-device-key)          │  validate ─▶ INSERT OR IGNORE ─▶ update device ─▶ evaluate rules      │
 │ 10 trucks  │ ───────────────────────▶ │                         │                              │              │
 │ + faults   │                          │                         ▼                              ▼              │
 └────────────┘                          │                  ┌────────────┐                ┌──────────────┐       │
        ▲  POST /fault (control)         │                  │  SQLite    │ ◀──────────────│ alert engine │       │
        └────────────────────────────────│── /api/demo/fault│ readings   │   offline      │ open/resolve │       │
                                         │                  │ devices    │   sweep (5 s)  └──────┬───────┘       │
 ┌──────────────────────┐   REST + SSE   │                  │ trips      │                       │ after COMMIT  │
 │ Dispatcher dashboard │ ◀──────────────│── /api/stream ◀──│ trip_events│                  ┌────▼─────┐         │
 │ (vanilla JS, SVG)    │                │                  │ alerts     │                  │ SSE hub  │         │
 └──────────────────────┘                │                  │ users      │                  └──────────┘         │
 ┌──────────────────────┐   REST (JWT)   │                  └────────────┘                                       │
 │ Driver PWA           │ ◀─────────────▶│  auth (HS256 JWT, roles)  ·  /api/trips, /api/trips/:id/events        │
 │ service worker +     │                └───────────────────────────────────────────────────────────────────────┘
 │ localStorage outbox  │
 └──────────────────────┘
```

Two containers: `api` (also serves both web apps) and `simulator`. SQLite sits on a named volume.

## 2. Data model

| Table | Key | Notes |
|---|---|---|
| `users` | `id` | `role ∈ {driver, dispatcher}`, scrypt hash |
| `devices` | `id` (`TRK-01`) | latest state denormalised for the live list: `status`, `last_seen_at` (**receive time**, drives offline), `last_reading_ts` (**event time**), temp, battery, door, lat/lng |
| `trips` | `id` (`T-1`) | `device_id`, `driver_id`, `status ASSIGNED→IN_PROGRESS→COMPLETED`, `started_at`, `delivered_at`, `completed_at` |
| `readings` | **`(device_id, ts)`** | idempotency key; `ts` normalised to UTC ISO-8601 first; plus `received_at` |
| `trip_events` | `id`, **`client_event_id` UNIQUE** | driver actions with the *driver's* timestamp, `applied` flag, `received_at` |
| `alerts` | `id` | `type ∈ {TEMP_BREACH, DEVICE_OFFLINE}`, `OPEN/RESOLVED`, ack info, `trip_id` of the active trip. **Partial unique index** `(device_id,type) WHERE status='OPEN'` guarantees one open alert per device and type, even under races |

## 3. Key trade-offs

**1. Alert rule evaluates stored history in event time, rather than keeping in-memory state per device.**
On each new reading, the engine loads the last ~3 minutes of that device's readings, sorted by device timestamp, and asks: "is there a continuous run above 8 °C ending at the newest reading and spanning ≥120 s?" (`rules.evaluateBreach`, a pure function).
*Gains:* late, duplicate and out-of-order messages are handled for free; the result is idempotent and survives restarts; no per-device state to corrupt.
*Costs:* one small indexed query per reading (fine for 10 devices; at 5,000 it moves to a stream processor with windowed state, see NEXT_STEPS). A long silent gap inside a hot run does not reset the run (deliberately conservative for cold chain).

**2. Offline detection uses server receive time on a timer, while temperature uses device time.**
A silent device sends nothing to react to, so a 5 s sweep checks `last_seen_at`. Device clocks drift, so they are not trusted for "is it alive", but they are the truth for "what was the temperature when". Any message we *receive* (even a duplicate or late one) counts as proof of life.
*Costs:* a late batch can flip a device back to ONLINE although its data is old. Acceptable: the link really did just work.

**3. Offline-safe driver actions: client-generated idempotency keys + at-least-once delivery, instead of CRDTs or server-assigned IDs.**
The phone creates a UUID when the button is tapped, stores the event in a persistent outbox, and only deletes it after a 2xx. Retries reuse the same UUID, and the server's `UNIQUE` constraint turns replays into a harmless 200. Stale events (e.g. START on an already-started trip) are recorded with `applied=false` rather than rejected, so one bad item can never wedge the queue, and the driver's real timestamp is preserved for the timeline.
*Costs:* "last write wins" on trip state by event order, with no conflict UI; fine for a single driver per trip.

**Smaller choices:** SQLite + SSE + vanilla JS to keep `docker compose up` as the entire setup (a Postgres/WebSocket/React version is a straight port); `ts` normalisation before insert so `…:03Z` and `…:03.000Z` can't dodge de-duplication; SSE events are published only after `COMMIT`.

## 4. Mocked / out of scope (as allowed by the brief)

HTTP instead of MQTT; GPS stored but not mapped; no push notifications; seeded users and trips; PWA instead of native app; shared device key.

## 5. Preparing for the follow-up discussion

- **What breaks first at 100× (1,000 devices, 200 msg/s)?** The synchronous single-writer SQLite and the per-ingest history query, then the SSE fan-out of every reading to every browser. Fix: queue/stream ingestion with batched writes, windowed rule state, per-viewer throttling.
- **How is offline sync safe from duplicates?** See trade-off 3: idempotency key created once at tap time, retained until acknowledged, enforced by a database `UNIQUE`; the "lost response" test proves it.
- **Cutting false alerts without missing real breaches:** keep the duration window (already), add hysteresis (resolve only after N normal readings), ignore door-open periods or use a longer window while the door is open, require N consecutive samples, and treat a sensor-fault signature (flatline, impossible jumps) separately from a breach. Tune on real data using alert precision vs. time-to-detect.
- **Least comfortable shortcut:** the shared device key plus the JWT in `localStorage`. Plan: per-device credentials (mTLS or signed JWTs with rotation) and short-lived `HttpOnly` session cookies with a stream ticket for SSE.
