// All tunables come from environment variables so the same image runs in
// Docker, locally and in tests. Defaults match the case-study rules.
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 3000),
    dbPath: env.DB_PATH || './data/coldchain.db',
    jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
    deviceKey: env.DEVICE_API_KEY || 'dev-device-key',
    simUrl: env.SIM_URL || 'http://localhost:4100',

    // Alert rules
    tempThresholdC: num(env.TEMP_THRESHOLD_C, 8),
    breachSeconds: num(env.BREACH_SECONDS, 120), // above threshold for this long => alert
    offlineSeconds: num(env.OFFLINE_SECONDS, 60), // silent for this long => OFFLINE
    sweepMs: num(env.SWEEP_MS, 5000),

    // Ingestion
    maxFutureSeconds: 300, // reject readings stamped > 5 min in the future (clock skew guard)
    maxBatch: 500,
  };
}
