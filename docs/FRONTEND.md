# Front-end pages

Every page is plain HTML + one shared CSS file + one shared JS module. No build
step, no framework, no bundler — Vercel serves the folder as-is.

```
public/
├── index.html          public gallery + search + filters + pagination
├── auth.html           register → OTP → session, or login → OTP → session
├── reset.html          forgot password → emailed link → set a new password
├── report.html         report a lost/found item, with upload or camera capture
├── item.html           item detail, claim submission, owner controls
├── dashboard.html      my reports, my claims, claims received, login activity, profile
├── admin/
│   └── index.html      separate administrator console (login + 7 sections)
└── assets/
    ├── app.css         design system: tokens, layout, components, responsive rules
    ├── config.js       the one file you edit per deployment (API base URL)
    ├── api.js          fetch wrapper, session store, toasts, formatting, nav
    ├── gallery.js      index.html
    ├── auth.js         auth.html
    ├── reset.js        reset.html
    ├── report.js       report.html
    ├── item.js         item.html
    ├── dashboard.js    dashboard.html
    └── admin.js        admin/index.html
```

---

## index.html — public gallery

The landing page and the product's shop window. Server-rendered counters, then a
live gallery.

| | |
|---|---|
| **Route** | `/` |
| **Auth** | none |
| **API** | `GET /api/items/stats/public`, `GET /api/items?type&category&location&search&sort&page&limit` |
| **UI** | hero with two calls to action · four statistics · tab row (All / Lost / Found) · filter bar (search, category, location with suggestions, sort) · responsive card grid · pagination · empty state · skeleton loading |
| **Notes** | Cards are links to `item.html?id=…`, so every listing has a shareable URL. The owner's email is never rendered. `#lost` / `#found` in the URL opens the matching tab. |

## auth.html — student sign-in and registration

One page, three panels, because the flow is a single conversation.

| | |
|---|---|
| **Route** | `/auth` |
| **API** | `POST /api/auth/register` → `POST /api/auth/verify-otp` · `POST /api/auth/login` → `POST /api/auth/verify-otp` · `POST /api/auth/resend-otp` · `POST /api/auth/logout` |
| **UI** | sign-in panel · registration panel (name, university email, password with hint) · six-box OTP panel with auto-advance, paste support, arrow-key navigation, resend countdown, "use a different email" · inline field errors · success/error banners · link to the admin portal and to password reset |
| **Notes** | No token is stored until the OTP is verified. `?next=` returns the visitor to the page they were on. |

## reset.html — password reset

| | |
|---|---|
| **Route** | `/reset` and `/reset?token=…` |
| **API** | `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` |
| **UI** | request panel · new-password panel (password + confirm) · done panel that reports how many sessions were signed out |
| **Notes** | Without a token the page asks for an email; with one it goes straight to choosing a password. The server's response is identical for known and unknown addresses. |

## report.html — report a lost or found item

| | |
|---|---|
| **Route** | `/report` |
| **Auth** | student session (redirects to `auth.html?next=report.html`) |
| **API** | `POST /api/items` (multipart), `GET /api/items/stats/public` (location suggestions) |
| **UI** | lost/found selector · item name · category · location with suggestions · date (max = today) · approximate time · description · additional information · **photo picker**: choose a file, drag and drop, or **Take photo** · live preview with Replace / Remove · inline validation · submit with a busy state |
| **Notes** | The camera dialog requests permission only when the user clicks "Take photo". If permission is denied or the browser has no `getUserMedia`, it falls back to the native capture input (`capture="environment"`) and says so. The file is checked for type and 5 MB before upload; the server checks the real bytes again. |

## item.html — detail, claim, owner controls

| | |
|---|---|
| **Route** | `/item?id=…` |
| **Auth** | optional; some controls need a session |
| **API** | `GET /api/items/:id` · `POST /api/claims` · `PATCH /api/claims/:id/decision` · `PATCH /api/claims/:id/complete` · `PATCH /api/items/:id` · `PATCH /api/items/:id/status` · `DELETE /api/items/:id` |
| **UI** | photo (with thumbnails for extra images) · type/status/claim-count pills · details table (category, location, date, reporter, views) · description · claim button or "you already have a claim" banner · **claim dialog** with the identification message and an optional private photo · **owner panel**: edit dialog, close, mark returned, confirm handover, delete, and the full list of claims with Approve / Reject |
| **Notes** | The owner sees every claim's message — this was a gap in the original app. "Mark returned" is refused while a claim is still open, and the page explains why. |

## dashboard.html — student dashboard

| | |
|---|---|
| **Route** | `/dashboard` |
| **Auth** | student session |
| **API** | `GET /api/auth/me` · `GET /api/items/mine` · `GET /api/claims/mine` · `GET /api/claims/received` · `GET /api/claims/:id/evidence` · `PATCH /api/claims/:id/*` · `GET /api/auth/sessions` · `PATCH /api/auth/me` · `POST /api/auth/change-password` |
| **UI** | six counters (reports, lost, found, reunited, claims sent, claims to review) · side navigation with five sections · **My reports** · **My claims** (with withdraw / "I have the item") · **Claims received** (message, claimant, evidence thumbnails, approve, reject, arrange handover, confirm returned) · **Login activity** table · **Profile settings** and change password |
| **Notes** | Claim evidence is fetched through short-lived signed links, never from a public URL. |

## admin/index.html — administrator console

| | |
|---|---|
| **Route** | `/admin` |
| **Auth** | administrator session only; a student is sent back to the public site |
| **API** | `POST /api/auth/admin/login` → `POST /api/auth/verify-otp` · `GET /api/admin/overview` · `/users` · `/items` · `/claims` · `/sessions` · `/auth-events` · `/audit-logs` · the matching `PATCH` routes |
| **UI** | its own login with an OTP step · dark sidebar · **Overview** (12 counters + "needs attention") · **Users** (search, verify status, suspend, reactivate, promote) · **Lost & found** (moderate: approve, remove, restore) · **Claims** (decide as an administrator) · **Login history** (revoke a session) · **Security events** · **Audit log** |
| **Notes** | Every section is paginated. Hiding a button is never the control — each of these endpoints is guarded on the server, and the tests assert 403 for a student token on every admin route. |

---

## Shared behaviour (api.js)

- `api(path, { method, body, form })` — adds the bearer token, parses the standard
  error envelope, and on `401` clears the session and returns to the right sign-in
  screen (student or admin).
- `session` — token and user in `localStorage`; cleared on logout and on any 401.
- `toast(message, kind)` — accessible live region, auto-dismiss.
- `escapeHtml` — every user-controlled string passes through it before `innerHTML`.
- `formatDate` / `formatDateTime` / `timeAgo` — rendered in IST.
- `safeNext` — resolves `?next=` against the current origin and refuses anything
  that would leave it.

## The only file you edit per deployment

`assets/config.js`:

```js
window.CAMPUS_CONFIG = {
  apiBase: '',            // same origin (API serves the frontend)
  // apiBase: 'https://campusconnect-api.onrender.com',   // split deployment
  siteName: 'CampusConnect',
  university: 'Sai University',
};
```

When `apiBase` is set, add that origin to `CORS_ORIGINS` on the API, and set
`APP_URL` on the API to the frontend URL so email links point at Vercel.
