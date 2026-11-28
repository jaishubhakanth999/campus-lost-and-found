# Second full-stack review — findings and fixes

A second review was run against the whole application after the first one was
closed: a real browser driving every page against a stub API, an API probe suite
against real PostgreSQL, and a code review of the parts the tests do not reach.

It reported 18 findings. Every one is fixed, and each now has a test in
`tests/review2.test.js` (backend, IDs `R1`–`R9`) or `tests/ui.test.js` (front end),
named after the finding so a failure points back here.

| ID | Sev | Finding | Fix |
|---|---|---|---|
| F1 | High | **Admin pagination was dead.** `pager()` built a detached `<div>`, attached listeners, then returned `outerHTML` — the listeners were thrown away, so Previous/Next did nothing in every section | `pager()` now returns markup only; `show()` binds the buttons after insertion. Verified in a browser: clicking Next issues `?page=2` and the label updates |
| F2 | High | **The report page deleted its own error box.** `#formAlert` sat inside `<form>` with class `error`, and `clearFieldErrors()` removes `.error` nodes — so the first submit destroyed it and every later error was invisible | the alert now lives outside the form, like every other page. Browser test asserts the server's 400 message is visible |
| F3 | High | **An administrator could approve a claim they filed themselves** | `decide()` refuses when the actor is the claimant (`R1`) |
| F4 | Medium | Cancelling the "why are you rejecting?" prompt still rejected the claim (`prompt() \|\| ''` turned Cancel into an empty note) | cancel now aborts; verified in a browser (no PATCH is sent) |
| F5 | Medium | Rejecting a listing left it `open`, so the owner could still approve a pending claim on a hidden item | `reject`/`remove` close pending claims, and an approval now also requires `moderation_status = 'approved'` (`R2`) |
| F6 | Medium | An administrator forcing `returned` skipped the live-claim guard, stranding a pending claim forever | the admin path now closes live claims in the same transaction (`R3`) |
| F7 | Medium | Restore forced `status = 'open'`, resurrecting returned or claimed items | moderation no longer touches the lifecycle at all; restore only un-removes a deleted listing (`R4`) |
| F8 | Medium | Claims were accepted on listings whose owner was suspended — and could never be reviewed | `submit()` refuses with a clear 409 (`R5`) |
| F9 | Medium | A wrong admin password silently reloaded the page: every 401 was treated as "session expired" | 401s from credential endpoints are no longer redirected — the message is shown |
| F10 | Low | `type` was accepted by the PATCH validator but dropped by the service | the update map now applies it (`R6`) |
| F11 | Low | The report date defaulted to the **UTC** date — yesterday for IST users before 05:30, and `max` blocked today | derived from local time |
| F12 | Low | Two different claim counts: the item page counted rejected claims as live | one definition (pending + approved) in both queries (`R7`) |
| F13 | Low | "Approve" on a removed listing reported success but left it hidden | approve means "make visible" and now really does (`R9`) |
| F14 | Low | The camera-unavailable message was written into a dialog that never opens | it goes to the page-level alert (possible once F2 was fixed) |
| F15 | Low | Docs quoted stale, inconsistent test counts and claimed every section was paginated | counts updated; the pagination claim is now true |
| F16 | Low | Portal separation was enforced only at the login entry point, and `/auth.html` sent an admin to the student dashboard | documented; admins now land in the console |
| F17 | Low | A stale `?page=999` returned an empty list, which the gallery rendered as "no listings exist" | page is clamped to the last page (`R8`) |
| F18 | Low | Evidence images were written to storage before the claim row was inserted, leaving orphans on a duplicate-claim 409 | the keys are deleted when the insert fails |

## Verified after the fixes

- **142 tests**, all passing (`npm test`), on Node 20 and 22 in CI.
- **Browser walkthrough** of the real stack (Chrome + Express + PostgreSQL): register → OTP → report with a photo → second student claims → owner reads the claim → approves → item claimed → handover → returned; all eight admin sections; a student refused the console; sign-out killing the token server-side. **0 page exceptions, 0 failed requests, 0 flow problems.**
- **22 API edge probes**: pagination past the end, zero-byte and extension-less uploads, two parallel approvals, completion after removal, suspended owner, deleted user's token, demoted admin, self-demotion, unknown moderation action, health.

## Still open by design

- Listings publish immediately; moderation is reactive (`remove` / `restore`).
- Portal separation is a login-time rule, not a per-token property (documented in `docs/SECURITY.md`).
- No password-strength meter beyond length/character rules.
