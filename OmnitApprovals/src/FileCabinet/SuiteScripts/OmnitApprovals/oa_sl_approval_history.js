/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define([
  'N/runtime',
  'N/search',
  './lib/oa_constants'
], (runtime, search, C) => {
  'use strict';

  const ACTION_LABELS = {
    [C.LOG_ACTIONS.SUBMITTED]:  'Submitted',
    [C.LOG_ACTIONS.APPROVED]:   'Approved',
    [C.LOG_ACTIONS.REJECTED]:   'Rejected',
    [C.LOG_ACTIONS.DELEGATED]:  'Delegated',
    [C.LOG_ACTIONS.REASSIGNED]: 'Reassigned',
    [C.LOG_ACTIONS.RESET]:      'Reset'
  };

  const ACTION_COLORS = {
    [C.LOG_ACTIONS.SUBMITTED]:  '#1a56db',
    [C.LOG_ACTIONS.APPROVED]:   '#057a55',
    [C.LOG_ACTIONS.REJECTED]:   '#c74634',
    [C.LOG_ACTIONS.DELEGATED]:  '#9061f9',
    [C.LOG_ACTIONS.REASSIGNED]: '#9061f9',
    [C.LOG_ACTIONS.RESET]:      '#d97706'
  };

  const SOURCE_LABELS = {
    [C.LOG_SOURCES.NETSUITE]: 'NetSuite',
    [C.LOG_SOURCES.EMAIL]:    'Email link'
  };

  const STATUS_LABELS = { '1': 'Pending', '2': 'Approved', '3': 'Rejected' };
  const STATUS_COLORS = { '1': '#d97706', '2': '#057a55', '3': '#c74634' };

  function onRequest(context) {
    const req  = context.request;
    const resp = context.response;
    resp.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });

    const recordId   = req.parameters.oa_record_id;
    const recordType = req.parameters.oa_record_type;

    if (!recordId || !recordType) {
      resp.write(_errorPage('Missing parameters.'));
      return;
    }

    // Access guard: only next approver, a past actor in the log, or a manager may view
    const userId = runtime.getCurrentUser().id;
    if (!_canViewHistory(recordId, recordType, userId)) {
      resp.write(_errorPage('You do not have permission to view this approval history.'));
      return;
    }

    try {
      resp.write(_render(recordId, recordType));
    } catch (e) {
      resp.write(_errorPage(e.message));
    }
  }

  function _canViewHistory(recordId, recordType, userId) {
    // Managers can always view
    try {
      const emp = search.lookupFields({ type: 'employee', id: userId, columns: [C.FIELDS.EMPLOYEE.IS_MANAGER] });
      if (emp[C.FIELDS.EMPLOYEE.IS_MANAGER]) return true;
    } catch (e) { /* no employee record */ }

    // Current next approver can view
    try {
      const txn = search.lookupFields({ type: recordType, id: recordId, columns: ['nextapprover'] });
      const nextApprover = txn.nextapprover && txn.nextapprover[0] ? txn.nextapprover[0].value : null;
      if (nextApprover && String(nextApprover) === String(userId)) return true;
    } catch (e) { /* graceful */ }

    // Past actor in the audit log can view (submitter, previous approver, etc.)
    let wasActor = false;
    try {
      search.create({
        type:    C.RECORDS.LOG,
        filters: [
          [C.FIELDS.LOG.TRANSACTION, 'equalto', recordId],
          'AND',
          [C.FIELDS.LOG.ACTOR, 'anyof', [userId]]
        ],
        columns: ['internalid']
      }).run().getRange({ start: 0, end: 1 }).forEach(() => { wasActor = true; });
    } catch (e) { /* graceful */ }
    return wasActor;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _render(recordId, recordType) {
    // ── Transaction summary (native fields only) ──────────────────────────────
    const txn = search.lookupFields({
      type:    recordType,
      id:      recordId,
      columns: ['tranid', 'approvalstatus', 'amount', 'currency', 'subsidiary', 'nextapprover']
    });

    const docNumber   = txn.tranid || recordId;
    const statusVal   = txn.approvalstatus;
    const statusText  = STATUS_LABELS[statusVal] || statusVal || '—';
    const statusColor = STATUS_COLORS[statusVal]  || '#888';
    const subsidiary  = txn.subsidiary && txn.subsidiary[0] ? txn.subsidiary[0].text : '—';
    const amount      = parseFloat(txn.amount) || 0;
    const currency    = txn.currency && txn.currency[0] ? txn.currency[0].text : '';
    const nextApprover = txn.nextapprover && txn.nextapprover[0] ? txn.nextapprover[0].text : '—';
    const rtLabel     = recordType === 'purchaseorder' ? 'Purchase Order' : 'Vendor Bill';

    // ── Audit log entries ─────────────────────────────────────────────────────
    const logs = [];
    search.create({
      type:    C.RECORDS.LOG,
      filters: [[C.FIELDS.LOG.TRANSACTION, 'equalto', recordId]],
      columns: [
        C.FIELDS.LOG.ACTION,
        C.FIELDS.LOG.ACTOR,
        C.FIELDS.LOG.TARGET,
        C.FIELDS.LOG.STEP,
        C.FIELDS.LOG.SOURCE,
        C.FIELDS.LOG.COMMENT,
        C.FIELDS.LOG.TIMESTAMP,
        'created'
      ]
    }).run().each(r => {
      const ts = r.getValue(C.FIELDS.LOG.TIMESTAMP) || r.getValue('created');
      logs.push({
        action:    r.getValue(C.FIELDS.LOG.ACTION),
        actor:     r.getText(C.FIELDS.LOG.ACTOR)  || '—',
        target:    r.getText(C.FIELDS.LOG.TARGET) || '',
        step:      r.getValue(C.FIELDS.LOG.STEP),
        source:    r.getValue(C.FIELDS.LOG.SOURCE),
        comment:   r.getValue(C.FIELDS.LOG.COMMENT) || '',
        timestamp: ts ? new Date(ts) : null
      });
      return true;
    });

    logs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Derive submitted-by and approver info from log
    const submittedEntry = logs.find(l => l.action === C.LOG_ACTIONS.SUBMITTED);
    const submittedBy    = submittedEntry ? submittedEntry.actor : '—';
    const approver1Entry = logs.find(l => l.action === C.LOG_ACTIONS.APPROVED && l.step === '1');
    const approver1      = approver1Entry ? approver1Entry.actor : '—';

    const logRows = logs.length ? logs.map(l => {
      const label  = ACTION_LABELS[l.action] || l.action;
      const color  = ACTION_COLORS[l.action] || '#888';
      const src    = SOURCE_LABELS[l.source] || l.source || '';
      const ts     = l.timestamp
        ? l.timestamp.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';
      const who    = l.target ? `${_esc(l.actor)} <span class="arrow">→</span> ${_esc(l.target)}` : _esc(l.actor);
      return `<tr>
        <td class="ts">${_esc(ts)}</td>
        <td><span class="pill" style="background:${_esc(color)}18;color:${_esc(color)};border:1px solid ${_esc(color)}30">${_esc(label)}</span></td>
        <td class="center">Step&nbsp;${_esc(l.step || '—')}</td>
        <td>${who}</td>
        <td><span class="src">${_esc(src)}</span></td>
        <td class="comment">${l.comment ? `<span class="comment-text">${_esc(l.comment)}</span>` : ''}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" class="empty">No approval activity recorded yet.</td></tr>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approval History — ${docNumber}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0efee;color:#312d2a;font-size:14px;padding:32px 28px}
  .topbar{background:#312d2a;margin:-32px -28px 28px;padding:0 28px;height:48px;display:flex;align-items:center;gap:10px}
  .topbar-logo{color:#c74634;font-weight:700;font-size:15px}
  .topbar-title{color:#aaa;font-size:13px}
  .card{background:#fff;border-radius:12px;padding:24px 28px;box-shadow:0 1px 4px rgba(0,0,0,.07);margin-bottom:20px}
  h1{font-size:20px;font-weight:700}
  h2{font-size:14px;font-weight:600;color:#555;margin-bottom:16px;text-transform:uppercase;letter-spacing:.4px}
  .sub{color:#888;font-size:13px;margin-top:3px}
  .status-pill{display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700}
  .header-row{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
  .meta{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px 28px}
  .meta-item label{display:block;font-size:11px;font-weight:600;color:#bbb;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
  .meta-item span{font-size:13px;color:#312d2a;font-weight:500}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:9px 12px;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f0efee;white-space:nowrap}
  td{padding:11px 12px;border-bottom:1px solid #f5f5f5;font-size:13px;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafafa}
  .ts{white-space:nowrap;color:#666;font-size:12px}
  .center{text-align:center}
  .pill{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;white-space:nowrap}
  .src{font-size:11px;color:#888;background:#f5f5f5;padding:2px 8px;border-radius:10px;white-space:nowrap}
  .comment{max-width:260px;color:#555}
  .comment-text{font-style:italic}
  .arrow{color:#bbb}
  .empty{color:#bbb;text-align:center;padding:32px!important;font-style:italic}
</style>
</head>
<body>
<div class="topbar">
  <span class="topbar-logo">OMNI:T</span>
  <span style="color:#555;font-size:16px">›</span>
  <span class="topbar-title">Approval History</span>
</div>

<div class="card">
  <div class="header-row">
    <div>
      <h1>${rtLabel} — ${docNumber}</h1>
      <div class="sub">${subsidiary}</div>
    </div>
    <span class="status-pill" style="background:${statusColor}18;color:${statusColor}">${statusText}</span>
  </div>
  <div class="meta">
    <div class="meta-item"><label>Amount (base currency)</label><span>${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></div>
    <div class="meta-item"><label>Submitted by</label><span>${submittedBy}</span></div>
    <div class="meta-item"><label>Approver (step 1)</label><span>${approver1}</span></div>
    <div class="meta-item"><label>Next approver</label><span>${nextApprover}</span></div>
  </div>
</div>

<div class="card">
  <h2>Approval timeline</h2>
  <table>
    <thead><tr>
      <th style="width:140px">Date &amp; time</th>
      <th style="width:110px">Action</th>
      <th style="width:70px">Step</th>
      <th>Who</th>
      <th style="width:96px">Via</th>
      <th>Comment / reason</th>
    </tr></thead>
    <tbody>${logRows}</tbody>
  </table>
</div>
</body></html>`;
  }

  function _errorPage(msg) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:sans-serif;padding:40px;background:#f4f4f4}.card{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 12px rgba(0,0,0,.09)}h2{color:#c74634;margin:0 0 12px}p{color:#555}</style>
</head><body><div class="card"><h2>Error</h2><p>${msg}</p></div></body></html>`;
  }

  return { onRequest };
});
