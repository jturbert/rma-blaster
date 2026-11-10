// ============================================================
// Tests for the Worker's API (worker/index.mjs).
//
// Runs the real handlers against an in-memory SQLite database
// built from the real migration file, and a fake file bucket.
// No Cloudflare account, no network.
//
// Run:  node tests/worker.test.mjs      (needs Node 22.13 or newer)
// ============================================================

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, createSign } from 'node:crypto';
import worker from '../worker/index.mjs';
import { STALE_CLAIM_MINUTES } from '../worker/constants.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + label +
    (ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`));
}

// ---- stand-ins for the Cloudflare bindings ----

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const prepare = (sql, args = []) => ({
    bind: (...next) => prepare(sql, next),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all:   async () => ({ results: db.prepare(sql).all(...args) }),
    run:   async () => { db.prepare(sql).run(...args); return { success: true }; }
  });
  return { prepare, raw: db };
}

function fakeR2() {
  const store = new Map();
  return {
    store,
    put: async (key, bytes, opts) => { store.set(key, { bytes, httpMetadata: opts?.httpMetadata }); },
    get: async key => {
      const hit = store.get(key);
      return hit ? { body: hit.bytes, httpMetadata: hit.httpMetadata } : null;
    },
    delete: async key => { store.delete(key); }
  };
}

const TEAM = 'team.example.com';
const AUD  = 'test-audience';

function makeEnv(extra = {}) {
  return { DB: fakeD1(), FILES: fakeR2(), DEV_USER: 'dev@localhost', ...extra };
}

// A request the way the app sends one. host defaults to localhost, where
// DEV_USER counts as a login.
async function call(env, method, path, { json, body, headers = {}, host = 'localhost', bare = false } = {}) {
  const h = { ...headers };
  if (method !== 'GET' && !bare) h['X-Requested-With'] = 'rma-blaster';
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await worker.fetch(new Request(`https://${host}${path}`, { method, headers: h, body }), env);
  const type = res.headers.get('Content-Type') || '';
  const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}

// ---- who gets in ----

console.log('\nLogin');
{
  const env = makeEnv();
  check('dev user is accepted on localhost', (await call(env, 'GET', '/api/me')).data, { email: 'dev@localhost' });
  check('dev user is ignored on a real hostname',
        (await call(env, 'GET', '/api/me', { host: 'rma.duneblue.com' })).status, 401);

  const prod = makeEnv({ DEV_USER: undefined, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
  check('no token is refused', (await call(prod, 'GET', '/api/entries', { host: 'rma.duneblue.com' })).status, 401);
  check('a junk token is refused',
        (await call(prod, 'GET', '/api/me', { host: 'rma.duneblue.com',
          headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } })).status, 401);

  const unset = makeEnv({ DEV_USER: undefined, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: '' });
  check('Access not configured refuses everyone',
        (await call(unset, 'GET', '/api/me', { host: 'rma.duneblue.com',
          headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } })).status, 401);

  // Real signed tokens, checked against a key set served by a stubbed fetch.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));

  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sign = (claims, key = privateKey) => {
    const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}`;
    return `${head}.${createSign('RSA-SHA256').update(head).sign(key).toString('base64url')}`;
  };
  const soon = Math.floor(Date.now() / 1000) + 600;
  const good = { iss: `https://${TEAM}`, aud: [AUD], exp: soon, email: 'jim@example.com' };
  const tryToken = async token => (await call(prod, 'GET', '/api/me',
    { host: 'rma.duneblue.com', headers: { 'Cf-Access-Jwt-Assertion': token } }));

  check('a valid Access token is accepted', (await tryToken(sign(good))).data, { email: 'jim@example.com' });
  check('the Access cookie works too',
        (await call(prod, 'GET', '/api/me', { host: 'rma.duneblue.com',
          headers: { Cookie: `other=1; CF_Authorization=${sign(good)}` } })).status, 200);
  check('expired token is refused', (await tryToken(sign({ ...good, exp: soon - 1200 }))).status, 401);
  check('token with no expiry is refused', (await tryToken(sign({ ...good, exp: undefined }))).status, 401);
  check('token for another app is refused', (await tryToken(sign({ ...good, aud: ['other'] }))).status, 401);
  check('token from another team is refused', (await tryToken(sign({ ...good, iss: 'https://evil.example' }))).status, 401);
  check('token signed by someone else is refused', (await tryToken(sign(good, other.privateKey))).status, 401);
  check('token without an email is refused', (await tryToken(sign({ ...good, email: undefined }))).status, 401);
  globalThis.fetch = realFetch;

  check('a change without the app header is refused',
        (await call(env, 'POST', '/api/entries', { json: { rma_number: '1' }, bare: true })).status, 403);
  check('nothing outside /api is served by the Worker', (await call(env, 'GET', '/wrangler.toml')).status, 404);
}

