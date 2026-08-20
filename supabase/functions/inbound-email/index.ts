// ============================================================
// RMA Blaster — inbound-email Edge Function
//
// Receives a Postmark inbound-email webhook and parks the raw
// message + its PDF/photo attachments in the pending_emails queue.
//
// It deliberately does NO parsing: subject matching, PDF field
// extraction and warranty inference all happen in the app, which
// already has that logic and is the only place it should live.
//
// Protected by a shared token in the query string, because Postmark
// cannot send custom auth headers:
//     https://<project>.supabase.co/functions/v1/inbound-email?token=XXXX
//
// Required secret (Dashboard → Edge Functions → Secrets):
//     INBOUND_TOKEN — any long random string; must match the URL above
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BUCKET = 'rma-pdfs';

function headerValue(headers: Array<{ Name: string; Value: string }> | undefined, name: string) {
  const hit = (headers || []).find(h => h.Name?.toLowerCase() === name.toLowerCase());
  return hit?.Value || '';
}

function base64ToBytes(b64: string) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Keep a storage path safe regardless of what the sender named the file
function safeName(name: string) {
  return (name || 'attachment')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
}

// RMA attachments are now a PDF (form / invoice) or a photo (fault photos,
// or a photographed invoice) — anything else isn't something the app uses.
//
// This mirrors attachments.js in the app, which classifies the same files
// once they arrive. The two are separate on purpose: this runs on Deno and
// deploys separately, and the repo has no build step to share code between
// them. Keep the accepted types in step — anything rejected here never
// reaches the app at all.
//
// Senders omit Content-Type or send 'application/octet-stream' often
// enough that the filename has to be checked too, not just the header.
function isWantedAttachment(name: string, type: string) {
  const lowerName = name.toLowerCase();
  const lowerType = type.toLowerCase();
  if (/pdf|jpe?g|png/.test(lowerType)) return true;
  return /\.(pdf|jpe?g|png)$/.test(lowerName);
}

function isPhoto(name: string, type: string) {
  const lowerType = type.toLowerCase();
  if (/jpe?g|png/.test(lowerType)) return true;
  if (lowerType.includes('pdf')) return false;
  return /\.(jpe?g|png)$/i.test(name);
}

// Photos are the only attachment big enough to matter against the 1 GB
// storage tier: an invoice PDF is ~100 KB, a phone photo 3-8 MB. Cap them
// so one dealer sending a burst of full-resolution shots can't fill it.
// PDFs are uncapped — they are the document the RMA actually needs, and the
// site already refuses anything over 10 MB at the form.
//
// Nothing is lost when a photo is skipped: every RMA is archived in full,
// attachments included, in the Gmail mailbox (see RMA_ARCHIVE_TO on the
// site). A skip is recorded on the queue row so it shows in the app rather
// than disappearing quietly.
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

// Decoded byte length of a base64 payload, without decoding it.
function base64Bytes(b64: string) {
  const clean = (b64 || '').replace(/=+$/, '');
  return Math.floor(clean.length * 3 / 4);
}

function formatMB(bytes: number) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const expected = Deno.env.get('INBOUND_TOKEN');
  if (!expected || url.searchParams.get('token') !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }

  let mail: any;
  try {
    mail = await req.json();
  } catch (_) {
    return new Response('Bad JSON', { status: 400 });
  }

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Prefer the ORIGINAL Message-ID so a re-forwarded copy of the same
  // email is recognised as a duplicate; fall back to Postmark's own id.
  const messageId =
    headerValue(mail.Headers, 'Message-ID') || mail.MessageID || crypto.randomUUID();

  // Already queued (Postmark retries on any non-2xx) — ack and stop.
  const { data: existing } = await supa
    .from('pending_emails').select('id').eq('message_id', messageId).maybeSingle();
  if (existing) {
    return new Response(JSON.stringify({ ok: true, duplicate: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Store PDF attachments; metadata goes in the queue row.
  const attachments: Array<Record<string, string>> = [];
  const folder = `pending/${crypto.randomUUID()}`;

  const skipped: string[] = [];

  for (const att of (mail.Attachments || [])) {
    const name = att.Name || '';
    const type = att.ContentType || '';
    if (!isWantedAttachment(name, type) || !att.Content) continue;

    if (isPhoto(name, type)) {
      const bytes = base64Bytes(att.Content);
      if (bytes > MAX_PHOTO_BYTES) {
        console.log(`Skipping oversized photo: ${name} (${formatMB(bytes)})`);
        skipped.push(`${name} (${formatMB(bytes)})`);
        continue;
      }
    }

    const path = `${folder}/${safeName(name)}`;
    const { error } = await supa.storage.from(BUCKET).upload(
      path, base64ToBytes(att.Content), { contentType: type || 'application/octet-stream', upsert: true }
    );
    if (error) {
      console.error('Attachment upload failed:', name, error.message);
      continue;
    }
    attachments.push({ filename: name, storagePath: path, contentType: type });
  }

  const { error: insErr } = await supa.from('pending_emails').insert({
    message_id:   messageId,
    subject:      mail.Subject || '',
    from_address: mail.From || '',
    sent_at:      mail.Date || headerValue(mail.Headers, 'Date') || '',
    text_body:    (mail.TextBody || '').slice(0, 100000),
    attachments,
    // Carried through to the Email Queue panel so a skipped photo is visible
    // rather than silent. ingest.js preserves this when the row succeeds.
    error: skipped.length
      ? `Photo too large to store, still in the Gmail archive: ${skipped.join(', ')}`
      : null
  });

  if (insErr) {
    console.error('Queue insert failed:', insErr.message);
    // Postmark will retry and upload these again under a fresh folder,
    // so clear the ones we just wrote rather than leaving them orphaned.
    if (attachments.length) {
      await supa.storage.from(BUCKET)
        .remove(attachments.map(a => a.storagePath))
        .catch(() => { /* best effort — the retry matters more */ });
    }
    // 500 makes Postmark retry later, which is what we want here.
    return new Response(JSON.stringify({ ok: false, error: insErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({ ok: true, attachments: attachments.length }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
});
