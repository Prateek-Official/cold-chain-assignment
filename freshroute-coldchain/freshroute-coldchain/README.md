# FreshRoute Smart Cold-Chain Mini Platform

A thin, working end-to-end slice: **10 simulated IoT trucks → one backend → dispatcher web dashboard + driver mobile PWA**, with an alert rule, role-based login, idempotent ingestion and offline-safe driver actions.

```
simulator ──HTTP──▶ POST /api/ingest ─▶ SQLite ─▶ alert engine ─▶ SSE ─▶ Dispatcher dashboard  (http://localhost:3000)
                                          ▲                                    
Driver PWA (offline queue) ──REST──────────┘                                    (http://localhost:3000/driver/)
```

## Run it (about 2 minutes)

**Requirements:** Docker with Compose. Nothing else.

```bash
docker compose up --build
```

| What | URL |
|---|---|
| Dispatcher dashboard | http://localhost:3000 |
| Driver app (mobile-first PWA) | http://localhost:3000/driver/ |
| Simulator fault API | http://localhost:4100 |

**Demo logins**

| Role | Username | Password |
|---|---|---|
| Dispatcher (sees everything) | `dispatcher` | `dispatch123` |
| Driver (own trips only) | `driver1` (Asha, trips T-1…T-5) | `driver123` |
| Driver | `driver2` (Ravi, trips T-6…T-10) | `driver123` |

Stop with `Ctrl+C`; `docker compose down -v` also wipes the database.

### Run without Docker (Node 22.13+)

```bash
cd backend && npm install && npm start          # terminal 1  -> :3000
cd simulator && node simulator.js               # terminal 2  (no dependencies)
```

## See it work (demo script, about 5 minutes)

The simulator injects faults automatically (**TRK-02** temperature spike at about 40 s, **TRK-07** goes offline at about 70 s), and you can trigger more yourself.

1. Open the dashboard and sign in as `dispatcher`. Ten devices appear with live temperature, battery and door state.
2. **Temperature alert.** In the *Demo: inject a fault* panel pick `TRK-01` and click **Temperature spike**. Watch the chart climb over the red 8 °C line. About 2 minutes after it crosses, an alert lands in the *Live alerts* feed. Click **Acknowledge**. When the spike ends, the alert auto-resolves.
   *(Want it faster? `BREACH_SECONDS=30 OFFLINE_SECONDS=20 docker compose up`.)*
3. **Offline alert.** Click **Go offline (90 s)** on any device. About 60 s later it flips to `OFFLINE` and raises an alert. It recovers by itself when data resumes.
4. **Duplicates and late messages.** Click **Duplicate burst** and **Late message**. The same reading is sent four times, or delivered 25-45 s late. The device list and chart stay correct and no duplicate rows are stored.
5. **Trip detail.** Click a trip (e.g. `T-1`) to see sensor history, driver events and alerts on one chart and timeline.
6. **Driver app, airplane mode.** Open `/driver/` (a phone-sized window is nicest), sign in as `driver1`, open `T-1`, then in Chrome DevTools → Network switch to **Offline**.
   Tap **Confirm delivery** and **Complete trip**. The UI updates instantly and shows "⏳ saved on this phone". Reload the page (it still loads) and switch the network back to **No throttling**. The queue syncs by itself. On the dashboard the timeline shows the events with their original times, tagged *synced offline*.

## Run the tests

```bash
cd backend && npm install && npm test          # 36 tests, about 3 s, no Docker needed
# or, with Docker:
docker compose run --rm --no-deps api npm test
```

What the tests cover (real Express app + real in-memory SQLite + controllable clock):

| Area | Examples |
|---|---|
| **Alert rule** | no alert at 115 s; alert at 120 s; exactly 8.0 °C isn't "above"; one normal reading resets; short spike never alerts; exactly one alert, auto-resolved on recovery |
| **Offline rule** | 59 s stays online, 61 s goes offline + alert; sweeping twice makes one alert; next message recovers and resolves |
| **De-dup / late data** | same `(deviceId, ts)` stored once (even with a different timestamp spelling); late reading stored but can't rewind "latest"; batch ingest per-item results |
| **Validation** | bad temp / ts / battery / device id / future timestamp → 422, nothing stored; missing device key → 401 |
| **Auth / roles** | driver sees only own trips; 403 on another driver's trip, readings, timeline and events; drivers blocked from dispatcher endpoints; tampered and expired tokens rejected |
| **Offline sync** | replayed `clientEventId` is a no-op; queued start→deliver→complete applies in order with the driver's timestamps; stale events never block the queue; lost-response retry doesn't duplicate; overlapping syncs are single-flight |

The driver's real queue module (`backend/public/driver/queue.js`) is tested against the real server.

## What is real and what is mocked

