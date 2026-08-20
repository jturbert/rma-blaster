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
// globalName defaults to the capitalised filename; pass it explicitly for
// modules whose global doesn't follow that (pdf-parser.js -> PDFParser).
const load = (file, globalName) => {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const name = file.replace('.js', '');
  return eval(src + '; ' + (globalName || name.charAt(0).toUpperCase() + name.slice(1)) + ';');
};

const Brands = load('brands.js');
global.Brands = Brands;
const Attachments = load('attachments.js');
global.Attachments = Attachments;
const PDFParser = load('pdf-parser.js', 'PDFParser');
global.PDFParser = PDFParser;
const Storage = load('storage.js');
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

console.log('--- body field parsing (duneblue.com plain-text emails) ---');
// Mirrors server/handler.js's renderText() output from the DB-Site repo,
// for the "rma" form's field labels.
const dbSiteBody = [
  'RMA NUMBER: #1500',
  'Sound Kitchen · Final Audio · D8000 Pro · Ref: WS-102',
  '',
  'Dealer: Sound Kitchen',
  'Contact person: Wil Smeets',
  'Street address: Teststraat 1',
  'City: Rotterdam',
  'Postal code: 3011AB',
  'Country: Netherlands',
  'Email: wil@example.com',
  'Phone: +31 6 12345678',
  'Brand: Final Audio',
  'Model: D8000 Pro',
  'Serial number: SN12345',
  'Reference: WS-102',
  'Under warranty: yes',
  'Problem description: Left channel cuts out intermittently.',
  'Other remarks: Customer says it started after a firmware update.',
  '',
  'NOTES:',
  '',
  ''
].join('\n');
const bodyFields = PDFParser.parseGenericRMAFields(
  dbSiteBody.split('\n').map(l => l.trim()).filter(l => l.length > 0)
);
check('brand extracted', bodyFields.make, 'Final Audio');
check('model extracted', bodyFields.model, 'D8000 Pro');
check('serial extracted', bodyFields.serialNumber, 'SN12345');
check('"Problem description:" label recognised', bodyFields.issueDescription,
      'Left channel cuts out intermittently.');
check('"Other remarks:" mapped to notes', bodyFields.notes,
      'Customer says it started after a firmware update.');
check('"Under warranty: yes" -> Yes', bodyFields.warrantyStatus, 'Yes');

const noWarrantyFields = PDFParser.parseGenericRMAFields(['Under warranty: no']);
check('"Under warranty: no" -> No', noWarrantyFields.warrantyStatus, 'No');

// renderText()'s bare "NOTES:" print-box heading (blank ruled space for
// handwritten notes) must not be mistaken for the "Other remarks" field,
// especially when remarks was left blank and something else follows it.
const noRemarksFields = PDFParser.parseGenericRMAFields([
  'Brand: Meze', 'NOTES:', 'SEND THE PRODUCT TO'
]);
check('bare "NOTES:" heading is not captured as notes', noRemarksFields.notes, '');

// The warranty match is anchored to the label. Unanchored, any line holding
// both "warranty" and a colon set the status — so a remark mentioning a
// warranty card silently marked the RMA out of warranty.
const remarkMentioningWarranty = PDFParser.parseGenericRMAFields([
  'Other remarks: no warranty card included'
]);
check('remark mentioning "warranty" does not set the status',
      remarkMentioningWarranty.warrantyStatus, '');
check('remark mentioning "warranty" is still captured as notes',
      remarkMentioningWarranty.notes, 'no warranty card included');
check('"Warranty:" label still parses',
      PDFParser.parseGenericRMAFields(['Warranty: Yes']).warrantyStatus, 'Yes');
check('Dutch "Garantie:" label still parses',
      PDFParser.parseGenericRMAFields(['Garantie: nee']).warrantyStatus, 'No');
check('Dutch "ja" -> Yes',
      PDFParser.parseGenericRMAFields(['Garantie: ja']).warrantyStatus, 'Yes');
// An unanchored /no/ also matches "unknown", which would read as out of warranty.
check('"unknown" is not read as No',
      PDFParser.parseGenericRMAFields(['Warranty: unknown']).warrantyStatus, 'unknown');
check('"Out of warranty" -> No',
      PDFParser.parseGenericRMAFields(['Warranty: Out of warranty']).warrantyStatus, 'No');
check('"In warranty" -> Yes',
      PDFParser.parseGenericRMAFields(['Warranty: In warranty']).warrantyStatus, 'Yes');

console.log('--- old vs new format detection (the changeover) ---');
// New site: body carries the form. Old WordPress: body is prose, form is a PDF.
// Getting this wrong during the mixed period means a stray "Label: value" in an
// old email's prose claims a field and locks out the PDF's real value.
check('new-site body recognised', Ingest.isSiteFormBody(dbSiteBody), true);
check('quoted forward of a new-site body still recognised',
      Ingest.isSiteFormBody(dbSiteBody.split('\n').map(l => '> ' + l).join('\n')), true);
check('old-format forwarded email is NOT treated as a form body',
      Ingest.isSiteFormBody(fwd('Forwarded message', 'Date', 'Tue, 21 Jul 2026 at 10:15')), false);
check('prose mentioning a colon is not a form body',
      Ingest.isSiteFormBody('Hi, please see attached.\nNote: this one is urgent.'), false);
