'use strict';

const multer = require('multer');
const { ZodError } = require('zod');
const { AppError } = require('../lib/errors');
const logger = require('../lib/logger');

/** 404 for anything that matched no route. */
function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

const PG_MAP = {
  23505: [409, 'That record already exists'],
  23503: [400, 'A referenced record does not exist'],
  23514: [400, 'The submitted values are not allowed'],
  23502: [400, 'A required value is missing'],
  '22P02': [400, 'One of the submitted values has the wrong format'],
  '22001': [400, 'One of the submitted values is too long'],
};

/**
 * Central error mapper. Clients get a stable shape
 *   { error: { code, message, fields? } }
 * and internal details never leave the server.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;

  // Validation
  if (err instanceof ZodError) {
    const fields = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || 'body';
      if (!fields[key]) fields[key] = issue.message;
    }
    return res.status(400).json({
      error: { code: 'validation_failed', message: 'Please check the highlighted fields', fields },
    });
  }

  // Uploads
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Image is too large (maximum ${require('../config/env').getConfig().MAX_UPLOAD_MB} MB)`
        : err.code === 'LIMIT_FILE_COUNT'
          ? 'Too many images in one report'
          : err.message;
    return res.status(status).json({ error: { code: 'upload_rejected', message } });
  }

  // Postgres
  if (err && err.code && PG_MAP[err.code]) {
    const [status, message] = PG_MAP[err.code];
    logger.warn('database constraint violation', { code: err.code, detail: err.detail });
    return res.status(status).json({ error: { code: 'db_constraint', message } });
  }

  // JWT
  if (err && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')) {
    return res
      .status(401)
      .json({ error: { code: 'unauthorized', message: 'Please sign in again' } });
  }

  if (err instanceof AppError || (err && err.status && err.expose)) {
    const body = { error: { code: err.code || 'error', message: err.message } };
    if (err.fields) body.error.fields = err.fields;
    if (err.details) body.error.details = err.details;
    if (err.status >= 500) logger.error('application error', { message: err.message });
    return res.status(err.status).json(body);
  }

  const requestId = Math.random().toString(36).slice(2, 10);
  logger.error('unhandled error', {
    requestId,
    message: err && err.message,
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : undefined,
    path: req.originalUrl,
    method: req.method,
  });
  return res.status(500).json({
    error: { code: 'internal_error', message: 'Something went wrong on our side', requestId },
  });
}

module.exports = { notFoundHandler, errorHandler };
