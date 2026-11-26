# Security model

Written to be read by whoever runs this platform, not just by developers.

---

## 1. Identity and authentication

**Rule: an account is a verified university email address. Nothing else.**

| Control | Implementation | Where |
|---|---|---|
| University domain allow-list | `ALLOWED_EMAIL_DOMAINS`, sub-domains matched automatically | `src/services/authService.js` → `domainAllowed()` |
| No password-only login | Password check issues an **OTP challenge**, never a token | `login()` |
| No JWT before verification | The only place `signToken()` is called is after a successful OTP | `verifyOtp()` |
| Unverified accounts | Login re-sends a signup code instead of failing (no existence leak, no dead end) | `login()` |
| Suspended accounts | Blocked at login **and** at OTP verification **and** on every authenticated request | `login()`, `verifyOtp()`, `middleware/auth.js` |
| Password storage | bcrypt, cost 12, hash never selected by any query that returns a user | `users.password_hash` |
| Timing enumeration | A dummy bcrypt comparison runs when the account does not exist | `login()` |
| Generic errors | Wrong password and unknown account return the identical 401 message | `login()` |

## 2. OTP lifecycle

| Requirement | Value / behaviour |
|---|---|
| Length | 6 digits, generated with `crypto.randomInt` (not `Math.random`) |
| Storage | HMAC-SHA256 with `OTP_PEPPER` — the plain code is never stored |
| Lifetime | 5 minutes (`OTP_TTL_MINUTES`) |
| Single use | Burned with `update … where consumed_at is null returning id` — two parallel requests cannot both redeem one code |
| Attempts | 5 (`OTP_MAX_ATTEMPTS`), incremented atomically (`attempts = attempts + 1`) and burned in the same statement |
| Supersede | Issuing a new code marks the previous one consumed, enforced by a partial unique index |
| Resend cooldown | 60 seconds (`OTP_RESEND_COOLDOWN_SECONDS`) |
| Resend scope | Only refreshes a challenge that already exists — it cannot create the first code of a purpose, so the OTP is never a single-factor login |
| Hourly cap | 6 codes per user across **all** purposes (`OTP_MAX_PER_HOUR`), so cycling purposes cannot multiply the budget |
| Purpose binding | `admin_login` is refused for non-administrators at both resend and verify |
| Delivery | Nodemailer over SMTP; never logged, never returned by an API |
| Comparison | `crypto.timingSafeEqual` |

> Why HMAC and not bcrypt for the OTP? A 6-digit code has only 10⁶ possibilities;
> any unkeyed hash of it can be reversed offline in milliseconds. Keying the hash
> with a server-side pepper means a stolen database dump alone is useless, while
> online guessing is stopped by the attempt limit and the 5-minute window.

## 3. Sessions

- A JWT carries `sub` (user), `sid` (session) and `role`, signed HS256 with an
  issuer claim and an expiry.
- `middleware/auth.js` verifies the signature **and** loads `user_sessions` by
  `sid`. If the row is missing, logged out, revoked or expired, the request is
  rejected with 401 — so logout is real, not cosmetic.
- `role` in the token is ignored for authorisation; the database row is
  authoritative, so demoting an administrator takes effect immediately.
- `last_activity_at` is touched at most once every five minutes to avoid a write
  per request.
- The session lifetime is clamped to the JWT lifetime at boot, so "active" always
  means "usable".
- Expired sessions are marked `expired` lazily on access and by a sweep every ten
  minutes, so a closed browser never produces a fake logout timestamp.
- Changing a password revokes every other session for that account.

## 4. Authorisation

- Ownership checks are in the service layer for every item and claim mutation.
- The admin router applies `authenticate` + `requireRole('admin')` at the router
  level, so a newly added admin route cannot ship unprotected.
- The browser hides controls for convenience only; the tests assert 401 for
  anonymous and 403 for student access on **every** admin route.
- Two administrative invariants are enforced in SQL-adjacent logic: an
  administrator cannot change their own role/status, and the last active
  administrator cannot be demoted.

## 5. Input handling

- Every route declares zod schemas for `params`, `query` and `body`
  (`src/validators`). Unknown fields are dropped, enums are whitelisted, numbers
  are coerced.
