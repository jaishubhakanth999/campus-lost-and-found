'use strict';

/**
 * Administrator API.
 *
 * router.use(authenticate, requireRole('admin')) applies to EVERY route below,
 * so a new endpoint cannot accidentally ship without protection. The front end
 * hiding a button is never the control.
 */

const router = require('express').Router();
const { asyncHandler } = require('../lib/errors');
const { validate } = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const adminService = require('../services/adminService');
const authService = require('../services/authService');
const claimService = require('../services/claimService');
const itemService = require('../services/itemService');
const audit = require('../services/auditService');
const v = require('../validators');

router.use(authenticate, requireRole('admin'));

router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, overview: await adminService.overview() });
  })
);

/* ---------------------------------- users --------------------------------- */

router.get(
  '/users',
  validate({ query: v.adminUsersQuery }),
  asyncHandler(async (req, res) => {
    const q = req.validated.query;
    const result = await adminService.listUsers({
      ...q,
      verified: q.verified === undefined ? null : q.verified === 'true',
    });
    res.json({ ok: true, ...result });
  })
);

router.patch(
  '/users/:id',
  validate({ params: v.idParam, body: v.adminUserPatch }),
  asyncHandler(async (req, res) => {
    const user = await adminService.updateUser({
      targetId: req.validated.params.id,
      actor: req.user,
      patch: req.validated.body,
      ip: req.ip,
    });
    res.json({ ok: true, user });
  })
);

/* -------------------------------- sessions -------------------------------- */

router.get(
  '/sessions',
  validate({ query: v.adminSessionsQuery }),
  asyncHandler(async (req, res) => {
    const result = await adminService.listSessions(req.validated.query);
    res.json({ ok: true, ...result });
  })
);

router.patch(
  '/sessions/:id/revoke',
  validate({ params: v.idParam }),
  asyncHandler(async (req, res) => {
    const result = await authService.revokeSession(
      req.validated.params.id,
      'revoked by administrator'
    );
    await audit.record({
      actor: req.user,
      action: 'session.revoked',
      targetType: 'session',
      targetId: req.validated.params.id,
      ip: req.ip,
    });
    res.json({ ok: true, ...result });
  })
);

router.get(
  '/auth-events',
  validate({ query: v.adminEventsQuery }),
  asyncHandler(async (req, res) => {
    const result = await adminService.listAuthEvents(req.validated.query);
    res.json({ ok: true, ...result });
  })
);

/* ---------------------------------- items --------------------------------- */

router.get(
  '/items',
  validate({ query: v.adminItemsQuery }),
  asyncHandler(async (req, res) => {
    const result = await adminService.listItems(req.validated.query);
    res.json({ ok: true, ...result });
  })
);

router.patch(
  '/items/:id/moderate',
  validate({ params: v.idParam, body: v.adminModerate }),
  asyncHandler(async (req, res) => {
    const result = await adminService.moderateItem({
      id: req.validated.params.id,
      actor: req.user,
      action: req.validated.body.action,
      note: req.validated.body.note || null,
      ip: req.ip,
    });
    res.json({ ok: true, ...result });
  })
);

router.patch(
  '/items/:id/status',
  validate({ params: v.idParam, body: v.itemStatus }),
  asyncHandler(async (req, res) => {
    const item = await itemService.setStatus(
      req.validated.params.id,
      req.user,
      req.validated.body.status
    );
    await audit.record({
      actor: req.user,
      action: 'item.status_changed',
      targetType: 'item',
      targetId: req.validated.params.id,
      details: { status: req.validated.body.status, note: req.validated.body.note || null },
      ip: req.ip,
    });
    res.json({ ok: true, item });
  })
);

/* ---------------------------------- claims -------------------------------- */

router.get(
  '/claims',
  validate({ query: v.adminClaimsQuery }),
  asyncHandler(async (req, res) => {
    const result = await adminService.listClaims(req.validated.query);
    res.json({ ok: true, ...result });
  })
);

router.patch(
  '/claims/:id/decision',
  validate({ params: v.idParam, body: v.claimDecision }),
  asyncHandler(async (req, res) => {
    const claim = await claimService.decide({
      claimId: req.validated.params.id,
      actor: req.user,
      decision: req.validated.body.decision,
      note: req.validated.body.note || null,
      ip: req.ip,
    });
    res.json({ ok: true, claim });
  })
);

/* ----------------------------------- audit -------------------------------- */

router.get(
  '/audit-logs',
  validate({ query: v.adminAuditQuery }),
  asyncHandler(async (req, res) => {
    const result = await audit.list(req.validated.query);
    res.json({ ok: true, ...result });
  })
);

module.exports = router;
