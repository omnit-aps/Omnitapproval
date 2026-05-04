/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define([
  'N/runtime',
  'N/search',
  'N/url',
  'N/format',
  './lib/oa_constants',
  './lib/oa_utils',
  './oa_engine'
], (runtime, search, url, format, C, utils, engine) => {
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
    const settingsUrl = url.resolveScript({ scriptId: 'customscript_oa_sl_settings', deploymentId: 'customdeploy_oa_sl_settings', returnExternalUrl: false });

    // Whitelist filter values to avoid passing junk straight into search filters.
    const ALLOWED_TYPES = ['all', 'po', 'vb'];
    const ALLOWED_STATUSES = ['pending', 'approved', 'rejected', 'all'];
    const rawTypeFilter   = req.parameters.oa_filter_type   || 'all';
    const rawStatusFilter = req.parameters.oa_filter_status || 'pending';
    const typeFilter   = ALLOWED_TYPES.indexOf(rawTypeFilter)   >= 0 ? rawTypeFilter   : 'all';
    const statusFilter = ALLOWED_STATUSES.indexOf(rawStatusFilter) >= 0 ? rawStatusFilter : 'pending';

    const dateFrom    = req.parameters.oa_filter_date_from    || '';
    const dateTo      = req.parameters.oa_filter_date_to      || '';
    const vendorId    = req.parameters.oa_filter_vendor       || '';
    const amountMin   = req.parameters.oa_filter_amount_min   || '';
    const amountMax   = req.parameters.oa_filter_amount_max   || '';
    const subsidiaryId = req.parameters.oa_filter_subsidiary  || '';
    const approverId   = req.parameters.oa_filter_approver    || '';
    const page         = Math.max(0, parseInt(req.parameters.oa_page || '0', 10) || 0);
    const PAGE_SIZE    = 50;

    const quickAction = req.parameters.oa_quick_action || '';
    const quickId     = req.parameters.oa_quick_id     || '';
    const quickType   = req.parameters.oa_quick_type   || '';

    let isApprover = false, isSuperApprover = false, isManager = false;
    try {
      const emp = search.lookupFields({ type: 'employee', id: userId, columns: [C.FIELDS.EMPLOYEE.IS_APPROVER, C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER, C.FIELDS.EMPLOYEE.IS_MANAGER] });
      isApprover      = utils.parseBool(emp[C.FIELDS.EMPLOYEE.IS_APPROVER]);
      isSuperApprover = utils.parseBool(emp[C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER]);
      isManager       = utils.parseBool(emp[C.FIELDS.EMPLOYEE.IS_MANAGER]);
    } catch (e) { /* graceful */ }

    // Access guard: only employees flagged as approver/manager/super_approver
    // can view the dashboard. Without this, anyone with role audience access
    // (allroles=T) could see pending records — even if they had no role in OA.
    if (!isApprover && !isManager && !isSuperApprover) {
      resp.write(`<!DOCTYPE html><html><head><title>Access denied</title></head><body style="font-family:sans-serif;padding:48px;text-align:center"><h1>Access denied</h1><p>You are not configured as an approver, manager, or super approver. Contact your Omnit Approvals administrator.</p></body></html>`);
      return;
    }

    const approvers    = loadActiveApprovers();
    const vendors      = loadVendorList();
    const subsidiaries = loadSubsidiaryList();
    const allRows = loadPendingTransactions(userId, typeFilter, statusFilter, dateFrom, dateTo, vendorId, amountMin, amountMax, subsidiaryId, approverId);
    const totalRows = allRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const rows = allRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
    resp.write(renderDashboard(rows, selfUrl, settingsUrl, typeFilter, statusFilter, userId, isSuperApprover, isManager, approvers, quickAction, quickId, quickType, dateFrom, dateTo, vendorId, amountMin, amountMax, subsidiaryId, vendors, subsidiaries, approverId, safePage, totalPages, totalRows));
  }

  // ─── Batch POST ───────────────────────────────────────────────────────────────

  function handleBatchPost(req, resp) {
    const userId = runtime.getCurrentUser().id;

    let isApprover = false, isManager = false, isSuperApprover = false;
    try {
      const emp = search.lookupFields({ type: 'employee', id: userId, columns: [C.FIELDS.EMPLOYEE.IS_APPROVER, C.FIELDS.EMPLOYEE.IS_MANAGER, C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER] });
      isApprover      = utils.parseBool(emp[C.FIELDS.EMPLOYEE.IS_APPROVER]);
      isManager       = utils.parseBool(emp[C.FIELDS.EMPLOYEE.IS_MANAGER]);
      isSuperApprover = utils.parseBool(emp[C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER]);
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
        // Per-action privilege check — defence in depth on top of the
        // role-level guard above. Without this, a crafted POST could let
        // a base approver issue super_approve/super_decline/reset/reassign.
        const isAssignedToThisRecord = (() => {
          try {
            const f = search.lookupFields({ type: a.recordType, id: a.recordId, columns: ['custbody_oa_next_approver'] });
            const next = f.custbody_oa_next_approver;
            const nextId = Array.isArray(next) && next[0] ? String(next[0].value) : '';
            return nextId === String(userId);
          } catch (e) { return false; }
        })();
        if (a.action === 'approve' || a.action === 'decline') {
          if (!isAssignedToThisRecord && !isSuperApprover) {
            return { success: false, message: 'You are not the assigned approver for this record.' };
          }
        } else if (a.action === 'super_approve' || a.action === 'super_decline') {
          if (!isSuperApprover) {
            return { success: false, message: 'Super approver privilege required.' };
          }
        } else if (a.action === 'reassign' || a.action === 'reset') {
          if (!isManager) {
            return { success: false, message: 'Manager privilege required to reassign or reset.' };
          }
        } else {
          return { success: false, message: `Unknown action '${a.action}'.` };
        }

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
        } else if (a.action === 'reset') {
          if (!a.newApprover) {
            result = { success: false, message: 'New approver ID required for reset.' };
          } else {
            result = engine.processReset(a.recordId, a.recordType, userId, a.newApprover);
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

  function loadPendingTransactions(userId, typeFilter, statusFilter, dateFrom, dateTo, vendorId, amountMin, amountMax, subsidiaryId, approverId) {
    let isManager = false, isSuperApprover = false;
    try {
      const emp = search.lookupFields({ type: 'employee', id: userId, columns: [C.FIELDS.EMPLOYEE.IS_MANAGER, C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER] });
      isManager       = utils.parseBool(emp[C.FIELDS.EMPLOYEE.IS_MANAGER]);
      isSuperApprover = utils.parseBool(emp[C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER]);
    } catch (e) { /* user has no employee record — treat as non-manager */ }

    const statusMap = { pending: C.APPROVAL_STATUS.PENDING, approved: C.APPROVAL_STATUS.APPROVED, rejected: C.APPROVAL_STATUS.REJECTED };
    const approvalStatuses = statusFilter === 'all' ? Object.values(C.APPROVAL_STATUS) : [statusMap[statusFilter] || C.APPROVAL_STATUS.PENDING];

    const typeMap  = { po: 'PurchOrd', vb: 'VendBill' };
    const txnTypes = typeFilter === 'all' ? ['PurchOrd', 'VendBill'] : [typeMap[typeFilter]].filter(Boolean);

    const filters = [
      ['type', 'anyof', txnTypes],
      'AND',
      ['approvalstatus', 'anyof', approvalStatuses],
      'AND',
      ['mainline', 'is', 'T'],
      'AND',
      [C.FIELDS.TRANSACTION.SUBMITTED_BY, 'noneof', ['@NONE@']]
    ];

    // Managers and super approvers see all OA-tagged records; others see only their assigned pending records
    if (!isManager && !isSuperApprover) {
      filters.push('AND', ['custbody_oa_next_approver', 'anyof', [userId]]);
    }

    // ── Additional advanced filters ──────────────────────────────────────────────
    // Codex MED #4: HTML date inputs submit ISO 'YYYY-MM-DD'. NS transaction
    // searches expect the account's date format (M/D/YYYY in US accounts).
    // Convert via N/format so the filter doesn't silently match nothing in
    // accounts using a different display format.
    const _toAccountDate = (iso) => {
      try {
        if (!iso) return iso;
        const d = new Date(iso + 'T00:00:00');
        if (isNaN(d.getTime())) return iso;
        return format.format({ value: d, type: format.Type.DATE });
      } catch (_) { return iso; }
    };
    const dateFromFmt = _toAccountDate(dateFrom);
    const dateToFmt   = _toAccountDate(dateTo);
    if (dateFromFmt && dateToFmt) {
      filters.push('AND', ['trandate', 'within', dateFromFmt, dateToFmt]);
    } else if (dateFromFmt) {
      filters.push('AND', ['trandate', 'onorafter', dateFromFmt]);
    } else if (dateToFmt) {
      filters.push('AND', ['trandate', 'onorbefore', dateToFmt]);
    }

    if (vendorId) {
      filters.push('AND', ['entity', 'anyof', [vendorId]]);
    }

    if (amountMin && !isNaN(parseFloat(amountMin))) {
      filters.push('AND', ['amount', 'greaterthanorequalto', parseFloat(amountMin)]);
    }
    if (amountMax && !isNaN(parseFloat(amountMax))) {
      filters.push('AND', ['amount', 'lessthanorequalto', parseFloat(amountMax)]);
    }

    if (subsidiaryId) {
      filters.push('AND', ['subsidiary', 'anyof', [subsidiaryId]]);
    }

    if (approverId) {
      filters.push('AND', ['custbody_oa_next_approver', 'anyof', [approverId]]);
    }

    const rows = [];
    // Codex MED #5: search.run().each() silently caps at 4000 rows. For
    // accounts with deep history (e.g. all-status filter on a busy
    // sub) totals + pagination would lie above 4k. runPaged with
    // pageSize=1000 paginates the result and yields every row, no cap.
    const pagedSearch = search.create({
      type:    'transaction',
      filters,
      columns: [
        'internalid', 'type', 'tranid', 'entity', 'currency', 'subsidiary',
        'amount', 'approvalstatus', 'custbody_oa_next_approver',
        C.FIELDS.TRANSACTION.SUBMITTED_BY,
        C.FIELDS.TRANSACTION.BASE_AMOUNT,
        { name: 'datecreated', sort: search.Sort.DESC }
      ]
    });
    const pagedData = pagedSearch.runPaged({ pageSize: 1000 });
    const _processRow = (r) => {
      const approvalStatus = r.getValue('approvalstatus');
      const txnAmount  = parseFloat(r.getValue('amount')) || 0;
      const baseAmount = parseFloat(r.getValue(C.FIELDS.TRANSACTION.BASE_AMOUNT)) || 0;
      rows.push({
        id:          r.id,
        type:        r.getValue('type') === 'PurchOrd' ? 'purchaseorder' : 'vendorbill',
        typeLabel:   r.getValue('type') === 'PurchOrd' ? 'Purchase Order' : 'Vendor Bill',
        tranid:      r.getValue('tranid'),
        entity:      r.getText('entity'),
        currency:    r.getText('currency'),
        subsidiary:  r.getText('subsidiary'),
        amount:      txnAmount,
        baseAmount:  baseAmount,
        status:      approvalStatus,
        statusLabel: approvalStatus === C.APPROVAL_STATUS.PENDING  ? 'Pending'
                   : approvalStatus === C.APPROVAL_STATUS.APPROVED ? 'Approved' : 'Rejected',
        statusClass: approvalStatus === C.APPROVAL_STATUS.PENDING  ? 'badge-orange'
                   : approvalStatus === C.APPROVAL_STATUS.APPROVED ? 'badge-green' : 'badge-red',
        nextApprover:   r.getText('custbody_oa_next_approver') || '—',
        nextApproverId: r.getValue('custbody_oa_next_approver') || '',
        submittedBy:  r.getText(C.FIELDS.TRANSACTION.SUBMITTED_BY) || '—',
        created:      r.getValue('datecreated')
      });
    };
    pagedData.pageRanges.forEach((pageRange) => {
      const pg = pagedData.fetch({ index: pageRange.index });
      pg.data.forEach(_processRow);
    });

    return rows;
  }

  // ─── Active approvers for reassign dropdown ───────────────────────────────────

  function loadActiveApprovers() {
    const approvers = [];
    try {
      search.create({
        type: 'employee',
        filters: [
          ['isinactive', 'is', 'F'],
          'AND',
          [C.FIELDS.EMPLOYEE.IS_APPROVER, 'is', 'T']
        ],
        columns: [
          { name: 'internalid' },
          { name: 'entityid' },
          { name: 'firstname' },
          { name: 'lastname' }
        ]
      }).run().each(r => {
        const first = r.getValue('firstname') || '';
        const last  = r.getValue('lastname')  || '';
        const entity = r.getValue('entityid') || '';
        const display = (first || last) ? `${first} ${last}`.trim() : entity;
        approvers.push({ id: r.id, name: display });
        return true;
      });
      approvers.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) { /* graceful — return empty list; fallback handled in render */ }
    return approvers;
  }

  // ─── Vendor list for filter dropdown ─────────────────────────────────────────

  function loadVendorList() {
    const vendors = [];
    try {
      search.create({
        type: 'vendor',
        filters: [['isinactive', 'is', 'F']],
        columns: [
          { name: 'internalid' },
          { name: 'entityid' },
          { name: 'companyname' },
        ],
      }).run().each(r => {
        const id   = r.id;
        const name = r.getValue('companyname') || r.getValue('entityid') || id;
        vendors.push({ id, name });
        return vendors.length < 1000; // safety cap; large NS accounts can have 10k+ vendors
      });
      vendors.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) { /* graceful — return empty list */ }
    return vendors;
  }

  // ─── Subsidiary list for filter dropdown ─────────────────────────────────────

  function loadSubsidiaryList() {
    const subs = [];
    try {
      search.create({
        type: 'subsidiary',
        filters: [['isinactive', 'is', 'F']],
        columns: [{ name: 'internalid' }, { name: 'name' }],
      }).run().each(r => {
        subs.push({ id: r.id, name: r.getValue('name') || r.id });
        return true;
      });
      subs.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) { /* graceful — return empty list (e.g. SUBSIDIARIES feature off) */ }
    return subs;
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderDashboard(rows, selfUrl, settingsUrl, typeFilter, statusFilter, userId, isSuperApprover, isManager, approvers, quickAction, quickId, quickType, dateFrom, dateTo, vendorId, amountMin, amountMax, subsidiaryId, vendors, subsidiaries, approverId, page, totalPages, totalRows) {
    // Feature 1: build approver <select> options once, reused per row
    const approverOpts = (approvers || []).map(a =>
      `<option value="${_esc(a.id)}">${_esc(a.name)}</option>`
    ).join('');

    // Advanced filter dropdowns
    const vendorOpts = (vendors || []).map(v =>
      `<option value="${_esc(v.id)}"${vendorId === String(v.id) ? ' selected' : ''}>${_esc(v.name)}</option>`
    ).join('');
    // Approver filter dropdown — same data as reassign approverOpts but with `selected` based on the URL filter param
    const approverFilterOpts = (approvers || []).map(a =>
      `<option value="${_esc(a.id)}"${String(approverId) === String(a.id) ? ' selected' : ''}>${_esc(a.name)}</option>`
    ).join('');
    const subsidiaryOpts = (subsidiaries || []).map(s =>
      `<option value="${_esc(s.id)}"${subsidiaryId === String(s.id) ? ' selected' : ''}>${_esc(s.name)}</option>`
    ).join('');

    // Build "clear filters" URL — strip all oa_filter_* params except status/type chips
    // selfUrl already has '?script=...&deploy=...' — append filter params with '&', not '?'.
    // _esc() turns '&' into '&amp;' for HTML safety since this lands in an href attribute.
    const clearUrl = _esc(`${selfUrl}&oa_filter_status=${statusFilter}&oa_filter_type=${typeFilter}`);

    // Feature 2: map record type to NS transaction URL segment
    function txnUrl(type, id) {
      const seg = type === 'purchaseorder' ? 'purchord' : 'vendbill';
      return `/app/accounting/transactions/${seg}.nl?id=${encodeURIComponent(id)}`;
    }

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
        // Super approver: can override-approve/reject; managers additionally see reassign
        const reassignOpt = isManager ? `\n             <option value="reassign">Reassign</option>` : '';
        actionOptions = `<option value="">— Select action —</option>
             <option value="super_approve">Super Approve</option>
             <option value="super_decline">Super Reject</option>${reassignOpt}
             <option value="skip">Skip</option>`;
      } else if (isManager) {
        // Manager only: can reassign/reset but not approve directly
        actionOptions = `<option value="">— Select action —</option>
             <option value="reassign">Reassign</option>
             <option value="reset">Reset &amp; Re-route</option>
             <option value="skip">Skip</option>`;
      } else {
        // Regular approver not assigned to this record — no actionable options
        actionOptions = `<option value="">— Not your record —</option>`;
      }
      // Input cell: render every input the user might need based on privilege.
      // CSS `.input-stack > *:not(:first-child){margin-top:4px}` stacks them.
      // JS in submitBatch reads only the input matching the chosen action.
      // Inputs not relevant to the chosen action are simply blank/ignored.
      const inputStyle = 'width:180px;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px';
      const reassignField = approverOpts
        ? `<select class="reassign-input" data-id="${_esc(r.id)}" style="${inputStyle};background:#fff"><option value="">— Select approver —</option>${approverOpts}</select>`
        : `<input type="text" class="reassign-input" data-id="${_esc(r.id)}" placeholder="New approver employee ID" style="${inputStyle}">`;
      const reasonField = `<input type="text" class="reason-input" data-id="${_esc(r.id)}" placeholder="Reason (required for rejection)" style="${inputStyle}">`;
      const superReasonField = `<input type="text" class="super-reason-input" data-id="${_esc(r.id)}" placeholder="Override justification (required)" style="${inputStyle}">`;
      let inputs = '';
      if (isPending) {
        if (isAssigned) inputs += reasonField;
        if (isSuperApprover) inputs += superReasonField;
        if (isManager) inputs += reassignField;
      }
      const inputCell = inputs ? `<div class="input-stack">${inputs}</div>` : '';
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
        <td class="mono"><a href="${_esc(txnUrl(r.type, r.id))}" target="_blank" rel="noopener" style="color:#1565c0;text-decoration:none" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${_esc(r.tranid || `#${r.id}`)}</a></td>
        <td>${_esc(r.currency)}</td>
        <td>${_esc(r.subsidiary)}</td>
        <td class="amount">${_esc(r.currency)} ${r.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}${
          // Feature 3: show base-currency equivalent when it differs from transaction amount
          // custbody_oa_base_amount stores the base-currency snapshot captured at routing time.
          // We show it only when non-zero and meaningfully different from the displayed amount
          // (handles both cross-currency and same-currency transactions).
          // TODO: if base currency symbol is needed, join against subsidiary record here.
          (r.baseAmount && Math.abs(r.baseAmount - r.amount) > 0.005)
            ? `<div style="font-size:11px;color:#888;font-weight:400;margin-top:2px">Base: ${r.baseAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>`
            : ''
        }</td>
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
  .topbar{background:#312d2a;padding:0 32px;height:52px;display:flex;align-items:center;gap:16px;justify-content:space-between}
  .topbar-logo{color:#c74634;font-weight:700;font-size:16px;letter-spacing:.5px}
  .topbar-sep{color:#666;font-size:18px}
  .topbar-title{color:#ccc;font-size:14px}
  .topbar-settings{color:#ccc;font-size:13px;font-weight:500;text-decoration:none;padding:6px 14px;border-radius:6px;border:1px solid #4a4541;transition:background .15s,color .15s;margin-left:auto}
  .topbar-settings:hover{background:#4a4541;color:#fff}
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
  .input-stack > *{display:block;width:100%}
  .input-stack > * + *{margin-top:4px}
  .pagination{display:flex;align-items:center;gap:6px;margin-top:18px;justify-content:flex-end;flex-wrap:wrap}
  .pagination .page-meta{color:#888;font-size:13px;margin-right:auto}
  .pagination .page-link{display:inline-block;padding:6px 12px;border:1px solid #ddd;border-radius:6px;text-decoration:none;color:#312d2a;font-size:13px;background:#fff}
  .pagination .page-link:hover{background:#f4f4f4}
  .pagination .page-link.active{background:#c74634;color:#fff;border-color:#c74634;font-weight:600}
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
  .adv-filters{display:flex;align-items:flex-end;gap:12px;margin-bottom:20px;flex-wrap:wrap;background:#fff;border-radius:10px;padding:14px 18px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  .adv-filter-group{display:flex;flex-direction:column;gap:4px;min-width:140px;flex:1}
  .adv-filter-group label{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px}
  .adv-filter-group input,.adv-filter-group select{padding:7px 10px;border:1.5px solid #ddd;border-radius:6px;font-size:13px;font-family:inherit;background:#fff;color:#312d2a;transition:border-color .15s}
  .adv-filter-group input:focus,.adv-filter-group select:focus{border-color:#c74634;outline:none}
  .adv-filter-range{display:flex;gap:6px;align-items:center}
  .adv-filter-range input{flex:1;min-width:0}
  .adv-filter-range span{font-size:12px;color:#aaa;flex-shrink:0}
  .btn-clear-filters{padding:7px 16px;border-radius:6px;border:1.5px solid #ddd;font-size:13px;font-weight:500;cursor:pointer;background:#fff;color:#555;text-decoration:none;white-space:nowrap;align-self:flex-end;transition:all .15s}
  .btn-clear-filters:hover{border-color:#c74634;color:#c74634}
  .btn-apply-filters{padding:7px 18px;border-radius:6px;border:none;font-size:13px;font-weight:600;cursor:pointer;background:#c74634;color:#fff;white-space:nowrap;align-self:flex-end;transition:background .15s}
  .btn-apply-filters:hover{background:#b03d2e}
</style>
</head>
<body>
<div class="topbar">
  <span class="topbar-logo">OMNI:T</span>
  <span class="topbar-sep">›</span>
  <span class="topbar-title">Omnit Approvals — Bulk Approval</span>
  <a href="${_esc(settingsUrl)}" class="topbar-settings">Settings</a>
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

  <form id="adv-filter-form" method="GET" action="${_esc(selfUrl)}" class="adv-filters">
    <input type="hidden" name="script" value="customscript_oa_sl_dashboard">
    <input type="hidden" name="deploy" value="customdeploy_oa_sl_dashboard">
    <input type="hidden" name="oa_filter_status" value="${_esc(statusFilter)}">
    <input type="hidden" name="oa_filter_type"   value="${_esc(typeFilter)}">
    <div class="adv-filter-group">
      <label>Date from</label>
      <input type="date" name="oa_filter_date_from" value="${_esc(dateFrom)}">
    </div>
    <div class="adv-filter-group">
      <label>Date to</label>
      <input type="date" name="oa_filter_date_to" value="${_esc(dateTo)}">
    </div>
    <div class="adv-filter-group">
      <label>Vendor</label>
      <select name="oa_filter_vendor">
        <option value="">All vendors</option>
        ${vendorOpts}
      </select>
    </div>
    <div class="adv-filter-group">
      <label>Amount range</label>
      <div class="adv-filter-range">
        <input type="number" step="0.01" min="0" name="oa_filter_amount_min" value="${_esc(amountMin)}" placeholder="Min">
        <span>–</span>
        <input type="number" step="0.01" min="0" name="oa_filter_amount_max" value="${_esc(amountMax)}" placeholder="Max">
      </div>
    </div>
    <div class="adv-filter-group">
      <label>Subsidiary</label>
      <select name="oa_filter_subsidiary">
        <option value="">All subsidiaries</option>
        ${subsidiaryOpts}
      </select>
    </div>
    <div class="adv-filter-group">
      <label>Approver</label>
      <select name="oa_filter_approver">
        <option value="">All approvers</option>
        ${approverFilterOpts}
      </select>
    </div>
    <button type="submit" class="btn-apply-filters">Apply</button>
    <a href="${clearUrl}" class="btn-clear-filters">Clear filters</a>
  </form>

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

  ${(() => {
    if (totalPages <= 1) return '';
    // Derive pagination URLs from selfUrl (already has '?script=...&deploy=...')
    // rather than reconstructing the route.
    const filterQs =
      `&oa_filter_status=${encodeURIComponent(statusFilter)}` +
      `&oa_filter_type=${encodeURIComponent(typeFilter)}` +
      (dateFrom    ? `&oa_filter_date_from=${encodeURIComponent(dateFrom)}` : '') +
      (dateTo      ? `&oa_filter_date_to=${encodeURIComponent(dateTo)}` : '') +
      (vendorId    ? `&oa_filter_vendor=${encodeURIComponent(vendorId)}` : '') +
      (amountMin   ? `&oa_filter_amount_min=${encodeURIComponent(amountMin)}` : '') +
      (amountMax   ? `&oa_filter_amount_max=${encodeURIComponent(amountMax)}` : '') +
      (subsidiaryId? `&oa_filter_subsidiary=${encodeURIComponent(subsidiaryId)}` : '') +
      (approverId  ? `&oa_filter_approver=${encodeURIComponent(approverId)}` : '');
    const pageLinks = [];
    for (let p = 0; p < totalPages; p++) {
      const cls = p === page ? 'page-link active' : 'page-link';
      pageLinks.push(`<a class="${cls}" href="${_esc(selfUrl + filterQs + '&oa_page=' + p)}">${p + 1}</a>`);
    }
    const PAGE_SIZE_CONST = 50;
    const showing = `${page * PAGE_SIZE_CONST + 1}–${Math.min((page + 1) * PAGE_SIZE_CONST, totalRows)} of ${totalRows}`;
    return `<div class="pagination"><span class="page-meta">Showing ${showing}</span>${pageLinks.join('')}</div>`;
  })()}

  <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px">
    <button class="btn-secondary" onclick="resetAll()">Reset</button>
    <button class="btn-primary" onclick="submitAll()">Submit approvals</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
// Codex MED #8: emit values with JSON.stringify (JS-safe escape) instead of
// _esc (HTML-safe). HTML escape doesn't protect a JS string literal — an
// apostrophe or backslash in the value would break the script. JSON.stringify
// produces a properly-quoted JS literal regardless of the input.
const SELF_URL       = ${JSON.stringify(selfUrl)};
const OA_QUICK_ID     = ${JSON.stringify(String(quickId || ''))};
const OA_QUICK_ACTION = ${JSON.stringify(String(quickAction || ''))};
const OA_QUICK_TYPE   = ${JSON.stringify(String(quickType || ''))};

// ─── Quick-action pre-fill (from portlet "quick approve" links) ───────────────
window.addEventListener('DOMContentLoaded', () => {
  if (!OA_QUICK_ID) return;

  const row = document.querySelector('tr[data-id="' + OA_QUICK_ID + '"]');
  if (!row) return;

  // Scroll the row into view with a little breathing room
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const sel = row.querySelector('.action-select');
  if (!sel || sel.disabled) return;

  // Determine the best matching option value.
  // The portlet emits 'approve' or 'decline'; we map to whatever option the
  // dropdown actually contains for this row (assigned-user vs super-approver).
  function pickOption(hint) {
    const opts = Array.from(sel.options).map(o => o.value).filter(Boolean);
    if (hint === 'approve') {
      // Prefer the direct 'approve' (assigned), fall back to 'super_approve'
      if (opts.includes('approve'))       return 'approve';
      if (opts.includes('super_approve')) return 'super_approve';
    } else if (hint === 'decline') {
      // Prefer the direct 'decline' (assigned), fall back to 'super_decline'
      if (opts.includes('decline'))       return 'decline';
      if (opts.includes('super_decline')) return 'super_decline';
    }
    // Exact match (e.g. portlet already emitted 'super_approve')
    if (opts.includes(hint)) return hint;
    return null;
  }

  const resolved = pickOption(OA_QUICK_ACTION);
  if (!resolved) return;

  sel.value = resolved;

  // For reject actions, focus the appropriate reason input
  if (resolved === 'decline') {
    const reasonInput = row.querySelector('.reason-input');
    if (reasonInput) reasonInput.focus();
  } else if (resolved === 'super_decline') {
    const superInput = row.querySelector('.super-reason-input');
    if (superInput) superInput.focus();
  }

  showToast('Pre-filled action from quick approve link');
});

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
    if ((action === 'reassign' || action === 'reset') && !newApprover) {
      showToast('Please enter a new approver ID for all reassignments/resets.'); valid = false; return;
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