- All SQL is parameterised. Dynamic `WHERE` clauses are built from a fixed set of
  columns.
- Query-parameter operator injection (`?status[$ne]=open`) fails validation
  because the value is an object, not a string — asserted in the test suite.
- Free-text search uses PostgreSQL full-text search (`websearch_to_tsquery`), not
  a regex, so there is no ReDoS surface.
- JSON bodies are capped at 1 MB; uploads at `MAX_UPLOAD_MB`.

## 6. File uploads

1. `multer` enforces the file count and byte size.
2. The declared MIME type is checked (cheap rejection).
3. **sharp decodes the real bytes** — a text file renamed `.jpg` fails here.
4. The image is re-encoded to WebP at ≤1600 px, which strips EXIF (including GPS)
   and removes any embedded script or polyglot payload.
5. The filename is generated server-side (`uuid.webp`); the client's filename is
   never used in a path.
6. Public images live in a public bucket; claim evidence lives in a **private**
   bucket and is reachable only through 5-minute signed URLs issued to the two
   parties (or an administrator).
7. With the local driver, `/uploads` explicitly refuses the `private/` prefix with
   a 404, so the only route to evidence is the guarded `/api/files/private/*`.

## 7. Audit and privacy

| Table | Contains | Never contains |
|---|---|---|
| `auth_events` | event, outcome, reason, email, IP, user agent, timestamp | passwords, OTP codes, tokens |
| `admin_audit_logs` | actor, action, target, before/after details, IP | secrets |
| `user_sessions` | login/logout/last-activity timestamps, IP, user agent | tokens (only an opaque session id) |

- Public item responses expose the owner's **display name only**. The owner's
  email address never appears on a public endpoint — this was a finding in the
  original audit and is now asserted by a test.
- A student can read only their own profile, reports, claims and sessions.
- The logger redacts any key matching `pass|otp|code|token|secret|authorization|
  cookie|hash|pepper|service_role`.

## 8. HTTP hardening

- `helmet` with an explicit CSP (`script-src 'self'`, no inline scripts anywhere in
  the front end), `frame-ancestors 'none'`, `object-src 'none'`.
- HSTS in production, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- CORS is **off by default** (same-origin). When the frontend is hosted
  separately, `CORS_ORIGINS` is an explicit allow-list — never `*`.
- Rate limits: general (per user/IP), auth (30 / 15 min), OTP (10 / 15 min),
  writes (60 / hour), all keyed by user id where a session exists.
- `x-powered-by` disabled; errors return a generic message with a request id and
  log the detail server-side.

## 9. Database

- Constraints enforce the invariants the application depends on: unique
  lower-cased email, valid roles/statuses, one live OTP per user+purpose, one live
  claim per (item, claimant), timestamps maintained by triggers.
- RLS is enabled on all tables with no policies, so the public Supabase anon key
  reads nothing even if it leaks.
- Claim decisions run inside a transaction with `FOR UPDATE` row locks, and the
  item is moved `open → claimed` with a conditional update, so two approvals
  cannot both succeed.

## 10. Moderation model

Listings publish immediately (`moderation_status = 'approved'` on create).
Administrators can `remove` or `restore` any listing, and removal is recorded in
the audit log and closes pending claims on that listing. There is no pre-approval
queue: for a campus lost-and-found, a listing that waits for review is a listing
nobody finds.

## 11. Deliberately out of scope

Say these out loud before a pilot rather than discovering them later:

- **No 2FA for students** — the OTP *is* the second factor for a password login.
  Administrators would benefit from a TOTP app in a later phase.
- **No password reset flow yet.** Support path: an administrator sets a new
  password. Add a token-based reset before scaling beyond a pilot.
- **No CAPTCHA.** Rate limits and email verification cover the realistic abuse for
  a campus; revisit if you see automated signups.
- **No WAF/DDoS protection** beyond what your host provides.
- **No encryption at rest beyond the database provider's default.**
- **No PII data-retention policy.** Decide how long returned items and auth events
  are kept.

## 12. Reporting a problem

If you find a vulnerability, do not open a public issue. Email the platform owner
with the steps to reproduce and the impact; you will get a response before any
public disclosure.
