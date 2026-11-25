// Strict, dependency-free validation. Every function returns
// { ok: true, value } with a normalised value, or { ok: false, errors: [...] }.

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function parseTs(v) {
  if (typeof v !== 'string' || !ISO_TS.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

export const TRIP_EVENT_TYPES = ['TRIP_STARTED', 'DELIVERY_CONFIRMED', 'TRIP_COMPLETED'];

const isObject = (b) => b && typeof b === 'object' && !Array.isArray(b);

export function validateReading(body, { nowMs, maxFutureSeconds }) {
  if (!isObject(body)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors = [];
  const { deviceId, ts, tempC, doorOpen, battery, lat, lng } = body;

  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(deviceId))
    errors.push('deviceId must be 1-32 characters of [A-Za-z0-9_-]');

  const ms = parseTs(ts);
  if (ms === null) errors.push('ts must be an ISO-8601 timestamp with timezone, e.g. 2026-11-20T08:15:03Z');
  else if (ms > nowMs + maxFutureSeconds * 1000) errors.push('ts is too far in the future');

  if (typeof tempC !== 'number' || !Number.isFinite(tempC) || tempC < -80 || tempC > 100)
    errors.push('tempC must be a number between -80 and 100');
  if (typeof doorOpen !== 'boolean') errors.push('doorOpen must be a boolean');
  if (!Number.isInteger(battery) || battery < 0 || battery > 100)
    errors.push('battery must be an integer between 0 and 100');
  if (lat !== undefined && (typeof lat !== 'number' || lat < -90 || lat > 90)) errors.push('lat must be -90..90');
  if (lng !== undefined && (typeof lng !== 'number' || lng < -180 || lng > 180)) errors.push('lng must be -180..180');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      deviceId,
      ts: new Date(ms).toISOString(), // normalised => stable dedupe key
      tempC,
      doorOpen,
      battery,
      lat: lat ?? null,
      lng: lng ?? null,
    },
  };
}

export function validateTripEvent(body, { nowMs, maxFutureSeconds }) {
  if (!isObject(body)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors = [];
  const { type, clientEventId, ts } = body;

  if (!TRIP_EVENT_TYPES.includes(type)) errors.push(`type must be one of ${TRIP_EVENT_TYPES.join(', ')}`);
  if (typeof clientEventId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(clientEventId))
    errors.push('clientEventId must be 8-64 characters of [A-Za-z0-9_-] (a UUID works)');
  const ms = parseTs(ts);
  if (ms === null) errors.push('ts must be an ISO-8601 timestamp with timezone');
  else if (ms > nowMs + maxFutureSeconds * 1000) errors.push('ts is too far in the future');

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { type, clientEventId, ts: new Date(ms).toISOString() } };
}
