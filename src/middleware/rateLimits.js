'use strict';

const rateLimit = require('express-rate-limit');
const { getConfig } = require('../config/env');

/**
 * Per-route limiters. The default key is the authenticated user id where one
 * exists (so one noisy student cannot throttle the whole campus behind a
 * proxy) and the client IP otherwise.
 */
function makeLimiter({ windowMs, max, message, name }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip,
    handler: (req, res) => {
      res.status(429).json({ error: { code: 'rate_limited', message } });
    },
    // We set trust proxy explicitly in app.js, so skip the library's own
    // header heuristics (they only produce warnings for our custom key).
    validate: false,
  });
}

function limiters() {
  const cfg = getConfig();
  const general = makeLimiter({
    windowMs: cfg.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    max: cfg.RATE_LIMIT_MAX,
    message: 'Too many requests. Please wait a moment and try again.',
  });

  const auth = makeLimiter({
    windowMs: 15 * 60 * 1000,
    max: cfg.RATE_LIMIT_AUTH_MAX,
    message: 'Too many attempts. Please try again in a few minutes.',
  });

  const otp = makeLimiter({
    windowMs: 15 * 60 * 1000,
    max: cfg.RATE_LIMIT_OTP_MAX,
    message: 'Too many verification codes requested. Please wait before trying again.',
  });

  const write = makeLimiter({
    windowMs: 60 * 60 * 1000,
    max: cfg.RATE_LIMIT_WRITE_MAX,
    message: 'You are posting very quickly. Please wait before creating more reports.',
  });

  return { general, auth, otp, write };
}

module.exports = { limiters, makeLimiter };
