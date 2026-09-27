// Minimal, dependency-free auth for the admin area: PBKDF2 password
// verification + signed, expiring session cookies. Everything here uses only
// the Web Crypto API (globalThis.crypto.subtle), which the Cloudflare
// Workers runtime provides natively — no npm packages needed.

const SESSION_COOKIE = "zettly_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Constant-time comparison of two equal-length byte-ish strings, to avoid
// leaking timing information about how much of a secret matched.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

/**
 * Verify a plaintext password against a stored hash of the form
 * "pbkdf2$<iterations>$<saltBase64Url>$<hashBase64Url>" (see
 * scripts/hash-admin-password.mjs for how to generate one).
 */
export async function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const salt = fromBase64Url(parts[2]);
  const expected = parts[3];
  const derived = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(toBase64Url(derived), expected);
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(sig));
}

/** Create a signed, expiring session token: "<payloadB64>.<hmacB64>". */
export async function createSessionToken(secret, extra = {}) {
  const payload = { ...extra, exp: Date.now() + SESSION_TTL_MS };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

/** Verify a session token's signature and expiry; returns the payload or null. */
export async function verifySessionToken(secret, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");
  const expectedSig = await hmac(secret, payloadB64);
  if (!timingSafeEqual(expectedSig, sig)) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}

export function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookieName() {
  return SESSION_COOKIE;
}

export function buildSessionCookie(token, { clear = false } = {}) {
  const maxAge = clear ? 0 : Math.floor(SESSION_TTL_MS / 1000);
  const value = clear ? "" : token;
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

/** Returns the verified session payload for this request, or null. */
export async function getSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return verifySessionToken(env.SESSION_SECRET, token);
}

// ---- Login rate limiting (per source IP, backed by D1) ----------------

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

export async function isLockedOut(env, ip) {
  if (!env.DB) return false;
  const row = await env.DB.prepare(
    `SELECT locked_until FROM admin_login_attempts WHERE ip = ?`
  )
    .bind(ip)
    .first();
  if (!row || !row.locked_until) return false;
  return new Date(row.locked_until + "Z").getTime() > Date.now();
}

export async function recordFailedLogin(env, ip) {
  if (!env.DB) return;
  const row = await env.DB.prepare(
    `SELECT attempts FROM admin_login_attempts WHERE ip = ?`
  )
    .bind(ip)
    .first();
  const attempts = (row?.attempts || 0) + 1;
  const lockedUntil =
    attempts >= MAX_ATTEMPTS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString().replace("Z", "")
      : null;
  await env.DB.prepare(
    `INSERT INTO admin_login_attempts (ip, attempts, locked_until, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(ip) DO UPDATE SET attempts = excluded.attempts, locked_until = excluded.locked_until, updated_at = excluded.updated_at`
  )
    .bind(ip, attempts, lockedUntil)
    .run();
}

export async function clearFailedLogins(env, ip) {
  if (!env.DB) return;
  await env.DB.prepare(`DELETE FROM admin_login_attempts WHERE ip = ?`).bind(ip).run();
}
