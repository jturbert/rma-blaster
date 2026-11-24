// ============================================================
// RMA Blaster: the Worker
//
// Serves the app's files (Cloudflare does that part by itself, see
// [assets] in wrangler.toml) and answers /api/* for the app.
//
// The API is deliberately thin. It stores and fetches rows and
// files and nothing more. All RMA parsing still happens in the
// browser (pdf-parser.js, ingest.js), exactly as before.
//
// Rows go out with the same snake_case column names Supabase
// returned, so storage.js maps them the way it always did.
//
// Bindings (wrangler.toml):
//   DB     D1 database: entries, pdfs, pending_emails
//   FILES  R2 bucket: the PDFs and photos
// ============================================================

import { requireSession } from './auth.mjs';
import { STALE_CLAIM_MINUTES } from './constants.mjs';

// Largest single file accepted. The site refuses anything over 10 MB at the
// form, so this is a ceiling against accidents, not a working limit.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// The only entry columns the app may write. Anything else in a request body
// is dropped, so a stray field can never reach the SQL.
const ENTRY_COLUMNS = [
  'email_id', 'rma_number', 'date', 'dealer', 'make', 'model', 'serial_number',
  'issue_description', 'issue_confirmed', 'purchase_date', 'warranty_status',
  'course_of_action', 'date_of_resolution', 'how_resolved', 'notes',
  'replaced_from', 'status', 'flags', 'deleted', 'deleted_at', 'imported_at', 'last_modified'
];

// The columns whose changes go in the history, in the order the Supabase
// trigger used. Timestamps and the source email id are left out, as there.
const HISTORY_COLUMNS = [
  'status', 'rma_number', 'date', 'dealer', 'make', 'model', 'serial_number',
  'issue_description', 'issue_confirmed', 'purchase_date', 'warranty_status',
  'course_of_action', 'date_of_resolution', 'how_resolved', 'notes',
  'replaced_from', 'flags', 'deleted'
];

const QUEUE_WRITABLE = ['status', 'error', 'entry_id'];
const QUEUE_STATUSES = ['pending', 'processing', 'processed', 'ignored', 'error'];
const PDF_TYPES      = ['rma-form', 'invoice', 'photo'];

// ---- small helpers ----

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const nowIso = () => new Date().toISOString();
const staleCutoff = () => new Date(Date.now() - STALE_CLAIM_MINUTES * 60000).toISOString();

function toId(text) {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id');
  return n;
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch (_) { /* fall through */ }
  throw new HttpError(400, 'Request body must be a JSON object');
}

function entryOut(row) {
  return row ? { ...row, deleted: !!row.deleted } : null;
}

function queueOut(row) {
  if (!row) return null;
  if (row.attachments === undefined) return row;
  let attachments = [];
  try { attachments = JSON.parse(row.attachments) || []; } catch (_) { /* leave empty */ }
  return { ...row, attachments };
}

// Pick the writable entry columns out of a request body, as [column, value]
// pairs ready to bind.
function entryFields(body) {
  const fields = [];
  for (const col of ENTRY_COLUMNS) {
    if (body[col] === undefined) continue;
    let value = body[col];
    if (col === 'deleted') value = value ? 1 : 0;
    else if (value === '' && col === 'deleted_at') value = null;
    else if (value !== null && typeof value !== 'string') value = String(value);
    fields.push([col, value]);
  }
  return fields;
}

// Turn SQLite's own wording for a duplicate into something a person can read.
function dbError(err) {
  const text = String(err && err.message || err);
  if (/UNIQUE constraint failed: entries\.email_id/i.test(text)) {
    return new HttpError(409, 'An entry already exists for that email');
  }
  if (/FOREIGN KEY constraint failed/i.test(text)) {
    return new HttpError(400, 'That entry does not exist');
  }
  return err;
}

// ---- change history ----
//
// Every save writes one row per field that changed: which login, when, what
// it said before and what it says now. Same rows the Supabase trigger wrote,
// so history copied across from there reads the same as history made here.
//
// The history statements go in one batch with the save itself. D1 runs a
// batch as a single transaction, so either the change and its record both
// land, or neither does. An edit can never exist without its author.
//
// Values are compared as text, the way the trigger did: an empty field is
// '', and archived reads 'true' or 'false'.

