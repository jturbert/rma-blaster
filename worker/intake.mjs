// ============================================================
// RMA Blaster: new RMAs handed over by the Dune Blue site.
//
// When a dealer submits the RMA form on duneblue.com, the site's own
// Worker calls this directly over a Cloudflare service binding (see
// worker/main.mjs). It is not reachable from the internet at all: there
// is no URL for it, only the binding.
//
// It does exactly what the Supabase Edge Function did with a Postmark
// webhook: park the raw message and its files in the queue, parse
// nothing. The app parses it the next time anyone opens it, with the
// same code that has always parsed the emailed copy, because the site
// hands over the same subject line and the same plain-text body.
// ============================================================

// Same rules as the Edge Function (supabase/functions/inbound-email) and
// attachments.js. Keep the accepted types in step.
function isWantedAttachment(name, type) {
  if (/pdf|jpe?g|png/.test(type.toLowerCase())) return true;
  return /\.(pdf|jpe?g|png)$/i.test(name);
}

function isPhoto(name, type) {
  const lower = type.toLowerCase();
  if (/jpe?g|png/.test(lower)) return true;
  if (lower.includes('pdf')) return false;
  return /\.(jpe?g|png)$/i.test(name);
}

export function contentTypeFor(name) {
  const ext = name.toLowerCase().split('.').pop();
  return { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }[ext]
      || 'application/octet-stream';
}

function safeName(name) {
  return (name || 'attachment').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-{2,}/g, '-').slice(0, 80);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Photos over this are not stored, same as before. The site's own emailed
// copy, with the full-size photo, still goes to the Gmail archive, and the
// skip is noted on the queue row so it shows in the app.
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const formatMB = bytes => (bytes / (1024 * 1024)).toFixed(1) + ' MB';

/**
 * Store one submission in the queue.
 *
 * mail: {
 *   messageId    stable per RMA, so a retry is recognised as the same one
 *   subject      exactly as the site's email has it ("RMA #1234 from ...")
 *   from         the address the site's email comes from
 *   date         when it was submitted
 *   text         the plain-text body of the site's email
 *   attachments  [{ filename, content (base64), contentType? }]
 * }
 *
 * Returns { ok: true, duplicate?: true, attachments: n }. Throws if it could
 * not be stored, so the site knows to try again; anything half-written is
 * cleaned up first.
 */
export async function storeSubmission(env, mail) {
  if (!mail || typeof mail !== 'object') throw new Error('No submission');
  const messageId = String(mail.messageId || '').slice(0, 300);
  const subject   = String(mail.subject || '');
  if (!messageId) throw new Error('A submission needs a messageId');
  if (!/^RMA #\d+/.test(subject)) throw new Error('Not an RMA submission');

  const existing = await env.DB.prepare('SELECT id FROM pending_emails WHERE message_id = ?')
    .bind(messageId).first();
  if (existing) return { ok: true, duplicate: true, attachments: 0 };

  const folder = `pending/${crypto.randomUUID()}`;
  const stored = [];
  const skipped = [];
  try {
    for (const att of (Array.isArray(mail.attachments) ? mail.attachments : [])) {
      const name = String(att && att.filename || '');
      const type = String(att && att.contentType || contentTypeFor(name));
      if (!att || !att.content || !isWantedAttachment(name, type)) continue;

      const bytes = base64ToBytes(att.content);
      if (isPhoto(name, type) && bytes.length > MAX_PHOTO_BYTES) {
        skipped.push(`${name} (${formatMB(bytes.length)})`);
        continue;
      }
      const path = `${folder}/${safeName(name)}`;
      await env.FILES.put(path, bytes, { httpMetadata: { contentType: type } });
      stored.push({ filename: name, storagePath: path, contentType: type });
    }

    await env.DB.prepare(
      `INSERT INTO pending_emails (message_id, subject, from_address, sent_at, text_body, attachments, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      messageId, subject, String(mail.from || ''), String(mail.date || new Date().toUTCString()),
      String(mail.text || '').slice(0, 100000), JSON.stringify(stored),
      skipped.length ? `Photo too large to store, still in the Gmail archive: ${skipped.join(', ')}` : null
    ).run();
  } catch (err) {
    // Two hand-offs of the same RMA at once: the other one won. Not an error.
    if (/UNIQUE constraint failed: pending_emails\.message_id/i.test(String(err && err.message))) {
      await Promise.all(stored.map(s => env.FILES.delete(s.storagePath).catch(() => {})));
      return { ok: true, duplicate: true, attachments: 0 };
    }
    // The site will try again, under a fresh folder, so do not leave these behind.
    await Promise.all(stored.map(s => env.FILES.delete(s.storagePath).catch(() => {})));
    throw err;
  }
  return { ok: true, attachments: stored.length };
}
