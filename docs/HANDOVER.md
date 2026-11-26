# Handover — how to get this branch onto GitHub

The work in this package is committed as a single commit on a branch called
`feat/supabase-otp-security`, based on `d120b2a` (the current `main`).

It could not be pushed from the build environment because the GitHub integration
that was used has **read-only** access to `jaishubhakanth999/campus-lost-and-found`
(GitHub returns `403 Resource not accessible by integration`). Everything else is
ready, so you only need to push it yourself.

---

## Option A — apply the patch (recommended)

You need the two files that came with this handover:

- `campusconnect-supabase-upgrade.zip` — the complete working source
- `campusconnect-supabase-upgrade.patch` — the same change as a git patch

```bash
git clone https://github.com/jaishubhakanth999/campus-lost-and-found.git
cd campus-lost-and-found

git checkout -b feat/supabase-otp-security
git am /path/to/campusconnect-supabase-upgrade.patch

npm ci
npm test            # 89 tests, all should pass (takes ~95 s)

git push -u origin feat/supabase-otp-security
gh pr create --fill --base main
```

If `git am` complains, use the zip instead (Option B) — the content is identical.

## Option B — use the zip

```bash
git clone https://github.com/jaishubhakanth999/campus-lost-and-found.git
cd campus-lost-and-found
git checkout -b feat/supabase-otp-security

# copy the zip contents over the working tree (keep the repo's .git folder)
unzip -o /path/to/campusconnect-supabase-upgrade.zip -d .

git add -A
git commit -m "feat: migrate to Supabase Postgres with email-OTP auth, sessions, admin console and image galleries"
git push -u origin feat/supabase-otp-security
gh pr create --fill --base main
```

---

## Before the branch is useful

1. **Confirm the university email domain** with Sai University, then set
   `ALLOWED_EMAIL_DOMAINS` — it is deliberately not hard-coded.
2. Create the Supabase project and run the schema:
   `docs/SUPABASE_SETUP.md`.
3. Create the two storage buckets (`item-images` public, `claim-evidence`
   private).
4. Configure SMTP and send yourself one real OTP.
5. Provision the administrator: `npm run create-admin` (there is no public admin
   signup by design).
6. Deploy: `docs/DEPLOYMENT.md` — including the 18-point post-deploy checklist.

## If you want the connector to push in future

The GitHub App installation needs **Contents: Read and write** on this
repository. Once that is granted, a follow-up turn can push and open the PR
directly.
