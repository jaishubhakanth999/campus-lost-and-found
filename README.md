# CampusConnect — Sai University Lost &amp; Found

A production-oriented campus lost-and-found portal: students report lost or found
items with photos, claim what is theirs, and administrators can review, remove or
restore any listing. Listings publish immediately; moderation is reactive, which
is the right trade-off for a campus board (an item that sits in a queue for two
days is an item nobody finds).
Accounts are restricted to university email addresses and **every sign-in requires
a one-time code sent to that address**.

> **Stack:** Node.js 20 · Express 4 · PostgreSQL (Supabase) · vanilla HTML/CSS/JS
> · JWT + email OTP · bcrypt · Nodemailer · Multer + sharp · Helmet.

---

## 1. What changed in this version

This repository used to be a MongoDB/Mongoose prototype. It now runs on
PostgreSQL (Supabase) with a hardened authentication flow. Nothing was rewritten
for its own sake: the Express app, the route layout, the JWT approach and the
front end's visual identity are all preserved.

| Area | Before | Now |
|---|---|---|
| Database | MongoDB + Mongoose models | PostgreSQL (Supabase) with SQL migrations, constraints, indexes and RLS |
| Registration | Any email address | University domain allow-list (`ALLOWED_EMAIL_DOMAINS`) |
| Login | Password → JWT immediately | Password → **6-digit email OTP** → JWT |
| Sessions | Stateless token, logout only cleared the browser | `user_sessions` table; logout/expiry/revocation are enforced server-side |
| Activity | Nothing recorded | Login, logout, failed attempts, OTP outcomes, admin actions |
| Admin | One shared login, stats only | Separate `/admin/` console: users, items, claims, login history, security events, audit log |
| Images | Trusted the client's MIME type | Decoded and re-encoded with sharp (real type check, EXIF stripped, resized) |
| Claims | Owner could not read the claim text; double approvals possible | Full claim text in the UI; guarded state machine inside a transaction |
| Validation | Inline presence checks | zod schemas on every route; 400s with field-level errors |
| Tests | None | 126 tests: integration against a real PostgreSQL server, plus every page executed in a DOM |
| CI | None | GitHub Actions runs the suite on Node 20 and 22 for every push and pull request |

Full detail, including the audit that motivated each change, is in
[`docs/SECURITY.md`](docs/SECURITY.md).

---

## 2. Architecture

```
Browser (public/)
  ├── index.html      public galleries + search/filter/pagination
  ├── auth.html       register → OTP → session, or login → OTP → session
  ├── report.html     lost/found report + upload or camera capture
  ├── item.html       item detail, claim submission, owner controls
  ├── dashboard.html  my reports, my claims, claims received, login activity, profile
  ├── reset.html      forgot-password: request a link, then set a new password
  └── admin/          separate administrator console (login + 7 sections)

Express (src/)
  ├── app.js                    helmet/CSP, CORS, static, routes, error mapper
  ├── routes/                   auth · items · claims · admin · files · health
  ├── services/                 authService · itemService · claimService ·
  │                             adminService · auditService · storage · mailer
  ├── middleware/               auth (JWT + session) · validate (zod) ·
  │                             upload (multer + sharp) · rateLimits · error
  ├── db/                       pool (pg) · migrate (forward-only)
  └── validators/               one zod schema per request shape

PostgreSQL (db/migrations/001_schema.sql)
  users · otp_codes · user_sessions · auth_events ·
  items · claims · admin_audit_logs
```

**Why `pg` and not the Supabase JS client?** Every write happens on the server and
the claim workflow needs multi-statement transactions. A direct Postgres
connection gives real `BEGIN/COMMIT` semantics and works the same against
Supabase, a local Postgres, or the in-memory test server.

---

## 3. Local setup (10 minutes)

### 3.1 Prerequisites
- Node.js 20+
- A Supabase project (free tier is enough) — or any PostgreSQL 15+ database

### 3.2 Create the database

In the Supabase dashboard open **SQL Editor** and run the contents of
[`db/migrations/001_schema.sql`](db/migrations/001_schema.sql), **or** use the
migration runner (recommended, it also records what has been applied):

```bash
npm install
cp .env.example .env      # then fill in the values below
npm run migrate
```

### 3.3 Fill in `.env`

