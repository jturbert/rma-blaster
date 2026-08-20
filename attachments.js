// ============================================================
// RMA Blaster — Attachment File Types
//
// THE single place attachment types are defined. Storage naming,
// upload content-types, download content-types and the PDF-vs-photo
// decision during ingestion all read from here, so a file type added
// once behaves consistently everywhere.
//
// The inbound-email Edge Function keeps its OWN copy of this
// allowlist: it runs on Deno, is deployed separately, and this repo
// has no build step to share code between the two. If you add a type
// here, add it to isWantedAttachment() in
// supabase/functions/inbound-email/index.ts as well, or the file will
// be dropped at the door and never reach this code.
// ============================================================

const Attachments = (() => {
  // mime      — what we send when we have to name the type ourselves
  // ext       — the extension stored filenames get
  // mimeTest  — matched against a Content-Type header, lowercased
  // extTest   — matched against a filename's extension, lowercased
  const TYPES = [
    { ext: 'pdf', mime: 'application/pdf', isPdf: true,
      mimeTest: /pdf/,  extTest: /^pdf$/ },
    { ext: 'jpg', mime: 'image/jpeg', isPdf: false,
      mimeTest: /jpe?g/, extTest: /^jpe?g$/ },
    { ext: 'png', mime: 'image/png', isPdf: false,
      mimeTest: /png/,  extTest: /^png$/ },
  ];

  // Content-Type headers are the better signal when present and recognised,
  // but senders omit them or send 'application/octet-stream' often enough
  // that the filename has to be a real fallback rather than a decoration.
  function _byContentType(contentType) {
    const t = String(contentType || '').toLowerCase();
    if (!t) return null;
    return TYPES.find(entry => entry.mimeTest.test(t)) || null;
  }

  function _byFilename(filename) {
    const m = String(filename || '').match(/\.([a-z0-9]+)$/i);
    if (!m) return null;
    const ext = m[1].toLowerCase();
    return TYPES.find(entry => entry.extTest.test(ext)) || null;
  }

  // Content-type first, then the filename. Returns null when neither
  // identifies a type we know.
  function identify(contentType, filename) {
    return _byContentType(contentType) || _byFilename(filename) || null;
  }

  // Extension for a stored filename. Falls back to 'pdf' because every
  // attachment predating photo support was a PDF.
  function extFor(contentType, filename) {
    const hit = identify(contentType, filename);
    return hit ? hit.ext : 'pdf';
  }

  // Content-Type to hand a browser or a storage upload. Deliberately
  // 'application/octet-stream' when unknown: claiming a wrong type is
  // worse than declining to guess.
  function mimeFor(filename, contentType) {
    const hit = identify(contentType, filename);
    return hit ? hit.mime : 'application/octet-stream';
  }

  // Is this something PDFParser should be pointed at? Unknown types are
  // not: feeding a JPEG to pdf.js only produces a confusing console error.
  function isPdf(contentType, filename) {
    const hit = identify(contentType, filename);
    return !!hit && hit.isPdf;
  }

  return { TYPES, identify, extFor, mimeFor, isPdf };
})();
