'use strict';

/**
 * Authentication service — the whole email-OTP flow lives here.
 *
 * Flow summary
 *   register  → domain check → account row (unverified) → OTP email
 *   verify    → OTP check  → mark verified → create session → JWT
 *   login     → password   → OTP email (never a session yet)
 *   verify    → OTP check  → create session → JWT
 *   logout    → session row closed → JWT stops working immediately
 *
 * Design rules enforced here:
 *  * No JWT is ever issued before the OTP is verified.
 *  * OTPs are stored as HMAC digests, single-use, 5-minute lifetime, max 5
 *    attempts, with a resend cooldown and an hourly cap.
 *  * Issuing a new code supersedes the previous one.
 *  * Login errors never reveal whether an account exists.
 *  * Admin and student portals are separate and mutually exclusive.
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../db/pool');
const { getConfig } = require('../config/env');
const {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  conflict,
  tooMany,
} = require('../lib/errors');
const { generateCode, hashCode, verifyCode } = require('../lib/otp');
const { signToken } = require('../middleware/auth');
const mailer = require('./mailer');
const templates = require('./emailTemplates');
const logger = require('../lib/logger');

const bcryptRounds = () => getConfig().BCRYPT_ROUNDS;
const PUBLIC_USER_FIELDS = `id, name, email, role, is_email_verified, status,
  student_id, department, phone, last_login_at, email_verified_at, created_at, updated_at`;

let dummyHash;
function getDummyHash() {
  if (!dummyHash) dummyHash = bcrypt.hashSync('timing-equaliser-not-a-real-password', bcryptRounds());
  return dummyHash;
}

const normalizeEmail = (raw) => String(raw || '').trim().toLowerCase();

function emailDomain(email) {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1);
}

/**
 * True when the address belongs to an approved university domain.
 * Sub-domains are accepted: with "saiuniversity.edu.in" configured,
 * "student@scds.saiuniversity.edu.in" is allowed.
 */
function domainAllowed(email, kind = 'student') {
  const cfg = getConfig();
  if (!cfg.REQUIRE_EMAIL_DOMAIN) return true;
  const domains = kind === 'admin' ? cfg.adminEmailDomains : cfg.ALLOWED_EMAIL_DOMAINS;
  if (!domains.length) return false;
  const domain = emailDomain(email);
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function allowedDomainHint(kind = 'student') {
  const cfg = getConfig();
  const domains = kind === 'admin' ? cfg.adminEmailDomains : cfg.ALLOWED_EMAIL_DOMAINS;
  return domains.length ? domains.map((d) => `@${d}`).join(' or ') : 'an approved university domain';
}

async function findUserByEmail(email, { withPassword = false } = {}) {
  const cols = withPassword ? `${PUBLIC_USER_FIELDS}, password_hash` : PUBLIC_USER_FIELDS;
  const { rows } = await query(`select ${cols} from users where lower(email) = $1 limit 1`, [
    normalizeEmail(email),
  ]);
  return rows[0] || null;
}

async function findUserById(id, client = null) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(`select ${PUBLIC_USER_FIELDS} from users where id = $1`, [id]);
  return rows[0] || null;
}

/* ------------------------------- auth events ------------------------------- */

