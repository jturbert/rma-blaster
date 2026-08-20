// ============================================================
// RMA Blaster — Inbound Email Ingestion
//
// Turns rows in the pending_emails queue into RMA entries.
// The subject/date parsing here is carried over unchanged from
// v1's Gmail reader. Form fields come primarily from the plain-text
// email body (the current duneblue.com site's format); PDFParser is
// kept for older forwarded emails that still carry a rendered PDF
// form, and for reading invoice dates / filing attachments (which
// may now be PDFs or photos).
// ============================================================

const Ingest = (() => {
  const SUBJECT_PATTERN = /^RMA\s+#(\d+)\s+from\s+(.+?)\s+about\s+(.+)$/i;

  // Brands come from brands.js — the one place they're defined.

  // "RMA #1140 from Audiofenzy about Final Wil Smeets"
  // Strips any stacked Re:/Fw:/Fwd: prefixes before matching.
  function parseSubject(subject) {
    const prefix = /^(Re|Fw|Fwd):\s*/i;
    let s = (subject || '').trim();
    while (prefix.test(s)) s = s.replace(prefix, '').trim();
    const m = s.match(SUBJECT_PATTERN);
    if (!m) return null;
    const about = m[3].trim();
    return {
      rmaNumber:  m[1].trim(),
      dealer:     m[2].trim(),
      customer:   about,
      brandGuess: Brands.detect(about)
    };
  }

  // Mail clients write dates in their own prose, which Date() can't parse
  // as-is. Gmail uses "Tue, 21 Jul 2026 at 10:15" (Dutch: "om"); the
  // separator word has to go before parsing, or every forwarded date is
  // silently lost. Trailing timezone names in parentheses also trip it up.
  function parseMailDate(raw) {
    if (!raw) return null;
    const cleaned = raw.trim()
      .replace(/\s+(at|om|um|à)\s+/i, ' ')   // Gmail's separator, localised
      .replace(/\s*\([^)]*\)\s*$/, '')       // "(CEST)" and friends
      .trim();
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
  }

  // Recover the ORIGINAL send date from a forwarded message body.
  // Gmail writes a "---------- Forwarded message ---------" block with a
  // Date: line (Dutch Gmail: "Doorgestuurd bericht" / "Datum:"); Outlook
  // uses "Sent:" / "Verzonden:". This survives any number of forwards,
  // which the outer Date header does not.
  function extractForwardedDate(bodyText) {
    if (!bodyText) return '';
    const fwdMatch = bodyText.match(
      /[-]{3,}\s*(?:Forwarded message|Doorgestuurd bericht)\s*[-]{3,}([\s\S]{0,800})/i
    );
    if (fwdMatch) {
      const dateMatch = fwdMatch[1].match(/^(?:Date|Datum):\s*(.+)$/im);
      const d = dateMatch && parseMailDate(dateMatch[1]);
      if (d) return d.toISOString().split('T')[0];
    }
    const sentMatch = bodyText.match(/^(?:Sent|Verzonden):\s*(.+)$/im);
    const d = sentMatch && parseMailDate(sentMatch[1]);
    if (d) return d.toISOString().split('T')[0];
    return '';
  }

  // Date priority: forwarded-message date, then the email's own Date
  // header, then when we received it.
  function resolveDate(row) {
    const fwd = extractForwardedDate(row.text_body);
    if (fwd) return fwd;
    for (const candidate of [row.sent_at, row.received_at]) {
      const d = parseMailDate(candidate);
      if (d) return d.toISOString().split('T')[0];
    }
    return '';
  }

  // ---- Warranty inference (single definition, used by app.js too) ----
  const WARRANTY_PERIOD_DAYS = 730;   // 2-year warranty window

  // Whole days between the invoice (purchase) date and the RMA date.
  // null when either date is missing/unparseable or the invoice postdates
  // the RMA (a bad parse — don't infer anything from it).
  function daysSincePurchase(rmaDateStr, invoiceDate) {
    if (!invoiceDate || !rmaDateStr) return null;
    const rmaDate = new Date(rmaDateStr);
    if (isNaN(rmaDate.getTime())) return null;
    const diff = (rmaDate - invoiceDate) / 86400000;
    return diff >= 0 ? Math.round(diff) : null;
  }

  // 'Yes' | 'No' | '' (when inference isn't possible)
  function inferWarrantyStatus(rmaDateStr, invoiceDate) {
    const days = daysSincePurchase(rmaDateStr, invoiceDate);
    if (days === null) return '';
    return days <= WARRANTY_PERIOD_DAYS ? 'Yes' : 'No';
  }

  // ---- Queue processing ----

  // The form fields a parsed RMA source can supply.
  const FORM_FIELDS = [
    'make', 'model', 'serialNumber', 'issueDescription', 'warrantyStatus', 'notes'
  ];

  // Copy parsed fields onto the entry, filling blanks only.
  //
  // Order is the precedence: the email body is parsed first because on the
  // current site it IS the form, so an attached PDF — which nowadays is
  // either an invoice or a leftover from the retired template — can only
  // fill what the body left empty, never overwrite it.
  function fillBlankFields(entry, fields) {
    if (!fields) return;
    for (const key of FORM_FIELDS) {
      if (fields[key] && !entry[key]) entry[key] = fields[key];
    }
  }

  // Does this body carry the form itself, the way the current site sends it?
  //
  // This gate matters during the changeover. Old WordPress submissions put
  // the form in a PDF attachment and their body is free prose; parsing that
  // prose for "Label: value" pairs risks a stray match claiming a field and,
  // because fields fill blanks only, locking out the real value from the PDF.
  // So: parse the body only when it is recognisably the new site's, and let
  // every other email keep the PDF-first behaviour it has always had.
  //
  // renderText() in DB-Site's server/handler.js always leads an RMA with the
  // "RMA NUMBER:" line, and always labels the fault "Problem description:".
  // Leading '>' allows for a quoted forward.
  const SITE_BODY_MARKERS = [
    /^\s*>*\s*RMA NUMBER:/im,
    /^\s*>*\s*Problem description:/im,
  ];
  function isSiteFormBody(text) {
    return !!text && SITE_BODY_MARKERS.some(re => re.test(text));
  }

  async function discardAttachments(row) {
    for (const att of (row.attachments || [])) {
      if (att.storagePath) await Storage.removePath(att.storagePath);
    }
  }

  // Build one entry (plus its PDFs) from a queued email.
  async function processRow(row) {
    const parsed = parseSubject(row.subject);
    if (!parsed) {
      await discardAttachments(row);
      await Storage.updatePending(row.id, {
        status: 'ignored', error: 'Subject does not match the RMA pattern'
      });
      return { outcome: 'ignored' };
    }

    // An email we've already turned into an entry (same Message-ID) is
    // caught by the queue's unique constraint, so a match here means a
    // DIFFERENT email carrying an RMA number we already have — a follow-up
    // or a re-send. Mirror v1: never auto-create a second entry for it.
    const existing = await Storage.entryByRmaNumber(parsed.rmaNumber);
    if (existing) {
      await discardAttachments(row);
      await Storage.updatePending(row.id, {
        status: 'ignored',
        entry_id: existing.id,
        error: `RMA #${parsed.rmaNumber} already exists — not imported again`
      });
      return { outcome: 'duplicate', rmaNumber: parsed.rmaNumber };
    }

    const dateStr = resolveDate(row);
    const entry = {
      emailId: row.message_id, status: 'Open',
      rmaNumber: parsed.rmaNumber, date: dateStr,
      dealer: parsed.dealer,
      make: '', model: '', serialNumber: '',
      issueDescription: '', issueConfirmed: '',
      warrantyStatus: '', courseOfAction: '',
      dateOfResolution: '', howResolved: '', notes: ''
    };

    // The current site puts the RMA form fields straight in the email body
    // (see DB-Site's server/handler.js renderText()) rather than in a
    // rendered PDF attachment, so read them from there first. This also
    // covers submissions with no attachment at all. Old-format emails skip
    // this entirely and stay PDF-first — see isSiteFormBody().
    if (isSiteFormBody(row.text_body)) {
      const bodyLines = row.text_body.split('\n')
        .map(l => l.replace(/^\s*>+\s?/, '').trim())   // undo quoted-forward prefixes
        .filter(l => l.length > 0);
      fillBlankFields(entry, PDFParser.parseGenericRMAFields(bodyLines));
    }

    // Second pass: read every attachment. PDFs may still carry fields (older
    // forwarded emails using the retired PDF-form template) and/or a purchase
    // date (an attached invoice). Photos carry neither — they're just filed.
    let invoiceDate = null;
    const queue = [];
    for (const att of (row.attachments || [])) {
      try {
        const buffer = await Storage.downloadPath(att.storagePath);
        const item = {
          buffer, sourcePath: att.storagePath,
          contentType: att.contentType, sourceName: att.filename
        };

        if (!Attachments.isPdf(att.contentType, att.filename)) {
          queue.push({ ...item, kind: 'photo' });
          continue;
        }

        const result = await PDFParser.processPDF(buffer, att.filename);

        if (!result.isInvoice) {
          fillBlankFields(entry, result.fields);
        } else if (result.invoiceDate) {
          invoiceDate = result.invoiceDate;
        }
        queue.push({ ...item, kind: result.isInvoice ? 'invoice' : 'rma-form' });
      } catch (err) {
        console.warn('[Ingest] Attachment failed:', att.filename, err.message);
      }
    }

    if (!entry.warrantyStatus && invoiceDate) {
      const status = inferWarrantyStatus(entry.date, invoiceDate);
      if (status) {
        entry.warrantyStatus = status;
        RMADebug.log(`[Ingest] Warranty inferred from invoice: ${status} (${daysSincePurchase(entry.date, invoiceDate)} days since purchase)`);
      }
    }

    // Fall back to the brand guessed from the subject line
    if (!entry.make && parsed.brandGuess) entry.make = parsed.brandGuess;

    const entryId = await Storage.saveEntry(entry);

    // Third pass: file the attachments against the new entry (the model name
    // is known now, so the filenames come out right), then drop the queue copies.
    for (const item of queue) {
      try {
        const fname = Storage.buildFilename(
          entry.rmaNumber, entry.dealer, entry.model || 'unknown', dateStr,
          item.kind, item.contentType, item.sourceName
        );
        await Storage.savePDF(entryId, fname, item.buffer, item.kind, item.contentType);
        await Storage.removePath(item.sourcePath);
      } catch (err) {
        console.warn('[Ingest] Could not store attachment:', err.message);
      }
    }

    await Storage.updatePending(row.id, { status: 'processed', entry_id: entryId });
    return { outcome: 'created', rmaNumber: entry.rmaNumber, entryId };
  }

  // Process the whole queue. One bad email never stops the rest.
  async function processPending(onProgress) {
    let rows = [];
    try {
      rows = await Storage.getPendingEmails();
    } catch (err) {
      console.warn('[Ingest] Could not read the queue:', err.message);
      return { created: 0, duplicates: 0, ignored: 0, failed: 0, total: 0 };
    }
    if (!rows.length) return { created: 0, duplicates: 0, ignored: 0, failed: 0, total: 0 };

    let created = 0, duplicates = 0, ignored = 0, failed = 0, claimed = 0;

    for (let i = 0; i < rows.length; i++) {
      if (onProgress) {
        onProgress(Math.round(((i + 1) / rows.length) * 100),
                   `Importing email ${i + 1} of ${rows.length}…`);
      }

      // Another device may be working on this one already (two people
      // signing in at once). Skip quietly rather than importing it twice.
      try {
        if (!await Storage.claimPendingEmail(rows[i].id)) continue;
      } catch (err) {
        console.warn('[Ingest] Could not claim email:', err.message);
        continue;
      }
      claimed++;

      try {
        const r = await processRow(rows[i]);
        if (r.outcome === 'created')        created++;
        else if (r.outcome === 'duplicate') duplicates++;
        else                                ignored++;
      } catch (err) {
        failed++;
        console.warn('[Ingest] Email failed:', rows[i].subject, err.message);
        try {
          await Storage.updatePending(rows[i].id, { status: 'error', error: err.message });
        } catch (_) { /* stays 'processing'; picked up again once the claim goes stale */ }
      }
    }

    return { created, duplicates, ignored, failed, total: claimed };
  }

  return {
    parseSubject, extractForwardedDate, resolveDate,
    daysSincePurchase, inferWarrantyStatus,
    fillBlankFields, isSiteFormBody,
    processPending
  };
})();
