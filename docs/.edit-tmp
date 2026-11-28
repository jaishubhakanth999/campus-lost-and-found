# Supabase setup

Everything below is done once, in your own Supabase project. Nothing in this
repository contains a real key, password or project reference.

---

## 1. Create the project

1. Sign in at <https://supabase.com> → **New project**.
2. Choose the region closest to your campus (Mumbai / Singapore for India).
3. Save the database password somewhere safe — it is shown once.

A free project is enough for a campus pilot (500 MB database, 1 GB storage).

---

## 2. Create the schema

### The one-paste version (recommended)

Open **SQL Editor → New query**, paste all of
[`db/supabase/one-shot-setup.sql`](../db/supabase/one-shot-setup.sql) and run it.
That single file creates the 8 tables, every constraint and index, both storage
buckets, and finishes with verification queries. It is idempotent, and it is
generated from `db/migrations/*.sql` plus `storage_setup.sql`, so it cannot drift
from what `npm run migrate` applies.

The sections below describe the same work step by step, which is useful the first
time you want to understand what is being created.

### Option A — migration runner (recommended)

```bash
cp .env.example .env
# paste DATABASE_URL from step 3, then:
npm run migrate
```

The runner applies every file in `db/migrations/` once, inside a transaction, and
records it in `schema_migrations`. Re-running it is safe.

### Option B — SQL editor

Open **SQL Editor → New query**, paste the whole contents of
`db/migrations/001_schema.sql`, and run it. This is the same SQL the runner
executes.

### What gets created

| Table | Purpose |
|---|---|
| `users` | Students and administrators. `is_email_verified`, `role`, `status`, `created_at` |
| `otp_codes` | One live 6-digit code per user+purpose (HMAC digest only) |
| `user_sessions` | Login/logout history, expiry and revocation |
| `auth_events` | Security trail: failed logins, OTP outcomes, logouts |
| `items` | Lost/found reports with a JSONB image list and a full-text search column |
| `claims` | Ownership claims, decisions, handover and completion |
| `admin_audit_logs` | Every privileged action with actor, target and timestamp |

Row Level Security is enabled on all seven tables **with no policies**. The API
connects with a privileged role that bypasses RLS, so the app works, while the
public `anon` key can read nothing. Do not add permissive policies unless you
intend to query these tables directly from a browser.

---

## 3. Get the connection string

**Project Settings → Database → Connection string → URI**

| Situation | Use | Port |
|---|---|---|
| Long-running server (Render web service) | Direct connection | `5432` |
| Serverless / many short connections | Connection pooling (transaction) | `6543` |

Replace `[YOUR-PASSWORD]` with the database password. Then in `.env`:

```bash
DATABASE_URL=postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
DATABASE_SSL=true
```

> If you use the transaction pooler (6543), keep `DATABASE_POOL_MAX` modest
> (5–10): each request borrows one pooled connection.

---

## 4. Create the storage buckets

**Storage → New bucket**

| Bucket | Public? | Used for | File size limit |
|---|---|---|---|
| `item-images` | **Public** | Gallery photos for lost/found listings | 5 MB |
| `claim-evidence` | **Private** | Ownership-proof photos on claims | 5 MB |

Then set:

```bash
STORAGE_DRIVER=supabase
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<Project Settings → API → service_role key>
SUPABASE_BUCKET_PUBLIC=item-images
SUPABASE_BUCKET_PRIVATE=claim-evidence
```

**Never put the service_role key in front-end code.** It is only read by the
Express server. The browser never talks to Supabase directly — it talks to your
API.

The server writes objects with keys like
`public/2026/11/<uuid>.webp` and stores only that reference in Postgres. Private
evidence is served through 5-minute signed URLs generated per request.

---

## 5. Email delivery

The OTP is only as good as the mailbox it lands in. Any SMTP provider works
(SendGrid, Resend, Amazon SES, Zoho, Google Workspace, your university's mail
relay).

```bash
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=apikey-or-username
SMTP_PASS=the-secret
MAIL_FROM="CampusConnect <no-reply@your-university.edu.in>"
```

Checks worth doing before a pilot:

- SPF and DKIM records exist for the sending domain, or mail lands in spam.
- `MAIL_FROM` uses a domain you control — never a student's personal address.
- Send one test registration to a real student inbox and confirm the code arrives
  within a few seconds.

During local development keep `MAIL_TRANSPORT=file`: the email is written to
`tmp/mail-outbox/` and the code never appears in the console or the logs.

---

## 6. Verify the setup

```bash
npm run migrate        # should report "up to date" the second time
npm start              # boots and logs "database connected"
curl localhost:3000/api/health
```

`/api/health` must report `"database": { "connected": true }`. If it does not,
the connection string, password or SSL flag is wrong — the message in the log
says which.

---

## 7. Backups

Supabase takes daily backups on paid plans. On the free tier, run your own:

```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom -f campusconnect-$(date +%F).dump
```

Store it outside the project. Restore with `pg_restore --clean --if-exists`.
