import { lineChart } from './chart.js';

// ---------- helpers ----------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const fmtTemp = (v) => (v == null ? '—' : `${v.toFixed(1)}°C`);
const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

const S = {
  token: localStorage.getItem('cc_token'),
  user: JSON.parse(localStorage.getItem('cc_user') || 'null'),
  cfg: { tempThresholdC: 8 },
  devices: new Map(),
  alerts: [],
  trips: [],
  series: new Map(), // deviceId -> [{ts,tempC}] (event-time order)
  selected: null,
  trip: null, // trip detail view state
  es: null,
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/auth/login') { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Coalesce bursts of SSE events into one render per animation frame.
const dirty = new Set();
let raf = 0;
function schedule(...parts) {
  parts.forEach((p) => dirty.add(p));
  if (!raf) raf = requestAnimationFrame(() => {
    raf = 0;
    const todo = [...dirty]; dirty.clear();
    todo.forEach((p) => renderers[p]?.());
  });
}

// ---------- auth ---------------------------------------------------------------------
function logout() {
  S.token = null; S.user = null;
  localStorage.removeItem('cc_token'); localStorage.removeItem('cc_user');
  S.es?.close(); S.es = null;
  showView('login');
  renderUser();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    const { token, user } = await api('/auth/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    if (user.role !== 'dispatcher') throw new Error('This dashboard is for dispatchers. Drivers: open /driver/');
    S.token = token; S.user = user;
    localStorage.setItem('cc_token', token); localStorage.setItem('cc_user', JSON.stringify(user));
    await start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

function renderUser() {
  $('#userbox').innerHTML = S.user ? `<span>${esc(S.user.name)}</span><button id="logout">Sign out</button>` : '';
  $('#logout')?.addEventListener('click', logout);
}

function showView(name) {
  $('#login-view').hidden = name !== 'login';
  $('#dash-view').hidden = name !== 'dash';
  $('#trip-view').hidden = name !== 'trip';
}

// ---------- data loading ---------------------------------------------------------------
async function loadAll() {
  const [cfg, devs, alerts, trips] = await Promise.all([api('/config'), api('/devices'), api('/alerts?limit=50'), api('/trips')]);
  S.cfg = cfg;
  S.devices = new Map(devs.devices.map((d) => [d.id, d]));
  S.alerts = alerts.alerts;
  S.trips = trips.trips;
  if (!S.selected) S.selected = [...S.devices.keys()][0];
  await ensureSeries(S.selected);
}

async function ensureSeries(id, force = false) {
  if (!id || (!force && S.series.has(id))) return;
  const { readings } = await api(`/devices/${id}/readings?limit=150`);
  S.series.set(id, readings);
}

function addPoint(point) {
  const arr = S.series.get(point.deviceId);
  if (!arr) return;
  if (!arr.length || arr[arr.length - 1].ts < point.ts) arr.push(point);
  else if (!arr.some((p) => p.ts === point.ts)) { arr.push(point); arr.sort((a, b) => a.ts.localeCompare(b.ts)); }
  while (arr.length > 300) arr.shift();
}

// ---------- live stream (SSE) -------------------------------------------------------------
function connect() {
  S.es?.close();
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(S.token)}`);
  S.es = es;
  const conn = $('#conn');
  es.onopen = async () => {
    conn.className = 'conn conn-on'; conn.textContent = '● live';
    // (Re)synchronise after any gap so we never show stale state after a reconnect.
    try { await loadAll(); S.series.clear(); await ensureSeries(S.selected); if (S.trip) await loadTrip(S.trip.id); schedule('devices', 'alerts', 'trips', 'chart', 'tripView'); } catch {}
  };
  es.onerror = () => { conn.className = 'conn conn-off'; conn.textContent = '● reconnecting…'; };

  es.addEventListener('reading', (e) => {
    const { point, device } = JSON.parse(e.data);
    S.devices.set(device.id, device);
    addPoint(point);
    if (S.trip?.trip.deviceId === point.deviceId) addTripPoint(point);
    schedule('devices', 'trips', point.deviceId === S.selected ? 'chart' : 'noop', S.trip ? 'tripView' : 'noop');
  });
  es.addEventListener('device', (e) => {
    const d = JSON.parse(e.data);
    S.devices.set(d.id, d);
    schedule('devices', 'trips');
  });
  es.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data);
    const i = S.alerts.findIndex((x) => x.id === a.id);
    if (i >= 0) S.alerts[i] = a; else { S.alerts.unshift(a); S.flashId = a.id; }
    S.alerts.sort((x, y) => y.openedAt.localeCompare(x.openedAt) || y.id - x.id);
    api('/devices').then(({ devices }) => { S.devices = new Map(devices.map((d) => [d.id, d])); schedule('devices'); }).catch(() => {});
    schedule('alerts');
    if (S.trip && a.tripId === S.trip.id) loadTimeline().then(() => schedule('tripView'));
  });
  es.addEventListener('trip', (e) => {
    const t = JSON.parse(e.data);
    const i = S.trips.findIndex((x) => x.id === t.id);
    if (i >= 0) S.trips[i] = t;
    schedule('trips');
    if (S.trip?.id === t.id) { S.trip.trip = t; loadTimeline().then(() => schedule('tripView')); }
  });
}

// ---------- renderers ------------------------------------------------------------------------
const renderers = {
  noop() {},

  devices() {
    const rows = [...S.devices.values()].map((d) => `
      <tr class="row ${d.id === S.selected ? 'selected' : ''}" data-device="${esc(d.id)}">
        <td><b>${esc(d.id)}</b>${d.openAlerts ? `<span class="badge">${d.openAlerts}</span>` : ''}</td>
        <td><span class="pill pill-${d.status}">${d.status}</span></td>
        <td class="num ${d.tempC > S.cfg.tempThresholdC ? 'temp-hot' : ''}">${fmtTemp(d.tempC)}</td>
        <td class="num ${d.battery != null && d.battery < 20 ? 'bat-low' : ''}">${d.battery ?? '—'}${d.battery != null ? '%' : ''}</td>
        <td>${d.doorOpen == null ? '—' : d.doorOpen ? '🚪 open' : 'closed'}</td>
        <td class="muted num">${ago(d.lastSeenAt)}</td>
      </tr>`).join('');
    $('#devices').innerHTML = `<thead><tr><th>Device</th><th>Status</th><th>Temp</th><th>Battery</th><th>Door</th><th>Last seen</th></tr></thead><tbody>${rows}</tbody>`;
    const list = [...S.devices.values()];
    const online = list.filter((d) => d.status === 'ONLINE').length;
    $('#dev-summary').textContent = `${online}/${list.length} online`;
    const sel = $('#demo-device');
    if (sel && sel.options.length !== list.length) sel.innerHTML = list.map((d) => `<option>${esc(d.id)}</option>`).join('');
  },

  alerts() {
    const open = S.alerts.filter((a) => a.status === 'OPEN').length;
    $('#alert-summary').textContent = `${open} open`;
    $('#alerts').innerHTML = S.alerts.length
      ? S.alerts.map((a) => `
        <div class="alert type-${a.type} ${a.status === 'RESOLVED' ? 'resolved' : ''} ${a.id === S.flashId ? 'flash' : ''}">
          <div class="hd"><span>${a.type === 'TEMP_BREACH' ? '🌡' : '📡'} ${esc(a.deviceId)}</span><span class="pill pill-${a.status}">${a.status}</span></div>
          <div>${esc(a.message)}</div>
          <div class="meta">${fmtTime(a.openedAt)}${a.resolvedAt ? ` → resolved ${fmtTime(a.resolvedAt)}` : ''}
            ${a.tripId ? ` · <a href="#/trip/${esc(a.tripId)}">${esc(a.tripId)}</a>` : ''}
            ${a.ackedBy ? ` · ✔ ack by ${esc(a.ackedBy)}` : a.status === 'OPEN' ? ` · <button class="btn small" data-ack="${a.id}">Acknowledge</button>` : ''}</div>
        </div>`).join('')
      : '<div class="empty">No alerts. All quiet.</div>';
    S.flashId = null;
  },

  chart() {
    const id = S.selected;
    $('#chart-title').textContent = id ? `${id} — temperature (last ~12 min)` : 'Temperature';
    const points = S.series.get(id) || [];
    const markers = S.alerts.filter((a) => a.deviceId === id && points.length && a.openedAt >= points[0].ts)
      .map((a) => ({ ts: a.openedAt, label: a.type === 'TEMP_BREACH' ? 'ALERT' : 'OFFLINE', kind: 'alert' }));
    $('#chart').innerHTML = lineChart({ points, threshold: S.cfg.tempThresholdC, markers });
  },

  trips() {
    const rows = S.trips.map((t) => {
      const d = S.devices.get(t.deviceId);
      return `<tr class="row" data-trip="${esc(t.id)}">
        <td><a href="#/trip/${esc(t.id)}"><b>${esc(t.id)}</b></a></td>
        <td>${esc(t.deviceId)}${d?.openAlerts ? '<span class="badge">!</span>' : ''}</td>
        <td>${esc(t.driverName)}</td>
        <td><span class="pill pill-${t.status}">${t.status.replace('_', ' ')}</span></td>
        <td class="num ${d?.tempC > S.cfg.tempThresholdC ? 'temp-hot' : ''}">${fmtTemp(d?.tempC)}</td>
      </tr>`;
    }).join('');
    $('#trips').innerHTML = `<thead><tr><th>Trip</th><th>Device</th><th>Driver</th><th>Status</th><th>Temp</th></tr></thead><tbody>${rows}</tbody>`;
  },

  tripView() {
    const v = S.trip;
    if (!v) return;
    const t = v.trip;
    const d = S.devices.get(t.deviceId);
    const label = { TRIP_STARTED: 'Trip started', DELIVERY_CONFIRMED: 'Delivery confirmed', TRIP_COMPLETED: 'Trip completed' };
    const short = { TRIP_STARTED: 'START', DELIVERY_CONFIRMED: 'DELIVERED', TRIP_COMPLETED: 'DONE' };

    const markers = v.timeline.filter((x) => x.source === 'driver' || x.type === 'ALERT_OPENED').map((x) =>
      x.source === 'driver' ? { ts: x.at, label: short[x.type], kind: 'ok' } : { ts: x.at, label: 'ALERT', kind: 'alert' });

    const items = v.timeline.map((x) => {
      let text;
      if (x.source === 'driver') text = `<b>${label[x.type] ?? x.type}</b> by ${esc(x.by ?? 'driver')}${x.syncedLate ? `<span class="tag">synced offline, received ${fmtTime(x.receivedAt)}</span>` : ''}${x.applied ? '' : '<span class="tag">no state change</span>'}`;
      else if (x.type === 'ALERT_OPENED') text = `<span class="tl-sensor-bad">${x.alertType === 'TEMP_BREACH' ? '🌡' : '📡'} Alert: ${esc(x.message)}</span>`;
      else text = `<span class="tl-sensor-ok">✔ Alert resolved (${esc(x.alertType)})</span>`;
      return `<li><span class="when">${fmtTime(x.at)}</span><span>${text}</span></li>`;
    }).join('');

    $('#trip-view').innerHTML = `
      <a class="back" href="#/">← Back to dashboard</a>
      <div class="card trip-head">
        <h1>${esc(t.id)}</h1>
        <div class="kv"><b>Status</b><span class="pill pill-${t.status}">${t.status.replace('_', ' ')}</span></div>
        <div class="kv"><b>Cargo</b>${esc(t.cargo)}</div>
        <div class="kv"><b>Route</b>${esc(t.origin)} → ${esc(t.destination)}</div>
        <div class="kv"><b>Driver</b>${esc(t.driverName)}</div>
        <div class="kv"><b>Device</b>${esc(t.deviceId)} <span class="pill pill-${d?.status ?? 'UNKNOWN'}">${d?.status ?? 'UNKNOWN'}</span></div>
        <div class="kv"><b>Now</b><span class="num ${d?.tempC > S.cfg.tempThresholdC ? 'temp-hot' : ''}">${fmtTemp(d?.tempC)}</span></div>
        <div class="kv"><b>Started</b>${fmtTime(t.startedAt)}</div>
        <div class="kv"><b>Delivered</b>${fmtTime(t.deliveredAt)}</div>
        <div class="kv"><b>Completed</b>${fmtTime(t.completedAt)}</div>
      </div>
      <div class="two-col">
        <section class="panel"><h2>Sensor history + driver events</h2>${lineChart({ points: v.readings, threshold: S.cfg.tempThresholdC, markers })}</section>
        <section class="panel"><h2>Timeline</h2>${items ? `<ul class="timeline">${items}</ul>` : '<div class="empty">No events yet</div>'}</section>
      </div>`;
  },
};

// ---------- trip detail ------------------------------------------------------------------------
async function loadTimeline() {
  S.trip.timeline = (await api(`/trips/${S.trip.id}/timeline`)).timeline;
}
async function loadTrip(id) {
  const [{ trip }, { readings }, { timeline }] = await Promise.all([api(`/trips/${id}`), api(`/trips/${id}/readings`), api(`/trips/${id}/timeline`)]);
  S.trip = { id, trip, readings, timeline };
}
function addTripPoint(p) {
  const arr = S.trip.readings;
  if (!arr.some((x) => x.ts === p.ts)) { arr.push(p); arr.sort((a, b) => a.ts.localeCompare(b.ts)); }
}

// ---------- events & routing -----------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const ack = e.target.closest('[data-ack]');
  if (ack) { ack.disabled = true; try { await api(`/alerts/${ack.dataset.ack}/ack`, { method: 'POST' }); } catch (err) { alert(err.message); } return; }

  const row = e.target.closest('tr[data-device]');
  if (row && !e.target.closest('a')) {
    S.selected = row.dataset.device;
    await ensureSeries(S.selected);
    schedule('devices', 'chart');
    return;
  }
  const trip = e.target.closest('tr[data-trip]');
  if (trip && !e.target.closest('a')) location.hash = `#/trip/${trip.dataset.trip}`;

  const fault = e.target.closest('[data-fault]');
  if (fault) {
    const msg = $('#demo-msg');
    msg.textContent = '…';
    try {
      const r = await api('/demo/fault', { method: 'POST', body: { deviceId: $('#demo-device').value, fault: fault.dataset.fault, seconds: fault.dataset.fault === 'spike' ? 240 : undefined } });
      msg.textContent = r.message || 'sent';
    } catch (err) { msg.textContent = `⚠ ${err.message}`; }
  }
});

async function route() {
  if (!S.token) return showView('login');
  const m = location.hash.match(/^#\/trip\/(.+)$/);
  try {
    if (m) {
      await loadTrip(decodeURIComponent(m[1]));
      showView('trip');
      schedule('tripView');
    } else {
      S.trip = null;
      showView('dash');
      schedule('devices', 'alerts', 'chart', 'trips');
    }
  } catch (err) {
    if (m) { $('#trip-view').innerHTML = `<a class="back" href="#/">← Back</a><p class="error">${esc(err.message)}</p>`; showView('trip'); }
  }
}
window.addEventListener('hashchange', route);

// "x seconds ago" labels tick without needing new data
setInterval(() => { if (!$('#dash-view').hidden) schedule('devices'); }, 5000);

async function start() {
  renderUser();
  showView('dash');
  await loadAll();
  connect();
  await route();
}

renderUser();
if (S.token) start().catch(() => logout()); else showView('login');
