'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../lib/errors');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { limiters } = require('../middleware/rateLimits');
const authService = require('../services/authService');
const v = require('../validators');

const L = limiters();

const clientMeta = (req) => ({
  ip: req.ip,
  userAgent: String(req.get('user-agent') || '').slice(0, 300),
});

/** Registration — no JWT is issued until the OTP is verified. */
router.post(
  '/register',
  L.auth,
  validate({ body: v.register }),
  asyncHandler(async (req, res) => {
    const result = await authService.register({ ...req.validated.body, ...clientMeta(req) });
    res.status(201).json({ ok: true, ...result });
  })
);

/** Student login — returns an OTP challenge, never a session. */
router.post(
  '/login',
  L.auth,
  validate({ body: v.login }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.validated.body;
    const result = await authService.login({
      email,
      password,
      portal: 'student',
      ...clientMeta(req),
    });
    res.json({ ok: true, ...result });
  })
);

/** Administrator login — separate endpoint, same OTP requirement. */
router.post(
  '/admin/login',
  L.auth,
  validate({ body: v.login }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.validated.body;
    const result = await authService.login({
      email,
      password,
      portal: 'admin',
      ...clientMeta(req),
    });
    res.json({ ok: true, ...result });
  })
);

/** The only place a JWT is ever handed out. */
router.post(
  '/verify-otp',
  L.otp,
  validate({ body: v.verifyOtp }),
  asyncHandler(async (req, res) => {
    const { email, code, purpose } = req.validated.body;
    const result = await authService.verifyOtp({ email, code, purpose, ...clientMeta(req) });
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/resend-otp',
  L.otp,
  validate({ body: v.resendOtp }),
  asyncHandler(async (req, res) => {
    const { email, purpose } = req.validated.body;
    const result = await authService.resendOtp({ email, purpose, ip: req.ip });
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await authService.logout({
      sessionRowId: req.session.rowId,
      userId: req.user.id,
      reason: 'user logout',
      ...clientMeta(req),
    });
    res.json({ ok: true, ...result });
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const profile = await authService.getProfile(req.user.id);
    res.json({ ok: true, user: profile });
  })
);

router.patch(
  '/me',
  authenticate,
  validate({ body: v.updateProfile }),
  asyncHandler(async (req, res) => {
    const user = await authService.updateProfile(req.user.id, req.validated.body);
    res.json({ ok: true, user });
  })
);

router.post(
  '/change-password',
  authenticate,
  validate({ body: v.changePassword }),
  asyncHandler(async (req, res) => {
    const result = await authService.changePassword(req.user.id, {
      ...req.validated.body,
      keepSessionRowId: req.session.rowId,
    });
    res.json({ ok: true, ...result });
  })
);

/** The student's own login/logout history. */
router.get(
  '/sessions',
  authenticate,
  asyncHandler(async (req, res) => {
    const sessions = await authService.listSessions(req.user.id);
    res.json({ ok: true, sessions, currentSessionId: req.session.sid });
  })
);

module.exports = router;
