# Independent review — findings and what was done

An adversarial review was run against this codebase after it was written. It was
told to break the authentication, the claim workflow, the file handling and the
admin boundary, and to prove findings by execution rather than by reading alone.

It reported 15 findings. Every one is closed, and every closed finding now has a
regression test in `tests/regressions.test.js` named after it (`F1`, `F2`, …) so a
future change cannot quietly reintroduce it.

| ID | Sev | Finding | Status | Fix |
|---|---|---|---|---|
| F1 | High | Private claim evidence was reachable at `/uploads/private/...` because `express.static` was mounted over the whole upload root | **Fixed** | `/uploads` now refuses the `private/` prefix with a 404; evidence is only reachable through `/api/files/private/*` (or a signed Supabase URL), which checks the caller |
| F2 | High | OTP "single use" and "max attempts" were read-modify-write races — one code could be redeemed several times and parallel wrong guesses overwrote the counter | **Fixed** | The code is burned with `update … where consumed_at is null returning id` and a lost race is a 400; attempts use `attempts = attempts + 1` with the burn decided in the same statement |
| F3 | High | `POST /api/auth/resend-otp` would mint a `login`/`admin_login` code from an email address alone, making the password factor optional | **Fixed** | A resend only refreshes a challenge that already exists (created by a successful password check); otherwise it returns the generic response and sends nothing |
| F4 | Medium | An owner could mark an item "returned" while a claim was pending, stranding that claim forever | **Fixed** | The owner transition to `returned` is refused with 409 while a pending/approved claim exists (administrators keep an override) |
| F5 | Medium | Re-registering an existing **unverified** address overwrote its name and password hash without proving mailbox control | **Fixed** | The resume path re-issues the code and leaves the stored credentials untouched |
| F6 | Medium | `studentId` from the profile form was dropped by validation, so `users.student_id` could never be set | **Fixed** | Both `studentId` and `student_id` are accepted and persisted; covered by a test |
| F7 | Medium | The handover email linked to the claim id, so the claimant got a dead `/item.html?id=<claim>` link | **Fixed** | The email now links the item; asserted in the test |
| F8 | Medium | `verify-otp` never bound `purpose` to the account's role, and the hourly cap was per purpose — a student could request and redeem an `admin_login` code | **Fixed** | `admin_login` is refused for non-administrators at both resend and verify; the hourly cap now counts every purpose for the account |
| F9 | Low | `login_success`, `admin_login_success` and `session_revoked` were declared but never written | **Fixed** | Written at the right places, so the admin "Security events" filters return real rows |
| F10 | Low | `ApiError` dropped `details`, so the resend countdown ignored the server's `retryAfter` | **Fixed** | `details` is preserved and used |
| F11 | Low | `?next=/\evil.example` slipped past the open-redirect check | **Fixed** | The target is resolved with `new URL(next, location.origin)` and must stay on the same origin |
| F12 | Low | The JWT expired after 12 h but sessions stayed "active" for 72 h | **Fixed** | The session lifetime is clamped to the token lifetime at config time |
| F13 | Low | Moderation is vestigial: every listing is auto-approved, so the pending queue is always empty | **Documented** | Auto-publish is the intended behaviour for a campus board; the docs now describe moderation as *reactive* (remove/restore) instead of advertising a pre-approval queue |
| F14 | Low | The API accepted claims on `lost` listings although the UI hides that action | **Fixed** | The service refuses claims on anything but `found` items |
| F15 | Low | Claim evidence could be uploaded but never viewed — the signed-link endpoint had no caller | **Fixed** | The dashboard renders evidence thumbnails for the owner through `/api/claims/:id/evidence` |

## What the review found clean

These areas were attacked and held up; they are worth knowing because they are
the parts you should not "simplify" later:

- **Session forgery and replay** — HS256 with pinned algorithm and issuer, the
  session row is checked on every request, role comes from the database, and
  logout/expiry/suspension all fail closed.
- **IDOR and privilege escalation** — no cross-student read or write was found;
  every `/api/admin/*` route returns 403 for a student, self-promotion is refused
  and the last administrator cannot be demoted.
- **SQL safety** — every dynamic fragment is built from a fixed column whitelist
  with bound parameters; operator smuggling through the query string is a 400.
- **Upload content validation** — a text file or SVG sent as `image/png` is
  rejected by sharp, and generated filenames cannot traverse directories.

## The test suite after the fixes

126 tests, all passing:

| File | Tests | Covers |
|---|---|---|
| `tests/auth.test.js` | 27 | domain rules, OTP lifecycle, sessions, portal separation |
| `tests/items.test.js` | 20 | reporting, images, galleries, filters, ownership |
| `tests/claims.test.js` | 14 | claim workflow and state machine |
| `tests/admin.test.js` | 15 | admin access control, moderation, audit trail |
| `tests/security.test.js` | 13 | token tampering, headers, CORS, path traversal |
| `tests/regressions.test.js` | 12 | one test per audit finding above |
| `tests/recovery.test.js` | 11 | password reset end to end, listing expiry and owner warnings |
| `tests/ui.test.js` | 14 | every page boots in a DOM; forms submit the right payloads |

```bash
npm test          # ~2 minutes; needs a machine that can run WebAssembly
```
