import { createOutbox, syncOutbox, applyPending } from './queue.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const THRESHOLD = 8;

const S = {
  token: localStorage.getItem('cc_d_token'),
  user: JSON.parse(localStorage.getItem('cc_d_user') || 'null'),
  trips: JSON.parse(localStorage.getItem('cc_d_trips') || '[]'), // last server snapshot (offline cache)
  reachable: navigator.onLine,
  syncing: false,
  notices: [],
  loginError: '',
};
const outbox = createOutbox(localStorage, 'cc_d_outbox');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/driver/sw.js').catch(() => {});

// ---------- network ------------------------------------------------------------------
class NetError extends Error {}

async function request(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    S.reachable = false;
    throw new NetError('offline');
  }
  S.reachable = true;
  return res;
}

async function loadTrips() {
  if (!S.token) return;
  try {
    const res = await request('/trips');
    if (res.status === 401) return signOut(false);
    const { trips } = await res.json();
    S.trips = trips;
    localStorage.setItem('cc_d_trips', JSON.stringify(trips));
  } catch (e) {
    if (!(e instanceof NetError)) throw e; // offline: keep showing the cached snapshot
  }
  render();
}

/** One outbox item -> sync outcome. Decision table is the contract with queue.js. */
async function sendItem(item) {
  try {
    const res = await request(`/trips/${encodeURIComponent(item.tripId)}/events`, {
      method: 'POST',
      body: JSON.stringify({ type: item.type, clientEventId: item.clientEventId, ts: item.ts }),
    });
    if (res.ok) return { ok: true }; // 201 created or 200 duplicate: either way the server has it
    if (res.status === 401) return { retry: true, reason: 'auth' };
    if (res.status >= 500 || res.status === 408 || res.status === 429) return { retry: true, reason: 'server' };
    const body = await res.json().catch(() => ({}));
    return { drop: true, reason: body.error || `HTTP ${res.status}` };
  } catch {
    return { retry: true, reason: 'network' };
  }
}

async function sync() {
  if (!S.token || !outbox.size()) return;
  S.syncing = true; render();
  const r = await syncOutbox(outbox, sendItem);
  S.syncing = false;
  r.dropped.forEach((d) => S.notices.push(`Could not save "${d.item.type.replace('_', ' ').toLowerCase()}" for ${d.item.tripId}: ${d.reason}`));
  if (r.stopped && r.stopReason === 'auth') return signOut(false);
  if (r.sent || r.dropped.length) await loadTrips(); else render();
}

// ---------- actions --------------------------------------------------------------------
function act(tripId, type) {
  outbox.add({ tripId, type }); // saved on the phone first, always
  render();
  sync(); // then try to push it right away (no-op if offline)
}

async function signIn(username, password) {
  S.loginError = '';
  try {
    const res = await request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (data.user.role !== 'driver') throw new Error('Dispatchers: use the dashboard at /');
    S.token = data.token; S.user = data.user;
    localStorage.setItem('cc_d_token', data.token); localStorage.setItem('cc_d_user', JSON.stringify(data.user));
    await sync(); // anything queued before the session expired goes first
    await loadTrips();
    location.hash = '#/';
  } catch (e) {
    S.loginError = e instanceof NetError ? 'You are offline. Connect once to sign in.' : e.message;
    render();
  }
}

function signOut(clearQueue = false) {
  S.token = null; S.user = null;
  localStorage.removeItem('cc_d_token'); localStorage.removeItem('cc_d_user');
  if (clearQueue) localStorage.removeItem('cc_d_outbox'); // by default the queue survives sign-out
  render();
}

// ---------- views -------------------------------------------------------------------------
const pending = () => outbox.list();
const viewTrips = () => S.trips.map((t) => applyPending(t, pending()));
const isStale = (t) => !S.reachable || !t.lastReadingTs || Date.now() - Date.parse(t.lastReadingTs) > 60_000;
const tempHtml = (t, cls = 'temp') => `<span class="${cls} ${t.tempC > THRESHOLD ? 'hot' : ''}">${t.tempC == null ? '—' : `${t.tempC.toFixed(1)}°C`}</span>`;

function listView() {
  const trips = viewTrips();
  return `<h1>My trips</h1>${S.notices.map((n) => `<div class="toast">${esc(n)}</div>`).join('')}
    ${trips.map((t) => `
      <a class="card" href="#/trip/${esc(t.id)}">
        <div class="row"><span class="id">${esc(t.id)}</span><span class="pill ${t.status}">${t.status.replace('_', ' ')}</span></div>
        <div class="sub">${esc(t.cargo)}</div>
        <div class="sub">${esc(t.origin)} → ${esc(t.destination)}</div>
        <div class="row" style="margin-top:8px">
          <span>${tempHtml(t)} ${t.openAlerts ? '⚠️' : ''}</span>
          ${t.pending ? `<span class="pending">⏳ ${t.pending} to sync</span>` : ''}
        </div>
      </a>`).join('') || '<p class="hint">No trips assigned.</p>'}
    <p class="hint"><button class="btn ghost" data-act="signout" style="font-size:14px;padding:10px">Sign out (${esc(S.user?.name)})</button></p>`;
}

