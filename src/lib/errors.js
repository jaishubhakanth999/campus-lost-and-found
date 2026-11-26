'use strict';

/** Typed application error carrying an HTTP status and a safe public message. */
class AppError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = options.code || 'error';
    this.fields = options.fields;
    this.details = options.details;
    this.expose = options.expose !== false;
  }
}

const badRequest = (msg, fields) => new AppError(400, msg, { code: 'bad_request', fields });
const unauthorized = (msg = 'Please sign in to continue') =>
  new AppError(401, msg, { code: 'unauthorized' });
const forbidden = (msg = 'You do not have access to this resource') =>
  new AppError(403, msg, { code: 'forbidden' });
const notFound = (msg = 'Not found') => new AppError(404, msg, { code: 'not_found' });
const conflict = (msg, fields) => new AppError(409, msg, { code: 'conflict', fields });
const tooMany = (msg = 'Too many requests, please slow down', retryAfter) =>
  new AppError(429, msg, { code: 'rate_limited', details: { retryAfter } });

/** Wraps an async route handler so rejected promises reach the error handler. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooMany,
  asyncHandler,
};
