# RMA Blaster: moving to Cloudflare

Written 2026-11-10. Stage 1 is built on the `cloudflare` branch and tested
on this computer only. Nothing exists on Cloudflare yet; section 8 is the
list of steps that puts it there.

On this branch README.md, REFERENCE.md and SETUP.md still describe the
Supabase version. They get rewritten at stage 4. Until then this file is
the truth for the branch. Once the move is done, fold what matters into
REFERENCE.md and delete this.

> No secrets in this file. The repo is public.

---

## 1. Where it ends up

One Cloudflare Worker, same shape as Interlocutor:

```
rma.duneblue.com
        │
Cloudflare Access                 (login; same Zero Trust team as Interlocutor)
        │
Worker "rma-blaster"
   ├── static assets              the app: index.html, app.js, parser, styles
   ├── /api/*                     small API the app calls
   ├── D1  rma-blaster-db         entries, pdfs, pending_emails
   ├── R2  rma-blaster-files      the PDFs and photos
   └── intake                     receives new RMAs from the Dune Blue site
```

| Today | After |
|---|---|
| GitHub Pages | Worker static assets |
| Supabase Postgres | D1 |
| Supabase Storage | R2 |
| Supabase Auth, passwords | Cloudflare Access, emailed login code |
| `inbound-email` Edge Function | Part of the Worker |
| Postmark | Gone |
| Gmail forwarding filter | Gone |
| `rmablaster@gmail.com` | Stays, as archive only. Nothing depends on it. |
| Resend | Stays. It belongs to the site. |
| GitHub | Stays as the repo and runs the tests |

## 2. What changes in the code, and what does not

**Untouched:** `pdf-parser.js`, `excel.js`, `brands.js`, `attachments.js`,
`debug.js`, `styles.css`, nearly all of `app.js`, nearly all of `ingest.js`,
and the 37 tests.

This works because every database and file call in the app already goes
through `Storage.*` in `storage.js`. Only that file knows Supabase exists.
The plan is to keep every `Storage` function name and return shape exactly
as it is and replace the insides with `fetch('/api/...')`.

**Rewritten:**

| File | Change |
|---|---|
| `storage.js` | Same functions, new insides. About 20 functions. |
| `app.js` lines ~28 to 120 | Sign-in form, sign-out, and the Supabase URL/key settings fields go away. Access handles login before the page loads. |
| `index.html` | Drop the sign-in markup, the Supabase settings fields and the supabase-js script tag. |
| `config.js` | Deleted. Nothing left to configure in the browser. |
| `supabase/` | Deleted at the end. |

**New:**

| File | What |
|---|---|
| `wrangler.toml` | Bindings for D1, R2, assets, Access vars |
| `.assetsignore` | Whitelist of the files served as the app |
| `worker/index.mjs` | Router and API handlers |
| `worker/auth.mjs` | Access login check, same approach as Interlocutor's `src/auth.ts` |
| `worker/constants.mjs` | The one number shared with `storage.js` |
| `migrations/0001_init.sql` | The three tables in SQLite form |
| `tools/migrate-from-supabase.mjs` | Copies data and files across. Safe to re-run. |
| `tests/worker.test.mjs`, `tests/migrate.test.mjs` | 81 tests for the above |
| `package.json` | Only there to pin the Cloudflare CLI. The app still has no build step. |

### Three things that need care

1. **The claim.** `claimPendingEmail` relies on Postgres settling a race
   inside one UPDATE. D1 can do the same with
   `UPDATE ... WHERE id = ? AND (status = 'pending' OR stale) RETURNING id`.
   This moves into the Worker and gets its own test.
2. **Row Level Security is gone.** Today the database refuses anyone who is
   not signed in. After the move, the Worker is the only thing that can reach
   D1 and R2 at all, and it checks the Access login on every request. Same
   result, but the check is our code, so it gets a test too.
