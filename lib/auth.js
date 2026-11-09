/**
 * Senhas (scrypt), sessões por token e limite de tentativas.
 */
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_DAYS) || 30) * 24 * 3600 * 1000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// Hash fixo para comparar quando o usuário não existe (evita revelar isso pelo tempo de resposta).
let dummyHash = null;
async function verifyAgainstDummy(password) {
  dummyHash ||= await hashPassword('senha-inexistente-' + crypto.randomBytes(8).toString('hex'));
  await verifyPassword(password, dummyHash);
  return false;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function createSession(pool, userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await pool.query(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
    [sha256(token), userId, now, now + SESSION_TTL_MS, String(userAgent || '').slice(0, 255)],
  );
  return token;
}

async function userIdFromToken(pool, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const [rows] = await pool.query('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', [sha256(token)]);
  if (!rows.length || Number(rows[0].expires_at) < Date.now()) return null;
  return rows[0].user_id;
}

async function deleteSession(pool, token) {
  if (!token) return;
  await pool.query('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

async function purgeExpiredSessions(pool) {
  await pool.query('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
}

/** Limite simples em memória: no máximo `max` eventos por `windowMs` para cada chave. */
class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.resetAt < now) this.hits.delete(k);
    }, 60_000).unref();
  }
  blocked(key) {
    const entry = this.hits.get(key);
    return !!entry && entry.resetAt > Date.now() && entry.count >= this.max;
  }
  hit(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
  }
  reset(key) {
    this.hits.delete(key);
  }
}

module.exports = {
  hashPassword, verifyPassword, verifyAgainstDummy,
  createSession, userIdFromToken, deleteSession, purgeExpiredSessions, RateLimiter,
};
