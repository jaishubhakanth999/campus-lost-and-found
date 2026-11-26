'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../lib/errors');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { limiters } = require('../middleware/rateLimits');
const { imageUploader, processUploads } = require('../middleware/upload');
const claimService = require('../services/claimService');
const v = require('../validators');

const L = limiters();
const upload = imageUploader({ maxFiles: 2 });

router.post(
  '/',
  authenticate,
  L.write,
  upload.array('evidence', 2),
  processUploads,
  validate({ body: v.claimCreate }),
  asyncHandler(async (req, res) => {
    const claim = await claimService.submit({
      user: req.user,
      itemId: req.validated.body.itemId,
      message: req.validated.body.message,
      processedImages: req.processedImages,
    });
    res.status(201).json({ ok: true, claim });
  })
);

router.get(
  '/mine',
  authenticate,
  asyncHandler(async (req, res) => {
    const claims = await claimService.listMine(req.user.id);
    res.json({ ok: true, claims });
  })
);

router.get(
  '/received',
  authenticate,
  asyncHandler(async (req, res) => {
    const claims = await claimService.listReceived(req.user.id);
    res.json({ ok: true, claims });
  })
);

router.get(
  '/:id',
  authenticate,
  validate({ params: v.idParam }),
  asyncHandler(async (req, res) => {
    const claim = await claimService.getOne(req.validated.params.id, req.user);
    res.json({ ok: true, claim });
  })
);

/** Private evidence images, via 5-minute signed links. */
router.get(
  '/:id/evidence',
  authenticate,
  validate({ params: v.idParam }),
  asyncHandler(async (req, res) => {
    const links = await claimService.evidenceLinks(req.validated.params.id, req.user);
    res.json({ ok: true, links });
  })
);

router.patch(
  '/:id/decision',
  authenticate,
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

router.patch(
  '/:id/withdraw',
  authenticate,
  validate({ params: v.idParam }),
  asyncHandler(async (req, res) => {
    const result = await claimService.withdraw({
      claimId: req.validated.params.id,
      user: req.user,
    });
    res.json({ ok: true, ...result });
  })
);

router.patch(
  '/:id/handover',
  authenticate,
  validate({ params: v.idParam, body: v.handover }),
  asyncHandler(async (req, res) => {
    const claim = await claimService.proposeHandover({
      claimId: req.validated.params.id,
      user: req.user,
      place: req.validated.body.place,
      at: req.validated.body.at || null,
    });
    res.json({ ok: true, claim });
  })
);

router.patch(
  '/:id/complete',
  authenticate,
  validate({ params: v.idParam }),
  asyncHandler(async (req, res) => {
    const claim = await claimService.complete({
      claimId: req.validated.params.id,
      user: req.user,
      ip: req.ip,
    });
    res.json({ ok: true, claim });
  })
);

module.exports = router;
