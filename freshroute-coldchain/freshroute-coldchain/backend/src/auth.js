import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// ---- passwords (scrypt, per-user salt) -------------------------------------
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---- tokens (standard HS256 JWT, ~20 lines instead of a dependency) --------
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const sign = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url');

export function signToken(payload, secret, { ttlSeconds = 12 * 3600, nowMs = Date.now() } = {}) {
  const iat = Math.floor(nowMs / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, iat, exp: iat + ttlSeconds });
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

export function verifyToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const given = Buffer.from(parts[2]);
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.exp || payload.exp * 1000 < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- express middleware ----------------------------------------------------
export function authenticate(config) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    // EventSource cannot set headers, so the SSE endpoint also accepts ?token=
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    const payload = verifyToken(token, config.jwtSecret);
    if (!payload) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: payload.sub, role: payload.role, name: payload.name, username: payload.username };
    next();
  };
}

export const requireRole = (role) => (req, res, next) =>
  req.user?.role === role ? next() : res.status(403).json({ error: `Requires ${role} role` });
