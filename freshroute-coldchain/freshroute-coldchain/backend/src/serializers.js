// DB rows (snake_case) -> API objects (camelCase).

export const serializeDevice = (r) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  lastSeenAt: r.last_seen_at,
  lastReadingTs: r.last_reading_ts,
  tempC: r.last_temp_c,
  battery: r.last_battery,
  doorOpen: r.last_door_open == null ? null : !!r.last_door_open,
  lat: r.last_lat,
  lng: r.last_lng,
  openAlerts: r.open_alerts ?? 0,
});

export const serializeTrip = (r) => ({
  id: r.id,
  deviceId: r.device_id,
  driverId: r.driver_id,
  driverName: r.driver_name,
  cargo: r.cargo,
  origin: r.origin,
  destination: r.destination,
  status: r.status,
  startedAt: r.started_at,
  deliveredAt: r.delivered_at,
  completedAt: r.completed_at,
  deviceStatus: r.device_status,
  tempC: r.last_temp_c,
  battery: r.last_battery,
  doorOpen: r.last_door_open == null ? null : !!r.last_door_open,
  lastReadingTs: r.last_reading_ts,
  lastSeenAt: r.last_seen_at,
  openAlerts: r.open_alerts ?? 0,
});

export const serializeAlert = (r) => ({
  id: r.id,
  deviceId: r.device_id,
  tripId: r.trip_id,
  type: r.type,
  status: r.status,
  message: r.message,
  peakTempC: r.peak_temp_c,
  openedAt: r.opened_at,
  resolvedAt: r.resolved_at,
  ackedBy: r.acked_by_name ?? null,
  ackedAt: r.acked_at,
});

export const serializeReading = (r) => ({
  deviceId: r.device_id,
  ts: r.ts,
  tempC: r.temp_c,
  doorOpen: !!r.door_open,
  battery: r.battery,
  lat: r.lat,
  lng: r.lng,
});