const historyText = col => col === 'deleted'
  ? `CASE WHEN e.deleted THEN 'true' ELSE 'false' END`
  : `COALESCE(e.${col}, '')`;

// Statements recording a new entry, to run straight after its INSERT in the
// same batch. Reads the stored row, so defaults count as what was written.
function creationHistory(env, session) {
  return HISTORY_COLUMNS.map(col => {
    const before = col === 'deleted' ? `'false'` : `''`;
    return env.DB.prepare(
      `INSERT INTO entry_history (entry_id, rma_number, user_id, user_email, action, field, old_value, new_value)
       SELECT e.id, e.rma_number, ?, ?,
              CASE WHEN e.email_id IS NOT NULL THEN 'imported' ELSE 'created' END,
              '${col}', ${before}, ${historyText(col)}
         FROM entries e
        WHERE e.id = (SELECT MAX(id) FROM entries) AND ${historyText(col)} <> ${before}`
    ).bind(session.sub, session.email);
  });
}

// Statements recording an edit, to run straight BEFORE its UPDATE in the
// same batch, while the row still holds the old values.
function editHistory(env, session, id, fields) {
  const given = new Map(fields);
  const newRma = given.has('rma_number') ? given.get('rma_number') : null;
  return HISTORY_COLUMNS.filter(col => given.has(col)).map(col => {
    let value = given.get(col);
    if (col === 'deleted') value = value ? 'true' : 'false';
    else value = value === null ? '' : String(value);
    return env.DB.prepare(
      `INSERT INTO entry_history (entry_id, rma_number, user_id, user_email, action, field, old_value, new_value)
       SELECT e.id, COALESCE(?, e.rma_number), ?, ?, 'edited', '${col}', ${historyText(col)}, ?
         FROM entries e
        WHERE e.id = ? AND ${historyText(col)} <> ?`
    ).bind(newRma, session.sub, session.email, value, id, value);
  });
}

async function listHistory(env, url) {
  const entry = url.searchParams.get('entry_id');
  if (entry !== null) {
    const { results } = await env.DB.prepare(
      `SELECT id, changed_at, user_email, action, field, old_value, new_value
         FROM entry_history WHERE entry_id = ? ORDER BY id DESC LIMIT 500`).bind(toId(entry)).all();
    return json(results);
  }
  // The whole table, oldest first, a page at a time (for the backup file).
  const after = Number(url.searchParams.get('after_id') || 0);
  if (!Number.isInteger(after) || after < 0) throw new HttpError(400, 'Bad after_id');
  const { results } = await env.DB.prepare(
    'SELECT * FROM entry_history WHERE id > ? ORDER BY id LIMIT 1000').bind(after).all();
  return json(results);
}

// ---- entries ----

async function listEntries(env, url) {
  const rma = url.searchParams.get('rma');
  if (rma !== null) {
    const row = await env.DB.prepare(
      'SELECT * FROM entries WHERE rma_number = ? ORDER BY id LIMIT 1').bind(rma).first();
    return json(row ? [entryOut(row)] : []);
  }
  const which = url.searchParams.get('deleted') || 'false';
  let sql = 'SELECT * FROM entries';
  if (which === 'false') sql += ' WHERE deleted = 0';
  else if (which === 'true') sql += ' WHERE deleted = 1';
  else if (which !== 'all') throw new HttpError(400, 'deleted must be true, false or all');
  const { results } = await env.DB.prepare(sql + ' ORDER BY id').all();
  return json(results.map(entryOut));
}

async function getEntry(env, id) {
  const row = await env.DB.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first();
  return json(entryOut(row));
}

