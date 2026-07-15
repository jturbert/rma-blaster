// ============================================================
// RMA Blaster v2 - Main Application Controller
//   • Shared Supabase database — same data on every device
//   • Email/password logins per team member (no Google OAuth)
//   • PDFs in cloud storage, fetched on demand
//   • Entries created manually or imported from a v1 backup;
//     automated email ingestion is planned as a separate service
// ============================================================

const App = (() => {
  let allEntries    = [];
  let currentFilter = 'all';
  let currentSearch = '';
  let sortField     = 'rmaNumber';
  let sortAsc       = false;
  let editingId     = null;
  let editingPDFs   = [];
  let isNewEntry    = false;

  // ============================================================
  // INIT & AUTH
  // ============================================================
  function isConfigured(url, key) {
    return !!(url && key &&
              !url.includes('YOUR_SUPABASE') && !key.includes('YOUR_SUPABASE'));
  }

  async function init() {
    // Settings-panel values override config.js
    const savedUrl  = await Storage.getSetting('supabaseUrl');
    const savedKey  = await Storage.getSetting('supabaseAnonKey');
    const url = savedUrl || CONFIG.supabaseUrl;
    const key = savedKey || CONFIG.supabaseAnonKey;

    document.getElementById('s-supa-url').value   = isConfigured(url, key) ? url : '';
    document.getElementById('s-supa-key').value   = isConfigured(url, key) ? key : '';
    document.getElementById('s-excel-name').value =
      (await Storage.getSetting('excelFilename')) || Excel.DEFAULT_FILENAME;

    if (!isConfigured(url, key)) {
      document.getElementById('setup-banner').style.display = 'flex';
      showSection('settings');
      return;
    }

    const client = Storage.init(url, key);

    client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') showLogin();
    });

    const { data: { session } } = await client.auth.getSession();
    if (session) {
      await enterApp(session.user);
    } else {
      showLogin();
    }
  }

  function showLogin() {
    document.getElementById('login-overlay').style.display = 'flex';
    document.getElementById('auth-btn').style.display      = 'none';
    document.getElementById('user-name').textContent       = '';
    document.getElementById('new-rma-btn').disabled        = true;
  }

  async function enterApp(user) {
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('auth-btn').style.display      = '';
    document.getElementById('user-name').textContent       = user.email || '';
    document.getElementById('new-rma-btn').disabled        = false;
    await refreshTable();
  }

  async function handleLogin(event) {
    event.preventDefault();
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl    = document.getElementById('login-error');
    const btn      = document.getElementById('login-btn');
    errEl.style.display = 'none';
    btn.disabled = true;
    try {
      const { data, error } = await Storage.client().auth.signInWithPassword({ email, password });
      if (error) {
        errEl.textContent   = error.message === 'Invalid login credentials'
          ? 'Wrong email or password.' : error.message;
        errEl.style.display = 'block';
        return;
      }
      document.getElementById('login-password').value = '';
      await enterApp(data.user);
    } catch (err) {
      errEl.textContent   = 'Connection failed: ' + err.message;
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  }

  async function handleAuthClick() {
    await Storage.client().auth.signOut();
    showLogin();
  }

  // ============================================================
  // SETTINGS
  // ============================================================
  async function saveSettings() {
    const url = document.getElementById('s-supa-url').value.trim();
    const key = document.getElementById('s-supa-key').value.trim();
    if (!url || !key) { showToast('Please enter both the project URL and the anon key.', 'error'); return; }
    await Storage.setSetting('supabaseUrl', url);
    await Storage.setSetting('supabaseAnonKey', key);
    showToast('Saved. Reloading...', 'success');
    setTimeout(() => location.reload(), 1200);
  }

  async function saveExcelName() {
    let name = document.getElementById('s-excel-name').value.trim();
    if (!name) { showToast('Please enter a filename.', 'error'); return; }
    if (!name.toLowerCase().endsWith('.xlsx')) name += '.xlsx';
    document.getElementById('s-excel-name').value = name;
    await Storage.setSetting('excelFilename', name);
    showToast('Excel filename set to: ' + name, 'success');
  }

  async function saveCopyAs() {
    let name = document.getElementById('s-copy-name').value.trim();
    if (!name) { showToast('Please enter a name for the copy.', 'error'); return; }
    if (!name.toLowerCase().endsWith('.xlsx')) name += '.xlsx';
    const entries = await Storage.getAllEntries();
    if (!entries.length) { showToast('No data to export.', 'error'); return; }
    try {
      await Excel.downloadCopyAs(entries, name);
      showToast('Downloading copy: ' + name, 'success');
      document.getElementById('s-copy-name').value = '';
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  // ============================================================
  // WARRANTY INFERENCE
  // ============================================================
  const WARRANTY_PERIOD_DAYS = 730;   // 2-year warranty window

  // Whole days between the invoice (purchase) date and the RMA date.
  // Returns null when either date is missing/unparseable or the
  // invoice postdates the RMA (bad parse — don't infer from it).
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

  // ============================================================
  // TABLE
  // ============================================================
  async function refreshTable() {
    try {
      allEntries = await Storage.getAllEntries();
    } catch (err) {
      showToast('Could not load entries: ' + err.message, 'error');
      return;
    }
    applyFilterAndRender();
    updateStats(allEntries);
  }

  function applyFilterAndRender() {
    let list = allEntries;
    if (currentFilter === 'open')   list = list.filter(e => e.status === 'Open');
    if (currentFilter === 'closed') list = list.filter(e => e.status === 'Closed');
    if (currentSearch) {
      const q = currentSearch.toLowerCase();
      list = list.filter(e =>
        ['rmaNumber','dealer','make','model','serialNumber','issueDescription','notes']
          .some(k => (e[k]||'').toLowerCase().includes(q))
      );
    }
    list.sort((a,b) => {
      let va = a[sortField]||'', vb = b[sortField]||'';
      if (sortField === 'rmaNumber') { va = parseInt(va)||0; vb = parseInt(vb)||0; }
      return sortAsc ? (va < vb ? -1 : va > vb ? 1 : 0) : (va > vb ? -1 : va < vb ? 1 : 0);
    });
    renderTable(list);
  }

  function warrantyBadge(w) {
    if (!w) return '<span class="warr-badge warr-unknown">—</span>';
    if (w === 'Yes' || w === 'In Warranty')     return '<span class="warr-badge warr-in">Yes</span>';
    if (w === 'No'  || w === 'Out of Warranty') return '<span class="warr-badge warr-out">No</span>';
    if (w === 'Expired')                        return '<span class="warr-badge warr-exp">Exp</span>';
    return `<span class="warr-badge warr-unknown">${esc(w)}</span>`;
  }

  function replacedBadge(r) {
    if (!r) return '<span class="repl-badge repl-unknown">—</span>';
    if (r === 'Stock')     return '<span class="repl-badge repl-stock">Stock</span>';
    if (r === 'Warehouse') return '<span class="repl-badge repl-warehouse">Warehouse</span>';
    if (r === 'Waiting')   return '<span class="repl-badge repl-waiting">Waiting</span>';
    if (r === 'Credit')    return '<span class="repl-badge repl-credit">Credit</span>';
    if (r === 'Repaired')  return '<span class="repl-badge repl-repaired">Repaired</span>';
    return `<span class="repl-badge repl-unknown">${esc(r)}</span>`;
  }

  function truncate(s, max) {
    if (!s) return '';
    return s.length > max ? esc(s.substring(0, max)) + '…' : esc(s);
  }

  function renderTable(entries) {
    const tbody = document.getElementById('rma-tbody');
    if (!entries.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="11"><div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        <p>${allEntries.length ? 'No records match the filter.' : 'No RMA records yet.'}</p>
        <p class="empty-sub">${allEntries.length ? 'Try adjusting the search or filter.' : 'Click <strong>New RMA</strong> or restore a backup in Settings.'}</p>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = entries.map(e => `<tr>
      <td><span class="badge ${e.status==='Closed'?'badge-closed':'badge-open'}"><span class="badge-dot"></span>${e.status}</span></td>
      <td><span class="rma-num">#${esc(e.rmaNumber)}</span></td>
      <td class="col-date">${esc(e.date)}</td>
      <td><span class="dealer-name">${esc(e.dealer)}</span></td>
      <td>${esc(e.make)}</td>
      <td><span class="model-cell">${esc(e.model)}</span></td>
      <td class="col-serial" title="${esc(e.serialNumber)}">${esc(e.serialNumber)}</td>
      <td class="col-warranty">${warrantyBadge(e.warrantyStatus)}</td>
      <td class="col-truncate" title="${esc(e.issueDescription)}">${truncate(e.issueDescription, 45)}</td>
      <td class="col-replaced">${replacedBadge(e.replacedFrom)}</td>
      <td><div class="action-btns"><button class="btn-icon" title="Edit" onclick="App.openModal(${e.id})">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button></div></td>
    </tr>`).join('');
  }

  function updateStats(entries) {
    document.getElementById('stat-total').textContent  = entries.length;
    document.getElementById('stat-open').textContent   = entries.filter(e=>e.status==='Open').length;
    document.getElementById('stat-closed').textContent = entries.filter(e=>e.status==='Closed').length;
  }

  function setFilter(f, el) {
    currentFilter = f;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    applyFilterAndRender();
  }
  function onSearch(v) { currentSearch = v.trim(); applyFilterAndRender(); }
  function sortBy(field) {
    sortAsc = sortField === field ? !sortAsc : true;
    sortField = field;
    applyFilterAndRender();
  }

  // ============================================================
  // STATISTICS
  // ============================================================
  function computeStats(entries) {
    const total     = entries.length;
    const open      = entries.filter(e => e.status==='Open').length;
    const closed    = entries.filter(e => e.status==='Closed').length;
    const confirmed = entries.filter(e => e.issueConfirmed==='Yes').length;
    const notConf   = entries.filter(e => e.issueConfirmed==='No').length;
    const pending   = entries.filter(e => !e.issueConfirmed||e.issueConfirmed==='').length;
    const inWarr    = entries.filter(e => e.warrantyStatus==='Yes' || e.warrantyStatus==='In Warranty').length;
    const outWarr   = entries.filter(e => e.warrantyStatus==='No'  || e.warrantyStatus==='Out of Warranty').length;
    const expWarr   = entries.filter(e => e.warrantyStatus==='Expired').length;
    const unknWarr  = total - inWarr - outWarr - expWarr;

    const dealerMap = {};
    for (const e of entries) {
      const k = e.dealer || 'Unknown';
      if (!dealerMap[k]) dealerMap[k] = { open:0, closed:0 };
      e.status==='Closed' ? dealerMap[k].closed++ : dealerMap[k].open++;
    }
    const dealers = Object.entries(dealerMap)
      .map(([name,d]) => ({ name, open:d.open, closed:d.closed, total:d.open+d.closed }))
      .sort((a,b) => b.total-a.total).slice(0,12);

    const makeMap = {};
    for (const e of entries) {
      const k = e.make || 'Unknown';
      if (!makeMap[k]) makeMap[k] = { open:0, closed:0 };
      e.status==='Closed' ? makeMap[k].closed++ : makeMap[k].open++;
    }
    const makes = Object.entries(makeMap)
      .map(([name,d]) => ({ name, open:d.open, closed:d.closed, total:d.open+d.closed }))
      .sort((a,b) => b.total-a.total).slice(0,12);

    const modelMap = {};
    for (const e of entries) {
      if (!e.model) continue;
      if (!modelMap[e.model]) modelMap[e.model] = { make: e.make||'', open:0, closed:0 };
      e.status==='Closed' ? modelMap[e.model].closed++ : modelMap[e.model].open++;
    }
    const models = Object.entries(modelMap)
      .map(([name,d]) => ({ name, make:d.make, open:d.open, closed:d.closed, total:d.open+d.closed }))
      .sort((a,b) => b.total-a.total).slice(0,15);

    const monthly = {};
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = d.toISOString().substring(0,7);
      monthly[k] = { label: d.toLocaleDateString('en-US',{month:'short',year:'2-digit'}), count:0 };
    }
    for (const e of entries) {
      if (e.date) {
        const k = e.date.substring(0,7);
        if (monthly[k]) monthly[k].count++;
      }
    }

    return { total, open, closed, confirmed, notConf, pending,
             inWarr, outWarr, expWarr, unknWarr,
             dealers, makes, models, monthly: Object.values(monthly) };
  }

  function renderStats() {
    const s   = computeStats(allEntries);
    const pct = (n, d) => d > 0 ? Math.round((n/d)*100) : 0;

    document.getElementById('stats-empty').style.display   = s.total ? 'none'  : 'block';
    document.getElementById('stats-content').style.display = s.total ? 'block' : 'none';
    document.getElementById('stats-subtitle').textContent  =
      s.total ? `Based on ${s.total} entr${s.total===1?'y':'ies'}` : '';
    if (!s.total) return;

    document.getElementById('sv-total').textContent    = s.total;
    document.getElementById('sv-open').textContent     = s.open;
    document.getElementById('sv-closed').textContent   = s.closed;
    document.getElementById('sv-confirm').textContent  = pct(s.confirmed,s.total)+'%';
    document.getElementById('sv-notconf').textContent  = s.notConf;
    document.getElementById('sv-warranty').textContent = pct(s.inWarr,s.total)+'%';

    const maxTotal   = (arr) => Math.max(...arr.map(x=>x.total), 1);
    const stackedBars = (arr, containerId) => {
      const mx = maxTotal(arr);
      document.getElementById(containerId).innerHTML = arr.map(item => `
        <div class="bar-row">
          <div class="bar-label" title="${esc(item.name)}">${esc(item.name)}</div>
          <div class="bar-track">
            <div class="bar-fill-open"   style="width:${pct(item.open,mx)}%"></div>
            <div class="bar-fill-closed" style="width:${pct(item.closed,mx)}%"></div>
          </div>
          <div class="bar-count">${item.total}</div>
        </div>`).join('') || '<p class="stats-empty">No data</p>';
    };
    stackedBars(s.dealers, 'chart-dealer');
    stackedBars(s.makes,   'chart-brand');

    const maxMonth = Math.max(...s.monthly.map(m=>m.count), 1);
    document.getElementById('chart-monthly').innerHTML = `
      <div class="monthly-grid">
        ${s.monthly.map(m => `
          <div class="month-col">
            <div class="month-count">${m.count||''}</div>
            <div class="month-bar-wrap">
              <div class="month-bar" style="height:${pct(m.count,maxMonth)}%"></div>
            </div>
            <div class="month-label">${m.label}</div>
          </div>`).join('')}
      </div>`;

    const breakdown = (items, containerId) => {
      const tot = items.reduce((a,x)=>a+x.count,0)||1;
      document.getElementById(containerId).innerHTML = items.map(item => `
        <div class="breakdown-row">
          <div class="breakdown-label">${esc(item.label)}</div>
          <div class="breakdown-track">
            <div class="breakdown-fill" style="width:${pct(item.count,tot)}%;background:${item.color}"></div>
          </div>
          <div class="breakdown-pct">${pct(item.count,tot)}%</div>
          <div class="bar-count">${item.count}</div>
        </div>`).join('');
    };

    breakdown([
      { label:'Yes',     count:s.inWarr,   color:'#16a34a' },
      { label:'No',      count:s.outWarr,  color:'#dc2626' },
      { label:'Expired', count:s.expWarr,  color:'#9ca3af' },
      { label:'Unknown', count:s.unknWarr, color:'#d1d5db' }
    ], 'chart-warranty');

    breakdown([
      { label:'Confirmed',     count:s.confirmed, color:'#2563eb' },
      { label:'Not Confirmed', count:s.notConf,   color:'#dc2626' },
      { label:'Pending',       count:s.pending,   color:'#d1d5db' }
    ], 'chart-confirm');

    document.getElementById('chart-models').innerHTML = s.models.length ? `
      <table class="model-table-inner">
        <thead><tr><th>#</th><th>Model</th><th>Make</th><th>Total</th><th>Open</th><th>Closed</th></tr></thead>
        <tbody>${s.models.map((m,i) => `
          <tr>
            <td>${i+1}</td>
            <td><strong>${esc(m.name)}</strong></td>
            <td>${esc(m.make)}</td>
            <td>${m.total}</td>
            <td style="color:var(--amber)">${m.open}</td>
            <td style="color:var(--green)">${m.closed}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<p class="stats-empty">No model data yet.</p>';
  }

  // ============================================================
  // MODAL (edit existing / create new)
  // ============================================================
  function fillModal(entry) {
    document.getElementById('m-id').value        = entry.id || '';
    document.getElementById('m-rma').value       = entry.rmaNumber        || '';
    document.getElementById('m-date').value      = entry.date             || '';
    document.getElementById('m-dealer').value    = entry.dealer           || '';
    document.getElementById('m-make').value      = entry.make             || '';
    document.getElementById('m-model').value     = entry.model            || '';
    document.getElementById('m-serial').value    = entry.serialNumber     || '';
    document.getElementById('m-issue').value     = entry.issueDescription || '';
    document.getElementById('m-confirmed').value = entry.issueConfirmed   || '';
    const wNorm = entry.warrantyStatus === 'In Warranty'      ? 'Yes'
                : entry.warrantyStatus === 'Out of Warranty'  ? 'No'
                : entry.warrantyStatus || '';
    document.getElementById('m-warranty').value       = wNorm;
    document.getElementById('m-action').value         = entry.courseOfAction   || '';
    document.getElementById('m-resolved-date').value  = entry.dateOfResolution || '';
    document.getElementById('m-resolved-how').value   = entry.howResolved      || '';
    document.getElementById('m-replaced-from').value  = entry.replacedFrom     || '';
    document.getElementById('m-notes').value          = entry.notes            || '';

    const toggle = document.getElementById('m-status-toggle');
    toggle.checked = entry.status === 'Closed';
    document.getElementById('m-status-label').textContent = entry.status || 'Open';
  }

  function collectModalFields() {
    return {
      status:           document.getElementById('m-status-toggle').checked ? 'Closed' : 'Open',
      rmaNumber:        document.getElementById('m-rma').value.trim(),
      date:             document.getElementById('m-date').value,
      dealer:           document.getElementById('m-dealer').value.trim(),
      make:             document.getElementById('m-make').value.trim(),
      model:            document.getElementById('m-model').value.trim(),
      serialNumber:     document.getElementById('m-serial').value.trim(),
      issueDescription: document.getElementById('m-issue').value.trim(),
      issueConfirmed:   document.getElementById('m-confirmed').value,
      warrantyStatus:   document.getElementById('m-warranty').value,
      courseOfAction:   document.getElementById('m-action').value.trim(),
      dateOfResolution: document.getElementById('m-resolved-date').value,
      howResolved:      document.getElementById('m-resolved-how').value.trim(),
      replacedFrom:     document.getElementById('m-replaced-from').value,
      notes:            document.getElementById('m-notes').value.trim()
    };
  }

  async function openModal(id) {
    const entry = await Storage.getEntry(id);
    if (!entry) return;
    editingId  = id;
    isNewEntry = false;

    document.getElementById('modal-title').textContent = `RMA #${entry.rmaNumber} — ${entry.dealer}`;
    document.getElementById('m-rma').setAttribute('readonly', '');
    document.getElementById('m-archive-btn').style.display = '';
    fillModal(entry);

    editingPDFs = await Storage.getPDFsForEntry(id);
    renderModalFileList();

    document.getElementById('edit-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function openNewModal() {
    editingId  = null;
    isNewEntry = true;

    // Suggest the next RMA number (numeric max + 1); editable
    const maxRma = allEntries.reduce((mx, e) => Math.max(mx, parseInt(e.rmaNumber) || 0), 0);
    fillModal({
      rmaNumber: maxRma ? String(maxRma + 1) : '',
      date: new Date().toISOString().split('T')[0],
      status: 'Open'
    });
    document.getElementById('modal-title').textContent = 'New RMA';
    document.getElementById('m-rma').removeAttribute('readonly');
    document.getElementById('m-archive-btn').style.display = 'none';

    editingPDFs = [];
    renderModalFileList();

    document.getElementById('edit-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  // Create the entry from current modal fields if it doesn't exist yet.
  // Used when a PDF is uploaded before the first save of a new entry.
  async function ensureEntrySaved() {
    if (editingId) return editingId;
    const fields = collectModalFields();
    if (!fields.rmaNumber) throw new Error('Enter an RMA number first.');
    const dupe = await Storage.entryByRmaNumber(fields.rmaNumber);
    if (dupe) throw new Error(`RMA #${fields.rmaNumber} already exists.`);
    editingId  = await Storage.saveEntry(fields);
    isNewEntry = false;
    document.getElementById('m-archive-btn').style.display = '';
    return editingId;
  }

  async function downloadPDF(idx) {
    const pdf = editingPDFs[idx];
    if (!pdf) return;
    showToast('Downloading: ' + pdf.filename);
    try {
      await Storage.downloadPDF(pdf);
    } catch (err) {
      showToast('Download failed: ' + err.message, 'error');
    }
  }

  function renderModalFileList() {
    const filesEl = document.getElementById('m-files');
    if (editingPDFs.length) {
      filesEl.innerHTML = editingPDFs.map((pdf, idx) => `
        <div class="file-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="file-name">${esc(pdf.filename)}</span>
          <span class="file-type-badge ${pdf.type==='invoice'?'file-type-inv':'file-type-rma'}">${pdf.type==='invoice'?'Invoice':'RMA Form'}</span>
          <button class="btn btn-secondary btn-sm" onclick="App.downloadPDF(${idx})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download
          </button>
        </div>`).join('');
    } else {
      filesEl.innerHTML = `<p class="no-files">${isNewEntry ? 'Save or upload — the entry is created automatically on first upload.' : 'No PDF attachments stored for this entry.'}</p>`;
    }
  }

  // Upload a PDF (type 'rma-form' or 'invoice'), store it, and use its
  // contents: form PDFs auto-fill blank fields, invoices set warranty.
  async function uploadPDF(input, type) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      await ensureEntrySaved();
      const entry  = await Storage.getEntry(editingId);
      const fields = collectModalFields();
      const fname  = Storage.buildFilename(
        entry.rmaNumber, fields.dealer || entry.dealer,
        fields.model || entry.model || 'unknown',
        fields.date || entry.date, type === 'invoice'
      );
      await Storage.savePDF(editingId, fname, buffer, type);
      editingPDFs = await Storage.getPDFsForEntry(editingId);
      renderModalFileList();

      let extraMsg = '';
      try {
        const parsed = await PDFParser.processPDF(buffer, file.name);

        if (type === 'invoice') {
          const status = inferWarrantyStatus(fields.date || entry.date, parsed.invoiceDate);
          if (status) {
            const days = daysSincePurchase(fields.date || entry.date, parsed.invoiceDate);
            document.getElementById('m-warranty').value = status;
            extraMsg = ` Warranty set to ${status} (${days} days since purchase) — save to keep it.`;
          }
        } else if (!parsed.isInvoice) {
          // RMA form: fill BLANK modal fields from the parsed PDF
          const f = parsed.fields || {};
          const fillIf = (id, val) => {
            const el = document.getElementById(id);
            if (el && !el.value && val) el.value = val;
          };
          fillIf('m-make',   f.make);
          fillIf('m-model',  f.model);
          fillIf('m-serial', f.serialNumber);
          fillIf('m-issue',  f.issueDescription);
          fillIf('m-notes',  f.notes);
          if (f.warrantyStatus && !document.getElementById('m-warranty').value) {
            document.getElementById('m-warranty').value = f.warrantyStatus;
          }
          extraMsg = ' Blank fields filled from the form — review and save.';
        }
      } catch (parseErr) {
        console.warn('[App] PDF parse error:', parseErr.message);
      }

      showToast(`${type === 'invoice' ? 'Invoice' : 'RMA form'} PDF uploaded.` + extraMsg, 'success');
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error');
    }
  }

  function closeModal() {
    document.getElementById('edit-modal').style.display = 'none';
    document.body.style.overflow = '';
    editingId   = null;
    editingPDFs = [];
    isNewEntry  = false;
  }
  function closeModalOnBackdrop(e) { if (e.target.id === 'edit-modal') closeModal(); }
  function onStatusToggle(cb) { document.getElementById('m-status-label').textContent = cb.checked ? 'Closed' : 'Open'; }

  async function saveEntry() {
    const fields = collectModalFields();
    if (!fields.rmaNumber) { showToast('Please enter an RMA number.', 'error'); return; }
    try {
      if (editingId) {
        const existing = await Storage.getEntry(editingId);
        if (!existing) return;
        await Storage.saveEntry({ ...existing, ...fields });
      } else {
        const dupe = await Storage.entryByRmaNumber(fields.rmaNumber);
        if (dupe) { showToast(`RMA #${fields.rmaNumber} already exists.`, 'error'); return; }
        await Storage.saveEntry(fields);
      }
      closeModal();
      showToast('Saved.', 'success');
      await refreshTable();
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    }
  }

  async function deleteEntry() {
    if (!editingId) return;
    if (!confirm('Archive this entry?\n\nIt will be removed from the dashboard but kept in Settings → Deleted Entries, where you can reinstate it at any time.')) return;
    const entry = await Storage.getEntry(editingId);
    if (!entry) return;
    entry.deleted   = true;
    entry.deletedAt = new Date().toISOString();
    await Storage.saveEntry(entry);
    closeModal();
    showToast('Entry archived — find it in Settings → Deleted Entries.', 'success');
    await refreshTable();
  }

  async function reinstateEntry(id) {
    const entry = await Storage.getEntry(id);
    if (!entry) return;
    entry.deleted   = false;
    entry.deletedAt = null;
    await Storage.saveEntry(entry);
    showToast(`RMA #${entry.rmaNumber} reinstated.`, 'success');
    await loadDeletedEntries();
    await refreshTable();
  }

  async function loadDeletedEntries() {
    const tbody = document.getElementById('deleted-tbody');
    if (!tbody) return;
    let entries = [];
    try { entries = await Storage.getDeletedEntries(); } catch (_) {}
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="deleted-empty">No archived entries.</td></tr>';
      return;
    }
    entries.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
    tbody.innerHTML = entries.map(e => `<tr>
      <td><span class="rma-num">#${esc(e.rmaNumber)}</span></td>
      <td class="col-date">${esc(e.date)}</td>
      <td>${esc(e.dealer)}</td>
      <td>${esc(e.model)}</td>
      <td class="col-date">${e.deletedAt ? esc(String(e.deletedAt).slice(0, 10)) : '—'}</td>
      <td><button class="btn btn-sm btn-secondary" onclick="App.reinstateEntry(${e.id})">Reinstate</button></td>
    </tr>`).join('');
  }

  // ============================================================
  // BACKUP & RESTORE
  // ============================================================
  let _backupRevokeTimer = null;

  async function exportBackup() {
    const exportBtn = document.getElementById('backup-export-btn');
    const readyDiv  = document.getElementById('backup-ready-link');
    const anchor    = document.getElementById('backup-dl-anchor');
    try {
      if (exportBtn) exportBtn.disabled = true;
      showToast('Preparing backup…');

      const result = await Storage.exportBackup(msg => setProgress(50, msg));
      hideProgress();

      if (anchor && readyDiv) {
        anchor.href     = result.url;
        anchor.download = result.filename;
        readyDiv.style.display = 'flex';
        if (_backupRevokeTimer) clearTimeout(_backupRevokeTimer);
        _backupRevokeTimer = setTimeout(() => {
          URL.revokeObjectURL(result.url);
          if (readyDiv) readyDiv.style.display = 'none';
        }, 300000);
      }

      try {
        const a = document.createElement('a');
        a.href = result.url; a.download = result.filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } catch (_) { /* silent — user can tap the link instead */ }

      showToast(`Backup ready — ${result.entryCount} entries, ${result.pdfCount} PDF(s).`, 'success');
    } catch (err) {
      hideProgress();
      showToast('Backup failed: ' + err.message, 'error');
    } finally {
      if (exportBtn) exportBtn.disabled = false;
    }
  }

  async function importBackup() {
    const input = document.getElementById('backup-file-input');
    const file  = input.files[0];
    if (!file) { showToast('Please choose a backup file first.', 'error'); return; }

    if (!confirm(
      'Import this backup into the shared database?\n\n' +
      'Entries that already exist (same RMA) are skipped — nothing is overwritten or deleted.'
    )) { input.value = ''; return; }

    try {
      const text   = await file.text();
      const result = await Storage.importBackup(text, msg => setProgress(50, msg));
      hideProgress();
      input.value  = '';
      await refreshTable();
      const parts = [`Imported ${result.entryCount} entries and ${result.pdfCount} PDF(s)`];
      if (result.skipped)        parts.push(`${result.skipped} already existed (skipped)`);
      if (result.failed?.length) parts.push(`${result.failed.length} FAILED — see browser console`);
      showToast(parts.join(', ') + '.', result.failed?.length ? 'error' : 'success');
      if (result.failed?.length) console.warn('[Import] Failures:\n' + result.failed.join('\n'));
    } catch (err) {
      hideProgress();
      showToast('Import failed: ' + err.message, 'error');
    }
  }

  // ============================================================
  // EXCEL EXPORT
  // ============================================================
  async function exportExcel() {
    const entries = await Storage.getAllEntries();
    if (!entries.length) { showToast('No entries to export.', 'error'); return; }
    const fn = await Excel.downloadExcel(entries);
    showToast('Downloading: ' + fn + ' — check your Downloads / Files app.', 'success');
  }

  async function populateBrandExportSelect() {
    const sel = document.getElementById('s-brand-select');
    if (!sel) return;
    const brands = [...new Set(allEntries.map(e => e.make).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">— All Brands —</option>' +
      brands.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
  }

  async function exportByBrand() {
    const brand = document.getElementById('s-brand-select')?.value.trim();
    const from  = document.getElementById('s-brand-from')?.value;
    const to    = document.getElementById('s-brand-to')?.value;

    let entries = await Storage.getAllEntries();
    if (brand) entries = entries.filter(e => e.make === brand);
    if (from)  entries = entries.filter(e => e.date >= from);
    if (to)    entries = entries.filter(e => e.date <= to);

    if (!entries.length) {
      showToast('No entries match the selected filters.', 'error');
      return;
    }

    const label    = brand ? brand.replace(/\s+/g, '_') : 'All_Brands';
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `RMA_${label}_${datePart}.xlsx`;
    Excel.downloadBrandExcel(entries, filename);
    showToast(`Downloading: ${filename} (${entries.length} entries)`, 'success');
  }

  async function exportStockReplacements() {
    const from      = document.getElementById('s-stock-from')?.value;
    const to        = document.getElementById('s-stock-to')?.value;
    const recipient = document.getElementById('s-stock-recipient')?.value.trim();

    let entries = await Storage.getAllEntries();
    entries = entries.filter(e => e.replacedFrom === 'Stock');
    if (from) entries = entries.filter(e => e.date >= from);
    if (to)   entries = entries.filter(e => e.date <= to);

    if (!entries.length) {
      showToast('No Stock replacement entries match the selected range.', 'error');
      return;
    }

    const date     = new Date().toISOString().slice(0, 10);
    const datePart = date.replace(/-/g, '');
    const filename = `RMA_Stock_${datePart}.xlsx`;
    Excel.downloadBrandExcel(entries, filename);

    const logKey  = 'stockExportLog';
    const raw     = await Storage.getSetting(logKey);
    const log     = raw ? JSON.parse(raw) : [];
    log.unshift({ date, recipient: recipient || '—', count: entries.length, from: from || '—', to: to || '—', filename });
    if (log.length > 50) log.length = 50;
    await Storage.setSetting(logKey, JSON.stringify(log));

    showToast(`Downloading: ${filename} (${entries.length} entries)`, 'success');
    renderStockExportLog();
  }

  async function renderStockExportLog() {
    const el = document.getElementById('stock-export-log');
    if (!el) return;
    const raw = await Storage.getSetting('stockExportLog');
    const log = raw ? JSON.parse(raw) : [];
    if (!log.length) { el.textContent = 'No exports yet.'; return; }
    el.innerHTML = `<table style="width:100%;border-collapse:collapse">
      <thead><tr style="text-align:left;border-bottom:1px solid var(--gray-200)">
        <th style="padding:4px 8px">Date</th>
        <th style="padding:4px 8px">Recipient</th>
        <th style="padding:4px 8px">Entries</th>
        <th style="padding:4px 8px">Period</th>
      </tr></thead>
      <tbody>${log.map(r => `<tr style="border-bottom:1px solid var(--gray-100)">
        <td style="padding:4px 8px">${esc(r.date)}</td>
        <td style="padding:4px 8px">${esc(r.recipient)}</td>
        <td style="padding:4px 8px">${r.count}</td>
        <td style="padding:4px 8px">${esc(r.from)} → ${esc(r.to)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  // ============================================================
  // BATCH PDF DOWNLOAD
  // ============================================================
  async function batchDownloadPDFs() {
    const all = await Storage.getAllPDFs();
    if (!all.length) { showToast('No PDFs stored yet.', 'error'); return; }
    try {
      const zip = new JSZip();
      for (let i = 0; i < all.length; i++) {
        setProgress(Math.round((i / all.length) * 90), `Fetching PDF ${i + 1}/${all.length}…`);
        try {
          const buffer = await Storage.getPDFData(all[i]);
          zip.file(all[i].filename, buffer);
        } catch (err) {
          console.warn('[App] ZIP: skipping', all[i].filename, err.message);
        }
      }
      setProgress(95, 'Building ZIP…');
      const blob = await zip.generateAsync({ type: 'blob' });
      hideProgress();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = `RMA_PDFs_${date}.zip`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast(`Downloaded ${all.length} PDF(s) as ZIP.`, 'success');
    } catch (err) {
      hideProgress();
      showToast('ZIP failed: ' + err.message, 'error');
    }
  }

  // ============================================================
  // NAVIGATION
  // ============================================================
  function showSection(name, navEl) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById('section-' + name);
    if (target) target.classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    if (navEl) navEl.classList.add('active');
    if (name === 'stats')    renderStats();
    if (name === 'settings') { populateBrandExportSelect(); loadDeletedEntries(); renderStockExportLog(); }
  }

  // ============================================================
  // PROGRESS / TOAST / UTILS
  // ============================================================
  function setProgress(pct, label) {
    document.getElementById('progress-wrap').style.display = 'block';
    document.getElementById('progress-bar').style.width = Math.min(100, pct) + '%';
    if (label) document.getElementById('progress-label').textContent = label;
  }
  function hideProgress() { document.getElementById('progress-wrap').style.display = 'none'; }

  let toastTimer = null;
  function showToast(msg, type='') {
    const el = document.getElementById('toast');
    el.textContent   = msg;
    el.className     = 'toast' + (type ? ' toast-'+type : '');
    el.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }

  function esc(s) {
    return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  window.addEventListener('DOMContentLoaded', init);

  return {
    handleLogin, handleAuthClick,
    saveSettings, saveExcelName, saveCopyAs,
    showSection, setFilter, onSearch, sortBy, refreshTable,
    openModal, openNewModal, closeModal, closeModalOnBackdrop, onStatusToggle,
    saveEntry, deleteEntry, reinstateEntry, downloadPDF, uploadPDF,
    exportExcel, exportByBrand, exportStockReplacements, batchDownloadPDFs,
    exportBackup, importBackup
  };
})();