```bash
# Supabase → Project Settings → Database → Connection string (URI)
DATABASE_URL=postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres
DATABASE_SSL=true

# generate two different secrets
JWT_SECRET=$(openssl rand -hex 32)
OTP_PEPPER=$(openssl rand -hex 32)

# Confirmed with the university. Sub-domains (e.g. scds.) are matched too.
ALLOWED_EMAIL_DOMAINS=saiuniversity.edu.in

# Development email: writes the OTP email to tmp/mail-outbox/*.html
MAIL_TRANSPORT=file
MAIL_FROM="CampusConnect <no-reply@your-university.edu.in>"

STORAGE_DRIVER=local
APP_URL=http://localhost:3000
```

### 3.4 Run it

```bash
npm run dev          # http://localhost:3000
```

Register with an address on your configured domain, then open the newest file in
`tmp/mail-outbox/` to read the 6-digit code. (The code is never printed to the
console or written to logs.)

### 3.5 Create an administrator

Two ways: the script below (validates the domain and writes an audit entry), or
`node scripts/hash-password.js` if you only have the Supabase SQL Editor. Both are
described in `docs/DEPLOYMENT.md`.

There is **no public admin registration**. Provision an administrator from the
shell of the deployment:

```bash
ADMIN_EMAIL=admin@your-university.edu.in \
ADMIN_NAME="Portal Admin" \
ADMIN_PASSWORD='a-long-password-with-a-number' \
npm run create-admin
```

Then sign in at `/admin/`. The administrator still receives an OTP on every login.

---

## 4. API overview

All responses are JSON. Errors use one shape:

```json
{ "error": { "code": "validation_failed", "message": "…", "fields": { "email": "…" } } }
```

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Liveness + database check |
| POST | `/api/auth/register` | — | Create account (unverified) + send signup OTP |
| POST | `/api/auth/login` | — | Verify password, send login OTP |
| POST | `/api/auth/admin/login` | — | Same, administrator portal only |
| POST | `/api/auth/verify-otp` | — | Exchange OTP for JWT + session |
| POST | `/api/auth/resend-otp` | — | New code (cooldown + hourly cap) |
| POST | `/api/auth/forgot-password` | — | Email a single-use reset link (always the same response) |
| POST | `/api/auth/reset-password` | — | Set a new password from that link; signs every session out |
| POST | `/api/auth/logout` | user | Close the session, record `logout_at` |
| GET/PATCH | `/api/auth/me` | user | Profile + statistics / update profile |
| POST | `/api/auth/change-password` | user | Rotate password, revoke other sessions |
| GET | `/api/auth/sessions` | user | Own login history |
| GET | `/api/items` | — | Gallery: search, filters, sort, pagination |
| GET | `/api/items/stats/public` | — | Public counters + location suggestions |
| GET | `/api/items/:id` | optional | Item detail (owner email never exposed) |
| GET | `/api/items/mine` | user | My reports |
| POST | `/api/items` | user | Create report (multipart, up to 3 images) |
| PATCH | `/api/items/:id` | owner/admin | Edit content |
| PATCH | `/api/items/:id/status` | owner/admin | Lifecycle transition |
| DELETE | `/api/items/:id` | owner/admin | Soft delete |
| POST | `/api/claims` | user | Submit claim (private evidence optional) |
| GET | `/api/claims/mine` · `/received` | user | Claims I sent / claims on my items |
| GET | `/api/claims/:id` · `/:id/evidence` | parties | Claim detail + signed evidence links |
| PATCH | `/api/claims/:id/decision` | owner/admin | Approve or reject (transactional) |
| PATCH | `/api/claims/:id/withdraw` · `/handover` · `/complete` | parties | Lifecycle |
| GET | `/api/admin/overview` · `/users` · `/items` · `/claims` · `/sessions` · `/auth-events` · `/audit-logs` | admin | Console data |
| PATCH | `/api/admin/users/:id` · `/items/:id/moderate` · `/items/:id/status` · `/claims/:id/decision` · `/sessions/:id/revoke` | admin | Moderation |

A ready-to-import Postman collection lives in
[`postman/CampusConnect.postman_collection.json`](postman/CampusConnect.postman_collection.json).

---

## 5. Tests

```bash
npm test
```

The suite starts a **real PostgreSQL server** (PGlite — PostgreSQL 19 compiled to
WebAssembly) over TCP, runs the actual migrations against it, drives the HTTP API
with Supertest, and loads every page in a headless DOM to submit its forms.
126 tests cover:

