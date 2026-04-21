/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define([
  'N/runtime',
  'N/search',
  'N/url',
  './lib/oa_constants',
  './oa_engine'
], (runtime, search, url, C, engine) => {
  'use strict';

  function onRequest(context) {
    const req  = context.request;
    const resp = context.response;
    resp.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });

    if (req.method === 'POST') {
      handleBatchPost(req, resp);
      return;
    }

    const userId  = runtime.getCurrentUser().id;
    const selfUrl = url.resolveScript({ scriptId: 'customscript_oa_sl_dashboard', deploymentId: 'customdeploy_oa_sl_dashboard', returnExternalUrl: false });

    const typeFilter   = req.parameters.oa_filter_type   || 'all';
    const statusFilter = req.parameters.oa_filter_status || 'pending';

    const rows = loadPendingTransactions(userId, typeFilter, statusFilter);
    resp.write(renderDashboard(rows, selfUrl, typeFilter, statusFilter));
  }

  // ─── Batch POST ───────────────────────────────────────────────────────────────

  function handleBatchPost(req, resp) {
    const userId  = runtime.getCurrentUser().id;
    const selfUrl = url.resolveScript({ scriptId: 'customscript_oa_sl_dashboard', deploymentId: 'customdeploy_oa_sl_dashboard', returnExternalUrl: false });
    const body    = JSON.parse(req.body || '{}');
    const actions = body.actions || [];

    const results = actions.map(a => {
      try {
        let result;
        if (a.action === 'approve') {
          result = engine.processApproval(a.recordId, a.recordType, userId, parseInt(a.step, 10) || 1);
        } else if (a.action === 'decline') {
          result = engine.processDecline(a.recordId, a.recordType, userId, a.comment || 'Afvist via dashboard');
        } else {
          result = { success: false, message: 'Ukendt handling' };
        }
        return { recordId: a.recordId, ...result };
      } catch (e) {
        return { recordId: a.recordId, success: false, message: e.message };
      }
    });

    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    resp.write(JSON.stringify({ results }));
  }

  // ─── Data loading ─────────────────────────────────────────────────────────────

  function loadPendingTransactions(userId, typeFilter, statusFilter) {
    const isManager = search.lookupFields({ type: 'employee', id: userId, columns: [C.FIELDS.EMPLOYEE.IS_MANAGER] })[C.FIELDS.EMPLOYEE.IS_MANAGER];

    const statusMap = { pending: C.APPROVAL_STATUS.PENDING, approved: C.APPROVAL_STATUS.APPROVED, rejected: C.APPROVAL_STATUS.REJECTED };
    const approvalStatuses = statusFilter === 'all' ? Object.values(C.APPROVAL_STATUS) : [statusMap[statusFilter] || C.APPROVAL_STATUS.PENDING];

    const typeMap = { po: 'PurchOrd', vb: 'VendBill' };
    const txnTypes = typeFilter === 'all' ? ['PurchOrd', 'VendBill'] : [typeMap[typeFilter]].filter(Boolean);

    const filters = [
      ['type', 'anyof', txnTypes],
      'AND',
      ['approvalstatus', 'anyof', approvalStatuses]
    ];

    // Non-managers only see transactions assigned to them
    if (!isManager) {
      filters.push('AND', [
        [`${C.FIELDS.TRANSACTION.APPROVER1}`, 'anyof', [userId]],
        'OR',
        [`${C.FIELDS.TRANSACTION.APPROVER2}`, 'anyof', [userId]]
      ]);
    }

    const rows = [];
    search.create({
      type:    'transaction',
      filters,
      columns: [
        'internalid', 'type', 'tranid', 'entity', 'currency', 'subsidiary',
        'amount', 'approvalstatus',
        C.FIELDS.TRANSACTION.CURRENT_STEP,
        C.FIELDS.TRANSACTION.APPROVER1,
        C.FIELDS.TRANSACTION.APPROVER2,
        C.FIELDS.TRANSACTION.SUBMITTED_BY,
        { name: 'datecreated' }
      ]
    }).run().each(r => {
      const approvalStatus = r.getValue('approvalstatus');
      rows.push({
        id:           r.id,
        type:         r.getValue('type') === 'PurchOrd' ? 'purchaseorder' : 'vendorbill',
        typeLabel:    r.getValue('type') === 'PurchOrd' ? 'Purchase Order' : 'Vendor Bill',
        tranid:       r.getValue('tranid'),
        entity:       r.getText('entity'),
        currency:     r.getText('currency'),
        subsidiary:   r.getText('subsidiary'),
        amount:       parseFloat(r.getValue('amount')) || 0,
        status:       approvalStatus,
        statusLabel:  approvalStatus === C.APPROVAL_STATUS.PENDING ? 'Afventer' : approvalStatus === C.APPROVAL_STATUS.APPROVED ? 'Godkendt' : 'Afvist',
        statusClass:  approvalStatus === C.APPROVAL_STATUS.PENDING ? 'badge-orange' : approvalStatus === C.APPROVAL_STATUS.APPROVED ? 'badge-green' : 'badge-red',
        step:         r.getValue(C.FIELDS.TRANSACTION.CURRENT_STEP),
        approver1:    r.getText(C.FIELDS.TRANSACTION.APPROVER1),
        submittedBy:  r.getText(C.FIELDS.TRANSACTION.SUBMITTED_BY),
        created:      r.getValue('datecreated')
      });
      return true;
    });

    return rows;
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  function renderDashboard(rows, selfUrl, typeFilter, statusFilter) {
    const totalApproved = rows.filter(r => r.status === C.APPROVAL_STATUS.APPROVED).reduce((s, r) => s + r.amount, 0);
    const totalRejected = rows.filter(r => r.status === C.APPROVAL_STATUS.REJECTED).reduce((s, r) => s + r.amount, 0);
    const totalPending  = rows.filter(r => r.status === C.APPROVAL_STATUS.PENDING).length;
    const totalAll      = rows.length;
    const progress      = totalAll > 0 ? Math.round(((totalAll - totalPending) / totalAll) * 100) : 0;

    const tableRows = rows.map(r => `
      <tr data-id="${r.id}" data-type="${r.type}" data-step="${r.step}">
        <td>
          <select class="action-select" data-id="${r.id}">
            <option value="">— Vælg handling —</option>
            <option value="approve">Godkend</option>
            <option value="decline">Afvis</option>
            <option value="skip">Spring over</option>
          </select>
        </td>
        <td><input type="text" class="reason-input" data-id="${r.id}" placeholder="Årsag (kræves ved afvis)" style="width:180px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px"></td>
        <td><span class="badge ${r.typeLabel === 'Purchase Order' ? 'badge-blue' : 'badge-purple'}">${r.typeLabel}</span></td>
        <td class="fw500">${r.entity || '—'}</td>
        <td class="mono">${r.tranid}</td>
        <td>${r.currency}</td>
        <td>${r.subsidiary}</td>
        <td class="amount">${r.currency} ${r.amount.toLocaleString('da-DK', { minimumFractionDigits: 2 })}</td>
        <td>${r.submittedBy || '—'}</td>
        <td class="muted">${r.created || '—'}</td>
        <td><span class="badge ${r.statusClass}">${r.statusLabel}</span></td>
      </tr>`).join('') || '<tr><td colspan="11" class="empty">Ingen transaktioner matcher filteret.</td></tr>';

    return `<!DOCTYPE html>
<html lang="da">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bulk Approval — Omnit Approvals</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#f0efee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#312d2a;font-size:14px}
  .topbar{background:#312d2a;padding:0 32px;height:52px;display:flex;align-items:center;gap:16px}
  .topbar-logo{color:#c74634;font-weight:700;font-size:16px;letter-spacing:.5px}
  .topbar-sep{color:#666;font-size:18px}
  .topbar-title{color:#ccc;font-size:14px}
  .main{max-width:1400px;margin:0 auto;padding:28px 24px}
  .page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
  h1{font-size:24px;font-weight:700}
  .subtitle{color:#888;font-size:14px;margin-top:4px}
  .header-actions{display:flex;gap:10px}
  .filters{display:flex;align-items:center;gap:8px;margin-bottom:20px;flex-wrap:wrap}
  .filter-label{font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-right:4px}
  .filter-btn{padding:6px 14px;border-radius:20px;border:1.5px solid #ddd;font-size:13px;font-weight:500;cursor:pointer;background:#fff;color:#555;transition:all .15s}
  .filter-btn.active{border-color:#c74634;background:#c74634;color:#fff}
  .filter-sep{width:1px;height:20px;background:#ddd;margin:0 4px}
  .summary-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
  .card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  .card-label{font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
  .card-value{font-size:24px;font-weight:700;color:#312d2a}
  .card-sub{font-size:13px;color:#aaa;margin-top:4px}
  .progress-bar{height:6px;background:#eee;border-radius:3px;margin-top:10px;overflow:hidden}
  .progress-fill{height:100%;border-radius:3px;background:#2e7d32;transition:width .4s}
  .table-card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.06);overflow:hidden}
  .table-toolbar{display:flex;justify-content:flex-end;align-items:center;padding:14px 20px;border-bottom:1px solid #f0efee;gap:8px}
  .table-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:10px 14px;font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;background:#fafafa;border-bottom:2px solid #f0efee;white-space:nowrap}
  td{padding:11px 14px;border-bottom:1px solid #f5f5f5;font-size:13px;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafafa}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
  .badge-green{background:#e8f5e9;color:#2e7d32}
  .badge-orange{background:#fff3e0;color:#e65100}
  .badge-red{background:#ffebee;color:#c62828}
  .badge-blue{background:#e3f2fd;color:#1565c0}
  .badge-purple{background:#f3e5f5;color:#6a1b9a}
  .action-select{padding:6px 10px;border:1.5px solid #ddd;border-radius:6px;font-size:13px;font-family:inherit;background:#fff;cursor:pointer;min-width:160px}
  .action-select:focus{border-color:#c74634;outline:none}
  .empty{color:#bbb;text-align:center;padding:40px!important}
  .fw500{font-weight:500}
  .mono{font-family:monospace;font-size:13px}
  .amount{font-weight:600;text-align:right}
  .muted{color:#aaa}
  .btn-primary{background:#c74634;color:#fff;padding:10px 22px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;border:none;cursor:pointer;display:inline-block}
  .btn-primary:hover{background:#b03d2e}
  .btn-secondary{background:#f5f5f5;color:#555;padding:10px 22px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;border:none;cursor:pointer;display:inline-block}
  .toast{position:fixed;bottom:28px;right:28px;background:#312d2a;color:#fff;padding:14px 22px;border-radius:10px;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.2);opacity:0;transition:opacity .3s;z-index:9999}
  .toast.show{opacity:1}
</style>
</head>
<body>
<div class="topbar">
  <span class="topbar-logo">OMNI:T</span>
  <span class="topbar-sep">/</span>
  <span class="topbar-title">Omnit Approvals — Bulk Approval</span>
</div>
<div class="main">
  <div class="page-header">
    <div>
      <h1>Bulk Approval</h1>
      <p class="subtitle">Behandl flere transaktioner på én gang</p>
    </div>
    <div class="header-actions">
      <button class="btn-secondary" onclick="resetAll()">Nulstil</button>
      <button class="btn-primary" onclick="submitAll()">Send godkendelser</button>
    </div>
  </div>

  <div class="filters">
    <span class="filter-label">Status:</span>
    <button class="filter-btn ${statusFilter === 'pending'  ? 'active' : ''}" onclick="setFilter('status','pending')">Afventer</button>
    <button class="filter-btn ${statusFilter === 'approved' ? 'active' : ''}" onclick="setFilter('status','approved')">Godkendt</button>
    <button class="filter-btn ${statusFilter === 'rejected' ? 'active' : ''}" onclick="setFilter('status','rejected')">Afvist</button>
    <button class="filter-btn ${statusFilter === 'all'      ? 'active' : ''}" onclick="setFilter('status','all')">Alle</button>
    <span class="filter-sep"></span>
    <span class="filter-label">Type:</span>
    <button class="filter-btn ${typeFilter === 'all' ? 'active' : ''}" onclick="setFilter('type','all')">Alle</button>
    <button class="filter-btn ${typeFilter === 'po'  ? 'active' : ''}" onclick="setFilter('type','po')">Purchase Order</button>
    <button class="filter-btn ${typeFilter === 'vb'  ? 'active' : ''}" onclick="setFilter('type','vb')">Vendor Bill</button>
  </div>

  <div class="summary-cards">
    <div class="card">
      <div class="card-label">Total godkendt</div>
      <div class="card-value" style="color:#2e7d32">DKK ${totalApproved.toLocaleString('da-DK', { minimumFractionDigits: 2 })}</div>
    </div>
    <div class="card">
      <div class="card-label">Total afvist</div>
      <div class="card-value" style="color:#c74634">DKK ${totalRejected.toLocaleString('da-DK', { minimumFractionDigits: 2 })}</div>
    </div>
    <div class="card">
      <div class="card-label">Fremgang</div>
      <div class="card-value">${progress}%</div>
      <div class="card-sub">${totalAll - totalPending} af ${totalAll} behandlet</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
    </div>
  </div>

  <div class="table-card">
    <div class="table-toolbar">
      <span class="muted" style="flex:1;font-size:13px">${rows.length} transaktion${rows.length !== 1 ? 'er' : ''}</span>
      <button class="btn-secondary" style="padding:7px 16px;font-size:13px" onclick="window.location.reload()">Opdater</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Handling</th><th>Årsag</th><th>Type</th><th>Leverandør</th>
          <th>Bilagsnr.</th><th>Valuta</th><th>Subsidiary</th>
          <th style="text-align:right">Beløb</th><th>Oprettet af</th><th>Dato</th><th>Status</th>
        </tr></thead>
        <tbody id="txn-table">${tableRows}</tbody>
      </table>
    </div>
  </div>

  <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px">
    <button class="btn-secondary" onclick="resetAll()">Nulstil</button>
    <button class="btn-primary" onclick="submitAll()">Send godkendelser</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const SELF_URL = '${selfUrl}';

function setFilter(key, val) {
  const params = new URLSearchParams(window.location.search);
  params.set('oa_filter_' + key, val);
  window.location.search = params.toString();
}

function resetAll() {
  document.querySelectorAll('.action-select').forEach(s => s.value = '');
  document.querySelectorAll('.reason-input').forEach(i => i.value = '');
}

async function submitAll() {
  const actions = [];
  document.querySelectorAll('tr[data-id]').forEach(row => {
    const id     = row.dataset.id;
    const type   = row.dataset.type;
    const step   = row.dataset.step;
    const action = row.querySelector('.action-select').value;
    const reason = row.querySelector('.reason-input').value;
    if (!action || action === 'skip') return;
    if (action === 'decline' && !reason.trim()) {
      showToast('Angiv en årsag for alle afvisninger.'); throw new Error('missing reason');
    }
    actions.push({ recordId: id, recordType: type, step, action, comment: reason });
  });

  if (!actions.length) { showToast('Ingen handlinger valgt.'); return; }

  const btn = document.querySelector('.btn-primary');
  btn.disabled = true;
  btn.textContent = 'Behandler...';

  try {
    const res = await fetch(SELF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions })
    });
    const data = await res.json();
    const ok   = data.results.filter(r => r.success).length;
    const fail = data.results.filter(r => !r.success).length;
    showToast(\`Færdig: \${ok} behandlet\${fail ? ', ' + fail + ' fejlede' : ''}.\`);
    setTimeout(() => window.location.reload(), 1800);
  } catch (e) {
    showToast('Fejl under behandling. Prøv igen.');
    btn.disabled = false;
    btn.textContent = 'Send godkendelser';
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}
</script>
</body></html>`;
  }

  return { onRequest };
});