async function createEntry(env, request, session) {
  const fields = entryFields(await readJson(request));
  const rma = fields.find(([col]) => col === 'rma_number');
  if (!rma || !rma[1]) throw new HttpError(400, 'An RMA number is required');
  const cols = fields.map(([col]) => col);
  try {
    const [inserted] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`
      ).bind(...fields.map(([, value]) => value)),
      ...creationHistory(env, session)
    ]);
    return json({ id: inserted.results[0].id }, 201);
  } catch (err) { throw dbError(err); }
}

async function updateEntry(env, id, request, session) {
  const fields = entryFields(await readJson(request));
  if (!fields.length) throw new HttpError(400, 'Nothing to update');
  try {
    const results = await env.DB.batch([
      ...editHistory(env, session, id, fields),
      env.DB.prepare(
        `UPDATE entries SET ${fields.map(([col]) => `${col} = ?`).join(', ')} WHERE id = ? RETURNING id`
      ).bind(...fields.map(([, value]) => value), id)
    ]);
    const updated = results[results.length - 1].results;
    if (!updated.length) throw new HttpError(404, 'Entry not found');
    return json({ id });
  } catch (err) { throw dbError(err); }
}

// ---- files ----

async function listPdfs(env, url) {
  const entry = url.searchParams.get('entry_id');
  const query = entry !== null
    ? env.DB.prepare('SELECT * FROM pdfs WHERE entry_id = ? ORDER BY saved_at, id').bind(toId(entry))
    : env.DB.prepare('SELECT * FROM pdfs ORDER BY entry_id, id');
  const { results } = await query.all();
  return json(results);
}

// Upload one file and record it against an entry. The file's bytes are the
// request body; everything else rides in the query string.
async function uploadPdf(env, url, request) {
  const entryId  = toId(url.searchParams.get('entry_id'));
  const filename = (url.searchParams.get('filename') || '').replace(/[\/\\]/g, '-').slice(0, 200);
  const type     = url.searchParams.get('type') || 'rma-form';
  if (!filename) throw new HttpError(400, 'A filename is required');
  if (!PDF_TYPES.includes(type)) throw new HttpError(400, 'Unknown file type');

  const entry = await env.DB.prepare('SELECT id FROM entries WHERE id = ?').bind(entryId).first();
  if (!entry) throw new HttpError(404, 'Entry not found');

  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new HttpError(400, 'The file is empty');
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, 'The file is too large');

  const path = `entry-${entryId}/${Date.now()}-${filename}`;
  await env.FILES.put(path, bytes, {
    httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' }
  });

  try {
    const row = await env.DB.prepare(
      'INSERT INTO pdfs (entry_id, filename, type, storage_path) VALUES (?, ?, ?, ?) RETURNING id'
    ).bind(entryId, filename, type, path).first();
    return json({ id: row.id, storage_path: path }, 201);
  } catch (err) {
    // Do not leave a file behind that no row points at.
    await env.FILES.delete(path).catch(() => {});
    throw dbError(err);
  }
}

function filePath(url) {
  const path = url.searchParams.get('path') || '';
  if (!path || path.includes('..') || path.startsWith('/')) throw new HttpError(400, 'Bad path');
  return path;
}

async function downloadFile(env, url) {
  const object = await env.FILES.get(filePath(url));
  if (!object) throw new HttpError(404, 'File not found');
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      // The app turns these bytes into a download itself. These two headers
      // stop a browser from ever rendering a stored file as a page on this
      // site, whatever a dealer managed to send.
      'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store'
    }
  });
}

// Only the holding area for unprocessed email attachments can be deleted
// from. Files belonging to entries are never removed: the app archives,
// it does not delete.
async function deleteFile(env, url) {
  const path = filePath(url);
  if (!path.startsWith('pending/')) {
    throw new HttpError(403, 'Only files waiting in the email queue can be removed');
  }
  await env.FILES.delete(path);
  return json({ ok: true });
}

// ---- inbound email queue ----

const WAITING = `(status = 'pending' OR (status = 'processing' AND processed_at < ?))`;

async function listQueue(env, url) {
  const entry = url.searchParams.get('entry_id');
  if (entry !== null) {
    const row = await env.DB.prepare(
      `SELECT subject, from_address, sent_at, received_at, text_body
         FROM pending_emails WHERE entry_id = ? ORDER BY id LIMIT 1`).bind(toId(entry)).first();
    return json(row || null);
  }

  const view = url.searchParams.get('view') || 'waiting';
  if (view === 'waiting') {
    const { results } = await env.DB.prepare(
      `SELECT * FROM pending_emails WHERE ${WAITING} ORDER BY id`).bind(staleCutoff()).all();
    return json(results.map(queueOut));
  }
  if (view === 'recent') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 25, 1), 200);
    const { results } = await env.DB.prepare(
      `SELECT id, subject, from_address, status, error, received_at, processed_at, entry_id
         FROM pending_emails ORDER BY id DESC LIMIT ?`).bind(limit).all();
    return json(results);
  }
  throw new HttpError(400, 'view must be waiting or recent');
}

// Take exclusive ownership of one queue row. The condition is part of the
// UPDATE itself, so when two people open the app at the same moment the
// database lets exactly one of them through and the other gets nothing back.
async function claimQueueRow(env, id) {
  const { results } = await env.DB.prepare(
    `UPDATE pending_emails SET status = 'processing', processed_at = ?
      WHERE id = ? AND ${WAITING} RETURNING id`
  ).bind(nowIso(), id, staleCutoff()).all();
  return json({ claimed: results.length > 0 });
}

async function updateQueueRow(env, id, request) {
  const body = await readJson(request);
  const sets = [], values = [];
  for (const col of QUEUE_WRITABLE) {
    if (body[col] === undefined) continue;
    if (col === 'status' && !QUEUE_STATUSES.includes(body[col])) {
      throw new HttpError(400, 'Unknown status');
    }
    sets.push(`${col} = ?`);
    values.push(body[col] === '' && col !== 'status' ? null : body[col]);
  }
  sets.push('processed_at = ?');
  values.push(nowIso());
  try {
    const row = await env.DB.prepare(
      `UPDATE pending_emails SET ${sets.join(', ')} WHERE id = ? RETURNING id`
    ).bind(...values, id).first();
    if (!row) throw new HttpError(404, 'Queue row not found');
    return json({ ok: true });
  } catch (err) { throw dbError(err); }
}

// ---- routing ----

async function route(request, env, url, session) {
  const method = request.method;
  const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const [resource, idText, action] = parts;

  if (resource === 'me' && method === 'GET' && parts.length === 1) {
    return json({ email: session.email });
  }

  if (resource === 'entries') {
    if (parts.length === 1 && method === 'GET')  return listEntries(env, url);
    if (parts.length === 1 && method === 'POST') return createEntry(env, request, session);
    if (parts.length === 2 && method === 'GET')  return getEntry(env, toId(idText));
    if (parts.length === 2 && method === 'PUT')  return updateEntry(env, toId(idText), request, session);
  }

  // Read only. There is deliberately no route that writes, edits or
  // deletes history: only createEntry and updateEntry add to it.
  if (resource === 'history' && parts.length === 1 && method === 'GET') {
    return listHistory(env, url);
  }

  if (resource === 'pdfs' && parts.length === 1) {
    if (method === 'GET')  return listPdfs(env, url);
    if (method === 'POST') return uploadPdf(env, url, request);
  }

  if (resource === 'files' && parts.length === 1) {
    if (method === 'GET')    return downloadFile(env, url);
    if (method === 'DELETE') return deleteFile(env, url);
  }

  if (resource === 'queue') {
    if (parts.length === 1 && method === 'GET')   return listQueue(env, url);
    if (parts.length === 2 && method === 'PATCH') return updateQueueRow(env, toId(idText), request);
    if (parts.length === 3 && action === 'claim' && method === 'POST') {
      return claimQueueRow(env, toId(idText));
    }
  }

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The app's own files never reach here: Cloudflare serves those first.
    // Anything else that is not the API does not exist.
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }

    try {
      const session = await requireSession(request, env);
      if (!session) return json({ error: 'Not signed in' }, 401);

      // Anything that changes data must carry a header only this app's own
      // pages can send. A form or link on some other website cannot add it,
      // so it cannot use a signed-in person's browser to make changes.
      if (request.method !== 'GET' && request.headers.get('X-Requested-With') !== 'rma-blaster') {
        return json({ error: 'Request did not come from the app' }, 403);
      }

      return await route(request, env, url, session);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('API error:', request.method, url.pathname, String(err && err.stack || err));
      return json({ error: 'Something went wrong on the server' }, 500);
    }
  }
};
