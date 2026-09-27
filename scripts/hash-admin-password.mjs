// Generates a value for the ADMIN_PASSWORD_HASH secret from a plaintext
// password, using the exact PBKDF2 scheme src/auth.js verifies against
// (Node's Web Crypto implementation is the same API Cloudflare Workers use,
// so this doesn't need any extra dependency).
//
// Usage:
//   node scripts/hash-admin-password.mjs "your-new-admin-password"
//
// Then store the printed value as a Cloudflare secret:
//   wrangler secret put ADMIN_PASSWORD_HASH
// (paste the printed string when prompted).

import { webcrypto as crypto } from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/hash-admin-password.mjs <password>");
  process.exit(1);
}
if (password.length < 10) {
  console.error("Please choose a password of at least 10 characters.");
  process.exit(1);
}

const ITERATIONS = 100000;

function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return Buffer.from(binary, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
  "deriveBits",
]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
const hash = toBase64Url(new Uint8Array(bits));
const saltB64 = toBase64Url(salt);

console.log(`pbkdf2$${ITERATIONS}$${saltB64}$${hash}`);
