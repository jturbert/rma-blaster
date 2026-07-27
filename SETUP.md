# RMA Blaster — Setup Guide

One-time setup, about 15 minutes. No Google Cloud, no OAuth screens.

---

## Part 1 — Create the Supabase Project

Supabase hosts the shared database and PDF storage. The free tier is far
more than this app needs.

1. Go to **[supabase.com](https://supabase.com)** → **Start your project** → sign up
   (signing up with your GitHub account is easiest)
2. Click **New project**
   - **Name:** `rma-blaster`
   - **Database password:** generate one and store it somewhere safe
     (you rarely need it — it's for direct database access, not the app)
   - **Region:** pick the one closest to you (e.g. `eu-central-1`, Frankfurt)
3. Wait ~1 minute while the project is created

## Part 2 — Create the Tables

1. In the Supabase dashboard, open **SQL Editor** (left sidebar)
2. Click **New query**
3. Open the file **`schema.sql`** from this repo, copy ALL of it, paste it in
4. Click **Run**. You should see "Success. No rows returned"

This creates the entries table, the PDF metadata table, the PDF storage
bucket, and the access rules (signed-in team members only).

## Part 3 — Create Team Logins

1. Dashboard → **Authentication** → **Users** → **Add user** → **Create new user**
2. Enter each person's email and a password. Check **Auto Confirm User**
3. Repeat for every team member

Then disable self-signup so only accounts you create can exist:

4. **Authentication** → **Sign In / Up** (or **Providers** → **Email** in older
   dashboards) → turn **OFF** "Allow new users to sign up" → Save

## Part 4 — Connect the App

1. Dashboard → **Project Settings** (gear icon) → **API**
2. Copy two values:
   - **Project URL** (like `https://abcdefgh.supabase.co`)
   - **anon public** key (long string starting with `eyJ`)
3. Open the app → **Settings** → paste both into **Database Connection** →
   **Save & Reload**

> Both values are safe to share with the team, and safe to commit in
> `config.js` — unlike the old Google client secret, they grant nothing
> by themselves. Every data operation still requires a team login,
> enforced by the database itself.

## Part 5 — Migrate Data from the Old App

1. In the **old** RMA Manager app: Settings → **Download Backup**
2. In RMA Blaster: sign in → Settings → **Import from Backup** → choose the file
3. Wait for the progress bar — entries go to the database, PDFs upload to
   cloud storage. Importing the same file twice is safe (duplicates are skipped)

## Part 6 — Automatic Email Import (Phase 2)

This is what replaces the old app's "Fetch New Emails" button. Once set up,
forwarded RMA emails turn into entries by themselves.

**The chain:** dealer form → `info@duneblue.com` → (already forwarding) →
`rmablaster@gmail.com` → Gmail filter forwards to Postmark → Postmark posts
to the `inbound-email` function → the email lands in a queue → the app turns
queued emails into entries, using the same PDF parser as everywhere else.

Nothing upstream of your Gmail account changes, so nobody at Dune Blue needs
to do anything.

### 6a — Add the queue table

Supabase → **SQL Editor** → **New query** → paste all of **`schema-phase2.sql`**
→ **Run**.

### 6b — Deploy the inbound-email function

1. Supabase → **Edge Functions** → **Deploy a new function** → name it exactly
   **`inbound-email`**
2. Paste the contents of **`supabase/functions/inbound-email/index.ts`**
3. Turn **OFF** "Verify JWT" (Postmark can't send a Supabase token — the
   function protects itself with a secret token in the URL instead)
4. Deploy
5. Go to **Edge Functions → Secrets** → add a secret named **`INBOUND_TOKEN`**
   with any long random string as the value. Keep a copy — you need it next.

Your function's address is now:
```
https://oyspjwnhzpczmumftris.supabase.co/functions/v1/inbound-email?token=YOUR_TOKEN
```

### 6c — Point Postmark at it

1. Sign up at **[postmarkapp.com](https://postmarkapp.com)** (inbound is free)
2. Create a server → open its **Inbound** stream
3. Copy the **inbound email address** it gives you
   (something like `abc123...@inbound.postmarkapp.com`)
4. Set the **Inbound webhook URL** to the function address from 6b,
   including `?token=...`
5. Save

### 6d — Forward from Gmail

In `rmablaster@gmail.com`:

1. **Settings → Forwarding and POP/IMAP → Add a forwarding address** → paste
   the Postmark inbound address → Next → Proceed
2. Google sends a confirmation code to that address. It arrives in the queue
   rather than an inbox, so fetch it: Supabase → **Table Editor** →
   `pending_emails` → find the Google row → read the code out of `text_body`
   → paste it back into Gmail's confirmation box
3. **Settings → Filters → Create a new filter**
   - **Subject:** `RMA #`
   - Next → tick **Forward it to** → pick the Postmark address
   - Create filter

> Forward only what matches the RMA subject. Blanket-forwarding everything
> works but fills the queue with junk the app then has to ignore.

### 6e — Test it

Forward one real RMA email to `rmablaster@gmail.com` (or send yourself a test
with a subject like `RMA #9999 from Test Dealer about Meze Alba`), wait a few
seconds, then open the app. It should appear on its own — or click
**Check Email** to pull it in immediately.

---

## Part 7 — Hosting (GitHub Pages)

Same arrangement as the old app: the repo's `main` branch is served at
`https://YOUR-USERNAME.github.io/rma-blaster/`. Enable it under
repo **Settings → Pages → Branch: main / (root)** if it isn't already.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Supabase not configured" banner | Enter the URL and anon key in Settings (Part 4) |
| "Wrong email or password" | Check with the administrator — accounts are created in the Supabase dashboard |
| Sign-in works but no data appears | Did you run `schema.sql`? Check SQL Editor for errors |
| PDF upload fails | Confirm the `rma-pdfs` bucket exists (Dashboard → Storage) — it's created by `schema.sql` |
| Import says everything was skipped | The entries already exist in the database — that's the dedup working |
| Emails aren't appearing | Check Supabase → Table Editor → `pending_emails`. Rows there = the mail chain works and the problem is parsing; no rows = the problem is Gmail forwarding, Postmark, or the token in the webhook URL |
| A queued email says "ignored" | Its subject didn't match `RMA #NNN from X about Y`, or that RMA number already exists. The reason is in the row's `error` column |
| Postmark shows webhook errors | Usually a token mismatch: the `?token=` in Postmark's webhook URL must equal the `INBOUND_TOKEN` secret exactly |