async function recordAuthEvent({ userId = null, email = null, event, outcome = 'success', reason = null, ip = null, userAgent = null }, client = null) {
  const run = client ? client.query.bind(client) : query;
  try {
    await run(
      `insert into auth_events (user_id, email, event, outcome, reason, ip, user_agent)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, email ? normalizeEmail(email) : null, event, outcome, reason, ip, userAgent]
    );
  } catch (err) {
    // Never let an audit write break the user-facing flow.
    logger.warn('could not record auth event', { event, message: err.message });
  }
}

/* ----------------------------------- OTP ---------------------------------- */

async function issueOtp({ user, purpose, ip = null }) {
  const cfg = getConfig();
  const now = Date.now();

  const { rows: recent } = await query(
    `select created_at from otp_codes
      where user_id = $1 and purpose = $2
      order by created_at desc limit 1`,
    [user.id, purpose]
  );

  if (recent.length && cfg.OTP_RESEND_COOLDOWN_SECONDS > 0) {
    const elapsed = (now - new Date(recent[0].created_at).getTime()) / 1000;
    if (elapsed < cfg.OTP_RESEND_COOLDOWN_SECONDS) {
      const retryAfter = Math.ceil(cfg.OTP_RESEND_COOLDOWN_SECONDS - elapsed);
      throw tooMany(`Please wait ${retryAfter} seconds before requesting another code`, retryAfter);
    }
  }

  // Counted across every purpose for this account, so a client cannot triple
  // its guessing budget by cycling signup/login/admin_login (F8).
  const { rows: hourly } = await query(
    `select count(*)::int as n from otp_codes
      where user_id = $1 and created_at > now() - interval '1 hour'`,
    [user.id]
  );
  if (hourly[0].n >= cfg.OTP_MAX_PER_HOUR) {
    throw tooMany('Too many codes requested. Please try again later.');
  }

  const code = generateCode();
  const codeHash = hashCode(code, purpose);
  const expiresAt = new Date(now + cfg.otpTtlMs);

  await withTransaction(async (client) => {
    // Supersede any live code so only the newest one can ever be used.
    await client.query(
      `update otp_codes set consumed_at = now()
        where user_id = $1 and purpose = $2 and consumed_at is null`,
      [user.id, purpose]
    );
    await client.query(
      `insert into otp_codes (user_id, purpose, code_hash, expires_at, max_attempts, request_ip)
       values ($1, $2, $3, $4, $5, $6)`,
      [user.id, purpose, codeHash, expiresAt, cfg.OTP_MAX_ATTEMPTS, ip]
    );
  });

  const mail = templates.otpEmail({
    name: user.name,
    code,
    minutes: cfg.OTP_TTL_MINUTES,
    purpose,
  });
  const sent = await mailer.send({ to: user.email, ...mail });
  await recordAuthEvent({
    userId: user.id,
    email: user.email,
    event: 'otp_sent',
    outcome: sent.ok ? 'success' : 'failure',
    reason: sent.ok ? purpose : 'mail delivery failed',
    ip,
  });

  return {
    purpose,
    email: user.email,
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: cfg.OTP_TTL_MINUTES * 60,
    resendInSeconds: cfg.OTP_RESEND_COOLDOWN_SECONDS,
    emailSent: sent.ok,
  };
}

async function verifyOtp({ email, code, purpose, ip = null, userAgent = null }) {
  const normalized = normalizeEmail(email);
  const user = await findUserByEmail(normalized, { withPassword: false });

  // Constant-ish behaviour for unknown accounts.
  if (!user) {
    verifyCode(code, hashCode('000000', purpose), purpose);
    await recordAuthEvent({
      email: normalized,
      event: 'otp_failed',
      outcome: 'failure',
      reason: 'unknown account',
      ip,
      userAgent,
    });
    throw badRequest('That code is invalid or has expired. Request a new one.');
  }

  // The purpose must belong to the portal this account may use (F8).
  if (purpose === 'admin_login' && user.role !== 'admin') {
    await recordAuthEvent({
      userId: user.id,
      email: user.email,
      event: 'otp_failed',
      outcome: 'blocked',
      reason: 'admin_login requested by a non-administrator',
      ip,
      userAgent,
    });
    throw badRequest('That code is invalid or has expired. Request a new one.');
  }

  if (user.status !== 'active') {
    await recordAuthEvent({
      userId: user.id,
      email: user.email,
      event: 'otp_failed',
      outcome: 'blocked',
      reason: `account ${user.status}`,
      ip,
      userAgent,
    });
    throw forbidden('This account is not available. Please contact the campus help desk.');
  }

  const { rows } = await query(
    `select id, code_hash, attempts, max_attempts, expires_at, consumed_at
       from otp_codes
      where user_id = $1 and purpose = $2 and consumed_at is null
      order by created_at desc limit 1`,
    [user.id, purpose]
  );
  const otp = rows[0];
  if (!otp) {
    throw badRequest('That code is invalid or has expired. Request a new one.');
  }

  if (new Date(otp.expires_at) <= new Date()) {
    await query(`update otp_codes set consumed_at = now() where id = $1`, [otp.id]);
    await recordAuthEvent({
      userId: user.id,
      email: user.email,
      event: 'otp_expired',
      outcome: 'failure',
      reason: purpose,
      ip,
      userAgent,
    });
    throw badRequest('That code has expired. Request a new one.');
  }

  if (otp.attempts >= otp.max_attempts) {
    await query(`update otp_codes set consumed_at = now() where id = $1`, [otp.id]);
    throw tooMany('Too many incorrect attempts. Request a new code.');
  }

  if (!verifyCode(code, otp.code_hash, purpose)) {
    // Atomic increment: parallel guesses can no longer overwrite each other's
    // counter (F2), and the row is burned when the budget is spent.
    const bumped = await query(
      `update otp_codes
          set attempts = attempts + 1,
              consumed_at = case when attempts + 1 >= max_attempts then now() else consumed_at end
        where id = $1 and consumed_at is null
        returning attempts, max_attempts`,
      [otp.id]
    );
    const attempts = bumped.rows[0] ? bumped.rows[0].attempts : otp.max_attempts;
    const exhausted = attempts >= otp.max_attempts;
    await recordAuthEvent({
      userId: user.id,
      email: user.email,
      event: 'otp_failed',
      outcome: 'failure',
      reason: `incorrect code (${attempts}/${otp.max_attempts})`,
      ip,
      userAgent,
    });
    if (exhausted) throw tooMany('Too many incorrect attempts. Request a new code.');
    throw badRequest(`That code is incorrect. ${otp.max_attempts - attempts} attempt(s) left.`);
  }

  // Success — burn the code first, conditionally, so two parallel requests
  // cannot both redeem it (F2). The loser is told the code is gone.
  const burned = await query(
    `update otp_codes set consumed_at = now()
      where id = $1 and consumed_at is null
      returning id`,
    [otp.id]
  );
  if (!burned.rowCount) {
    throw badRequest('That code is invalid or has expired. Request a new one.');
  }
  await recordAuthEvent({
    userId: user.id,
    email: user.email,
    event: 'otp_verified',
    outcome: 'success',
    reason: purpose,
    ip,
    userAgent,
  });

  if (purpose === 'signup') {
    await query(
      `update users
          set is_email_verified = true, email_verified_at = coalesce(email_verified_at, now())
        where id = $1`,
      [user.id]
    );
    user.is_email_verified = true;
    mailer
      .send({ to: user.email, ...templates.welcomeEmail({ name: user.name }) })
      .catch(() => {});
  }

  const session = await createSession({ user, ip, userAgent });
  await query(`update users set last_login_at = now() where id = $1`, [user.id]);
  await recordAuthEvent({
    userId: user.id,
    email: user.email,
    event: purpose === 'admin_login' ? 'admin_login_success' : 'login_success',
    outcome: 'success',
    reason: purpose,
    ip,
    userAgent,
  });

  return {
    token: session.token,
    session: session.session,
    user: await findUserById(user.id),
  };
}

/* --------------------------------- sessions -------------------------------- */

async function createSession({ user, ip = null, userAgent = null }) {
  const cfg = getConfig();
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + cfg.sessionTtlMs);

  const { rows } = await query(
    `insert into user_sessions (user_id, session_id, expires_at, ip, user_agent)
     values ($1, $2, $3, $4, $5)
     returning id, session_id, login_at, expires_at, status`,
    [user.id, sessionId, expiresAt, ip, userAgent]
  );

  return {
    token: signToken(user, sessionId),
    session: {
      id: rows[0].id,
      sessionId: rows[0].session_id,
      loginAt: rows[0].login_at,
      expiresAt: rows[0].expires_at,
      status: rows[0].status,
    },
  };
}

async function logout({ sessionRowId, reason = 'user logout', userId = null, ip = null, userAgent = null }) {
  const { rows } = await query(
    `update user_sessions
        set status = 'logged_out', logout_at = now(), logout_reason = $2
      where id = $1 and status = 'active'
      returning id, user_id, logout_at`,
    [sessionRowId, reason]
  );
  if (rows[0]) {
    await recordAuthEvent({
      userId: rows[0].user_id,
      event: 'logout',
      outcome: 'success',
      reason,
      ip,
      userAgent,
    });
  }
  return { loggedOut: Boolean(rows[0]), logoutAt: rows[0]?.logout_at || null };
}

async function revokeSession(sessionRowId, reason = 'revoked by administrator') {
  const { rows } = await query(
    `update user_sessions
        set status = 'revoked', logout_reason = $2, logout_at = coalesce(logout_at, now())
      where id = $1 and status = 'active'
      returning id, user_id`,
    [sessionRowId, reason]
  );
  if (rows[0]) {
    await recordAuthEvent({
      userId: rows[0].user_id,
      event: 'session_revoked',
      outcome: 'success',
      reason,
    });
  }
  return { revoked: Boolean(rows[0]), userId: rows[0]?.user_id || null };
}

async function revokeAllSessions(userId, exceptSessionRowId = null) {
  const { rowCount } = await query(
    `update user_sessions
        set status = 'revoked', logout_reason = 'revoked on password change', logout_at = now()
      where user_id = $1 and status = 'active' and ($2::uuid is null or id <> $2)`,
    [userId, exceptSessionRowId]
  );
  return rowCount;
}

/** Marks stale sessions expired. Run on boot and on a timer. */
async function sweepSessions() {
  const { rowCount } = await query(
    `update user_sessions
        set status = 'expired', logout_reason = 'expired automatically'
      where status = 'active' and expires_at <= now()`
  );
  const otp = await query(
    `delete from otp_codes
      where expires_at < now() - interval '1 day' and consumed_at is not null`
  );
  return { expiredSessions: rowCount, purgedOtps: otp.rowCount };
}

/* -------------------------------- register/login ---------------------------- */

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw badRequest('Password must be at least 8 characters', {
      password: 'Use at least 8 characters',
    });
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw badRequest('Password must contain a letter and a number', {
      password: 'Include at least one letter and one number',
    });
  }
  if (password.length > 128) {
    throw badRequest('Password is too long', { password: 'Maximum 128 characters' });
  }
}

async function register({ name, email, password, ip = null, userAgent = null }) {
  const normalized = normalizeEmail(email);

  if (!domainAllowed(normalized, 'student')) {
    throw forbidden(
      `CampusConnect is only available to university email addresses (${allowedDomainHint()}).`
    );
  }
  assertPassword(password);

  const existing = await findUserByEmail(normalized, { withPassword: true });

  let user;
  if (existing) {
    if (existing.is_email_verified) {
      await recordAuthEvent({
        userId: existing.id,
        email: normalized,
        event: 'register',
        outcome: 'blocked',
        reason: 'email already registered',
        ip,
        userAgent,
      });
      throw conflict('This email is already registered. Please sign in instead.');
    }
    // Unverified account: re-issue the code, but never overwrite the stored
    // credentials from an unauthenticated request (F5). The owner of the
    // mailbox keeps the password they chose; if they have forgotten it they
    // can complete verification and then change it.
    user = existing;
  } else {
    const passwordHash = await bcrypt.hash(password, bcryptRounds());
    const { rows } = await query(
      `insert into users (name, email, password_hash, role, is_email_verified)
       values ($1, $2, $3, 'student', false)
       returning ${PUBLIC_USER_FIELDS}`,
      [String(name).trim(), normalized, passwordHash]
    );
    user = rows[0];
  }

  await recordAuthEvent({
    userId: user.id,
    email: user.email,
    event: 'register',
    outcome: 'success',
    reason: existing ? 'resumed unverified registration' : 'new account',
    ip,
    userAgent,
  });

  const otp = await issueOtp({ user, purpose: 'signup', ip });
  return { otpRequired: true, user: { id: user.id, name: user.name, email: user.email }, ...otp };
}

async function login({ email, password, portal = 'student', ip = null, userAgent = null }) {
  const normalized = normalizeEmail(email);
  const isAdminPortal = portal === 'admin';
  const genericFailure = () => unauthorized('Invalid email or password');

  if (!domainAllowed(normalized, isAdminPortal ? 'admin' : 'student')) {
    await recordAuthEvent({
      email: normalized,
      event: isAdminPortal ? 'admin_login_failed' : 'login_failed',
      outcome: 'blocked',
      reason: 'email domain not allowed',
      ip,
      userAgent,
    });
    throw genericFailure();
  }

  const user = await findUserByEmail(normalized, { withPassword: true });
  if (!user) {
    await bcrypt.compare(String(password || ''), getDummyHash()); // equalise timing
    await recordAuthEvent({
      email: normalized,
      event: isAdminPortal ? 'admin_login_failed' : 'login_failed',
      outcome: 'failure',
      reason: 'no such account',
      ip,
      userAgent,
    });
    throw genericFailure();
  }

  const passwordOk = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!passwordOk) {
    await recordAuthEvent({
      userId: user.id,
      email: normalized,
      event: isAdminPortal ? 'admin_login_failed' : 'login_failed',
      outcome: 'failure',
      reason: 'wrong password',
      ip,
      userAgent,
    });
    throw genericFailure();
  }

  if (user.status !== 'active') {
    await recordAuthEvent({
      userId: user.id,
      email: normalized,
      event: isAdminPortal ? 'admin_login_failed' : 'login_failed',
      outcome: 'blocked',
      reason: `account ${user.status}`,
      ip,
      userAgent,
    });
    throw forbidden('This account is not available. Please contact the campus help desk.');
  }

  // Unverified account: finish registration instead of failing.
  if (!user.is_email_verified) {
    const otp = await issueOtp({ user, purpose: 'signup', ip });
    return {
      otpRequired: true,
      ...otp,
      message: 'Your email is not verified yet. We sent a new code to finish setting up your account.',
    };
  }

  if (isAdminPortal && user.role !== 'admin') {
    await recordAuthEvent({
      userId: user.id,
      email: normalized,
      event: 'admin_login_failed',
      outcome: 'blocked',
      reason: 'not an administrator',
      ip,
      userAgent,
    });
    throw forbidden('This account does not have administrator access.');
  }

  if (!isAdminPortal && user.role === 'admin') {
    throw forbidden('Administrators must sign in through the administrator portal.');
  }

  const purpose = isAdminPortal ? 'admin_login' : 'login';
  const otp = await issueOtp({ user, purpose, ip });
  return { otpRequired: true, ...otp };
}

/**
 * Resends the code for a challenge that already exists.
 *
 * It deliberately does NOT create the first code of a purpose: a login or
 * admin_login challenge must be authorised by the password check in login()
 * first, otherwise the OTP alone would be a single-factor login (F3).
 * Unknown addresses and missing challenges get the same generic response so
 * the endpoint cannot be used to discover accounts.
 */
async function resendOtp({ email, purpose, ip = null }) {
  const normalized = normalizeEmail(email);
  const cfg = getConfig();
  const generic = {
    otpRequired: true,
    email: normalized,
    purpose,
    expiresInSeconds: cfg.OTP_TTL_MINUTES * 60,
    resendInSeconds: cfg.OTP_RESEND_COOLDOWN_SECONDS,
    emailSent: true,
  };

  const user = await findUserByEmail(normalized);
  if (!user) return generic;
  if (purpose === 'admin_login' && user.role !== 'admin') return generic;

  const effectivePurpose = purpose !== 'signup' && !user.is_email_verified ? 'signup' : purpose;

  const { rows } = await query(
    `select id from otp_codes
      where user_id = $1 and purpose = $2 and consumed_at is null and expires_at > now()
      limit 1`,
    [user.id, effectivePurpose]
  );
  if (!rows[0]) {
    // No live challenge: refuse silently instead of minting one.
    await recordAuthEvent({
      userId: user.id,
      email: user.email,
      event: 'otp_sent',
      outcome: 'blocked',
      reason: `resend without an existing ${effectivePurpose} challenge`,
      ip,
    });
    return generic;
  }

  return issueOtp({ user, purpose: effectivePurpose, ip });
}

/* ------------------------------ password reset ----------------------------- */

/**
 * Starts a password reset.
 *
 * The response is always the same, so this endpoint cannot be used to discover
 * which addresses are registered. A live link is invalidated when a new one is
 * requested, only a hash is stored, and the token is single-use with a short
 * lifetime.
 */
async function requestPasswordReset({ email, ip = null, userAgent = null }) {
  const cfg = getConfig();
  const normalized = normalizeEmail(email);
  const generic = {
    ok: true,
    message: 'If that address belongs to an account, a reset link is on its way.',
    expiresInSeconds: cfg.PASSWORD_RESET_TTL_MINUTES * 60,
  };

  const user = await findUserByEmail(normalized);
  if (!user || user.status !== 'active') {
    await recordAuthEvent({
      email: normalized,
      event: 'password_reset_requested',
      outcome: 'failure',
      reason: user ? `account ${user.status}` : 'no such account',
      ip,
      userAgent,
    });
    return generic;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashCode(token, 'password_reset');
  const expiresAt = new Date(Date.now() + cfg.resetTtlMs);

  await withTransaction(async (client) => {
    await client.query(
      `update password_reset_tokens set used_at = now()
        where user_id = $1 and used_at is null`,
      [user.id]
    );
    await client.query(
      `insert into password_reset_tokens (user_id, token_hash, expires_at, request_ip)
       values ($1, $2, $3, $4)`,
      [user.id, tokenHash, expiresAt, ip]
    );
  });

  const url = `${getConfig().APP_URL.replace(/\/+$/, '')}/reset.html?token=${token}`;
  const sent = await mailer.send({
    to: user.email,
    ...templates.passwordResetEmail({
      name: user.name,
      url,
      minutes: cfg.PASSWORD_RESET_TTL_MINUTES,
    }),
  });

  await recordAuthEvent({
    userId: user.id,
    email: user.email,
    event: 'password_reset_requested',
    outcome: sent.ok ? 'success' : 'failure',
    reason: sent.ok ? null : 'mail delivery failed',
    ip,
    userAgent,
  });

  return generic;
}

/** Completes a reset. Single use, expiring, and it signs every session out. */
async function resetPassword({ token, password, ip = null, userAgent = null }) {
  assertPassword(password);
  const tokenHash = hashCode(String(token).trim(), 'password_reset');

  const { rows } = await query(
    `select id, user_id, expires_at, used_at
       from password_reset_tokens
      where token_hash = $1
      limit 1`,
    [tokenHash]
  );
  const record = rows[0];
  if (!record || record.used_at) {
    throw badRequest('That reset link is invalid or has already been used. Request a new one.');
  }
  if (new Date(record.expires_at) <= new Date()) {
    await query(`update password_reset_tokens set used_at = now() where id = $1`, [record.id]);
    throw badRequest('That reset link has expired. Request a new one.');
  }

  const passwordHash = await bcrypt.hash(password, bcryptRounds());

  await withTransaction(async (client) => {
    // Burn the link conditionally so two submissions cannot both succeed.
    const burned = await client.query(
      `update password_reset_tokens set used_at = now()
        where id = $1 and used_at is null
        returning id`,
      [record.id]
    );
    if (!burned.rowCount) {
      throw badRequest('That reset link is invalid or has already been used. Request a new one.');
    }
    await client.query(`update users set password_hash = $2 where id = $1`, [
      record.user_id,
      passwordHash,
    ]);
  });

  // A reset must not leave an attacker's session alive.
  const revoked = await revokeAllSessions(record.user_id);
  await recordAuthEvent({
    userId: record.user_id,
    event: 'password_reset_completed',
    outcome: 'success',
    reason: `${revoked} session(s) revoked`,
    ip,
    userAgent,
  });

  return { ok: true, sessionsRevoked: revoked };
}

/* ---------------------------------- profile -------------------------------- */

async function getProfile(userId) {
  const { rows } = await query(
    `select ${PUBLIC_USER_FIELDS} from users where id = $1`,
    [userId]
  );
  if (!rows[0]) throw new AppError(404, 'Account not found');
  const stats = await query(
    `select
       (select count(*)::int from items where owner_id = $1 and status <> 'removed') as reports,
       (select count(*)::int from items where owner_id = $1 and type = 'lost' and status <> 'removed') as lost_reports,
       (select count(*)::int from items where owner_id = $1 and type = 'found' and status <> 'removed') as found_reports,
       (select count(*)::int from items where owner_id = $1 and status = 'returned') as returned,
       (select count(*)::int from claims where claimant_id = $1) as claims_submitted,
       (select count(*)::int from claims c join items i on i.id = c.item_id
          where i.owner_id = $1 and c.status = 'pending') as claims_pending`,
    [userId]
  );
  return { ...rows[0], stats: stats.rows[0] };
}

async function updateProfile(userId, patch) {
  // The API accepts studentId (camelCase) from the browser and student_id from
  // scripts; both land in the same column (F6).
  const incoming = { ...patch };
  if (incoming.studentId !== undefined && incoming.student_id === undefined) {
    incoming.student_id = incoming.studentId;
  }
  patch = incoming;

  const fields = [];
  const values = [];
  let i = 1;
  for (const key of ['name', 'student_id', 'department', 'phone']) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = $${i}`);
      values.push(patch[key] === '' ? null : patch[key]);
      i += 1;
    }
  }
  if (!fields.length) return getProfile(userId);
  values.push(userId);
  const { rows } = await query(
    `update users set ${fields.join(', ')} where id = $${i} returning ${PUBLIC_USER_FIELDS}`,
    values
  );
  return { ...rows[0] };
}

