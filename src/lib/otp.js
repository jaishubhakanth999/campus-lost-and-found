'use strict';

/**
 * OTP primitives.
 *
 * A 6-digit code has only 1,000,000 possible values, so a plain hash of it
 * (bcrypt included) can be brute-forced offline in seconds. We therefore hash
 * with HMAC-SHA256 keyed by a server-side pepper (OTP_PEPPER). Without the
 * pepper the stored digest is useless, and verification stays fast and
 * constant-time. Attempts are limited server-side, which is what actually
 * protects the 6-digit space online.
 */

const crypto = require('node:crypto');
const { getConfig } = require('../config/env');

/** Cryptographically secure 6-digit code, zero padded ("000123" is valid). */
function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code, purpose = '') {
  const { OTP_PEPPER } = getConfig();
  return crypto
    .createHmac('sha256', OTP_PEPPER)
    .update(`${purpose}:${String(code).trim()}`)
    .digest('hex');
}

/** Constant-time comparison of two hex digests. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyCode(code, storedHash, purpose) {
  if (!code || !storedHash) return false;
  return safeEqual(hashCode(code, purpose), storedHash);
}

module.exports = { generateCode, hashCode, verifyCode, safeEqual };
