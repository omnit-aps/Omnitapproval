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

    let isSuperApprover = false;
    try {
      isSuperApprover = !!search.lookupFields({ type: 'employee', id: userId, columns: [C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER] })[C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER];
    } catch (e) { /* graceful */ }

    const rows = loadPendingTransactions(userId, typeFilter, statusFilter);
    resp.write(renderDashboard(rows, selfUrl, typeFilter, statusFilter, userId, isSuperApprover));
  }

  // ─── Batch POST ───────────────────────────────────────────────────────────────

  function handleBatchPost(req, resp) {
    const userId = runtime.getCurrentUser().id;

    let isApprover = false, isManager = false, isSuperApprover = false;
    try {
      const emp = search.lookupFields({ type: 'employee', id: userId, columns: [C.FIELDS.EMPLOYEE.IS_APPROVER, C.FIELDS.EMPLOYEE.IS_MANAGER, C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER] });
      isApprover      = !!emp[C.FIELDS.EMPLOYEE.IS_APPROVER];
      isManager       = !!emp[C.FIELDS.EMPLOYEE.IS_MANAGER];
      isSuperApprover = !!emp[C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER];
    } catch (e) { /* no employee record */ }

    if (!isApprover && !isManager && !isSuperApprover) {
      resp.setHeader({ name: 'Content-Type', value: 'application/json' });
      resp.write(JSON.stringify({ error: 'Access denied. You are not configured as an approver, manager, or super approver.' }));
      return;
    }

    let body;
    try { body = JSON.parse(req.body || '{}'); } catch (e) { body = {}; }
    const actions = body.actions || [];

    const results = actions.map(a => {
      try {
        let result;
        if (a.action === 'approve') {
          result = engine.processApproval(a.recordId, a.recordType, userId);
        } else if (a.action === 'decline') {
          result = engine.processDecline(a.recordId, a.recordType, userId, a.comment || 'Rejected via dashboard');
        } else if (a.action === 'super_approve') {
          result = engine.processApproval(a.recordId, a.recordType, userId, null, a.comment);
        } else if (a.action === 'super_decline') {
          result = engine.processDecline(a.recordId, a.recordType, userId, a.comment, null, true);
        } else if (a.action === 'reassign') {
          if (!a.newApprover) {
            result = { success: false, message: 'New approver ID required for reassign.' };
          } else {
            result = engine.processReassign(a.recordId, a.recordType, userId, a.newApprover);
          }
        } else {
          result = { success: false, message: 'Unknown action' };
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
    let isManager = false, isSuperApprover = false;
    try {
      const emp = search.lookupFields({ type: 'employee', id: userId, columns: [C.FIELDS.EMPLOYEE.IS_MANAGER, C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER] });
      isManager       = !!emp[C.FIELDS.EMPLOYEE.IS_MANAGER];
      isSuperApprover = !!emp[C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER];
    } catch (e) { /* user has no employee record — treat as non-manager */ }

    const statusMap = { pending: C.APPROVAL_STATUS.PENDING, approved: C.APPROVAL_STATUS.APPROVED, rejected: C.APPROVAL_STATUS.REJECTED };
    const approvalStatuses = statusFilter === 'all' ? Object.values(C.APPROVAL_STATUS) : [statusMap[statusFilter] || C.APPROVAL_STATUS.PENDING];

    const typeMap  = { po: 'PurchOrd', vb: 'VendBill' };
    const txnTypes = typeFilter === 'all' ? ['PurchOrd', 'VendBill'] : [typeMap[typeFilter]].filter(Boolean);

    const filters = [
      ['type', 'anyof', txnTypes],
      'AND',
      ['approvalstatus', 'anyof', approvalStatuses]
    ];

    // Managers and super approvers see all; others see only their assigned pending records
    if (!isManager && !isSuperApprover) {
      filters.push('AND', ['nextapprover', 'anyof', [userId]]);
    }

    const rows = [];
    search.create({
      type:    'transaction',
      filters,
      columns: [
        'internalid', 'type', 'tranid', 'entity', 'currency', 'subsidiary',
        'amount', 'approvalstatus', 'nextapprover',
        C.FIELDS.TRANSACTION.SUBMITTED_BY,
        { name: 'datecreated' }
      ]
    }).run().each(r => {
      const approvalStatus = r.getValue('approvalstatus');
      rows.push({
        id:          r.id,
        type:        r.getValue('type') === 'PurchOrd' ? 'purchaseorder' : 'vendorbill',
        typeLabel:   r.getValue('type') === 'PurchOrd' ? 'Purchase Order' : 'Vendor Bill',
        tranid:      r.getValue('tranid'),
        entity:      r.getText('entity'),
        currency:    r.getText('currency'),
        subsidiary:  r.getText('subsidiary'),
        amount:      parseFloat(r.getValue('amount')) || 0,
        status:      approvalStatus,
        statusLabel: approvalStatus === C.APPROVAL_STATUS.PENDING  ? 'Pending'
                   : approvalStatus === C.APPROVAL_STATUS.APPROVED ? 'Approved' : 'Rejected',
        statusClass: approvalStatus === C.APPROVAL_STATUS.PENDING  ? 'badge-orange'
                   : approvalStatus === C.APPROVAL_STATUS.APPROVED ? 'badge-green' : 'badge-red',
        nextApprover:   r.getText('nextapprover') || '—',
        nextApproverId: r.getValue('nextapprover') || '',
        submittedBy:  r.getText(C.FIELDS.TRANSACTION.SUBMITTED_BY) || '—',
        created:      r.getValue('datecreated')
      });
      return true;
    });

    return rows;
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderDashboard(rows, selfUrl, typeFilter, statusFilter, userId, isSuperApprover) {
    const totalApproved = rows.filter(r => r.status === C.APPROVAL_STATUS.APPROVED).reduce((s, r) => s + r.amount, 0);
    const totalRejected = rows.filter(r => r.status === C.APPROVAL_STATUS.REJECTED).reduce((s, r) => s + r.amount, 0);
    const totalPending  = rows.filter(r => r.status === C.APPROVAL_STATUS.PENDING).length;
    const totalAll      = rows.length;
    const progress      = totalAll > 0 ? Math.round(((totalAll - totalPending) / totalAll) * 100) : 0;

    const tableRows = rows.map(r => {
      const isAssigned = String(r.nextApproverId) === String(userId);
      const isPending  = r.status === C.APPROVAL_STATUS.PENDING;
      let actionOptions;
      if (!isPending) {
        actionOptions = `<option value="">— Not pending —</option>`;
      } else if (isAssigned) {
        actionOptions = `<option value="">— Select action —</option>
             <option value="approve">Approve</option>
             <option value="decline">Reject</option>
             <option value="skip">Skip</option>`;
      } else if (isSuperApprover) {
        actionOptions = `<option value="">— Select action —</option>
             <option value="super_approve">Super Approve</option>
             <option value="super_decline">Super Reject</option>
             <option value="reassign">Reassign</option>
             <option value="skip">Skip</option>`;
      } else {
        actionOptions = `<option value="">— Select action —</option>
             <option value="reassign">Reassign</option>
             <option value="skip">Skip</option>`;
      }
      const inputCell = !isPending
        ? ''
        : isAssigned
          ? `<input type="text" class="reason-input" data-id="${_esc(r.id)}" placeholder="Reason (required for rejection)" style="width:180px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">`
          : isSuperApprover
            ? `<input type="text" class="super-reason-input" data-id="${_esc(r.id)}" placeholder="Override justification (required)" style="width:180px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">`
            : `<input type="text" class="reassign-input" data-id="${_esc(r.id)}" placeholder="New approver employee ID" style="width:180px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">`;
      return `
      <tr data-id="${_esc(r.id)}" data-type="${_esc(r.type)}">
        <td>
          <select class="action-select" data-id="${_esc(r.id)}"${!isPending ? ' disabled' : ''}>
            ${actionOptions}
          </select>
        </td>
        <td>${inputCell}</td>
        <td><span class="badge ${r.typeLabel === 'Purchase Order' ? 'badge-blue' : 'badge-purple'}">${_esc(r.typeLabel)}</span></td>
        <td class="fw500">${_esc(r.entity) || '—'}</td>
        <td class="mono">${_esc(r.tranid)}</td>
        <td>${_esc(r.currency)}</td>
        <td>${_esc(r.subsidiary)}</td>
        <td class="amount">${_esc(r.currency)} ${r.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
        <td>${_esc(r.submittedBy) || '—'}</td>
        <td>${_esc(r.nextApprover)}</td>
        <td class="muted">${_esc(r.created) || '—'}</td>
        <td><span class="badge ${r.statusClass}">${_esc(r.statusLabel)}</span></td>
      </tr>`;
    }).join('') || '<tr><td colspan="12" class="empty">No transactions match the filter.</td></tr>';

    return `<!DOCTYPE html>
<html lang="en">
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
  <span class="topbar-sep">›</span>
  <span class="topbar-title">Omnit Approvals — Bulk Approval</span>
</div>
<div class="main">
  <div class="page-header">
    <div>
      <h1>Bulk Approval</h1>
      <p class="subtitle">Process multiple transactions at once</p>
    </div>
    <div class="header-actions">
      <button class="btn-secondary" onclick="resetAll()">Reset</button>
      <button class="btn-primary" onclick="submitAll()">Submit approvals</button>
    </div>
  </div>

  <div class="filters">
    <span class="filter-label">Status:</span>
    <button class="filter-btn ${statusFilter === 'pending'  ? 'active' : ''}" onclick="setFilter('status','pending')">Pending</button>
    <button class="filter-btn ${statusFilter === 'approved' ? 'active' : ''}" onclick="setFilter('status','approved')">Approved</button>
    <button class="filter-btn ${statusFilter === 'rejected' ? 'active' : ''}" onclick="setFilter('status','rejected')">Rejected</button>
    <button class="filter-btn ${statusFilter === 'all'      ? 'active' : ''}" onclick="setFilter('status','all')">All</button>
    <span class="filter-sep"></span>
    <span class="filter-label">Type:</span>
    <button class="filter-btn ${typeFilter === 'all' ? 'active' : ''}" onclick="setFilter('type','all')">All</button>
    <button class="filter-btn ${typeFilter === 'po'  ? 'active' : ''}" onclick="setFilter('type','po')">Purchase Order</button>
    <button class="filter-btn ${typeFilter === 'vb'  ? 'active' : ''}" onclick="setFilter('type','vb')">Vendor Bill</button>
  </div>

  <div class="summary-cards">
    <div class="card">
      <div class="card-label">Total approved</div>
      <div class="card-value" style="color:#2e7d32">${totalApproved.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
    </div>
    <div class="card">
      <div class="card-label">Total rejected</div>
      <div class="card-value" style="color:#c74634">${totalRejected.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
    </div>
    <div class="card">
      <div class="card-label">Progress</div>
      <div class="card-value">${progress}%</div>
      <div class="card-sub">${totalAll - totalPending} of ${totalAll} processed</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
    </div>
  </div>

  <div class="table-card">
    <div class="table-toolbar">
      <span class="muted" style="flex:1;font-size:13px">${rows.length} transaction${rows.length !== 1 ? 's' : ''}</span>
      <button class="btn-secondary" style="padding:7px 16px;font-size:13px" onclick="window.location.reload()">Refresh</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Action</th><th>Reason</th><th>Type</th><th>Vendor</th>
          <th>Document #</th><th>Currency</th><th>Subsidiary</th>
          <th style="text-align:right">Amount</th><th>Submitted by</th>
          <th>Next approver</th><th>Date</th><th>Status</th>
        </tr></thead>
        <tbody id="txn-table">${tableRows}</tbody>
      </table>
    </div>
  </div>

  <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px">
    <button class="btn-secondary" onclick="resetAll()">Reset</button>
    <button class="btn-primary" onclick="submitAll()">Submit approvals</button>
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
  document.querySelectorAll('.reassign-input').forEach(i => i.value = '');
  document.querySelectorAll('.super-reason-input').forEach(i => i.value = '');
}

async function submitAll() {
  const actions = [];
  let valid = true;
  document.querySelectorAll('tr[data-id]').forEach(row => {
    if (!valid) return;
    const id            = row.dataset.id;
    const type          = row.dataset.type;
    const action        = row.querySelector('.action-select').value;
    const reason        = row.querySelector('.reason-input')?.value || '';
    const superReason   = row.querySelector('.super-reason-input')?.value || '';
    const newApprover   = row.querySelector('.reassign-input')?.value.trim() || '';
    if (!action || action === 'skip') return;
    if (action === 'decline' && !reason.trim()) {
      showToast('Please provide a reason for all rejections.'); valid = false; return;
    }
    if ((action === 'super_approve' || action === 'super_decline') && !superReason.trim()) {
      showToast('Override justification is required for all Super Approve/Reject actions.'); valid = false; return;
    }
    if (action === 'reassign' && !newApprover) {
      showToast('Please enter a new approver ID for all reassignments.'); valid = false; return;
    }
    const comment = action === 'decline' ? reason : (action === 'super_approve' || action === 'super_decline') ? superReason : reason;
    actions.push({ recordId: id, recordType: type, action, comment, newApprover });
  });
  if (!valid) return;

  if (!actions.length) { showToast('No actions selected.'); return; }

  const btns = document.querySelectorAll('.btn-primary');
  btns.forEach(b => { b.disabled = true; b.textContent = 'Processing...'; });

  try {
    const res  = await fetch(SELF_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ actions })
    });
    const data = await res.json();
    if (data.error) { showToast('Access denied: ' + data.error); btns.forEach(b => { b.disabled = false; b.textContent = 'Submit approvals'; }); return; }
    const results = data.results || [];
    const ok   = results.filter(r => r.success).length;
    const fail = results.filter(r => !r.success).length;
    showToast(\`Done: \${ok} processed\${fail ? ', ' + fail + ' failed' : ''}.\`);
    setTimeout(() => window.location.reload(), 1800);
  } catch (e) {
    showToast('Error during processing. Please try again.');
    btns.forEach(b => { b.disabled = false; b.textContent = 'Submit approvals'; });
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
