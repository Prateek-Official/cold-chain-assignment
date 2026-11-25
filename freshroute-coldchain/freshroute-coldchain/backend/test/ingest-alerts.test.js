import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

let t;
before(async () => { t = await startTestApp(); });
after(() => t.close());

const count = (sql, ...args) => t.db.prepare(sql).get(...args).n;

test('ingest stores a valid reading and updates the device', async () => {
  const r = await t.ingest({ deviceId: 'TRK-01', tempC: 6.4, battery: 87 });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'stored');

  const dispatcher = await t.login('dispatcher');
  const { body } = await t.call('/api/devices/TRK-01', { token: dispatcher });
  assert.equal(body.device.status, 'ONLINE');
  assert.equal(body.device.tempC, 6.4);
  assert.equal(body.device.battery, 87);
});

test('duplicate messages are de-duplicated (same deviceId + ts stored once)', async () => {
  const ts = t.iso(-30);
  const first = await t.ingest({ deviceId: 'TRK-04', ts });
  const second = await t.ingest({ deviceId: 'TRK-04', ts });
  const third = await t.ingest({ deviceId: 'TRK-04', ts: ts.replace('.000Z', 'Z') }); // same instant, different spelling
  assert.deepEqual([first.body.status, second.body.status, third.body.status], ['stored', 'duplicate', 'duplicate']);
  assert.equal(count('SELECT COUNT(*) AS n FROM readings WHERE device_id = ?', 'TRK-04'), 1);
});

test('invalid payloads are rejected with 422 and clear reasons; nothing is stored', async () => {
  const before = count('SELECT COUNT(*) AS n FROM readings');
  const bad = [
    { tempC: 'hot' },
    { tempC: 500 },
    { ts: 'yesterday' },
    { battery: 150 },
    { doorOpen: 'no' },
    { deviceId: '../etc/passwd' },
    { ts: new Date(t.clock.t + 3600_000).toISOString() }, // 1h in the future
  ];
  for (const overrides of bad) {
    const r = await t.ingest(overrides);
    assert.equal(r.status, 422, JSON.stringify(overrides));
    assert.ok(r.body.errors.length > 0);
  }
  assert.equal(count('SELECT COUNT(*) AS n FROM readings'), before);
});

test('unknown devices and missing device keys are refused', async () => {
  assert.equal((await t.ingest({ deviceId: 'NOPE-99' })).status, 422);
  const r = await t.call('/api/ingest', { method: 'POST', body: { deviceId: 'TRK-01' } });
  assert.equal(r.status, 401);
});

test('batch ingest reports a result per item', async () => {
  const r = await t.call('/api/ingest', {
    method: 'POST',
    headers: { 'x-device-key': t.config.deviceKey },
    body: [
      { deviceId: 'TRK-05', ts: t.iso(-20), tempC: 4, doorOpen: false, battery: 80 },
      { deviceId: 'TRK-05', ts: t.iso(-20), tempC: 4, doorOpen: false, battery: 80 },
      { deviceId: 'TRK-05', ts: 'bad', tempC: 4, doorOpen: false, battery: 80 },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.status), ['stored', 'duplicate', 'rejected']);
});

test('a late (older) reading is stored but does not rewind the latest state', async () => {
  await t.ingest({ deviceId: 'TRK-06', ts: t.iso(0), tempC: 5.5 });
  const late = await t.ingest({ deviceId: 'TRK-06', ts: t.iso(-90), tempC: 7.7 });
  assert.equal(late.body.status, 'stored');
  assert.equal(late.body.late, true);

  const dispatcher = await t.login('dispatcher');
  const { body } = await t.call('/api/devices/TRK-06', { token: dispatcher });
  assert.equal(body.device.tempC, 5.5, 'latest temp must stay the newest-by-event-time reading');
  const hist = await t.call('/api/devices/TRK-06/readings', { token: dispatcher });
  assert.deepEqual(hist.body.readings.map((x) => x.tempC), [7.7, 5.5], 'history is returned in event-time order');
});

test('ALERT RULE: >8°C for 2 min raises exactly one alert; recovery resolves it', async () => {
  const dispatcher = await t.login('dispatcher');
  const openAlerts = async () =>
    (await t.call('/api/alerts?status=OPEN', { token: dispatcher })).body.alerts.filter((a) => a.deviceId === 'TRK-02' && a.type === 'TEMP_BREACH');

  // 115 s above threshold: not yet
  for (let s = 0; s <= 115; s += 5) { await t.ingest({ deviceId: 'TRK-02', ts: t.iso(), tempC: 9.8 }); t.clock.advance(5); }
  assert.equal((await openAlerts()).length, 0, 'must not alert before 2 minutes');

  // keep going well past 2 minutes: alert appears once, never duplicates
  for (let s = 0; s < 60; s += 5) { await t.ingest({ deviceId: 'TRK-02', ts: t.iso(), tempC: 10.2 }); t.clock.advance(5); }
  const alerts = await openAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].tripId, 'T-2', 'alert is linked to the active trip of that device');
  assert.match(alerts[0].message, /above 8°C/);

  // back to normal => resolved automatically
  await t.ingest({ deviceId: 'TRK-02', ts: t.iso(), tempC: 5.1 });
  assert.equal((await openAlerts()).length, 0);
  const all = await t.call('/api/alerts?status=RESOLVED', { token: dispatcher });
  assert.ok(all.body.alerts.some((a) => a.deviceId === 'TRK-02' && a.resolvedAt));
});