3. **An expired login mid-session.** Access answers API calls with a redirect
   to its login page instead of an error. `storage.js` needs to notice that
   and reload the page. Interlocutor already handles this; copy it.

### Repo layout

Unchanged. The app files stay in the repo root, so fixes made to the live
app on `main` merge into this branch without fuss. `.assetsignore` lists
exactly which root files Cloudflare serves; everything else is private by
default. A new script the page loads has to be added there.

### Deploys

Two options. Pick one in stage 1.

- **Push to deploy (recommended).** Connect the repo to Cloudflare Workers
  Builds. Pushing to `main` deploys, same habit as now.
- **Manual, like Interlocutor.** `npx wrangler deploy` from the repo root.

Either way the Worker and the app deploy together. The "pushed but forgot to
deploy the function" and `verify_jwt` traps both disappear.

## 3. Intake: how new RMAs arrive

The Dune Blue site turns out to be a Cloudflare Worker too (`duneblue`, in
`DB-Site/wrangler.jsonc`). That opens a shorter route than email.

**Option A, direct hand-off (recommended if both Workers are in the same
Cloudflare account).** When a dealer submits the form, the site Worker
passes the submission straight to the RMA Worker over a service binding: an
internal call, no public URL, no token. The site still sends its emails and
still BCCs the Gmail archive exactly as it does now.

```
dealer submits form
   ├── Resend: confirmation email + BCC to the Gmail archive   (unchanged)
   └── service binding → rma-blaster Worker → queue            (new)
```

- For: no email parsing, no Email Routing setup, nothing to forward or
  filter, one hop.
- Against: email retries for free and a direct call does not, so the site
  has to retry a failed hand-off itself. It also means a small change to
  DB-Site's `server/handler.js` and `wrangler.jsonc`.

**Option B, email.** Turn on Cloudflare Email Routing for a subdomain, add
an address like `intake@rma.the-soundkitchen.com` to the site's
`RMA_ARCHIVE_TO`, and have the Worker receive the mail directly.

- For: the site changes by one setting. Mail delivery retries on its own.
- Against: the Worker has to unpack raw email (a library handles it, but it
  is more moving parts), plus DNS records for the subdomain.

Either way the queue row looks the same as today (subject, date, body,
attachments), so `ingest.js` and the parser never know the difference.

**Guarding against silence.** RMA numbers come from a counter on the site,
so they are sequential. A cheap optional check: the app flags a gap in the
sequence. That catches a lost hand-off under either option. Not required
for the move.

## 4. Stages

The current app stays live and stays the real one until stage 3.

### Stage 1: build the new app beside the old one
- Create D1 database, R2 bucket, Worker, hostname, Access application.
- Write the Worker API and the new `storage.js`.
- Run the migration script to copy everything across as a test load.
- Use it read-only alongside the real app. Compare dashboards, open PDFs,
  run the three Excel exports and diff them against the old app's.

Done when: the new app shows the same entries and files as the old one and
every button works. Intake is untouched; Postmark and Supabase carry on.

### Stage 2: intake, running double
- Add intake to the Worker (option A or B).
- Point the site at it **in addition to** the existing Gmail route. Both
  queues now fill from the same submissions.
- Let it run for a week or two of real RMAs.

Done when: every RMA that reached the old queue also reached the new one,
with the same attachments.

### Stage 3: cutover
- Pick a quiet moment. Tell the team to stop editing in the old app.
- Re-run the migration script for a final, complete copy.
- Team switches to the new address. Add everyone's email to the Access
  policy beforehand.
- Replace the GitHub Pages site with a one-line "moved to" page.

Done when: a new RMA submitted on the site appears in the new app and the
team is working there.

### Stage 4: retire the old pieces
Wait two weeks after cutover, then:
- Delete the Gmail forwarding filter. Keep the mailbox.
- Close the Postmark server.
- Take a final Supabase backup file, then pause the project. Delete it a
  month later.
