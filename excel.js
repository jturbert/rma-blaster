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
    { header:'Notes',                key:'notes'            }
  ];

  async function getFilename() {
    return (await Storage.getSetting('excelFilename')) || DEFAULT_FILENAME;
  }

  function buildWorkbook(entries) {
    const wb     = XLSX.utils.book_new();
    const sorted = [...entries].sort((a,b) => parseInt(a.rmaNumber||0)-parseInt(b.rmaNumber||0));
    const rows   = [COLUMNS.map(c=>c.header), ...sorted.map(e => COLUMNS.map(c=>e[c.key]||''))];
    const ws     = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols']  = [8,8,12,20,14,18,16,40,14,14,30,16,30,30].map(w=>({wch:w}));
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

  return { downloadExcel, downloadCopyAs, downloadBrandExcel, DEFAULT_FILENAME, getFilename };
})();
