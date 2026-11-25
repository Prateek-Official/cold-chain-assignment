// Pure alert-rule functions: no database, no clock, no I/O. This is the part that
// is easiest to get subtly wrong, so it is isolated and unit-tested.

/**
 * "Temperature above X °C for N seconds".
 *
 * `readings` must be sorted by ts ascending and cover (at least) the last N seconds
 * before the newest reading. The rule is evaluated on *event time* (device timestamps),
 * from stored history rather than from in-memory state. Consequences:
 *   - late / out-of-order readings are handled for free (they slot into history),
 *   - duplicates are harmless,
 *   - evaluating twice gives the same answer (idempotent), and survives restarts.
 *
 * A breach is a continuous run of readings > threshold that ends at the newest reading
 * and spans >= windowSeconds. A single normal reading resets the run.
 */
export function evaluateBreach(readings, { thresholdC, windowSeconds }) {
  const none = { breached: false, since: null, durationSec: 0, peakC: null };
  if (!readings.length) return none;

  const last = readings[readings.length - 1];
  if (!(last.tempC > thresholdC)) return none;

  let i = readings.length - 1;
  let peakC = last.tempC;
  while (i > 0 && readings[i - 1].tempC > thresholdC) {
    i -= 1;
    peakC = Math.max(peakC, readings[i].tempC);
  }
  const since = readings[i].ts;
  const durationSec = (Date.parse(last.ts) - Date.parse(since)) / 1000;
  return { breached: durationSec >= windowSeconds, since, durationSec, peakC };
}

/** A device is stale when we have not *received* anything from it for `offlineSeconds`. */
export function isStale(lastSeenAtIso, nowMs, offlineSeconds) {
  if (!lastSeenAtIso) return false; // never seen => UNKNOWN, not OFFLINE
  return nowMs - Date.parse(lastSeenAtIso) >= offlineSeconds * 1000;
}
