'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../lib/errors');
const { validate } = require('../middleware/validate');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { limiters } = require('../middleware/rateLimits');
const { imageUploader, processUploads } = require('../middleware/upload');
const itemService = require('../services/itemService');
const v = require('../validators');

const L = limiters();
const upload = imageUploader({ maxFiles: 3 });

/** Public gallery: search, filter, sort, paginate. */
router.get(
  '/',
  validate({ query: v.listQuery }),
  asyncHandler(async (req, res) => {
    const result = await itemService.listItems({ filters: req.validated.query, ...req.validated.query });
    res.json({ ok: true, ...result });
  })
);

router.get(
  '/stats/public',
  asyncHandler(async (req, res) => {
    // Sequential on purpose: one connection per request keeps the pool free
    // and these two queries are sub-millisecond.
    const stats = await itemService.publicStats();
    const locations = await itemService.locationSuggestions();
    res.json({ ok: true, stats, locations });
  })
);

router.get(
  '/mine',
  authenticate,
  asyncHandler(async (req, res) => {
    const items = await itemService.listMine(req.user.id);
    res.json({ ok: true, items });
  })
);

router.post(
  '/',
  authenticate,
  L.write,
  upload.array('images', 3),
  processUploads,
  validate({ body: v.itemCreate }),
  asyncHandler(async (req, res) => {
    const item = await itemService.createItem({
      user: req.user,
      data: req.validated.body,
      processedImages: req.processedImages,
    });
    res.status(201).json({ ok: true, item });
  })
);

router.get(
  '/:id',
  optionalAuth,
  validate({ params: v.idParam }),
  asyncHandler(async (req, res) => {
    const item = await itemService.getItem(req.validated.params.id, { viewer: req.user });
    res.json({ ok: true, item });
  })
);

router.patch(
  '/:id',
  authenticate,
  validate({ params: v.idParam, body: v.itemUpdate }),
  asyncHandler(async (req, res) => {
    const item = await itemService.updateItem(
      req.validated.params.id,
      req.user,
      req.validated.body
    );
    res.json({ ok: true, item });
  })
);

router.patch(
  '/:id/status',
  authenticate,
  validate({ params: v.idParam, body: v.itemStatus }),
  asyncHandler(async (req, res) => {
    const item = await itemService.setStatus(
      req.validated.params.id,
      req.user,
      req.validated.body.status
    );
    res.json({ ok: true, item });
  })
);

router.delete(
  '/:id',
  authenticate,
  validate({ params: v.idParam }),
  asyncHandler(async (req, res) => {
    const result = await itemService.removeItem(req.validated.params.id, req.user);
    res.json({ ok: true, ...result });
  })
);

module.exports = router;
