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
- **Automatic email import** — forwarded RMA emails become entries on their
  own, with no OAuth anywhere. Mail is received by an inbound-email service
  and parked in a queue; the app parses the queue with the same PDF parser it
  uses everywhere else, so there is exactly one implementation of the form
  parsing rather than two that can drift apart.

See [SETUP.md](SETUP.md) for first-time setup.

## Tests

```
node tests/ingest.test.js
```

Covers subject parsing, forwarded-date recovery across mail clients and
languages, date-source priority, and warranty inference.