| Real | Mocked / simplified |
|---|---|
| Ingestion, validation, idempotency, late/duplicate handling | **Devices**: a Node script, not hardware or an MQTT broker (HTTP ingest with a shared device key) |
| Alert rules, offline sweep, alert lifecycle (open, acknowledge, resolve) | **Maps/GPS**: lat/lng are stored and returned but not drawn (out of scope) |
| JWT auth + role enforcement (scrypt password hashes) | **Push notifications**: dashboard uses live SSE only |
| Live dashboard via Server-Sent Events | **Users/trips**: seeded demo data; no admin UI to create them |
| Driver PWA with service worker + persistent outbox | **Native app**: PWA instead of React Native/Flutter |

## Stack, and why

- **Node 22 + Express + SQLite (`node:sqlite`)**: one runtime for API, simulator and tests, no native modules, no build step. Fastest thing I can fully explain; the schema is plain SQL and ports straight to Postgres.
- **SSE** rather than WebSockets: one-way server → browser is all the dashboard needs, and the browser reconnects by itself.
- **Vanilla JS + hand-rolled SVG chart**: zero front-end dependencies or build tooling, so `docker compose up` is the whole setup.
- **PWA rather than React Native/Flutter**: no app-store or emulator setup; service worker + `localStorage` outbox covers the offline requirement.

## API summary

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/auth/login` | public | `{username,password}` → `{token,user}` |
| `POST /api/ingest` | device key (`x-device-key`) | one reading or an array; per-item `stored / duplicate / rejected` |
| `GET /api/devices`, `/api/devices/:id`, `/api/devices/:id/readings` | dispatcher | live state and history |
| `GET /api/alerts?status=OPEN`, `POST /api/alerts/:id/ack` | dispatcher | alert feed and acknowledgement |
| `GET /api/trips`, `/api/trips/:id`, `/:id/readings`, `/:id/timeline` | driver (own) / dispatcher (all) | trip data |
| `POST /api/trips/:id/events` (also flat `POST /api/events`) | driver (own) / dispatcher | `TRIP_STARTED`, `DELIVERY_CONFIRMED`, `TRIP_COMPLETED`; idempotent on `clientEventId` |
| `GET /api/stream` | dispatcher | SSE: `reading`, `device`, `alert`, `trip` events |

Sample payloads from the brief work as-is:

```bash
curl -X POST localhost:3000/api/ingest -H 'x-device-key: dev-device-key' -H 'content-type: application/json' \
  -d '{"deviceId":"TRK-01","ts":"2026-11-20T08:15:03Z","tempC":6.4,"doorOpen":false,"battery":87}'
```

## Configuration (environment variables)

`TEMP_THRESHOLD_C` (8) · `BREACH_SECONDS` (120) · `OFFLINE_SECONDS` (60) · `SWEEP_MS` (5000) · `JWT_SECRET` · `DEVICE_API_KEY` · `DB_PATH` · simulator: `AUTO_FAULTS`, `INTERVAL_MS`, `DUP_RATE`, `LATE_RATE`.

## Repo layout

```
docker-compose.yml
backend/
  src/        config, db (schema), auth, validation, rules (pure alert logic), engine (ingest/alerts/events),
              repo (queries), routes, sse, seed, app, server
  public/
    dashboard/   dispatcher UI (index.html, app.js, chart.js, style.css)
    driver/      driver PWA (app.js, queue.js = offline outbox, sw.js, manifest)
  test/       36 tests
simulator/    simulator.js (10 devices, fault injection, control API)
docs/         DESIGN.md (one-page design note), NEXT_STEPS.md (path to 5,000 devices)
```

## Honest limitations

- Shared device key, not per-device credentials or mTLS. Fine for a demo, not for production.
- No login rate-limiting; the JWT lives in `localStorage` (XSS-exposed). SSE passes the token in the query string (EventSource can't set headers); fine on localhost, but use a short-lived stream ticket in production.
- Service workers need HTTPS or `localhost`. Testing the driver app from a phone over a plain-HTTP LAN IP works online, but offline reload needs HTTPS (e.g. a tunnel).
- Alert evaluation reads recent history from SQLite on every ingest. Great for 10 devices, not for 5,000 (see `docs/NEXT_STEPS.md`).
- I could not run `docker compose up` in the sandbox this was built in (no Docker daemon). The same code was verified by running API + simulator natively, the Dockerfile steps (`npm ci --omit=dev` + tests) in a clean directory, and a headless-browser pass of both UIs. See the notes at the end of this file if the first Docker run misbehaves.

## Troubleshooting

- **Port 3000/4100 busy**: change the left side of the `ports:` mapping in `docker-compose.yml`.
- **Dashboard empty / "reconnecting"**: `docker compose logs api`. The simulator waits for the API health check, so give it ~10 s on first boot.
- **Want a clean slate**: `docker compose down -v` (removes the SQLite volume and re-seeds on next start).
- **Alerts feel slow**: that's the real 2-minute rule. Use `BREACH_SECONDS=30 OFFLINE_SECONDS=20 docker compose up`.
