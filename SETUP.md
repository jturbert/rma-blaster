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

## Part 6 — Hosting (GitHub Pages)

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