- Remove `supabase/`, `schema.sql`, `schema-phase2.sql`, `config.js`.
- Rewrite REFERENCE.md and SETUP.md for the new setup. Delete this file.

### Rolling back
Before stage 3: delete the Worker, nothing else was touched.
After stage 3, before stage 4: the old app, Supabase and Postmark are all
still running. Switch the team back and copy across by hand anything
entered in the meantime. After stage 4 there is no way back, which is the
reason for the two-week wait.

## 5. What Jim does vs what Claude does

**Jim, in the Cloudflare dashboard or terminal:**
- Create the D1 database and R2 bucket (two `wrangler` commands, supplied).
- Create the Access application and add the team's emails.
- Attach the hostname.
- Connect the repo for push-to-deploy, or run the deploy command.
- Run the migration script. It needs a Supabase secret key, which stays on
  Jim's machine.
- Stage 2: deploy the small change to DB-Site.
- Stage 4: the dashboard clean-up in Gmail, Postmark and Supabase.

**Claude, in the repo:** everything in section 2, the migration script, the
tests, and the rewritten docs. Claude does not need Cloudflare access.

## 6. Open questions

Settled 2026-11-10:
- `duneblue.com` is in the same Cloudflare account as Interlocutor, so
  intake uses option A, the direct hand-off.
- Hostname is `rma.duneblue.com`. Do not create the DNS record by hand; the
  first deploy creates it, and a hand-made record blocks that.

Still open:

3. **Photo cap.** The 4 MB limit exists because Supabase gives 1 GB. R2
   gives 10 GB free. Raise it, or leave it?
4. **Deploys.** Push to deploy, or manual like Interlocutor?

## 7. Free-plan limits after the move

| | Limit | Our use |
|---|---|---|
| Workers requests | 100,000 a day | A few hundred |
| D1 | 5 GB | A few MB |
| R2 | 10 GB stored | Under 1 GB |
| Access | 50 users | The team |

Nothing pauses when idle.

## 8. Stage 1: putting it on Cloudflare

None of this touches the live app, Supabase, Postmark or the site. Run
everything from the branch's own folder:

```
cd ~/Documents/rma-blaster/.claude/worktrees/cloudflare
npm install
```

1. **Create the database.** Copy the `database_id` it prints into
   `wrangler.toml`, replacing `PASTE-DATABASE-ID-HERE`.
   ```
   npx wrangler d1 create rma-blaster-db
   ```
2. **Create the file bucket.**
   ```
   npx wrangler r2 bucket create rma-blaster-files
   ```
3. **Create the login, before the site exists.** In the Zero Trust
   dashboard: Access, Applications, Add an application, Self-hosted.
   Domain `rma.duneblue.com`. One Allow policy with only your own email
   for now. Session duration 1 week, same as Interlocutor. Copy the
   Application Audience (AUD) Tag from its Overview tab into `ACCESS_AUD`
   in `wrangler.toml`.
4. **Create the tables.**
   ```
   npm run db:migrate:remote
   ```
5. **Deploy.** This also creates the `rma.duneblue.com` DNS record.
   ```
   npm run deploy
   ```
6. **Check it.** Open `https://rma.duneblue.com`. Access should ask for
   your email and send a code, then show an empty RMA Blaster with your
   email top right.
7. **Copy the data.** Read the notes at the top of
   `tools/migrate-from-supabase.mjs` first.
   ```
   SUPABASE_SECRET_KEY=paste-it-here node tools/migrate-from-supabase.mjs fetch
   ```
   ```
   node tools/migrate-from-supabase.mjs load --remote
   ```

To try it on this computer first, with no Cloudflare involved:

```
npm run db:migrate:local
```
```
node tools/migrate-from-supabase.mjs load --local
```
```
npm run dev
```

**Not yet tested:** the `fetch` half of the migration script has never run
against the real Supabase project, because that needs the secret key. The
`load` half, the Worker and the app have all been run locally. Expect the
first real `fetch` to be the place something needs adjusting.
