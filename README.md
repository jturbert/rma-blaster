# RMA Blaster

Internal RMA tracking for a hi-fi distribution operation. Successor to
[RMA-Manager](https://github.com/jturbert/RMA-Manager).

What changed in v2:

- **Shared database** (Supabase Postgres) — every team member sees the same
  entries and PDFs on any device, live.
- **Simple logins** — each person gets an email + password. No Google OAuth,
  no weekly re-authentication, no unverified-app warnings.
- **PDFs in cloud storage** — no longer trapped in one browser's local storage.
- **Manual entry + PDF parsing** — create an RMA by hand, or upload the
  RMA form PDF and let it fill the fields.
- **One-file migration** — imports the old app's backup files (entries + PDFs).

Planned: automated email ingestion via an inbound-email service (no OAuth),
replacing v1's Gmail fetching.

See [SETUP.md](SETUP.md) for first-time setup.