async function changePassword(userId, { currentPassword, newPassword, keepSessionRowId = null }) {
  assertPassword(newPassword);
  const { rows } = await query(`select password_hash from users where id = $1`, [userId]);
  if (!rows[0]) throw new AppError(404, 'Account not found');
  const ok = await bcrypt.compare(String(currentPassword || ''), rows[0].password_hash);
  if (!ok) throw badRequest('Your current password is incorrect', { currentPassword: 'Incorrect' });
  const hash = await bcrypt.hash(newPassword, bcryptRounds());
  await query(`update users set password_hash = $2 where id = $1`, [userId, hash]);
  const revoked = await revokeAllSessions(userId, keepSessionRowId);
  return { updated: true, otherSessionsRevoked: revoked };
}

async function listSessions(userId) {
  const { rows } = await query(
    `select id, session_id, login_at, logout_at, last_activity_at, expires_at, status,
            logout_reason, ip, user_agent
       from user_sessions
      where user_id = $1
      order by login_at desc
      limit 50`,
    [userId]
  );
  return rows;
}

module.exports = {
  requestPasswordReset,
  resetPassword,
  normalizeEmail,
  domainAllowed,
  allowedDomainHint,
  findUserByEmail,
  findUserById,
  recordAuthEvent,
  issueOtp,
  verifyOtp,
  register,
  login,
  resendOtp,
  logout,
  revokeSession,
  revokeAllSessions,
  sweepSessions,
  createSession,
  getProfile,
  updateProfile,
  changePassword,
  listSessions,
  assertPassword,
  PUBLIC_USER_FIELDS,
};
