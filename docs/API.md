# API reference

Base URL: `https://your-api-host/api` (or `http://localhost:3000/api`).
All bodies are JSON unless stated. Authenticated calls send
`Authorization: Bearer <jwt>`.

Standard error shape:

```json
{ "error": { "code": "validation_failed", "message": "Please check the highlighted fields",
             "fields": { "email": "Enter a valid email address" } } }
```

| Status | Meaning |
|---|---|
| 400 | Validation failed / invalid state for this action |
| 401 | Missing, invalid, expired, logged-out or revoked session |
| 403 | Authenticated but not allowed (wrong role, not the owner, wrong portal) |
| 404 | Not found (also used for listings you are not allowed to see) |
| 409 | Conflict: duplicate claim, already-decided claim, item no longer open |
| 413 | Upload too large |
| 429 | Rate limited (check `retryAfter` in `details` when present) |
| 503 | Database unreachable (`/api/health`) |

---

## 1. Authentication

### 1.1 Register — creates an unverified account and sends a code

```http
POST /api/auth/register
Content-Type: application/json

{ "name": "Asha Rao", "email": "asha@saiuniversity.edu.in", "password": "Campus123" }
```

```json
201 {
  "ok": true, "otpRequired": true, "purpose": "signup",
  "email": "asha@saiuniversity.edu.in",
  "expiresInSeconds": 300, "resendInSeconds": 60, "emailSent": true,
  "user": { "id": "…", "name": "Asha Rao", "email": "asha@saiuniversity.edu.in" }
}
```

No token is returned. Errors: `403` domain not allowed, `409` already registered,
`400` validation (with `fields`).

### 1.2 Login — password check, then a code

```http
POST /api/auth/login
{ "email": "asha@saiuniversity.edu.in", "password": "Campus123" }
```

```json
200 { "ok": true, "otpRequired": true, "purpose": "login", "email": "…",
      "expiresInSeconds": 300, "resendInSeconds": 60 }
```

Unverified account → `purpose: "signup"` (finish registration). Administrators
must use `POST /api/auth/admin/login`.

### 1.3 Verify the code — the only way to get a token

```http
POST /api/auth/verify-otp
{ "email": "asha@saiuniversity.edu.in", "code": "482913", "purpose": "login" }
```

```json
200 {
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIs…",
  "session": { "id": "…", "sessionId": "…", "loginAt": "…", "expiresAt": "…", "status": "active" },
  "user": { "id": "…", "name": "Asha Rao", "role": "student", "is_email_verified": true }
}
```

`400` wrong/expired/reused code, `429` attempts exhausted.

### 1.4 Resend, logout, profile

```http
POST /api/auth/resend-otp   { "email": "…", "purpose": "login" }   → 200 / 429 (cooldown, hourly cap)
POST /api/auth/forgot-password { "email": "…" }                    → 200 (identical for known/unknown)
POST /api/auth/reset-password  { "token": "…", "password": "…" }   → 200 { sessionsRevoked } / 400
  # only refreshes an existing challenge; it never creates the first code of a
  # purpose, so an OTP alone can never be a login
POST /api/auth/logout                                              → 200 { loggedOut: true, logoutAt: "…" }
GET  /api/auth/me                                                  → 200 { user: { …, stats: { … } } }
PATCH /api/auth/me          { "name": "…", "department": "…", "phone": "…" }
POST /api/auth/change-password { "currentPassword": "…", "newPassword": "…" }
GET  /api/auth/sessions                                            → own login history
```

---

### 1.5 Password reset

```http
POST /api/auth/forgot-password   { "email": "asha@saiuniversity.edu.in" }
200 { "ok": true, "message": "If that address belongs to an account, a reset link is on its way.",
      "expiresInSeconds": 1800 }
```

The link in the email is `…/reset.html?token=<64 hex characters>`. Only an HMAC
digest of that token is stored, it works once, it expires after
`PASSWORD_RESET_TTL_MINUTES` (30), and requesting a new link invalidates the
previous one.

```http
POST /api/auth/reset-password   { "token": "…", "password": "NewPassword123" }
200 { "ok": true, "sessionsRevoked": 2 }
400 invalid / already used / expired / weak password
```

Every existing session for the account is revoked, so a stolen session cannot
survive a reset.

## 2. Items

### 2.1 Public gallery

