/**
 * TOTP (RFC 6238) for two-factor authentication, implemented on Node's crypto
 * so there's no third-party dependency for a security-critical primitive.
 * Compatible with Google Authenticator, Authy, 1Password, etc. (SHA1, 6 digits,
 * 30-second step — the universal defaults).
 */
import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/g, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A fresh random base32 secret (160 bits, the recommended length). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226). */
export function hotp(secret: string, counter: number, digits = 6): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (safe for any realistic time).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** TOTP for a given time (ms since epoch; defaults to now). */
export function totp(secret: string, atMs: number = Date.now(), step = 30, digits = 6): string {
  return hotp(secret, Math.floor(atMs / 1000 / step), digits);
}

/**
 * Verify a code, allowing ±`window` steps for clock skew (so a code is valid
 * for ~90 seconds with the default window of 1). Constant-ish comparison.
 */
export function verifyTotp(secret: string, token: string, atMs: number = Date.now(), window = 1, step = 30, digits = 6): boolean {
  if (!secret || !token) return false;
  const clean = String(token).replace(/\s/g, '');
  if (!/^\d{6,8}$/.test(clean)) return false;
  const counter = Math.floor(atMs / 1000 / step);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w, digits) === clean) return true;
  }
  return false;
}

/** otpauth:// URI that authenticator apps turn into a QR code. */
export function otpauthUrl(secret: string, account: string, issuer = 'Book of Business'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