- email domain rules, OTP success/failure/expiry/reuse/attempt limits/resend/rate caps
- unverified and suspended accounts, admin/student portal separation
- session creation, logout timestamps, revocation, expiry
- image upload (valid, wrong type, spoofed extension, oversized, private evidence)
- galleries, search, filters, pagination, operator-injection rejection
- claim submission, duplicate prevention, approval, double-approval rejection,
  re-decision rejection, withdrawal, handover, completion
- admin access control (401/403 on every admin route), moderation, audit trail
- JWT tampering, `alg:none`, wrong secret, security headers, CORS
- password reset: link emailed, hash-only storage, single use, expiry, session revocation
- listing housekeeping: expiry dates, auto-close, one-time owner warning
- front-end wiring: every page boots, every form submits the right payload
- one regression test per finding from the independent review (see
  `docs/AUDIT_FIXES.md`)

What the suite does **not** prove: real SMTP delivery, real browser camera capture,
and behaviour under concurrent load. Those need a deployed environment (see
`docs/DEPLOYMENT.md`).

---

## 6. Security model (short version)

- **Identity** = university email + OTP. No JWT is issued before verification.
- **OTP** = 6 digits, 5 minutes, single use (atomic — two parallel requests cannot
  both redeem it), HMAC-SHA256 with a server-side pepper, 5 attempts, 60 s resend
  cooldown, 6 per hour across all purposes, previous codes superseded. A resend
  only refreshes a challenge that a password check already created.
- **Password reset** = a 64-character token, stored only as an HMAC digest,
  single use, 30-minute lifetime, invalidated when a new one is requested, and it
  signs every session out when used. The request endpoint answers identically for
  known and unknown addresses.
- **Sessions** = a row in `user_sessions`. Logout, expiry and admin revocation take
  effect on the next request because the JWT is validated *and* the session is
  looked up. The session lifetime is clamped to the token lifetime so the history
  never reports an "active" session that can no longer be used.
- **Authorisation** = enforced in Express middleware on every route, never in the
  browser. `router.use(authenticate, requireRole('admin'))` covers the whole admin
  router.
- **Input** = zod on every body, query and params; queries are parameterised; the
  query parser cannot smuggle operators.
- **Uploads** = size cap → MIME check → real decode with sharp → re-encode to WebP
  (strips EXIF) → random server-side filename.
- **Privacy** = public responses never include another student's email; claim
  evidence lives in a private bucket behind 5-minute signed links.
- **Audit** = privileged actions and authentication events are recorded without
  ever storing passwords, OTP codes or tokens.
- **Database** = RLS enabled on all tables with no policies, so the public
  Supabase anon key can read nothing.

---

## 7. Documentation

| Document | Contents |
|---|---|
| [`docs/SUPABASE_SETUP.md`](docs/SUPABASE_SETUP.md) | Step-by-step Supabase project, schema, storage buckets, connection strings |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Vercel (frontend) + Render (API) + Supabase (data), environment variables, post-deploy checks |
| `render.yaml` | Render Blueprint — deploys the API with build/start commands, health check and env vars |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | Every page: route, purpose, API calls, UI elements |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, what is protected, what is deliberately out of scope |
| [`docs/API.md`](docs/API.md) | Endpoint reference with request/response examples |
| [`docs/AUDIT_FIXES.md`](docs/AUDIT_FIXES.md) | Every finding from the independent review, and what was done about it |

---

## 8. Status and honest limitations

Working and verified locally (126 tests, every page booted and rendered in a
headless DOM):

- the complete OTP registration and login flow, sessions, logout tracking
- item reporting with image upload, galleries, search and filters
- claims with guarded transitions, handover and completion
- password reset end to end, including session revocation
- listing expiry: auto-close plus a single owner nudge
- the admin console and its audit trail
- every page booting and every form submitting its payload (headless DOM tests)

**Not yet verified** — these require your own accounts and infrastructure:

- real SMTP delivery (the code path is exercised, the provider is not)
- camera capture on a physical phone (the code path and fallbacks are in place)
- Supabase Storage uploads (local driver is exercised; the Supabase driver needs
  your project's keys)
- behaviour under concurrent load, and anything about your production domain

The university email domain is `saiuniversity.edu.in` (confirmed), which also
covers sub-domains such as `scds.saiuniversity.edu.in`. It lives in
`ALLOWED_EMAIL_DOMAINS` — keep it configurable rather than hard-coding it in code,
so a second campus can be added later.
