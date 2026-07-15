// ============================================================
// RMA Manager - PDF Text Extraction & Field Parser
// Uses PDF.js (loaded via CDN in index.html)
//
// Dune Blue RMA form structure (all RMAs use this template):
//   Content stream has TWO phases:
//   Phase 1 – ALL LABELS (Dealer Name, Brand Model, Serial Number Warranty,
//              Yes, No, Reference, Upload file, Describe problem, Other remarks)
//   Phase 2 – ALL VALUES in the same order
//   The Dune Blue company letterhead appears between "Describe problem" value
//   and "Other remarks" value in Phase 2.
// ============================================================

const PDFParser = (() => {

  // Configure PDF.js worker
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  // ---- Extract all text from an already-loaded PDF object ----
  async function extractTextFromPDF(pdf) {
    let fullText = '';
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page    = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      let lastY   = null;
      let pageText = '';
      for (const item of content.items) {
        if (!item.str) continue;
        if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
          pageText += '\n';
        }
        pageText += item.str;
        lastY = item.transform[5];
      }
      fullText += pageText + '\n\n';
    }
    return fullText.trim();
  }

  // ---- Extract AcroForm field values from PDF annotations ----
  // Useful for checkbox / radio button states (Warranty Yes/No).
  //
  // Radio button groups: every option in the group shares the same fieldName.
  // The selected button reports its export value (e.g. "Yes"); unselected
  // buttons report "Off".  Because annotation order is not guaranteed, we
  // must never overwrite a real (non-Off) value with "Off".
  //
  // Some PDFs (including Dune Blue) have radio/checkbox widgets whose fieldName
  // is an empty string (falsy) — these were previously silently skipped.
  // We now also capture "unnamed" Btn widgets: a button is selected when its
  // buttonValue matches the group's fieldValue.  Selected buttons are stored
  // under the key "__btn_<buttonValue>" (e.g. "__btn_yes") for downstream use.
  async function extractFormData(pdf) {
    const data = {};
    try {
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const anns = await page.getAnnotations();
        console.log(`[PDFParser] Page ${pageNum}: ${anns.length} annotation(s)`);

        for (const ann of anns) {
          // Diagnostic: log every Widget annotation so we can see what the PDF exposes
          if (ann.subtype === 'Widget') {
            console.log(
              `[PDFParser] Widget: fieldType=${ann.fieldType}` +
              `, fieldName="${ann.fieldName}"` +
              `, fieldValue="${ann.fieldValue}"` +
              `, buttonValue="${ann.buttonValue}"` +
              `, radioButton=${ann.radioButton}` +
              `, checkBox=${ann.checkBox}`
            );
          }

          if (ann.fieldName && ann.fieldValue !== undefined) {
            // ── Named field (standard path) ──────────────────────────────
            const key      = ann.fieldName.toLowerCase();
            const incoming = ann.fieldValue;
            const existing = data[key];
            // Keep the first non-Off value; never let "Off" clobber a real value.
            if (existing === undefined || existing === 'Off' || existing === '') {
              data[key] = incoming;
            }
            console.log(`[PDFParser] Form field: "${ann.fieldName}" = "${incoming}" → stored as "${data[key]}"`);

          } else if (ann.subtype === 'Widget' && ann.fieldType === 'Btn' &&
                     ann.buttonValue != null) {
            // ── Unnamed Btn widget (fieldName is empty / null) ──────────
            // PDF.js sets fieldValue to the radio group's currently selected
            // export value.  A specific button is selected when its own
            // buttonValue matches that group value.
            const bv = String(ann.buttonValue);
            const fv = ann.fieldValue != null ? String(ann.fieldValue) : 'Off';
            if (fv && fv !== 'Off' && fv === bv) {
              data[`__btn_${bv.toLowerCase()}`] = bv;
              console.log(`[PDFParser] Unnamed Btn selected: "${bv}"`);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[PDFParser] Annotation extraction failed:', err.message);
    }
    return data;
  }

  // ---- Detect whether a PDF is a Dune Blue RMA form ----
  // Primary classifier: if it IS an RMA form, parse it as one.
  // If it is NOT an RMA form, treat it as an invoice and extract a purchase date.
  function isRMAForm(text) {
    const lower = (text || '').toLowerCase();
    // Dune Blue-specific markers
    if (lower.includes('duneblue.com') || lower.includes('dune blue')) return true;
    // Generic RMA form structure shared by this template
    if (lower.includes('describe problem') && lower.includes('dealer name')) return true;
    return false;
  }

  // ---- Known audio brands: [canonicalName, ...aliases] ----
  const BRAND_LIST = [
    ['Dan Clark Audio', 'Dan Clark', 'DCA'],
    ['64 Audio',        '64audio'],
    ['Campfire Audio',  'Campfire'],
    ['HiFiMAN',         'Hifiman'],
    ['Meze',            'MEZE'],
    ['Noble Audio',     'Noble'],
    ['Feliks Audio',    'Feliks'],
    ['Questyle'],
    ['LAiV'],
    ['HEDD'],
    ['Shanling'],
    ['Violectric'],
    ['D&A'],
    ['Final'],
    ['Palma'],
    ['DDHifi'],
    ['Lotoo'],
    ['Repeat'],
  ];

  // Scan text for any known brand (case-insensitive, longest match first).
  // Returns canonical brand name or ''.
  function detectBrand(text) {
    if (!text) return '';
    const lower = text.toLowerCase();
    const candidates = [];
    for (const [canonical, ...aliases] of BRAND_LIST) {
      for (const alias of [canonical, ...aliases]) {
        candidates.push({ canonical, alias, len: alias.length });
      }
    }
    candidates.sort((a, b) => b.len - a.len);
    for (const { canonical, alias } of candidates) {
      if (lower.includes(alias.toLowerCase())) return canonical;
    }
    return '';
  }

  // ---- Split a "BrandValueModelValue" concatenated line ----
  // e.g. "HifimanHifiman HE1000 Unveiled" → { brand: "HiFiMAN", model: "HE1000 Unveiled" }
  function splitBrandModel(valueLine) {
    if (!valueLine) return { brand: '', model: '' };
    const brand = detectBrand(valueLine);
    if (!brand) return { brand: valueLine.trim(), model: '' };

    const lower = valueLine.toLowerCase();
    // Collect all aliases for this brand, longest first
    const entry    = BRAND_LIST.find(([canonical]) => canonical === brand);
    const aliases  = entry ? [brand, ...entry.slice(1)] : [brand];
    aliases.sort((a, b) => b.length - a.length);

    let model = '';
    for (const alias of aliases) {
      const idx = lower.indexOf(alias.toLowerCase());
      if (idx !== -1) {
        model = valueLine.substring(idx + alias.length).trim();
        break;
      }
    }

    // Strip a leading brand alias from the model if present
    // (e.g. "Hifiman HE1000 Unveiled" → "HE1000 Unveiled")
    if (model) {
      const modelLower = model.toLowerCase();
      for (const alias of aliases) {
        if (modelLower.startsWith(alias.toLowerCase())) {
          model = model.substring(alias.length).trim();
          break;
        }
      }
    }

    return { brand, model };
  }

  // ---- Dune Blue letterhead line detector ----
  const LETTERHEAD_RE = [
    /^dune\s*blue$/i,
    /^samuel\s+soesmanstraat/i,
    /^3015\s*(gl)?/i,
    /^the\s+netherlands$/i,
    /^tel:\s*\d/i,
    /^info@duneblue\.com$/i,
    /^www\.duneblue\.com$/i,
  ];
  function isLetterheadLine(line) {
    return LETTERHEAD_RE.some(r => r.test(line.trim()));
  }

  // ---- Heuristic: does this string look like a serial number? ----
  function looksLikeSerialNumber(s) {
    if (!s) return false;
    if (s === '?') return true;                           // explicit "unknown"
    if (/^(rma[\s#\-])/i.test(s))    return false;       // "RMA 59348"
    if (/^(ord(?:er)?[\s#\-])/i.test(s)) return false;   // "ORD16533", "order # 22076"
    if (/^(order[\s#])/i.test(s))    return false;       // "order # 22076"
    if (/\s/.test(s) && !/\d/.test(s)) return false;     // multi-word, no digits → name
    // Reject customer reference patterns: Name-Brand-Number (e.g. "Kiril-Noble-21864")
    // Three or more hyphen-separated segments where the first is all letters = a reference
    const parts = s.split('-');
    if (parts.length >= 3 && /^[A-Za-z]+$/.test(parts[0])) return false;
    return /\d/.test(s) && s.length <= 30;               // has digits, short → serial
  }

  // ============================================================
  // Dune Blue-specific form parser
  // All Dune Blue forms share the same two-phase content stream:
  //   Phase 1: All labels (ends with "Other remarks")
  //   Phase 2: All values (in same order; Dune Blue letterhead
  //            appears between problem value and remarks value)
  //
  // Value order after labels:
  //   [0] Dealer + Contact
  //   [1] Street Address
  //   [2] City
  //   [3] ZIP + Country
  //   [4] Email + Phone
  //   [5] Brand + Model  ← extract
  //   [6] Serial Number  ← extract (optional, may be absent)
  //   [7] Reference      ← skip
  //   [8] Upload URL     ← anchor (starts with https://)
  //   [9+] Describe problem text (may span multiple lines)
  //   --- Dune Blue letterhead appears here ---
  //   [N+] Other remarks text
  // ============================================================
  function parseDuneBlueForm(lines, formData) {
    const result = {
      make: '', model: '', serialNumber: '',
      issueDescription: '', warrantyStatus: '', notes: ''
    };

    // Phase 1 ends with "Other remarks" label
    let labelsEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^other\s+remarks?$/i.test(lines[i])) {
        labelsEnd = i;
        break;
      }
    }
    if (labelsEnd === -1) return parseGenericRMAFields(lines, formData);

    const allValues = lines.slice(labelsEnd + 1);

    // Find where the Dune Blue letterhead starts in the value stream
    let letterheadIdx = allValues.length;
    for (let i = 0; i < allValues.length; i++) {
      if (/^dune\s*blue$/i.test(allValues[i])) {
        letterheadIdx = i;
        break;
      }
    }

    // Value lines before the letterhead (the main form fields)
    const valueLines = allValues.slice(0, letterheadIdx);

    // Other remarks: lines after letterhead, stripped of letterhead content
    result.notes = allValues
      .slice(letterheadIdx)
      .filter(l => l && !isLetterheadLine(l))
      .join(' ')
      .trim();

    // Find the Upload URL as an anchor (everything after = problem description)
    const urlIdx = valueLines.findIndex(l => /^https?:\/\//i.test(l));
    if (urlIdx !== -1) {
      result.issueDescription = valueLines
        .slice(urlIdx + 1)
        .filter(l => l && !isLetterheadLine(l))
        .join(' ')
        .trim();
    }

    // Values before the URL: dealer(0), street(1), city(2), zip(3), email(4), brand+model(5), serial?(6)
    const beforeUrl = urlIdx !== -1 ? valueLines.slice(0, urlIdx) : valueLines;

    if (beforeUrl.length > 5) {
      const { brand, model } = splitBrandModel(beforeUrl[5]);
      result.make  = brand;
      result.model = model;

      // Serial number at index 6 (if present and looks like one).
      // When serial is blank the Reference value slides into slot 6, making
      // beforeUrl only 7 items long. Require ≥ 8 items before treating [6] as serial.
      if (beforeUrl.length > 7 && looksLikeSerialNumber(beforeUrl[6])) {
        result.serialNumber = beforeUrl[6];
      }
    }

    // Warranty: try PDF form annotations first (most reliable).
    // The Dune Blue form may structure warranty as either:
    //   (A) A single radio-group field named "warranty" / "garantie" with
    //       value "Yes" / "No" / "Ja" / "Nee"
    //   (B) Separate per-option boolean fields literally named "yes", "no",
    //       "ja", "nee" — the checked one is non-Off, the other is "Off"
    if (formData && Object.keys(formData).length > 0) {
      // Case A — single warranty field
      for (const [key, value] of Object.entries(formData)) {
        if (!result.warrantyStatus && /warranty|garantie/i.test(key)) {
          if (value && value !== 'Off' && value !== '') {
            if (/^(yes|ja)$/i.test(value))              result.warrantyStatus = 'Yes';
            else if (/^(no|nee)$/i.test(value))         result.warrantyStatus = 'No';
            else if (/yes|ja|in/i.test(key))            result.warrantyStatus = 'Yes';
            else if (/no|nee|out|expired/i.test(key))   result.warrantyStatus = 'No';
            else if (/in.?warranty|under/i.test(value)) result.warrantyStatus = 'Yes';
            else if (/out|expired/i.test(value))        result.warrantyStatus = 'No';
            else                                         result.warrantyStatus = 'Yes';
          }
        }
      }
      // Case B — separate boolean fields named "yes"/"ja" and "no"/"nee"
      if (!result.warrantyStatus) {
        const yesVal = formData['yes'] ?? formData['ja'];
        const noVal  = formData['no']  ?? formData['nee'];
        if (yesVal && yesVal !== 'Off' && yesVal !== '') {
          result.warrantyStatus = 'Yes';
        } else if (noVal && noVal !== 'Off' && noVal !== '') {
          result.warrantyStatus = 'No';
        }
      }

      // Case C — unnamed Btn widgets (fieldName was empty/null, captured via __btn_*)
      if (!result.warrantyStatus) {
        const btnYes = formData['__btn_yes'] ?? formData['__btn_ja'];
        const btnNo  = formData['__btn_no']  ?? formData['__btn_nee'];
        if (btnYes) result.warrantyStatus = 'Yes';
        else if (btnNo) result.warrantyStatus = 'No';
      }
    }

    // Text-based warranty fallback: scan value fields after brand+model position.
    // The Dune Blue form may render the selected warranty option ("Yes"/"No") as a
    // plain text item in the content stream, typically at beforeUrl[7] (after serial
    // number at [6]). Count occurrences to handle "Yes" and "No" both appearing as
    // label artefacts — whichever count is higher wins.
    if (!result.warrantyStatus) {
      const checkArea = beforeUrl.slice(6);
      const yesCount = checkArea.filter(l => /^(yes|ja)$/i.test(l.trim())).length;
      const noCount  = checkArea.filter(l => /^(no|nee)$/i.test(l.trim())).length;
      if (yesCount > noCount)      result.warrantyStatus = 'Yes';
      else if (noCount > yesCount) result.warrantyStatus = 'No';
    }

    // Brand fallback: scan full text
    if (!result.make) result.make = detectBrand(lines.join(' '));

    return result;
  }

  // ============================================================
  // Generic / legacy parser — colon-based label: value pairs
  // Used as fallback for non-Dune-Blue PDFs
  // ============================================================
  function extractAfterLabel(line, nextLine) {
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const val = line.substring(colonIdx + 1).trim();
      if (val.length > 0 && val !== ':') return val;
    }
    const next = (nextLine || '').trim();
    if (next.length > 0 && next.length < 200) return next;
    return '';
  }

  function cleanValue(val) {
    if (!val) return '';
    return val.replace(/_{3,}/g, '').replace(/\s{2,}/g, ' ').trim();
  }

  function parseGenericRMAFields(lines, formData) {
    const result = {
      make: '', model: '', serialNumber: '',
      issueDescription: '', warrantyStatus: '', notes: ''
    };

    for (let i = 0; i < lines.length; i++) {
      const line     = lines[i];
      const lower    = line.toLowerCase();
      const nextLine = (lines[i + 1] || '').trim();

      if (!result.make &&
          lower.match(/^(make|brand|manufacturer|mfr)\s*[:]/i)) {
        result.make = cleanValue(extractAfterLabel(line, nextLine));
      }
      if (!result.model && lower.match(/^model\s*[:]/i)) {
        result.model = cleanValue(extractAfterLabel(line, nextLine));
      }
      if (!result.serialNumber &&
          lower.match(/^(serial|serial\s*#|serial\s*no|serial\s*number|s\/n|sn)\s*[:]/i)) {
        result.serialNumber = cleanValue(extractAfterLabel(line, nextLine));
      }
      if (!result.issueDescription &&
          lower.match(/^(description|issue|problem|fault|symptom|complaint|defect|reason for return)\s*[:]/i)) {
        let desc  = cleanValue(extractAfterLabel(line, nextLine));
        let extra = 1;
        while (extra <= 3 && i + extra < lines.length) {
          const cont = lines[i + extra].trim();
          if (cont.match(/^[A-Z][a-z ]{2,}[\s:]/) || cont === '') break;
          desc += ' ' + cont;
          extra++;
        }
        result.issueDescription = cleanValue(desc);
      }
      if (!result.warrantyStatus && lower.includes('warranty') && lower.includes(':')) {
        const val = cleanValue(extractAfterLabel(line, nextLine));
        if (val) {
          if (/yes|in.?warranty|under/i.test(val))       result.warrantyStatus = 'Yes';
          else if (/no|out|expired/i.test(val))          result.warrantyStatus = 'No';
          else                                            result.warrantyStatus = val;
        }
      }
    }

    if (!result.make) result.make = detectBrand(lines.join(' '));
    return result;
  }

  // ============================================================
  // Main dispatcher
  // ============================================================
  function parseRMAFields(text, formData) {
    if (!text) {
      return { make: '', model: '', serialNumber: '',
               issueDescription: '', warrantyStatus: '', notes: '' };
    }
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Use the Dune Blue-specific parser if this form is from duneblue.com
    if (text.toLowerCase().includes('duneblue.com') || text.toLowerCase().includes('dune blue')) {
      console.log('[PDFParser] Detected Dune Blue form — using structured parser');
      return parseDuneBlueForm(lines, formData);
    }

    // Fallback for any other PDF format
    return parseGenericRMAFields(lines, formData);
  }

  // ============================================================
  // Invoice date extraction — used to infer warranty status
  // when the RMA PDF itself does not carry that information.
  // ============================================================

  // Month name → number, multi-language (EN/NL/FR/DE/DA/SV/IT)
  const MONTHS = {
    jan:1, january:1, januari:1, janvier:1, januar:1, gennaio:1,
    feb:2, february:2, februari:2, février:2, fevrier:2, februar:2, febbraio:2,
    mar:3, mrt:3, march:3, mars:3, maart:3, märz:3, maerz:3, marzo:3, marts:3,
    apr:4, april:4, avril:4, aprile:4,
    may:5, mai:5, mei:5, maj:5, maggio:5,
    jun:6, june:6, juni:6, juin:6, giugno:6,
    jul:7, july:7, juli:7, juillet:7, luglio:7,
    aug:8, august:8, augustus:8, août:8, aout:8, agosto:8, augusti:8,
    sep:9, sept:9, september:9, septembre:9, settembre:9,
    oct:10, okt:10, oktober:10, october:10, octobre:10, ottobre:10,
    nov:11, november:11, novembre:11,
    dec:12, december:12, décembre:12, decembre:12, dezember:12, dicembre:12,
  };

  // Try to parse a date string in any of the common European formats.
  // Returns a Date object on success, null on failure.
  function parseDateStr(s) {
    if (!s) return null;
    s = s.trim();

    // YYYY-MM-DD (optionally followed by time: "2023-09-30 14:30")
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const [y, mo, d] = [+m[1], +m[2], +m[3]];
      if (y >= 2010 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
        return new Date(y, mo - 1, d);
    }

    // DD-MM-YYYY / DD.MM.YYYY / DD/MM/YYYY (optionally followed by time)
    m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/);
    if (m) {
      const [d, mo, y] = [+m[1], +m[2], +m[3]];
      if (y >= 2010 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
        return new Date(y, mo - 1, d);
    }

    // DD MonthName YYYY  — e.g. "14 mars 2022", "06 jan. 2026", "21 november 2025"
    m = s.match(/^(\d{1,2})\s+([a-zA-ZÀ-ÿ]+)\.?\s+(\d{4})$/);
    if (m) {
      const mo = MONTHS[m[2].toLowerCase().replace(/\.$/, '')];
      if (mo) {
        const [d, y] = [+m[1], +m[3]];
        if (y >= 2010 && d >= 1 && d <= 31) return new Date(y, mo - 1, d);
      }
    }

    // WeekdayName DD MonthName YYYY  — e.g. "Vrijdag 06 Februari 2026"
    m = s.match(/^\S+\s+(\d{1,2})\s+([a-zA-ZÀ-ÿ]+)\s+(\d{4})$/);
    if (m) {
      const mo = MONTHS[m[2].toLowerCase()];
      if (mo) {
        const [d, y] = [+m[1], +m[3]];
        if (y >= 2010 && d >= 1 && d <= 31) return new Date(y, mo - 1, d);
      }
    }

    // MonthName DD, YYYY  — e.g. "January 15, 2026"
    m = s.match(/^([a-zA-ZÀ-ÿ]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m) {
      const mo = MONTHS[m[1].toLowerCase()];
      if (mo) {
        const [d, y] = [+m[2], +m[3]];
        if (y >= 2010 && d >= 1 && d <= 31) return new Date(y, mo - 1, d);
      }
    }

    return null;
  }

  // Scan invoice text for a purchase/invoice date.
  // Strategy 1: look for a labeled date keyword on the same line or nearby.
  // Strategy 2: fallback — scan every short line for any parseable date.
  function extractInvoiceDate(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const today = new Date();

    // Regex matching lines that introduce an invoice/purchase date
    const DATE_LABEL = /^(factuurdatum|invoice[\s\-]?date|datum|dato|date|fakturadatum|fakturadato|rechnungsdatum|data\s+fattura|order[\s\-]?date|purchase[\s\-]?date|sale[\s\-]?date|besteldatum|verkoopdatum|aankoopdatum|datum\s+van\s+aankoop|order\s+placed|sold\s+on)\s*[:\-]?\s*/i;

    // Strategy 1 – labeled date
    for (let i = 0; i < lines.length; i++) {
      const lm = lines[i].match(DATE_LABEL);
      if (!lm) continue;

      // Value may be on the same line after the label
      const rest = lines[i].slice(lm[0].length).trim();
      if (rest) {
        const d = parseDateStr(rest);
        if (d && d <= today) {
          console.log(`[PDFParser] Invoice date (labeled): ${d.toISOString().slice(0, 10)}`);
          return d;
        }
      }

      // Or on one of the next few lines (handles "Datum\nVervaldatum\nFactuur\n03-12-2025")
      for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
        const d = parseDateStr(lines[j]);
        if (d && d <= today) {
          console.log(`[PDFParser] Invoice date (after label): ${d.toISOString().slice(0, 10)}`);
          return d;
        }
      }
    }

    // Strategy 2 – bare date fallback: scan every short line for any parseable date.
    // Many shop receipts/invoices simply print the date without a label.
    // Restrict to short lines (≤ 35 chars) to avoid matching numbers inside addresses
    // or reference strings. Only accept past dates.
    for (const line of lines) {
      if (line.length > 35) continue;
      const d = parseDateStr(line);
      if (d && d <= today) {
        console.log(`[PDFParser] Invoice date (fallback scan): ${d.toISOString().slice(0, 10)}`);
        return d;
      }
    }

    return null;
  }

  // ============================================================
  // Full process: open PDF, extract text + form data, parse fields
  // ============================================================
  async function processPDF(arrayBuffer, filename) {
    try {
      // Open PDF once — reuse for both text and annotation extraction
      const copy = arrayBuffer.slice(0);
      const pdf  = await pdfjsLib.getDocument({ data: copy }).promise;

      const text        = await extractTextFromPDF(pdf);
      const formData    = await extractFormData(pdf);
      // Primary classifier: RMA form vs invoice.
      // A PDF is an RMA form if it matches the Dune Blue template structure.
      // Everything else (shop receipts, web-shop PDFs, etc.) is treated as an
      // invoice — we extract its purchase date to infer warranty status.
      const rmaForm     = isRMAForm(text);
      const invoice     = !rmaForm;
      const fields      = rmaForm ? parseRMAFields(text, formData) : {};
      const invoiceDate = invoice ? extractInvoiceDate(text) : null;

      console.log('[PDFParser] Raw text (first 600 chars):\n', text.substring(0, 600));
      console.log('[PDFParser] Parsed fields:', JSON.stringify(fields));

      return { isInvoice: invoice, rawText: text, fields, invoiceDate };
    } catch (err) {
      console.error('[PDFParser] processPDF error:', err);
      return { isInvoice: false, rawText: '', fields: {}, invoiceDate: null };
    }
  }

  return { isRMAForm, parseRMAFields, processPDF };
})();
