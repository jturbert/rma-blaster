// ============================================================
// RMA Blaster — Storage Layer (Cloudflare)
//   • Entries in the D1 database, files in the R2 bucket
//   • Both reached through this app's own /api, served by the
//     Worker in worker/index.mjs. The browser never talks to the
//     database directly.
//   • Login is Cloudflare Access, which runs before this page
//     even loads. There is no sign-in code here.
//   • Per-device preferences (Excel filename etc.) in localStorage
//
// The public interface matches the Supabase version it replaced
// (and v1's IndexedDB layer before that), so the rest of the app
// carried over unchanged.
// ============================================================

const Storage = (() => {
  const SETTINGS_KEY = 'rmaBlasterSettings';
  const RELOAD_KEY   = 'rmaBlasterAuthReload';

  // The Access login has lapsed. Reloading the page sends the browser
  // through Access again, which signs the person back in (usually without
  // asking) and returns them here. The timestamp stops a reload loop if
  // something else is wrong.
  function _sessionLapsed() {
    let last = 0;
    try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0; } catch (_) {}
    if (Date.now() - last > 30000) {
      try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch (_) {}
      location.reload();
    }
    return new Error('Your login has expired. Reload the page to sign in again.');
  }

  // One request to the API. `action` names what was being attempted, for the
  // error message. Returns parsed JSON, or the raw bytes when opts.bytes is set.
  async function api(action, method, path, opts = {}) {
    const headers = {};
    let body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = opts.contentType || 'application/octet-stream';
      body = opts.body;
    }
    // The Worker refuses any change that lacks this header. See index.mjs.
    if (method !== 'GET') headers['X-Requested-With'] = 'rma-blaster';

    let res;
    try {
      // redirect: 'manual' matters. When the Access login lapses, Access
      // answers with a redirect to its own login page before the Worker
      // runs. Following it would fail in a confusing way; this lets us
      // see it for what it is.
      res = await fetch('/api/' + path, { method, headers, body,
                                          credentials: 'same-origin', redirect: 'manual' });
    } catch (err) {
      throw new Error(`${action} failed: could not reach the server (${err.message})`);
    }
    if (res.type === 'opaqueredirect' || res.status === 0 || res.status === 401) {
      throw _sessionLapsed();
    }
    if (!res.ok) {
      let message = `server answered ${res.status}`;
      try { message = (await res.json()).error || message; } catch (_) {}
      throw new Error(`${action} failed: ${message}`);
    }
    return opts.bytes ? res.arrayBuffer() : res.json();
  }

  const q = params => new URLSearchParams(params).toString();

  // Who Access says is signed in: { email }.
  function whoAmI() {
    return api('Signing in', 'GET', 'me');
  }

  // ---- camelCase (app) ↔ snake_case (database) mapping ----
  const FIELD_MAP = {
    emailId: 'email_id',           rmaNumber: 'rma_number',
    date: 'date',                  dealer: 'dealer',
    make: 'make',                  model: 'model',
    serialNumber: 'serial_number', issueDescription: 'issue_description',
    issueConfirmed: 'issue_confirmed', warrantyStatus: 'warranty_status',
    courseOfAction: 'course_of_action', dateOfResolution: 'date_of_resolution',
    howResolved: 'how_resolved',   notes: 'notes',
    replacedFrom: 'replaced_from', status: 'status',
    flags: 'flags',
    deleted: 'deleted',            deletedAt: 'deleted_at',
    importedAt: 'imported_at',     lastModified: 'last_modified'
  };

  function toRow(entry) {
    const row = {};
    for (const [camel, snake] of Object.entries(FIELD_MAP)) {
      if (entry[camel] !== undefined) row[snake] = entry[camel];
    }
    // The database wants null, not '' for timestamps
    if (row.deleted_at === '') row.deleted_at = null;
    return row;
  }

  // The Supabase version had to discover whether its flags column existed
  // yet. Here it always does (migrations/0002_history_flags.sql), so both
  // answers are fixed. Kept so app.js needs no Cloudflare-only branch.
  const flagsAvailable = () => true;
  const detectFlagsColumn = async () => true;

  function toEntry(row) {
    if (!row) return null;
    const entry = { id: row.id };
    for (const [camel, snake] of Object.entries(FIELD_MAP)) {
      entry[camel] = row[snake] ?? (camel === 'deleted' ? false : '');
    }
    return entry;
  }

  // ---- RMA Entries ----

  // Insert (no id) or update (id present). Returns the entry id.
  async function saveEntry(entry) {
    const row = toRow(entry);
    row.last_modified = new Date().toISOString();
    if (entry.id) {
      await api('Saving entry', 'PUT', `entries/${entry.id}`, { json: row });
      return entry.id;
    }
    return (await api('Creating entry', 'POST', 'entries', { json: row })).id;
  }

  async function getEntry(id) {
    return toEntry(await api('Loading entry', 'GET', `entries/${id}`));
  }

  async function getAllEntries() {
    return (await api('Loading entries', 'GET', 'entries?deleted=false')).map(toEntry);
  }

  async function getDeletedEntries() {
    return (await api('Loading archived entries', 'GET', 'entries?deleted=true')).map(toEntry);
  }

  async function entryByRmaNumber(rma) {
    const rows = await api('Looking up entry', 'GET', 'entries?' + q({ rma: String(rma) }));
    return rows.length ? toEntry(rows[0]) : null;
  }

  // ---- Change history ----
  // Who changed which field, and when. The Worker writes these rows itself
  // on every save, using the login Cloudflare Access vouched for, so the
  // browser cannot claim to be somebody else and cannot skip the log. The
  // API has no way to write, edit or delete them; this is read-only.
  // Newest first, at most 500.
  function getEntryHistory(entryId) {
    return api('Loading history', 'GET', 'history?' + q({ entry_id: entryId }));
  }

  // The whole history table, oldest first, for the backup file. Fetched in
  // pages so a large history cannot make one oversized request. Any failure
  // throws, on purpose: a backup that silently leaves out the record you
  // are relying on is worse than one that refuses to finish.
  async function getAllHistory() {
    const all = [];
    let after = 0;
    for (;;) {
      const page = await api('Backup (history)', 'GET', 'history?' + q({ after_id: after }));
      all.push(...page);
      if (page.length < 1000) return all;
      after = page[page.length - 1].id;
    }
  }

  // ---- Per-device settings (localStorage) ----
  // Kept async to preserve the v1 call sites.
  function _readSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch (_) { return {}; }
  }
  async function getSetting(key) {
    const v = _readSettings()[key];
    return v === undefined ? null : v;
  }
  async function setSetting(key, value) {
    const s = _readSettings();
    s[key] = value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  // ---- PDF Storage ----

  async function savePDF(entryId, filename, arrayBuffer, pdfType, contentType) {
    // buildFilename already resolved the extension, so the stored filename is
    // the reliable fallback when the caller has no Content-Type to pass.
    const type = contentType || Attachments.mimeFor(filename);
    const saved = await api('Uploading PDF', 'POST',
      'pdfs?' + q({ entry_id: entryId, filename, type: pdfType }),
      { body: arrayBuffer, contentType: type });
    return saved.id;
  }

  function _pdfFromRow(r) {
    return { id: r.id, entryId: r.entry_id, filename: r.filename,
             type: r.type, storagePath: r.storage_path, savedAt: r.saved_at };
  }

  async function getPDFsForEntry(entryId) {
    return (await api('Loading PDF list', 'GET', 'pdfs?' + q({ entry_id: entryId }))).map(_pdfFromRow);
  }

  async function getAllPDFs() {
    return (await api('Loading PDF list', 'GET', 'pdfs')).map(_pdfFromRow);
  }

  // Fetch the actual file bytes for a PDF record.
  function getPDFData(pdfRecord) {
    return api('Downloading PDF', 'GET', 'files?' + q({ path: pdfRecord.storagePath }), { bytes: true });
  }

  async function downloadPDF(pdfRecord) {
    const buffer = await getPDFData(pdfRecord);
    // Not every stored attachment is a PDF any more — hand the browser the
    // type the filename actually says, or it may try to open a photo as one.
    const blob = new Blob([buffer], { type: Attachments.mimeFor(pdfRecord.filename) });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = pdfRecord.filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---- Inbound email queue (phase 2) ----
  // Rows are written by the Worker when an RMA arrives and consumed
  // here by ingest.js, which does all the parsing.

  // A row claimed by a device that then crashed or was closed would sit in
  // 'processing' forever, so anything stuck there this long is fair game again.
  // The Worker enforces this; worker/index.mjs holds the same number under
  // the same name. Keep them equal.
  const STALE_CLAIM_MINUTES = 10;

  // Has a 'processing' claim been abandoned? Same rule the Worker uses,
  // exposed so the Email Queue can say "stuck" instead of "importing".
  function isClaimStale(processedAt) {
    if (!processedAt) return false;
    const t = new Date(processedAt).getTime();
    if (isNaN(t)) return false;
    return Date.now() - t > STALE_CLAIM_MINUTES * 60000;
  }

  // Queue rows waiting to be turned into entries: everything still pending,
  // plus anything abandoned mid-processing.
  function getPendingEmails() {
    return api('Loading inbound email queue', 'GET', 'queue?view=waiting');
  }

  // Take exclusive ownership of one queue row. Returns false when another
  // device got there first — that's how two people signing in at the same
  // moment avoid both importing the same email. The database settles the
  // race inside the Worker: exactly one caller gets true.
  async function claimPendingEmail(id) {
    return (await api('Claiming inbound email', 'POST', `queue/${id}/claim`)).claimed === true;
  }

  // Recent inbound emails in every state — powers the Email Queue panel,
  // which is how you find out why an email did or didn't become an entry.
  //
  // processed_at is needed to tell a claim that is genuinely being worked on
  // from one that was abandoned: both sit at status 'processing', and only
  // the timestamp separates them.
  function getRecentEmails(limit = 25) {
    return api('Loading email queue', 'GET', 'queue?' + q({ view: 'recent', limit }));
  }

  // The email an entry was created from, if it came in that way. Entries
  // migrated from v1 or typed in by hand have none, so this returns null.
  function getOriginalEmail(entryId) {
    return api('Loading original email', 'GET', 'queue?' + q({ entry_id: entryId }));
  }

  // The Worker stamps processed_at on every update.
  async function updatePending(id, fields) {
    await api('Updating inbound email', 'PATCH', `queue/${id}`, { json: fields });
  }

  // Download any stored file by its storage path
  function downloadPath(storagePath) {
    return api('Downloading attachment', 'GET', 'files?' + q({ path: storagePath }), { bytes: true });
  }

  // Only files still waiting in the email queue can be removed; the Worker
  // refuses anything else.
  async function removePath(storagePath) {
    try {
      await api('Removing attachment', 'DELETE', 'files?' + q({ path: storagePath }));
    } catch (err) {
      console.warn('[Storage] Could not remove object:', storagePath, err.message);
    }
  }

  // Build a safe filename: {rmaNumber}-{dealer}-{model}[-INV|-PHOTO]-{YYYY-MM-DD}.{ext}
  //   kind         — 'invoice' | 'rma-form' | 'photo'
  //   contentType  — the sender's Content-Type, when they sent a usable one
  //   sourceName   — the sender's own filename; the fallback when the
  //                  Content-Type is missing or generic, which is common
  //                  enough that leaving it out mislabels real photos
  function buildFilename(rmaNumber, dealer, model, dateStr, kind, contentType, sourceName) {
    const safe = s => (s||'unknown').replace(/[/\\?%*:|"<>]/g,'-').replace(/\s+/g,'-').replace(/-{2,}/g,'-').trim().substring(0,40);
    let date = 'unknown-date';
    try { date = new Date(dateStr).toISOString().split('T')[0]; } catch(_) {}
    const suffix = kind === 'invoice' ? '-INV' : kind === 'photo' ? '-PHOTO' : '';
    const ext = Attachments.extFor(contentType, sourceName);
    return `${safe(rmaNumber)}-${safe(dealer)}-${safe(model)}${suffix}-${date}.${ext}`;
  }

  // ---- Backup & Restore ----
  // Same JSON format as v1, so a backup exported from the old app
  // imports here directly (entries + base64-encoded PDFs).

  function _ab2b64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary  = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function _b642ab(base64) {
    const binary = atob(base64);
    const buf    = new ArrayBuffer(binary.length);
    const bytes  = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return buf;
  }

  async function exportBackup(onProgress) {
    const entryRows = await api('Backup (entries)', 'GET', 'entries?deleted=all');
    const pdfRecords = await getAllPDFs();

    const pdfs = [];
    for (let i = 0; i < pdfRecords.length; i++) {
      const p = pdfRecords[i];
      if (onProgress) onProgress(`Downloading PDF ${i + 1}/${pdfRecords.length}…`);
      try {
        const buffer = await getPDFData(p);
        pdfs.push({ entryId: p.entryId, filename: p.filename, type: p.type,
                    savedAt: p.savedAt, data: _ab2b64(buffer) });
      } catch (err) {
        console.warn('[Backup] Skipping PDF:', p.filename, err.message);
      }
    }

    // A copy of the change history, as it stood. It rides along as a record
    // only: importBackup ignores it, because nothing but the database trigger
    // is allowed to write to that table. entry_id matches the "id" of the
    // entries in this same file, and each row carries its RMA number too.
    if (onProgress) onProgress('Copying change history…');
    const history = await getAllHistory();

    const backup = {
      version:    1,
      exportedAt: new Date().toISOString(),
      entries:    entryRows.map(toEntry),
      settings:   [],
      pdfs,
      history:    history || []
    };

    const blob     = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const url      = URL.createObjectURL(blob);
    const date     = new Date().toISOString().split('T')[0];
    return { url, filename: `RMA-Backup-${date}.json`,
             entryCount: entryRows.length, pdfCount: pdfs.length,
             historyCount: history ? history.length : null };
  }

  // Import a v1 (or v2) backup file. Entries already in the database are
  // skipped, so running an import twice doesn't create duplicates. Dedup
  // matches by emailId (unique per source email); RMA number is only used
  // for entries without one — RMA numbers can legitimately repeat (a
  // re-submitted case), so they must not veto an import on their own.
  // One bad entry or PDF is recorded and skipped, never aborting the rest.
  async function importBackup(jsonText, onProgress) {
    let backup;
    try { backup = JSON.parse(jsonText); }
    catch (_) { throw new Error('Invalid backup file — could not parse JSON.'); }

    if (!backup.version || !Array.isArray(backup.entries)) {
      throw new Error('Invalid backup file — missing required fields.');
    }

    // Prefetch existing rows once for dedup (instead of 2 lookups per entry)
    const existingRows = await api('Import (reading existing entries)', 'GET', 'entries?deleted=all');
    const byEmail = new Map(existingRows.filter(r => r.email_id).map(r => [r.email_id, r.id]));
    const byRma   = new Map(existingRows.map(r => [String(r.rma_number), r.id]));

    const idMap  = new Map();   // old entry id → new database id
    const failed = [];
    let entryCount = 0, skipped = 0;

    for (let i = 0; i < backup.entries.length; i++) {
      const entry = backup.entries[i];
      if (onProgress) onProgress(`Importing entry ${i + 1}/${backup.entries.length}…`);

      const existingId = entry.emailId
        ? byEmail.get(entry.emailId)
        : byRma.get(String(entry.rmaNumber));
      if (existingId) {
        idMap.set(entry.id, existingId);
        skipped++;
        continue;
      }

      try {
        const { id: oldId, ...rest } = entry;
        const newId = await saveEntry(rest);
        idMap.set(oldId, newId);
        if (rest.emailId) byEmail.set(rest.emailId, newId);
        byRma.set(String(rest.rmaNumber), newId);
        entryCount++;
      } catch (err) {
        failed.push(`#${entry.rmaNumber}: ${err.message}`);
        console.warn('[Import] Entry failed:', entry.rmaNumber, err.message);
      }
    }

    // Prefetch existing PDFs once so re-imports skip already-uploaded files
    const existingPdfs = await getAllPDFs();
    const pdfKeys = new Set(existingPdfs.map(p => `${p.entryId}|${p.filename}`));

    let pdfCount = 0;
    const pdfs = Array.isArray(backup.pdfs) ? backup.pdfs : [];
    for (let i = 0; i < pdfs.length; i++) {
      const p = pdfs[i];
      if (onProgress) onProgress(`Uploading PDF ${i + 1}/${pdfs.length}…`);
      const entryId = idMap.get(p.entryId);
      if (!entryId) continue;
      if (pdfKeys.has(`${entryId}|${p.filename}`)) continue;

      try {
        // The backup format carries no content-type, so recover it from the
        // filename; otherwise every restored photo comes back as a PDF.
        await savePDF(entryId, p.filename, _b642ab(p.data), p.type || 'rma-form',
                      Attachments.mimeFor(p.filename));
        pdfKeys.add(`${entryId}|${p.filename}`);
        pdfCount++;
      } catch (err) {
        failed.push(`PDF ${p.filename}: ${err.message}`);
        console.warn('[Import] PDF failed:', p.filename, err.message);
      }
    }

    return { entryCount, pdfCount, skipped, failed, exportedAt: backup.exportedAt || null };
  }

  return {
    whoAmI,
    saveEntry, getEntry, getAllEntries, getDeletedEntries,
    entryByRmaNumber, getEntryHistory, getAllHistory, flagsAvailable, detectFlagsColumn,
    getSetting, setSetting,
    savePDF, getPDFsForEntry, getAllPDFs, getPDFData, downloadPDF, buildFilename,
    getPendingEmails, claimPendingEmail, getRecentEmails, getOriginalEmail,
    isClaimStale, updatePending, downloadPath, removePath,
    exportBackup, importBackup
  };
})();
