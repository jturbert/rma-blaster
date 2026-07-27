// ============================================================
// RMA Blaster — inbound-email Edge Function
//
// Receives a Postmark inbound-email webhook and parks the raw
// message + its PDF attachments in the pending_emails queue.
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
  return (name || 'attachment.pdf')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
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

  for (const att of (mail.Attachments || [])) {
    const name = att.Name || '';
    const type = att.ContentType || '';
    const isPdf = type.toLowerCase().includes('pdf') || name.toLowerCase().endsWith('.pdf');
    if (!isPdf || !att.Content) continue;

    const path = `${folder}/${safeName(name)}`;
    const { error } = await supa.storage.from(BUCKET).upload(
      path, base64ToBytes(att.Content), { contentType: 'application/pdf', upsert: true }
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
    attachments
  });

  if (insErr) {
    console.error('Queue insert failed:', insErr.message);
    // 500 makes Postmark retry later, which is what we want here.
    return new Response(JSON.stringify({ ok: false, error: insErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({ ok: true, attachments: attachments.length }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
});
