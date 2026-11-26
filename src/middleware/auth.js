'use strict';

const jwt = require('jsonwebtoken');
const { getConfig } = require('../config/env');
const { query } = require('../db/pool');
const { unauthorized, forbidden } = require('../lib/errors');

const ISSUER = 'campusconnect';

/** Signs a short-lived access token bound to a server-side session id (`sid`). */
function signToken(user, sessionId) {
  const cfg = getConfig();
  return jwt.sign({ sub: user.id, sid: sessionId, role: user.role }, cfg.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: cfg.JWT_EXPIRES_IN,
    issuer: ISSUER,
  });
}

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

const SESSION_LOOKUP = `
  select s.id            as session_row_id,
         s.session_id    as sid,
         s.status        as session_status,
         s.expires_at,
         u.id            as user_id,
         u.name, u.email, u.role,
         u.status        as user_status,
         u.is_email_verified
    from user_sessions s
    join users u on u.id = s.user_id
   where s.session_id = $1
`;

/**
 * Verifies the JWT *and* the session row it points at.
 * A token is worthless once its session is logged out, revoked or expired —
 * that is what makes logout real instead of cosmetic.
 */
async function authenticate(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) throw unauthorized();

    let payload;
    try {
      payload = jwt.verify(token, getConfig().JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: ISSUER,
      });
    } catch {
      throw unauthorized('Your session has ended, please sign in again');
    }

    const { rows } = await query(SESSION_LOOKUP, [payload.sid]);
    const session = rows[0];
    if (!session) throw unauthorized('Your session has ended, please sign in again');
    if (session.session_status !== 'active') {
      throw unauthorized('This session was signed out or revoked');
    }
    if (new Date(session.expires_at) <= new Date()) {
      await query(
        `update user_sessions set status = 'expired', logout_reason = 'session expired'
          where id = $1 and status = 'active'`,
        [session.session_row_id]
      );
      throw unauthorized('Your session expired, please sign in again');
    }
    if (session.user_status !== 'active') throw unauthorized('This account is not available');
    if (!session.is_email_verified) throw unauthorized('Please verify your email address');

    req.user = {
      id: session.user_id,
      name: session.name,
      email: session.email,
      role: session.role,
    };
    req.session = { rowId: session.session_row_id, sid: session.sid };

    // Touch last_activity_at at most every five minutes to avoid a write per request.
    await query(
      `update user_sessions
          set last_activity_at = now()
        where id = $1 and last_activity_at < now() - interval '5 minutes'`,
      [session.session_row_id]
    );

    return next();
  } catch (err) {
    return next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    return next();
  };
}

/** Attaches req.user when a valid token is present, but never blocks. */
async function optionalAuth(req, res, next) {
  if (!readToken(req)) return next();
  return authenticate(req, res, (err) => {
    if (err) {
      req.user = undefined;
      return next();
    }
    return next();
  });
}

module.exports = { authenticate, requireRole, optionalAuth, signToken };
