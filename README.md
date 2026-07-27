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

## Adding a brand

Edit **`brands.js`** — that's the only place. Both the PDF parser and the
email subject parser read from it, so a brand added there is recognised
everywhere.

```js
['Canonical Name', 'alias', 'another alias'],
```

The canonical name is what appears in the Brand column; aliases are other
spellings that turn up in forms and subject lines. Matching is
case-insensitive and tries the longest alias first, so a brand whose name
contains another brand's name still resolves correctly.

## Debugging a bad PDF parse

Verbose parser logging is off by default. In the browser console:

```js
RMADebug.on()     // then reload and re-import the problem PDF
RMADebug.off()
```

## Tests

```
node tests/ingest.test.js
```

Covers subject parsing, forwarded-date recovery across mail clients and
languages, date-source priority, and warranty inference.