```http
GET /api/items?type=found&category=Accessories&location=Library&search=wallet&sort=newest&page=1&limit=12
```

```json
200 {
  "ok": true, "page": 1, "limit": 12, "total": 34, "pages": 3,
  "items": [{
    "id": "…", "type": "found", "title": "Black wallet", "category": "Accessories",
    "description": "…", "location": "Central Library", "occurredOn": "2026-11-20",
    "occurredTime": "14:30:00", "status": "open",
    "images": [{ "key": "public/2026/11/…webp", "url": "/uploads/public/…", "width": 1200, "height": 900 }],
    "owner": { "id": "…", "name": "Finder Fatima" }
  }]
}
```

Only approved, non-removed listings. The owner's email is never included.
Invalid filters (e.g. `?status[$ne]=open`) return `400`.

### 2.2 Create a report (multipart)

```http
POST /api/items
Authorization: Bearer <token>
Content-Type: multipart/form-data

type=lost&title=Black+wallet&category=Accessories&description=…&location=Central+Library
&occurredOn=2026-11-20&occurredTime=14:30&additionalInfo=…
&images=@wallet.jpg
```

`images` may be repeated up to 3 times. JPG/PNG/WEBP, max `MAX_UPLOAD_MB`.
`400` unsupported/invalid image, `413` too large.

### 2.3 Detail, edit, lifecycle

```http
GET    /api/items/:id                 → item (+ claims if you own it, + myClaim if you claimed it)
PATCH  /api/items/:id                 { "title": "…", "description": "…" }     owner/admin
PATCH  /api/items/:id/status          { "status": "closed" }                   owner/admin
DELETE /api/items/:id                                                          owner/admin (soft delete)
GET    /api/items/mine                                                         own reports
GET    /api/items/stats/public                                                 counters + locations
```

Allowed transitions: `open → closed|returned`, `claimed → returned`,
`returned → closed`. `claimed` is set only by approving a claim, and `returned` is
refused (409) while a pending or approved claim exists — complete the claim
instead.

---

## 3. Claims

```http
POST /api/claims                       multipart: itemId, message, evidence[] (max 2, private)
GET  /api/claims/mine                  claims I submitted
GET  /api/claims/received              claims on my listings (includes claimant email)
GET  /api/claims/:id                   parties or admin
GET  /api/claims/:id/evidence          → { links: [{ key, url }] } (5-minute signed URLs)
PATCH /api/claims/:id/decision         { "decision": "approved" | "rejected", "note": "…" }   owner/admin
PATCH /api/claims/:id/withdraw         claimant, while pending
PATCH /api/claims/:id/handover         { "place": "Library front desk", "at": "2026-11-27T10:00:00+05:30" } owner
PATCH /api/claims/:id/complete         owner or claimant → item becomes "returned"
```

Only `found` listings can be claimed (`400` on a lost report, matching the UI).
Guarantees: one live claim per (item, claimant) — `409` otherwise; approval moves
the item to `claimed` atomically and rejects rival claims; a decided claim cannot
be re-decided (`409`).

---

## 4. Administrator

Every route below requires an administrator session. Anonymous → `401`, student →
`403`.

```http
GET   /api/admin/overview                              counters for the console
GET   /api/admin/users?search=&role=&status=&verified=&page=
PATCH /api/admin/users/:id                             { "status": "suspended" } | { "role": "admin" }
GET   /api/admin/sessions?userId=&status=&page=
PATCH /api/admin/sessions/:id/revoke
GET   /api/admin/auth-events?event=login_failed&email=&page=
GET   /api/admin/items?search=&type=&status=&moderation=&page=
PATCH /api/admin/items/:id/moderate                    { "action": "approve|reject|remove|restore", "note": "…" }
PATCH /api/admin/items/:id/status                      { "status": "returned" }
GET   /api/admin/claims?status=&page=
PATCH /api/admin/claims/:id/decision                   { "decision": "approved", "note": "…" }
GET   /api/admin/audit-logs?action=&page=
```

Suspending an account revokes its sessions immediately. Every privileged action
writes an `admin_audit_logs` row inside the same transaction.

---

## 5. Health

```http
GET /api/health
200 { "ok": true, "service": "campusconnect", "env": "production",
      "database": { "connected": true, "latencyMs": 4 }, "uptimeSeconds": 912 }
503 { "ok": false, "database": { "connected": false } }
```
