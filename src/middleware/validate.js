'use strict';

/**
 * Request validation. Every route declares a zod schema; nothing reaches a
 * handler — and therefore nothing reaches SQL — until it has been parsed and
 * coerced. Parsed values are exposed on req.validated so that Express 4's
 * read-only-ish req.query is never mutated.
 */
function validate(schemas) {
  return (req, res, next) => {
    try {
      req.validated = req.validated || {};
      for (const key of ['params', 'query', 'body']) {
        const schema = schemas[key];
        if (!schema) continue;
        req.validated[key] = schema.parse(req[key] ?? {});
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { validate };
