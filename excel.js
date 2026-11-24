// ============================================================
// RMA Manager (Web version) - Excel Handler
// All exports are browser downloads — works on Mac, PC, iPad.
// On iPad: files land in the Files app (Downloads / iCloud Drive).
// ============================================================

const Excel = (() => {
  const DEFAULT_FILENAME = 'RMA_Log.xlsx';
  const SHEETNAME        = 'RMA Log';

  const COLUMNS = [
    { header:'Status',               key:'status'           },
    { header:'RMA #',                key:'rmaNumber'        },
    { header:'Date',                 key:'date'             },
    { header:'Dealer',               key:'dealer'           },
    { header:'Make',                 key:'make'             },
    { header:'Model',                key:'model'            },
    { header:'Serial #',             key:'serialNumber'     },
    { header:'Description of Issue', key:'issueDescription' },
    { header:'Issue Confirmed',      key:'issueConfirmed'   },
    { header:'Warranty Status',      key:'warrantyStatus'   },
    { header:'Course of Action',     key:'courseOfAction'   },
    { header:'Date of Resolution',   key:'dateOfResolution' },
    { header:'How Resolved',         key:'howResolved'      },
    { header:'Notes',                key:'notes'            },
    // Last, so every existing column keeps its letter for anyone with
    // formulas or habits built on the old layout. Stored as keys; the
    // sheet gets the readable names from flags.js.
    { header:'Flags',                value: e => Flags.labels(e.flags).join(', ') },
    { header:'Purchase Date',        key:'purchaseDate'     }
  ];

  async function getFilename() {
    return (await Storage.getSetting('excelFilename')) || DEFAULT_FILENAME;
  }

  function buildWorkbook(entries) {
    const wb     = XLSX.utils.book_new();
    const sorted = [...entries].sort((a,b) => parseInt(a.rmaNumber||0)-parseInt(b.rmaNumber||0));
    const rows   = [COLUMNS.map(c=>c.header), ...sorted.map(e => COLUMNS.map(c => c.value ? c.value(e) : (e[c.key]||'')))];
    const ws     = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols']  = [8,8,12,20,14,18,16,40,14,14,30,16,30,30,34,12].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, SHEETNAME);
    return wb;
  }

  // Download the main Excel file
  async function downloadExcel(entries) {
    const filename = await getFilename();
    XLSX.writeFile(buildWorkbook(entries), filename);
    return filename;
  }

  // Download a named copy (for archiving / duplicate versions)
  async function downloadCopyAs(entries, customName) {
    if (!customName) throw new Error('No filename provided');
    if (!customName.toLowerCase().endsWith('.xlsx')) customName += '.xlsx';
    XLSX.writeFile(buildWorkbook(entries), customName);
    return customName;
  }

  // Supplier-facing columns for brand export
  const SUPPLIER_COLUMNS = [
    { header:'RMA #',                key:'rmaNumber'        },
    { header:'Date Submitted',       key:'date'             },
    { header:'Model',                key:'model'            },
    { header:'Serial #',             key:'serialNumber'     },
    { header:'Description of Issue', key:'issueDescription' },
    { header:'How Resolved',         key:'howResolved'      }
  ];

  // Download a supplier-ready spreadsheet (filtered by brand / date range)
  function downloadBrandExcel(entries, filename) {
    if (!filename.toLowerCase().endsWith('.xlsx')) filename += '.xlsx';
    const wb     = XLSX.utils.book_new();
    const sorted = [...entries].sort((a,b) => parseInt(a.rmaNumber||0)-parseInt(b.rmaNumber||0));
    const rows   = [SUPPLIER_COLUMNS.map(c=>c.header), ...sorted.map(e => SUPPLIER_COLUMNS.map(c=>e[c.key]||''))];
    const ws     = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols']  = [8,14,20,16,44,34].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'RMA Log');
    XLSX.writeFile(wb, filename);
    return filename;
  }

  // ----------------------------------------------------------
  // Manufacturer sheet: the "Noble RMAs / November 2026" layout
  // Jim used to build by hand in Numbers. Built with ExcelJS rather
  // than SheetJS because SheetJS (free build) can't write fonts,
  // borders or images.
  // ----------------------------------------------------------
  const MAKER_COLUMNS = [
    { header:'RMA#',                    width:10,  value: e => parseInt(e.rmaNumber, 10) || e.rmaNumber || '', align:'right' },
    { header:'Model',                   width:20, value: e => e.model || '' },
    { header:'Serial Number',           width:22, value: e => e.serialNumber || '' },
    { header:'Purchase Date',           width:15, value: e => dayMonthYear(e.purchaseDate) },
    { header:'Warranty Status (In/Out)',width:19, value: e => warrantyInOut(e.warrantyStatus) },
    { header:'Issue Description',       width:36, value: e => e.issueDescription || '' },
    { header:'Notes',                   width:26, value: e => e.howResolved || '' }
  ];
  const BLANK_ROWS  = 15;            // empty ruled rows at the end, like the original
  const BLUE        = 'FF1F5C99';
  const GRID        = 'FFA6A6A6';
  const TITLE_FONT  = 'Futura';
  const BODY_FONT   = 'Helvetica Neue';

  // 2025-09-24 → 24/9/2025, the way the sheet's notes write dates.
  function dayMonthYear(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${+m[3]}/${+m[2]}/${m[1]}` : (iso || '');
  }

  function warrantyInOut(w) {
    if (w === 'Yes' || w === 'In Warranty') return 'In';
    if (w === 'No' || w === 'Out of Warranty' || w === 'Expired') return 'Out';
    return '';
  }

  function makerFilename(brand, when) {
    const month = when.toLocaleString('en-US', { month: 'long' }).toLowerCase();
    return `${brand.replace(/\s+/g, '_')}_rma_${month}_${when.getFullYear()}.xlsx`;
  }

  async function downloadManufacturerSheet(entries, brand, when = new Date()) {
    if (typeof ExcelJS === 'undefined') throw new Error('The spreadsheet library did not load. Reload the page and try again.');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${brand} RMAs`.slice(0, 31), {
      views: [{ showGridLines: false }],
      pageSetup: {
        paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left:0.4, right:0.4, top:0.5, bottom:0.5, header:0.3, footer:0.3 }
      },
      headerFooter: { oddFooter: '&C&P' }
    });
    ws.columns = MAKER_COLUMNS.map(c => ({ width: c.width }));

    // Title block: rows 1-3, logo on the right
    ws.getRow(1).height = 46;
    ws.getRow(2).height = 22;
    ws.getRow(3).height = 14;
    ws.getCell('A1').value = `${brand} RMAs`;
    ws.getCell('A1').font  = { name: TITLE_FONT, size: 36, bold: true };
    ws.getCell('A1').alignment = { vertical: 'bottom' };
    ws.getCell('A2').value = when.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    ws.getCell('A2').font  = { name: TITLE_FONT, size: 16, bold: true };

    try {
      const res = await fetch('report-logo.png');
      if (res.ok) {
        const id = wb.addImage({ buffer: await res.arrayBuffer(), extension: 'png' });
        ws.addImage(id, { tl: { col: 5.6, row: 0.1 }, ext: { width: 330, height: 105 }, editAs: 'oneCell' });
      }
    } catch (_) { /* sheet still works without the logo */ }

    // Header row
    const HEAD = 5;
    const head = ws.getRow(HEAD);
    head.height = 44;
    MAKER_COLUMNS.forEach((c, i) => {
      const cell = head.getCell(i + 1);
      cell.value = c.header;
      cell.font  = { name: TITLE_FONT, size: 13, bold: true };
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = {
        top:    { style: 'thin',  color: { argb: BLUE } },
        left:   { style: i === 0 ? 'thin' : 'hair', color: { argb: i === 0 ? BLUE : GRID } },
        right:  { style: i === MAKER_COLUMNS.length - 1 ? 'thin' : 'hair', color: { argb: i === MAKER_COLUMNS.length - 1 ? BLUE : GRID } },
        bottom: { style: 'thin', color: { argb: BLUE } }
      };
    });

    // The solid blue bar under the header. A filled row rather than a
    // thick border: Numbers draws thick borders as thin ones.
    const bar = ws.getRow(HEAD + 1);
    bar.height = 6;
    MAKER_COLUMNS.forEach((c, i) => {
      bar.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B4A7F' } };
    });

    // Data rows, then blank ruled rows
    const sorted = [...entries].sort((a, b) => (parseInt(a.rmaNumber, 10) || 0) - (parseInt(b.rmaNumber, 10) || 0));
    const rows   = [...sorted.map(e => MAKER_COLUMNS.map(c => c.value(e))),
                    ...Array.from({ length: BLANK_ROWS }, () => MAKER_COLUMNS.map(() => ''))];
    const gridSide = { style: 'thin', color: { argb: GRID } };
    rows.forEach((vals, r) => {
      const row = ws.getRow(HEAD + 2 + r);
      vals.forEach((v, i) => {
        const cell = row.getCell(i + 1);
        cell.value = v;
        cell.font  = { name: BODY_FONT, size: 11 };
        cell.alignment = { vertical: 'bottom', wrapText: true, horizontal: MAKER_COLUMNS[i].align || 'left' };
        cell.border = { top: gridSide, left: gridSide, right: gridSide, bottom: gridSide };
      });
    });

    ws.pageSetup.printTitlesRow = `${HEAD}:${HEAD}`;

    const filename = makerFilename(brand, when);
    const buf  = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return filename;
  }

  return { downloadExcel, downloadCopyAs, downloadBrandExcel, downloadManufacturerSheet, DEFAULT_FILENAME, getFilename };
})();