test('ALERT RULE: a short spike (<2 min) never alerts', async () => {
  const dispatcher = await t.login('dispatcher');
  for (let s = 0; s < 60; s += 5) { await t.ingest({ deviceId: 'TRK-03', ts: t.iso(), tempC: 12 }); t.clock.advance(5); }
  await t.ingest({ deviceId: 'TRK-03', ts: t.iso(), tempC: 4 });
  const r = await t.call('/api/alerts', { token: dispatcher });
  assert.equal(r.body.alerts.filter((a) => a.deviceId === 'TRK-03').length, 0);
});

test('OFFLINE RULE: silent for 1 min => OFFLINE + alert; next message brings it back and resolves', async () => {
  const dispatcher = await t.login('dispatcher');
  await t.ingest({ deviceId: 'TRK-07', ts: t.iso() });

  t.clock.advance(59);
  t.engine.sweep();
  assert.equal((await t.call('/api/devices/TRK-07', { token: dispatcher })).body.device.status, 'ONLINE');

  t.clock.advance(2);
  t.engine.sweep();
  assert.equal((await t.call('/api/devices/TRK-07', { token: dispatcher })).body.device.status, 'OFFLINE');
  let open = (await t.call('/api/alerts?status=OPEN', { token: dispatcher })).body.alerts.filter((a) => a.deviceId === 'TRK-07');
  assert.equal(open.length, 1);
  assert.equal(open[0].type, 'DEVICE_OFFLINE');

  t.engine.sweep(); // sweeping again must not create a second alert
  open = (await t.call('/api/alerts?status=OPEN', { token: dispatcher })).body.alerts.filter((a) => a.deviceId === 'TRK-07');
  assert.equal(open.length, 1);

  await t.ingest({ deviceId: 'TRK-07', ts: t.iso() });
  assert.equal((await t.call('/api/devices/TRK-07', { token: dispatcher })).body.device.status, 'ONLINE');
  open = (await t.call('/api/alerts?status=OPEN', { token: dispatcher })).body.alerts.filter((a) => a.deviceId === 'TRK-07');
  assert.equal(open.length, 0);
});

test('dispatcher can acknowledge an alert', async () => {
  const dispatcher = await t.login('dispatcher');
  t.clock.advance(120);
  t.engine.sweep(); // devices that never reported again go offline => alerts exist
  const list = (await t.call('/api/alerts?status=OPEN', { token: dispatcher })).body.alerts;
  assert.ok(list.length > 0);
  const r = await t.call(`/api/alerts/${list[0].id}/ack`, { method: 'POST', token: dispatcher });
  assert.equal(r.status, 200);
  assert.equal(r.body.alert.ackedBy, 'Dana Dispatcher');
});
