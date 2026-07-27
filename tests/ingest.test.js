// ============================================================
// Tests for ingest.js — the parsing that turns forwarded RMA
// emails into entries. Pure functions only: no browser, no
// database, no network.
//
// Run:  node tests/ingest.test.js
// ============================================================

const fs   = require('fs');
const path = require('path');

// ingest.js only touches these at call time, so stubs are enough
global.Storage   = {};
global.PDFParser = {};
global.RMADebug  = { log: () => {} };

// brands.js is shared with the PDF parser and is used during parsing,
// so load the real thing rather than stubbing it
const load = (file) => {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const name = file.replace('.js', '');
  return eval(src + '; ' + name.charAt(0).toUpperCase() + name.slice(1) + ';');
};

const Brands = load('brands.js');
global.Brands = Brands;
const Ingest = load('ingest.js');

let pass = 0, fail = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(
    (ok ? '  ok  ' : '  FAIL') + '  ' + label +
    (ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`)
  );
}

// Build a forwarded-message body the way a mail client would
function fwd(marker, label, date) {
  return [
    'intro text',
    '',
    `---------- ${marker} ---------`,
    'From: Dealer <dealer@example.com>',
    `${label}: ${date}`,
    'Subject: RMA #1274 from Sound Kitchen about Dan Clark Audio',
    'To: info@duneblue.com',
    '',
    'form attached'
  ].join('\n');
}

console.log('--- brand detection (shared with the PDF parser) ---');
check('exact canonical name', Brands.detect('Meze Alba'), 'Meze');
check('alias resolves to canonical', Brands.detect('Hifiman HE1000'), 'HiFiMAN');
check('alias with no space', Brands.detect('64audio A6t'), '64 Audio');
check('abbreviation', Brands.detect('DCA Noire X'), 'Dan Clark Audio');
check('case insensitive', Brands.detect('dan clark audio e3'), 'Dan Clark Audio');
// "Noble Audio" contains "Noble"; longest-first matching must not settle for the short one
check('longest alias wins', Brands.detect('Noble Audio FoKus'), 'Noble Audio');
check('unknown brand', Brands.detect('Sennheiser HD600'), '');
check('empty input', Brands.detect(''), '');
check('null input', Brands.detect(null), '');
check('aliases longest-first', Brands.aliasesFor('Dan Clark Audio'), ['Dan Clark Audio', 'Dan Clark', 'DCA']);
check('aliases for single-name brand', Brands.aliasesFor('Questyle'), ['Questyle']);

console.log('--- subject parsing ---');
const s1 = Ingest.parseSubject('RMA #1274 from Sound Kitchen about Dan Clark Audio Noire X');
check('plain subject', [s1.rmaNumber, s1.dealer, s1.brandGuess],
      ['1274', 'Sound Kitchen', 'Dan Clark Audio']);

const s2 = Ingest.parseSubject('Fwd: RMA #1275 from HIFI CENTRUM OVERGAAUW B.V. about Meze Classic99 gen 2');
check('Fwd: prefix, dealer with dots', [s2.rmaNumber, s2.dealer, s2.brandGuess],
      ['1275', 'HIFI CENTRUM OVERGAAUW B.V.', 'Meze']);

const s3 = Ingest.parseSubject('Re: Fwd: RMA #1276 from Ears Unlimited about 64audio A6t');
check('stacked prefixes, brand alias', [s3.rmaNumber, s3.dealer, s3.brandGuess],
      ['1276', 'Ears Unlimited', '64 Audio']);

check('non-RMA subject rejected', Ingest.parseSubject('Your invoice is ready'), null);
check('empty subject rejected', Ingest.parseSubject(''), null);
check('unknown brand leaves guess blank',
      Ingest.parseSubject('RMA #1277 from Botman S&V about Something Odd').brandGuess, '');

console.log('--- forwarded date recovery ---');
// Gmail writes "at" (Dutch "om") between date and time; Date() chokes on it,
// which silently lost every forwarded date in v1.
check('en: "21 Jul 2026 at 10:15"',
      Ingest.extractForwardedDate(fwd('Forwarded message', 'Date', 'Tue, 21 Jul 2026 at 10:15')), '2026-07-21');
check('en: "Jul 21, 2026 at 10:15 AM"',
      Ingest.extractForwardedDate(fwd('Forwarded message', 'Date', 'Tue, Jul 21, 2026 at 10:15 AM')), '2026-07-21');
check('trailing (CEST) tolerated',
      Ingest.extractForwardedDate(fwd('Forwarded message', 'Date', 'Tue, 21 Jul 2026 10:15:00 +0200 (CEST)')), '2026-07-21');
check('nl: "Doorgestuurd bericht" + "Datum" + "om"',
      Ingest.extractForwardedDate(fwd('Doorgestuurd bericht', 'Datum', 'di 21 jul 2026 om 10:15')), '2026-07-21');
check('outlook "Sent:"',
      Ingest.extractForwardedDate('Sent: Tuesday, July 21, 2026 10:15 AM\nbody'), '2026-07-21');
check('outlook "Verzonden:"',
      Ingest.extractForwardedDate('Verzonden: Tuesday, July 21, 2026 10:15 AM\nbody'), '2026-07-21');
check('ISO date still works',
      Ingest.extractForwardedDate(fwd('Forwarded message', 'Date', '2026-07-21T10:15:00Z')), '2026-07-21');
check('unparseable date yields blank',
      Ingest.extractForwardedDate(fwd('Forwarded message', 'Date', 'sometime last week')), '');
check('no date in body', Ingest.extractForwardedDate('just a plain message'), '');

console.log('--- date priority ---');
const withFwd = fwd('Forwarded message', 'Date', 'Tue, 21 Jul 2026 at 10:15');
check('forwarded date beats Date header',
      Ingest.resolveDate({ text_body: withFwd, sent_at: 'Wed, 22 Jul 2026 09:00:00 +0200',
                           received_at: '2026-07-23T00:00:00Z' }), '2026-07-21');
check('falls back to Date header',
      Ingest.resolveDate({ text_body: 'no date here', sent_at: 'Wed, 22 Jul 2026 09:00:00 +0200',
                           received_at: '2026-07-23T00:00:00Z' }), '2026-07-22');
check('Date header with (CEST)',
      Ingest.resolveDate({ text_body: '', sent_at: 'Wed, 22 Jul 2026 09:00:00 +0200 (CEST)' }), '2026-07-22');
check('falls back to received_at',
      Ingest.resolveDate({ text_body: '', sent_at: '', received_at: '2026-07-23T00:00:00Z' }), '2026-07-23');
check('all sources missing yields blank',
      Ingest.resolveDate({ text_body: '', sent_at: '', received_at: '' }), '');

console.log('--- warranty inference (2-year window) ---');
check('within 2 years -> Yes',   Ingest.inferWarrantyStatus('2026-07-21', new Date(2025, 0, 15)), 'Yes');
check('exactly 730 days -> Yes', Ingest.inferWarrantyStatus('2026-07-21', new Date(2024, 6, 22)), 'Yes');
check('beyond 2 years -> No',    Ingest.inferWarrantyStatus('2026-07-21', new Date(2020, 0, 15)), 'No');
check('invoice after RMA -> blank (bad parse)',
      Ingest.inferWarrantyStatus('2026-07-21', new Date(2026, 11, 1)), '');
check('no invoice date -> blank', Ingest.inferWarrantyStatus('2026-07-21', null), '');
check('unparseable RMA date -> blank',
      Ingest.inferWarrantyStatus('not-a-date', new Date(2025, 0, 15)), '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
