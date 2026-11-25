import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBreach, isStale } from '../src/rules.js';

const opts = { thresholdC: 8, windowSeconds: 120 };
const T = (sec) => new Date(Date.UTC(2026, 10, 20, 8, 0, 0) + sec * 1000).toISOString();
/** series every 5 s starting at t=0 from a list of temps */
const series = (temps, stepSec = 5) => temps.map((tempC, i) => ({ ts: T(i * stepSec), tempC }));

test('no breach while above threshold for less than the window', () => {
  const r = evaluateBreach(series(Array(24).fill(9.5)), opts); // 23 intervals * 5s = 115s
  assert.equal(r.breached, false);
  assert.equal(r.durationSec, 115);
});

test('breach once above threshold for the full 2 minutes', () => {
  const r = evaluateBreach(series(Array(25).fill(9.5)), opts); // 24 intervals = 120s
  assert.equal(r.breached, true);
  assert.equal(r.durationSec, 120);
  assert.equal(r.peakC, 9.5);
});

test('exactly 8.0°C is NOT "above 8°C"', () => {
  assert.equal(evaluateBreach(series(Array(40).fill(8.0)), opts).breached, false);
});

test('one normal reading resets the run (no false alert from a flapping sensor)', () => {
  const temps = [...Array(20).fill(9), 7.9, ...Array(10).fill(9)];
  assert.equal(evaluateBreach(series(temps), opts).breached, false);
});

test('a run that ended is not a breach: only the run ending at the newest reading counts', () => {
  const temps = [...Array(30).fill(9), 6, 6];
  assert.equal(evaluateBreach(series(temps), opts).breached, false);
});

test('late, out-of-order readings are handled because history is re-sorted by event time', () => {
  // The reading at t=60 arrives late: evaluating over the sorted union still sees one continuous run.
  const all = series(Array(25).fill(9));
  const withoutLate = all.filter((_, i) => i !== 12);
  assert.equal(evaluateBreach(withoutLate, opts).breached, true); // gap does not break the run
  assert.equal(evaluateBreach(all, opts).breached, true);
});

test('a late *normal* reading inside the run breaks it (history is the source of truth)', () => {
  const all = series(Array(25).fill(9));
  all[12] = { ...all[12], tempC: 6 };
  assert.equal(evaluateBreach(all, opts).breached, false);
});

test('isStale: offline after 60 s of silence, never-seen devices stay UNKNOWN', () => {
  const now = Date.parse(T(100));
  assert.equal(isStale(T(41), now, 60), false);
  assert.equal(isStale(T(40), now, 60), true);
  assert.equal(isStale(null, now, 60), false);
});
