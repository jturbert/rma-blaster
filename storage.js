// ============================================================
// RMA Blaster — Storage Layer (Supabase)
//   • Entries in Postgres ('entries' table)
//   • PDF files in the 'rma-pdfs' storage bucket, metadata in 'pdfs'
//   • Per-device preferences (Excel filename etc.) in localStorage
//
// The public interface matches v1's IndexedDB storage layer, so
// the rest of the app code carried over with minimal changes.
// ============================================================

const Storage = (() => {
  let supa = null;   // Supabase client, created in init()

  const BUCKET       = 'rma-pdfs';
  const SETTINGS_KEY = 'rmaBlasterSettings';

  function init(url, anonKey) {
    supa = supabase.createClient(url, anonKey);
    return supa;
  }
  // Expose the client for auth calls in app.js
  const client = () => supa;

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
    deleted: 'deleted',            deletedAt: 'deleted_at',
    importedAt: 'imported_at',     lastModified: 'last_modified'
  };

  function toRow(entry) {
    const row = {};
    for (const [camel, snake] of Object.entries(FIELD_MAP)) {
      if (entry[camel] !== undefined) row[snake] = entry[camel];
    }
    // Postgres wants null, not '' for timestamps
    if (row.deleted_at === '') row.deleted_at = null;
    return row;
  }

  function toEntry(row) {
    if (!row) return null;
    const entry = { id: row.id };
    for (const [camel, snake] of Object.entries(FIELD_MAP)) {
      entry[camel] = row[snake] ?? (camel === 'deleted' ? false : '');
    }
    return entry;
  }

  function _throw(error, action) {
    throw new Error(`${action} failed: ${error.message}`);
  }

  // ---- RMA Entries ----

  // Insert (no id) or update (id present). Returns the entry id.
  async function saveEntry(entry) {
    const row = toRow(entry);
    row.last_modified = new Date().toISOString();
    if (entry.id) {
      const { error } = await supa.from('entries').update(row).eq('id', entry.id);
      if (error) _throw(error, 'Saving entry');
      return entry.id;
    }
    const { data, error } = await supa.from('entries').insert(row).select('id').single();
    if (error) _throw(error, 'Creating entry');
    return data.id;
  }

  async function getEntry(id) {
    const { data, error } = await supa.from('entries').select('*').eq('id', id).maybeSingle();
    if (error) _throw(error, 'Loading entry');
    return toEntry(data);
  }

  async function getAllEntries() {
    const { data, error } = await supa.from('entries').select('*').eq('deleted', false);
    if (error) _throw(error, 'Loading entries');
    return data.map(toEntry);
  }

  async function getDeletedEntries() {
    const { data, error } = await supa.from('entries').select('*').eq('deleted', true);
    if (error) _throw(error, 'Loading archived entries');
    return data.map(toEntry);
  }

  async function entryByEmailId(emailId) {
    if (!emailId) return null;
    const { data, error } = await supa.from('entries').select('*').eq('email_id', emailId).maybeSingle();
    if (error) _throw(error, 'Looking up entry');
    return toEntry(data);
  }

  async function entryByRmaNumber(rma) {
    const { data, error } = await supa.from('entries')
      .select('*').eq('rma_number', String(rma)).limit(1);
    if (error) _throw(error, 'Looking up entry');
    return data.length ? toEntry(data[0]) : null;
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

  async function savePDF(entryId, filename, arrayBuffer, pdfType) {
    const path = `entry-${entryId}/${Date.now()}-${filename}`;
    const { error: upErr } = await supa.storage.from(BUCKET)
      .upload(path, new Blob([arrayBuffer], { type: 'application/pdf' }));
    if (upErr) _throw(upErr, 'Uploading PDF');

    const { data, error } = await supa.from('pdfs')
      .insert({ entry_id: entryId, filename, type: pdfType, storage_path: path })
      .select('id').single();
    if (error) _throw(error, 'Saving PDF record');
    return data.id;
  }

  function _pdfFromRow(r) {
    return { id: r.id, entryId: r.entry_id, filename: r.filename,
             type: r.type, storagePath: r.storage_path, savedAt: r.saved_at };
  }

  async function getPDFsForEntry(entryId) {
    const { data, error } = await supa.from('pdfs')
      .select('*').eq('entry_id', entryId).order('saved_at');
    if (error) _throw(error, 'Loading PDF list');
    return data.map(_pdfFromRow);
  }

  async function getAllPDFs() {
    const { data, error } = await supa.from('pdfs').select('*').order('entry_id');
    if (error) _throw(error, 'Loading PDF list');
    return data.map(_pdfFromRow);
  }

  // Fetch the actual file bytes for a PDF record.
  async function getPDFData(pdfRecord) {
    const { data, error } = await supa.storage.from(BUCKET).download(pdfRecord.storagePath);
    if (error) _throw(error, 'Downloading PDF');
    return data.arrayBuffer();
  }

  async function downloadPDF(pdfRecord) {
    const buffer = await getPDFData(pdfRecord);
    const blob = new Blob([buffer], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = pdfRecord.filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Build a safe filename: {rmaNumber}-{dealer}-{model}-{YYYY-MM-DD}[-INV].pdf
  function buildFilename(rmaNumber, dealer, model, dateStr, isInvoice) {
    const safe = s => (s||'unknown').replace(/[/\\?%*:|"<>]/g,'-').replace(/\s+/g,'-').replace(/-{2,}/g,'-').trim().substring(0,40);
    let date = 'unknown-date';
    try { date = new Date(dateStr).toISOString().split('T')[0]; } catch(_) {}
    return `${safe(rmaNumber)}-${safe(dealer)}-${safe(model)}${isInvoice?'-INV':''}-${date}.pdf`;
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
    const { data: entryRows, error: e1 } = await supa.from('entries').select('*');
    if (e1) _throw(e1, 'Backup (entries)');
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

    const backup = {
      version:    1,
      exportedAt: new Date().toISOString(),
      entries:    entryRows.map(toEntry),
      settings:   [],
      pdfs
    };

    const blob     = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const url      = URL.createObjectURL(blob);
    const date     = new Date().toISOString().split('T')[0];
    return { url, filename: `RMA-Backup-${date}.json`,
             entryCount: entryRows.length, pdfCount: pdfs.length };
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
    const { data: existingRows, error: exErr } =
      await supa.from('entries').select('id, email_id, rma_number');
    if (exErr) _throw(exErr, 'Import (reading existing entries)');
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
        await savePDF(entryId, p.filename, _b642ab(p.data), p.type || 'rma-form');
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
    init, client,
    saveEntry, getEntry, getAllEntries, getDeletedEntries,
    entryByEmailId, entryByRmaNumber,
    getSetting, setSetting,
    savePDF, getPDFsForEntry, getAllPDFs, getPDFData, downloadPDF, buildFilename,
    exportBackup, importBackup
  };
})();
