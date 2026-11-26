# Deployment

Two supported shapes. Pick one.

| Shape | Frontend | API | Use when |
|---|---|---|---|
| **A — single service** (simplest) | Served by Express | Same Express process | You want one URL and no CORS |
| **B — split** | Vercel | Render (or any Node host) | You want the frontend on Vercel's CDN |

---

## Shape A — everything on Render

1. **New → Web Service** → connect this repository.
2. Build command: `npm ci`
3. Start command: `npm start`
4. Health check path: `/api/health`
5. Environment: add every variable from `.env.example` with production values.
   Required minimum:

```
NODE_ENV=production
APP_URL=https://campusconnect.onrender.com
DATABASE_URL=...            # Supabase
DATABASE_SSL=true
JWT_SECRET=<openssl rand -hex 32>
OTP_PEPPER=<openssl rand -hex 32>
ALLOWED_EMAIL_DOMAINS=your-university.edu.in
MAIL_TRANSPORT=smtp
SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / MAIL_FROM
STORAGE_DRIVER=supabase
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
TRUST_PROXY=1
```

6. **Pre-deploy command:** `npm run migrate` (Render runs it before each deploy;
   it is idempotent).
7. Create the administrator once, from the Render shell:

```bash
ADMIN_EMAIL=admin@your-university.edu.in ADMIN_NAME="Portal Admin" \
ADMIN_PASSWORD='…' npm run create-admin
```

> Render's disk is **ephemeral**. With `STORAGE_DRIVER=local` every uploaded photo
> disappears on the next deploy — use Supabase Storage in production. This is the
> single most common way this app would look broken after a deploy.

---

## Shape B — Vercel frontend + Render API

### API on Render
Follow Shape A steps 1–7.

### Frontend on Vercel
1. **Add New → Project** → import the same repository.
2. Framework preset: **Other**. Root directory: `public`.
   (If Vercel insists on a build step, set build command to `echo no build` and
   output directory to `public`.)
3. Before deploying, edit `public/assets/config.js`:

```js
window.CAMPUS_CONFIG = {
  apiBase: 'https://campusconnect-api.onrender.com',  // no trailing slash
  siteName: 'CampusConnect',
  university: 'Sai University',
};
```

4. On the API, allow the Vercel origin:

```
CORS_ORIGINS=https://campusconnect.vercel.app
```

5. `APP_URL` on the API must be the **Vercel** URL, not the Render URL: it is used
   to build the links inside verification emails.

```bash
APP_URL=https://campusconnect.vercel.app
```

6. Redeploy both after changing either value.

> In Shape B the API's Content-Security-Policy does not apply to pages served by
> Vercel. Vercel serves its own headers; if you need the same CSP there, add it in
> `vercel.json`.

---

## Post-deploy verification (do this, do not assume)

Run these against the live URL in order. Each one proves a specific piece.

| # | Check | Expected |
|---|---|---|
| 1 | `GET /api/health` | `{"ok":true,"database":{"connected":true}}` |
| 2 | Open `/` | Gallery renders; counters show numbers, not dashes |
| 3 | Register with a **non**-university email | Rejected with a clear message |
| 4 | Register with a university email | "Enter your code" screen appears |
| 5 | Check the inbox | 6-digit code, branded email, link points at your https domain |
| 6 | Enter a wrong code | Rejected, attempts decrease |
| 7 | Enter the correct code | Signed in, dashboard loads |
| 8 | Log out, sign in again | Second OTP required |
| 9 | Report a found item **with a photo** | Listing appears in the gallery immediately |
| 10 | Open the listing as another account | No owner email visible anywhere in the page source |
| 11 | Claim the item | Finder receives an email; claim text is visible to the finder |
| 12 | Approve the claim | Item becomes "claimed"; a second approval attempt is refused |
| 13 | Confirm handover | Item becomes "returned" |
| 14 | Sign in at `/admin/` as a student | Refused |
| 15 | Sign in at `/admin/` as the admin | OTP, then console with real counters |
| 16 | Suspend a test account in the console | That account is signed out immediately |
| 17 | Redeploy the API, then open an old photo URL | Image still loads (proves object storage) |
| 18 | Admin → Audit log | Your moderation actions are listed with actor and time |

If #17 fails, `STORAGE_DRIVER` is still `local`.

---

## Environment checklist

- [ ] `NODE_ENV=production`
- [ ] `APP_URL` is the public **https** URL of the frontend
- [ ] `JWT_SECRET` and `OTP_PEPPER` are two different 64-character random values
- [ ] `ALLOWED_EMAIL_DOMAINS` contains the confirmed university domain
- [ ] `DATABASE_URL` uses `sslmode`/`DATABASE_SSL=true`
- [ ] `TRUST_PROXY=1` (Render/Vercel sit in front of the app)
- [ ] `CORS_ORIGINS` set only when the frontend is on another origin
- [ ] `STORAGE_DRIVER=supabase` with both buckets created
- [ ] `MAIL_TRANSPORT=smtp` with SPF/DKIM configured
- [ ] No secret appears in the repository, the frontend bundle or the logs
- [ ] `npm run migrate` ran on the deployed database
- [ ] Administrator created via `npm run create-admin`

---

## Rollback

1. Redeploy the previous build (Render keeps the last successful deploy; Vercel
   keeps every deployment).
2. Migrations are forward-only and additive, so an older build keeps working
   against the newer schema.
3. If a bad change corrupted data, restore the most recent `pg_dump`/Supabase
   backup — take one before any schema change.

## What is still missing for a real launch

These are honest gaps, not oversights:

- **Load testing.** The app has been exercised by an integration suite, not by a
  thousand concurrent students. Run a load test against staging before a
  campus-wide announcement.
- **Monitoring.** Add an uptime check on `/api/health` and an alert on 5xx rate.
- **Password reset.** Deliberately left to a later phase; the support path today
  is an administrator resetting the account.
- **Data retention policy.** Decide how long returned items and auth events are
  kept, and add a scheduled purge.
