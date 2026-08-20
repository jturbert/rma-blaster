# RMA Blaster: Technical Reference

Everything the app is built on, where each piece lives, and what to check
when something stops working. Written to be read cold, months later.

Setup instructions are in [SETUP.md](SETUP.md). This file is the map.

> **No secrets in this file.** The repo is public. Where a password, token
> or key is involved, this says which dashboard holds it, never the value.

---

## 1. The short version

A dealer submits the RMA form on duneblue.com. That email travels through
four hands before it becomes a row you can see:

```
dealer submits form on duneblue.com
        ↓
Resend (the site's mail provider)    (sends the confirmation copy, BCCs the archive)
        ↓  BCC, RMA submissions only
rmablaster@gmail.com                 (our mailbox, and our archive)
        ↓  Gmail filter: subject contains "RMA"
Postmark inbound                     (receives mail, POSTs it as JSON)
        ↓  webhook
inbound-email Edge Function          (Supabase; stores it, parses nothing)
        ↓
pending_emails table + storage       (the queue)
        ↓  when anyone opens the app
the app parses and creates the entry
```

The site BCCs `rmablaster@gmail.com` directly (see `RMA_ARCHIVE_TO` in
DB-Site's `server/handler.js`) — mail lands there without going through
`info@duneblue.com` first. The Gmail filter and Postmark forward apply
regardless of how the mail arrived at that inbox, so this should work
unchanged, but it depends on that filter and the Postmark inbound stream
still being live — worth confirming in both dashboards if RMAs stop
appearing.

The one design decision worth remembering: **the Edge Function does no
parsing.** It only parks the raw email and its PDFs. All parsing happens in
the browser, so the Dune Blue form parser exists once rather than in two
places that could drift apart.

---

## 2. Services

### Supabase (database, file storage, logins, the inbound function)
| | |
|---|---|
| Console | [supabase.com/dashboard](https://supabase.com/dashboard) |
| Project | `rma-blaster`, region `eu-central-1` (Frankfurt) |
| Project ID | `oyspjwnhzpczmumftris` |
| API URL | `https://oyspjwnhzpczmumftris.supabase.co` |
| Plan | Free |
| Signed in with | Jim's GitHub account |

Holds four things: the Postgres database, the `rma-pdfs` storage bucket,
the user logins, and the `inbound-email` Edge Function.

**Free plan limits worth knowing:** 500 MB database, 1 GB file storage,
and projects pause after roughly a week with no activity. Normal use keeps
it awake. A long shutdown could pause it, and while paused, inbound email
fails rather than queues.

### Postmark (receives the forwarded email)
| | |
|---|---|
| Console | [account.postmarkapp.com](https://account.postmarkapp.com) |
| Used for | Inbound only. Nothing is ever sent. |
| Inbound address | In the server's Inbound stream. Long hash `@inbound.postmarkapp.com`. |
| Webhook target | The `inbound-email` function URL, with `?token=` on the end |

Sender Signatures and DKIM warnings in that dashboard are about **sending**
and can be ignored permanently.

The **Activity** tab is the first place to look if email stops arriving. It
shows each inbound message and what our webhook replied.

### Gmail: rmablaster@gmail.com
Our mailbox and a full archive independent of everything else. Two settings
matter, both under Gmail Settings:

- **Forwarding**: the Postmark inbound address, confirmed
- **Filter**: subject contains `RMA`, action forward to that address

The filter deliberately matches the broad word `RMA` rather than `RMA #`,
because Gmail's search index handles `#` unreliably. Over-forwarding is
safe: the app ignores anything whose subject does not match, and says why.

### GitHub (source and hosting)
| | |
|---|---|
| Repo | [github.com/jturbert/rma-blaster](https://github.com/jturbert/rma-blaster) |
| Live site | `https://jturbert.github.io/rma-blaster/` |
| Hosting | GitHub Pages, `main` branch, root |

Pushing to `main` deploys the site about a minute later. There is no build
step: the files in the repo are the files the browser runs.

**Predecessor:** [github.com/jturbert/RMA-Manager](https://github.com/jturbert/RMA-Manager),
the v1 Google/Gmail app. Its `backup-live-version` branch is the last state
before the 2026-07 security fixes.

---

## 3. Where each secret lives

Nothing here is stored in the repo.

| Secret | Where it lives | Notes |
|---|---|---|
| Supabase project URL and publishable key | `config.js`, committed | Public by design; RLS does the protecting |
| `INBOUND_TOKEN` | Supabase, Edge Functions, Secrets | Same string is in Postmark's webhook URL. Change one, change both. |
| Team logins | Supabase, Authentication, Users | Created by hand; self-signup is off |
| Supabase database password | Set at project creation | Rarely needed; only for direct database access |
| Postmark login | Postmark account | |
| Gmail password | The Google account | |

To rotate the inbound token: generate a new string, update the Supabase
secret, then update the `?token=` on Postmark's webhook URL. Both, or
inbound email stops.

---

## 4. Files

Loaded in this order (later files depend on earlier ones):

| File | Lines | What it does |
|---|---:|---|
| `config.js` | 19 | Supabase URL and publishable key |
| `debug.js` | 33 | Verbose-logging switch, off by default |
| `brands.js` | 68 | **The** brand list. Add brands here and nowhere else. |
| `attachments.js` | 78 | **The** attachment file-type list (PDF/JPG/PNG). Add file types here — and in the Edge Function, which keeps its own copy. |
| `storage.js` | 401 | Everything touching the database and file storage |
| `pdf-parser.js` | 576 | Reads the Dune Blue form and invoice dates |
| `excel.js` | 81 | The three spreadsheet exports |
| `ingest.js` | 253 | Email subject/date parsing; turns the queue into entries |
| `app.js` | 998 | UI, dashboard, modal, statistics, backup/restore |
| `index.html` | 474 | Markup and the script tags |
| `styles.css` | — | All styling |

Not loaded by the browser:

| File | Purpose |
|---|---|
| `schema.sql` | Creates `entries`, `pdfs`, the storage bucket and access rules. The `pdfs.type` column holds `rma-form`, `invoice` or `photo`; content types are derived from the stored filename's extension, not a column. |
| `schema-phase2.sql` | Creates `pending_emails` |
| `supabase/functions/inbound-email/index.ts` | The webhook receiver, deployed to Supabase |
| `tests/ingest.test.js` | 37 tests. Run: `node tests/ingest.test.js` |
| `tools/make-icons.py` | Regenerates the PNG icons from `favicon.svg`. Run after changing the icon: `python3 tools/make-icons.py` |

### Third-party libraries, all from CDN

| Library | Version | Used for |
|---|---|---|
| supabase-js | 2 (jsDelivr, floating) | Database, auth, storage |
| pdf.js | 3.11.174 (cdnjs, pinned) | Reading PDFs |
| SheetJS (xlsx) | 0.18.5 (cdnjs, pinned) | Excel export |
| JSZip | 3.10.1 (cdnjs, pinned) | Batch PDF download |

These load from public CDNs at page load. If the app ever goes blank or one
feature dies for no reason, check the browser console for a failed script.
Note supabase-js floats on major version 2, so it can change under us; the
other three are pinned exactly.

---

## 5. Database

### `entries`
The RMA records. Column names are snake_case in the database and camelCase
in the app; `storage.js` maps between them via `FIELD_MAP`.

Notable columns:
- `email_id` — unique. The source email's Message-ID. This is what stops
  the same email being imported twice.
- `deleted` / `deleted_at` — archive flag. **Nothing is ever hard deleted.**
- `last_modified` — set on every save.

### `pdfs`
One row per attached file. The bytes live in the `rma-pdfs` bucket;
`storage_path` points at them. Deleting an entry cascades to its PDFs.

### `pending_emails`
The inbound queue. `status` moves `pending` → `processing` → `processed`,
`ignored` or `error`, and `error` holds the human-readable reason shown in
the Email Queue panel.

`processing` is a claim: whoever grabs the row first processes it, so two
people signing in at once cannot import the same email twice. A claim
abandoned by a closed tab goes stale after 10 minutes and is retried.

### Access rules
Row Level Security is on for all three tables. Any signed-in team member
has full access; anyone not signed in has none. The Edge Function writes
with the service-role key, which bypasses RLS by design.

---

## 6. When something breaks

| Symptom | Look here first |
|---|---|
| No new RMAs appearing | Settings, Email Queue. Rows arriving means the mail chain is fine and the problem is parsing. No rows means it is Gmail, Postmark or the token. |
| Entries appear but fields are blank | The RMA form template probably changed. `pdf-parser.js` reads it structurally. Turn on `RMADebug.on()`, reload, re-import, and read the console. |
| An email shows "Ignored" | Normal for non-RMA subjects and repeat submissions. The reason is on the row. |
| An email shows "Failed" | Real error. The reason is on the row; the browser console has more. |
| Nothing loads at all | A CDN script failed, or Supabase is paused. Check the browser console. |
| Sign-in refuses a correct password | Check the user still exists in Supabase, Authentication, Users. |
| Postmark reports webhook errors | Almost always the token: the `?token=` in Postmark must equal `INBOUND_TOKEN` in Supabase exactly. |

**Diagnosing a bad parse:** open the browser console, run `RMADebug.on()`,
reload, re-import the PDF, and read the output. `RMADebug.off()` afterwards.

**The failure mode to watch for is silence.** Every problem above shows up
as things quietly not happening rather than as an error. Glancing at the
Email Queue every couple of weeks is the cheapest insurance.

---

## 7. History

- **v1, RMA Manager**: Google OAuth, read Gmail directly, synced through
  Google Drive, data stored per-browser in IndexedDB. Retired because its
  OAuth consent screen was stuck in testing mode, which expires logins
  every 7 days, and because per-browser storage meant no real sharing.
- **2026-07-15**: v1 security review. A live OAuth client secret was found
  committed to the public repo and rotated. A data-loss path was fixed
  where a failed sync could permanently delete entries.
- **2026-07-15**: v2 built on Supabase. 138 entries and 177 PDFs migrated
  from a v1 backup file.
- **2026-07-27**: automatic email ingestion replaced the manual fetch.
  Fixed a bug carried over from v1: Gmail writes forwarded dates as
  "Tue, 21 Jul 2026 at 10:15" and the literal "at" made JavaScript's date
  parser fail, so every forwarded date had been silently discarded.