// ---- entries ----

console.log('\nEntries');
{
  const env = makeEnv();
  const made = await call(env, 'POST', '/api/entries',
    { json: { rma_number: '1500', dealer: 'Sound Kitchen', email_id: '<a@x>', deleted: false, bogus: 'x' } });
  check('create returns an id', [made.status, made.data.id], [201, 1]);

  const got = (await call(env, 'GET', '/api/entries/1')).data;
  check('reads back what was saved', [got.rma_number, got.dealer, got.status, got.deleted],
        ['1500', 'Sound Kitchen', 'Open', false]);
  check('unknown fields are dropped', 'bogus' in got, false);
  check('missing entry reads as null', (await call(env, 'GET', '/api/entries/99')).data, null);

  check('RMA number is required', (await call(env, 'POST', '/api/entries', { json: { dealer: 'x' } })).status, 400);
  check('same source email twice is refused',
        (await call(env, 'POST', '/api/entries', { json: { rma_number: '1501', email_id: '<a@x>' } })).status, 409);
  check('two entries with no source email are fine',
        [(await call(env, 'POST', '/api/entries', { json: { rma_number: '1502' } })).status,
         (await call(env, 'POST', '/api/entries', { json: { rma_number: '1503' } })).status], [201, 201]);

  check('lookup by RMA number', (await call(env, 'GET', '/api/entries?rma=1502')).data.map(r => r.id), [2]);
  check('lookup of an unknown RMA number', (await call(env, 'GET', '/api/entries?rma=nope')).data, []);

  await call(env, 'PUT', '/api/entries/2', { json: { deleted: true, deleted_at: new Date().toISOString() } });
  check('archived entries leave the main list', (await call(env, 'GET', '/api/entries')).data.map(r => r.id), [1, 3]);
  check('and show in the archive', (await call(env, 'GET', '/api/entries?deleted=true')).data.map(r => r.id), [2]);
  check('backup sees everything', (await call(env, 'GET', '/api/entries?deleted=all')).data.length, 3);

  await call(env, 'PUT', '/api/entries/2', { json: { deleted: false, deleted_at: '' } });
  const restored = (await call(env, 'GET', '/api/entries/2')).data;
  check('restoring clears the archive date', [restored.deleted, restored.deleted_at], [false, null]);
  check('updating a missing entry is a 404', (await call(env, 'PUT', '/api/entries/99', { json: { notes: 'x' } })).status, 404);
  check('a hostile id is rejected', (await call(env, 'GET', '/api/entries/1;drop')).status, 400);
  check('there is no way to delete an entry', (await call(env, 'DELETE', '/api/entries/1')).status, 404);
}

// ---- files ----

console.log('\nFiles');
{
  const env = makeEnv();
  await call(env, 'POST', '/api/entries', { json: { rma_number: '1500' } });
  const bytes = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);
  const up = await call(env, 'POST', '/api/pdfs?entry_id=1&filename=1500-form.pdf&type=rma-form',
    { body: bytes, headers: { 'Content-Type': 'application/pdf' } });
  check('upload is recorded', [up.status, up.data.id], [201, 1]);

  const list = (await call(env, 'GET', '/api/pdfs?entry_id=1')).data;
  check('listed against its entry', [list.length, list[0].filename, list[0].type], [1, '1500-form.pdf', 'rma-form']);
  check('listed in the full list', (await call(env, 'GET', '/api/pdfs')).data.length, 1);

  const down = await call(env, 'GET', '/api/files?path=' + encodeURIComponent(list[0].storage_path));
  check('download returns the same bytes', [...down.data], [...bytes]);
  check('download keeps its type', down.headers.get('Content-Type'), 'application/pdf');
  check('download is never rendered as a page',
        [down.headers.get('Content-Disposition'), down.headers.get('X-Content-Type-Options')], ['attachment', 'nosniff']);

  check('upload to a missing entry is refused',
        (await call(env, 'POST', '/api/pdfs?entry_id=9&filename=a.pdf', { body: bytes })).status, 404);
  check('empty upload is refused',
        (await call(env, 'POST', '/api/pdfs?entry_id=1&filename=a.pdf', { body: new Uint8Array() })).status, 400);
  check('unknown file kind is refused',
        (await call(env, 'POST', '/api/pdfs?entry_id=1&filename=a.pdf&type=virus', { body: bytes })).status, 400);
  check('missing file is a 404', (await call(env, 'GET', '/api/files?path=nope/x.pdf')).status, 404);
  check('path tricks are refused', (await call(env, 'GET', '/api/files?path=../x')).status, 400);

  check('an entry\'s file cannot be deleted',
        (await call(env, 'DELETE', '/api/files?path=' + encodeURIComponent(list[0].storage_path))).status, 403);
  check('and is still there', env.FILES.store.has(list[0].storage_path), true);

  await env.FILES.put('pending/abc/photo.jpg', bytes, {});
  check('a queued attachment can be deleted', (await call(env, 'DELETE', '/api/files?path=pending/abc/photo.jpg')).status, 200);
  check('and is gone', env.FILES.store.has('pending/abc/photo.jpg'), false);
}

