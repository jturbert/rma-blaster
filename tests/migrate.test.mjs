// ============================================================
// Tests for the SQL that tools/migrate-from-supabase.mjs writes.
// Builds it from made-up Supabase rows, loads it into a database
// made from the real migration file, and reads the result back.
//
// Run:  node tests/migrate.test.mjs
// ============================================================

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildSql, filePaths, contentTypeFor } from '../tools/migrate-from-supabase.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + label +
    (ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
}

const data = {
  entries: [
    { id: 7, email_id: '<a@x>', rma_number: '1500', date: '2026-08-19', dealer: "O'Brien's Hi-Fi; DROP TABLE entries;--",
      make: 'Final', model: 'D8000 Pro', notes: 'line one\nline two é ü 日本', status: 'Open',
      deleted: false, deleted_at: null, imported_at: '2026-08-20T10:00:00.123456+00:00',
      last_modified: '2026-08-21T09:30:00+02:00' },
    { id: 9, email_id: null, rma_number: '1501', status: 'Closed', deleted: true,
      deleted_at: '2026-09-01T00:00:00+00:00', imported_at: null, last_modified: null }
  ],
  pdfs: [
    { id: 3, entry_id: 7, filename: 'a.pdf', type: 'rma-form', storage_path: 'entry-7/1-a.pdf', saved_at: '2026-08-20T10:00:01+00:00' }
  ],
  pending_emails: [
    { id: 4, message_id: '<m@x>', subject: 'RMA #1500', from_address: 'd@x', sent_at: 'Tue, 21 Jul 2026 at 10:15',
      text_body: 'é'.repeat(80000), attachments: [{ filename: 'p.jpg', storagePath: 'pending/abc/p.jpg' },
                                                  { filename: 'old.pdf', storagePath: 'entry-7/1-a.pdf' }],
      status: 'processed', error: null, entry_id: 7, received_at: '2026-08-20T09:59:00+00:00', processed_at: '2026-08-20T10:00:02+00:00' },
    { id: 5, message_id: '<n@x>', subject: 'hello', attachments: null, status: 'ignored', entry_id: null }
  ]
};

const sql = buildSql(data);
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
db.exec("INSERT INTO entries (rma_number) VALUES ('left over from before')");
db.exec(sql);

const entries = db.prepare('SELECT * FROM entries ORDER BY id').all();
check('old rows are replaced, ids are kept', entries.map(e => e.id), [7, 9]);
check('quotes and SQL in a name are stored as text', entries[0].dealer, "O'Brien's Hi-Fi; DROP TABLE entries;--");
check('newlines and accents survive', entries[0].notes, 'line one\nline two é ü 日本');
check('true/false become 1/0', entries.map(e => e.deleted), [0, 1]);
check('dates are rewritten in one format',
      [entries[0].imported_at, entries[0].last_modified], ['2026-08-20T10:00:00.123Z', '2026-08-21T07:30:00.000Z']);
check('empty dates stay empty', [entries[1].imported_at, entries[0].deleted_at], [null, null]);
check('the form date is left alone', entries[0].date, '2026-08-19');

check('file records keep their entry', db.prepare('SELECT entry_id, storage_path FROM pdfs').all(),
      [{ entry_id: 7, storage_path: 'entry-7/1-a.pdf' }]);

const mails = db.prepare('SELECT * FROM pending_emails ORDER BY id').all();
check('the raw email date is left alone', mails[0].sent_at, 'Tue, 21 Jul 2026 at 10:15');
check('attachments are stored as JSON', JSON.parse(mails[0].attachments).length, 2);
check('missing attachments become an empty list', mails[1].attachments, '[]');
check('a huge body is cut, on a whole character', [Buffer.byteLength(mails[0].text_body) <= 60000, /^é+$/.test(mails[0].text_body)], [true, true]);
check('no statement is near the 100 KB limit', Math.max(...sql.split('\n').map(l => Buffer.byteLength(l))) < 90000, true);
check('queue row keeps its link to the entry', mails[0].entry_id, 7);

const next = db.prepare("INSERT INTO entries (rma_number) VALUES ('new') RETURNING id").get();
check('new entries continue after the highest old id', next.id > 9, true);

db.exec(sql);
check('loading twice gives the same result', db.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 2);

check('files to copy: entry files and queued attachments, once each',
      filePaths(data), ['entry-7/1-a.pdf', 'pending/abc/p.jpg']);
check('content types', ['a.PDF', 'b.jpeg', 'c.png', 'd.heic'].map(contentTypeFor),
      ['application/pdf', 'image/jpeg', 'image/png', 'application/octet-stream']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