check('empty body is not a form body', Ingest.isSiteFormBody(''), false);
check('null body is not a form body', Ingest.isSiteFormBody(null), false);
// The confirmation copy the dealer receives leads with the same marker.
check('body with only "Problem description:" recognised',
      Ingest.isSiteFormBody('Dealer: X\nProblem description: buzzing'), true);

console.log('--- field precedence (body wins over attachments) ---');
// The email body is parsed first and is authoritative on the current site.
// A legacy PDF form parsed afterwards may only fill what the body left blank,
// or a stale attachment silently overwrites the real submission.
const entryFromBody = {
  make: 'Final Audio', model: 'D8000 Pro', serialNumber: '',
  issueDescription: 'Left channel cuts out.', warrantyStatus: 'Yes', notes: ''
};
Ingest.fillBlankFields(entryFromBody, {
  make: 'Meze', model: 'Alba', serialNumber: 'SN-FROM-PDF',
  issueDescription: 'Something else entirely', warrantyStatus: 'No', notes: 'PDF remarks'
});
check('body make survives an attachment', entryFromBody.make, 'Final Audio');
check('body model survives an attachment', entryFromBody.model, 'D8000 Pro');
check('body issue survives an attachment', entryFromBody.issueDescription, 'Left channel cuts out.');
check('body warranty survives an attachment', entryFromBody.warrantyStatus, 'Yes');
check('blank serial IS filled from the attachment', entryFromBody.serialNumber, 'SN-FROM-PDF');
check('blank notes ARE filled from the attachment', entryFromBody.notes, 'PDF remarks');

// With no body (an old forwarded submission), the PDF supplies everything.
const entryNoBody = {
  make: '', model: '', serialNumber: '',
  issueDescription: '', warrantyStatus: '', notes: ''
};
Ingest.fillBlankFields(entryNoBody, { make: 'Meze', model: 'Alba', warrantyStatus: 'No' });
check('PDF fills an empty entry', [entryNoBody.make, entryNoBody.model, entryNoBody.warrantyStatus],
      ['Meze', 'Alba', 'No']);
check('missing parse result is harmless',
      (Ingest.fillBlankFields(entryNoBody, null), entryNoBody.make), 'Meze');

console.log('--- attachment type classification ---');
check('pdf by content-type',   Attachments.extFor('application/pdf', null), 'pdf');
check('jpeg by content-type',  Attachments.extFor('image/jpeg', null), 'jpg');
check('png by content-type',   Attachments.extFor('image/png', null), 'png');
// Senders routinely omit the header or send a generic one; the filename has
// to carry the day or photos get stored as .pdf holding JPEG bytes.
check('generic content-type falls back to filename',
      Attachments.extFor('application/octet-stream', 'fault-photo.JPG'), 'jpg');
check('missing content-type falls back to filename',
      Attachments.extFor('', 'invoice.pdf'), 'pdf');
check('nothing recognisable defaults to pdf', Attachments.extFor('', 'scan'), 'pdf');
check('mime recovered from filename', Attachments.mimeFor('photo.png'), 'image/png');
check('mime for unknown declines to guess',
      Attachments.mimeFor('mystery.xyz'), 'application/octet-stream');
check('isPdf true for pdf', Attachments.isPdf('application/pdf', 'x.pdf'), true);
check('isPdf false for photo', Attachments.isPdf('image/jpeg', 'x.jpg'), false);
check('isPdf uses filename when header is generic',
      Attachments.isPdf('application/octet-stream', 'form.pdf'), true);
check('isPdf false for photo behind a generic header',
      Attachments.isPdf('application/octet-stream', 'fault.jpeg'), false);

console.log('--- attachment filenames (PDFs and photos) ---');
check('PDF invoice filename',
      Storage.buildFilename('1500', 'Sound Kitchen', 'D8000 Pro', '2026-08-19', 'invoice', 'application/pdf', 'inv.pdf'),
      '1500-Sound-Kitchen-D8000-Pro-INV-2026-08-19.pdf');
check('JPEG photo filename',
      Storage.buildFilename('1500', 'Sound Kitchen', 'D8000 Pro', '2026-08-19', 'photo', 'image/jpeg', 'a.jpg'),
      '1500-Sound-Kitchen-D8000-Pro-PHOTO-2026-08-19.jpg');
check('PNG photo filename',
      Storage.buildFilename('1500', 'Sound Kitchen', 'D8000 Pro', '2026-08-19', 'photo', 'image/png', 'a.png'),
      '1500-Sound-Kitchen-D8000-Pro-PHOTO-2026-08-19.png');
check('legacy rma-form PDF, no suffix',
      Storage.buildFilename('1500', 'Sound Kitchen', 'D8000 Pro', '2026-08-19', 'rma-form', 'application/pdf', 'f.pdf'),
      '1500-Sound-Kitchen-D8000-Pro-2026-08-19.pdf');
// The bug this guards: a photo with a generic Content-Type used to be named
// .pdf while holding JPEG bytes, because the filename fallback was dead code.
check('photo with generic content-type keeps its real extension',
      Storage.buildFilename('1500', 'Sound Kitchen', 'D8000 Pro', '2026-08-19', 'photo', 'application/octet-stream', 'IMG_4821.jpeg'),
      '1500-Sound-Kitchen-D8000-Pro-PHOTO-2026-08-19.jpg');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