// ---- inbound email queue ----

console.log('\nEmail queue');
{
  const env = makeEnv();
  const minsAgo = m => new Date(Date.now() - m * 60000).toISOString();
  const add = (id, status, processedAt = null) => env.DB.raw.prepare(
    `INSERT INTO pending_emails (id, message_id, subject, text_body, attachments, status, processed_at)
     VALUES (?, ?, ?, 'body', ?, ?, ?)`
  ).run(id, `<m${id}>`, `RMA #${id}`, JSON.stringify([{ filename: 'f.pdf', storagePath: `pending/${id}/f.pdf` }]),
        status, processedAt);

  add(1, 'pending');
  add(2, 'processing', minsAgo(1));                         // someone is working on it
  add(3, 'processing', minsAgo(STALE_CLAIM_MINUTES + 1));   // abandoned
  add(4, 'processed', minsAgo(60));
  add(5, 'error', minsAgo(60));

  const waiting = (await call(env, 'GET', '/api/queue?view=waiting')).data;
  check('waiting = pending plus abandoned claims', waiting.map(r => r.id), [1, 3]);
  check('attachments come back as a list', waiting[0].attachments[0].filename, 'f.pdf');

  const [first, second] = await Promise.all([
    call(env, 'POST', '/api/queue/1/claim'), call(env, 'POST', '/api/queue/1/claim')]);
  check('two claims at once: exactly one wins', [first.data.claimed, second.data.claimed].sort(), [false, true]);
  check('a row being worked on cannot be claimed', (await call(env, 'POST', '/api/queue/2/claim')).data.claimed, false);
  check('an abandoned row can be claimed', (await call(env, 'POST', '/api/queue/3/claim')).data.claimed, true);
  check('a finished row cannot be claimed', (await call(env, 'POST', '/api/queue/4/claim')).data.claimed, false);
  check('a failed row is not retried by itself', (await call(env, 'POST', '/api/queue/5/claim')).data.claimed, false);
  check('nothing is waiting after the claims', (await call(env, 'GET', '/api/queue?view=waiting')).data, []);

  await call(env, 'POST', '/api/entries', { json: { rma_number: '1' } });
  check('marking a row processed',
        (await call(env, 'PATCH', '/api/queue/1', { json: { status: 'processed', entry_id: 1, error: null } })).status, 200);
  const row = env.DB.raw.prepare('SELECT status, entry_id, error, processed_at FROM pending_emails WHERE id = 1').get();
  check('is stored', [row.status, row.entry_id, row.error, !!row.processed_at], ['processed', 1, null, true]);
  check('a made-up status is refused', (await call(env, 'PATCH', '/api/queue/1', { json: { status: 'banana' } })).status, 400);
  check('linking to a missing entry is refused', (await call(env, 'PATCH', '/api/queue/3', { json: { entry_id: 77 } })).status, 400);
  check('updating a missing row is a 404', (await call(env, 'PATCH', '/api/queue/99', { json: { status: 'error' } })).status, 404);

  const recent = (await call(env, 'GET', '/api/queue?view=recent&limit=2')).data;
  check('recent is newest first and limited', recent.map(r => r.id), [5, 4]);
  check('recent leaves the body out', 'text_body' in recent[0], false);

  const original = (await call(env, 'GET', '/api/queue?entry_id=1')).data;
  check('original email for an entry', [original.subject, original.text_body], ['RMA #1', 'body']);
  check('no original email reads as null', (await call(env, 'GET', '/api/queue?entry_id=42')).data, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
