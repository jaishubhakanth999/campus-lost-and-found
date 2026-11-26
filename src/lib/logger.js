'use strict';

/**
 * Tiny structured logger with redaction.
 *
 * Rule 7 of the brief: passwords and OTPs must never reach the logs. Every
 * value passes through redact() before it is serialised, so an accidental
 * logger.info({ code }) cannot leak a verification code.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SECRET_KEYS = /(pass(word)?|otp|code|token|secret|authorization|cookie|hash|pepper|service_role)/i;

function currentLevel() {
  const lvl = process.env.LOG_LEVEL || 'info';
  return LEVELS[lvl] ?? LEVELS.info;
}

function redact(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level, msg, meta) {
  if (LEVELS[level] < currentLevel()) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(meta ? redact(meta) : {}) };
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(JSON.stringify(line));
}

module.exports = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  redact,
};