function tripView(id) {
  const t = viewTrips().find((x) => x.id === id);
  if (!t) return '<a class="back" href="#/">← Trips</a><p>Trip not found.</p>';
  const stale = isStale(t);
  let actions = '';
  if (t.status === 'ASSIGNED') actions = `<button class="btn" data-act="TRIP_STARTED" data-trip="${esc(t.id)}">▶ Start trip</button>`;
  else if (t.status === 'IN_PROGRESS')
    actions = `<button class="btn green" data-act="DELIVERY_CONFIRMED" data-trip="${esc(t.id)}" ${t.deliveredAt ? 'disabled' : ''}>${t.deliveredAt ? '✔ Delivery confirmed' : '📦 Confirm delivery'}</button>
               <button class="btn ghost" data-act="TRIP_COMPLETED" data-trip="${esc(t.id)}" ${t.deliveredAt ? '' : 'disabled'}>🏁 Complete trip</button>
               ${t.deliveredAt ? '' : '<p class="hint">Confirm delivery first, then complete the trip.</p>'}`;
  else actions = '<div class="done">✔ Trip completed</div>';

  return `<a class="back" href="#/">← Trips</a>
    ${t.openAlerts ? '<div class="alertbox">⚠️ Cargo temperature alert open. Dispatch has been notified.</div>' : ''}
    <div class="card big">
      ${tempHtml(t, 'val')}
      <div class="cap">${stale ? `Last reading ${fmtTime(t.lastReadingTs)} ${S.reachable ? '(sensor quiet)' : '(offline, last known)'}` : `Live · updated ${fmtTime(t.lastReadingTs)}`}</div>
    </div>
    <div class="card">
      <div class="row"><span class="id">${esc(t.id)}</span><span class="pill ${t.status}">${t.status.replace('_', ' ')}</span></div>
      <div class="kv" style="margin-top:8px">
        <b>Cargo</b><span>${esc(t.cargo)}</span>
        <b>Route</b><span>${esc(t.origin)} → ${esc(t.destination)}</span>
        <b>Sensor</b><span>${esc(t.deviceId)} · ${t.deviceStatus === 'ONLINE' ? 'online' : esc(t.deviceStatus?.toLowerCase())} · 🔋${t.battery ?? '—'}%</span>
        <b>Started</b><span>${fmtTime(t.startedAt)}</span>
        <b>Delivered</b><span>${fmtTime(t.deliveredAt)}</span>
        <b>Completed</b><span>${fmtTime(t.completedAt)}</span>
      </div>
      ${t.pending ? `<p class="pending">⏳ ${t.pending} action(s) saved on this phone, waiting to sync</p>` : ''}
    </div>
    ${actions}`;
}

function loginView() {
  return `<form class="login" id="login-form">
    <h1>Driver sign in</h1>
    <label>Username<input name="username" value="driver1" autocomplete="username" autocapitalize="none" required></label>
    <label>Password<input name="password" type="password" value="driver123" autocomplete="current-password" required></label>
    <button class="btn" type="submit">Sign in</button>
    <p class="error">${esc(S.loginError)}</p>
    <p class="hint">Demo: driver1 / driver123 or driver2 / driver123</p>
  </form>`;
}

function render() {
  const net = $('#net');
  net.textContent = S.reachable ? '● Online' : '● Offline';
  net.className = `net ${S.reachable ? '' : 'off'}`;

  const n = outbox.size();
  const bar = $('#syncbar');
  bar.hidden = !n;
  bar.innerHTML = n ? `<span>⏳ ${n} change${n > 1 ? 's' : ''} saved on this phone${S.reachable ? '' : ' (will sync when online)'}</span>
    <button data-act="sync" ${S.syncing ? 'disabled' : ''}>${S.syncing ? 'Syncing…' : 'Sync now'}</button>` : '';

  const hash = location.hash.match(/^#\/trip\/(.+)$/);
  $('#app').innerHTML = !S.token ? loginView() : hash ? tripView(decodeURIComponent(hash[1])) : listView();
}

// ---------- wiring --------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const a = el.dataset.act;
  if (a === 'sync') sync();
  else if (a === 'signout') signOut(false);
  else act(el.dataset.trip, a);
});
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const f = new FormData(e.target);
  signIn(f.get('username'), f.get('password'));
});

window.addEventListener('hashchange', render);
window.addEventListener('online', () => { S.reachable = true; render(); sync().then(loadTrips); });
window.addEventListener('offline', () => { S.reachable = false; render(); });

// Poll for live temperature + retry the outbox. Cheap, and robust to "online" events that lie.
async function tick() {
  if (!S.token) return;
  await sync();
  if (!S.syncing) await loadTrips();
}
setInterval(tick, 5000);

render();
if (S.token) tick();
