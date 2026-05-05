/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * OA Audit Log — searchable log viewer over customrecord_oa_log.
 * Closes UAT-064 ("see all documents a specific employee has approved").
 *
 * Query params (all optional):
 *   oa_audit_actor       employee internal id
 *   oa_audit_action      LOG_ACTIONS code (1..9)
 *   oa_audit_source      LOG_SOURCES code (1=NetSuite, 2=Email)
 *   oa_audit_date_from   YYYY-MM-DD
 *   oa_audit_date_to     YYYY-MM-DD
 *   oa_audit_txn         transaction internal id (filter to one record)
 *   oa_audit_export=csv  return CSV instead of HTML
 *   oa_page              page number (50/page)
 */
define([
  'N/runtime',
  'N/search',
  'N/url',
  'N/format',
  './lib/oa_constants',
  './lib/oa_utils'
], (runtime, search, url, format, C, utils) => {
  'use strict';

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function _csvCell(s) {
    const v = String(s == null ? '' : s);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function _toAccountDate(iso) {
    try {
      if (!iso) return null;
      const d = new Date(iso + 'T00:00:00');
      if (isNaN(d.getTime())) return null;
      return format.format({ value: d, type: format.Type.DATE });
    } catch (_) { return null; }
  }

  const ACTION_LABELS = {
    '1': 'Submitted', '2': 'Approved', '3': 'Rejected',
    '4': 'Delegated', '5': 'Reassigned', '6': 'Reset',
    '7': 'Super Approved', '8': 'Super Rejected', '9': 'Resubmitted'
  };
  const ACTION_COLORS = {
    '1': '#1565c0', '2': '#2e7d32', '3': '#c74634',
    '4': '#0288d1', '5': '#6a1b9a', '6': '#5d4037',
    '7': '#388e3c', '8': '#b71c1c', '9': '#fb8c00'
  };
  const SOURCE_LABELS = { '1': 'NetSuite', '2': 'Email' };
  const PAGE_SIZE = 50;

  function loadActors() {
    const actors = [];
    try {
      const seen = {};
      search.create({
        type: C.RECORDS.LOG,
        filters: [],
        columns: [
          { name: C.FIELDS.LOG.ACTOR, summary: 'GROUP' }
        ]
      }).run().each((r) => {
        const id = r.getValue({ name: C.FIELDS.LOG.ACTOR, summary: 'GROUP' });
        const txt = r.getText({ name: C.FIELDS.LOG.ACTOR, summary: 'GROUP' });
        if (id && !seen[id]) { seen[id] = true; actors.push({ id, name: txt || id }); }
        return actors.length < 200;
      });
      actors.sort((a, b) => a.name.localeCompare(b.name));
    } catch (_) { /* graceful */ }
    return actors;
  }

  function buildSearch(filters) {
    const f = [];
    const push = (clause) => { if (f.length) f.push('AND'); f.push(clause); };
    if (filters.actor)   push([C.FIELDS.LOG.ACTOR,    'anyof', [filters.actor]]);
    if (filters.action)  push([C.FIELDS.LOG.ACTION,   'is',    filters.action]);
    if (filters.source)  push([C.FIELDS.LOG.SOURCE,   'is',    filters.source]);
    if (filters.txnId)   push([C.FIELDS.LOG.TRANSACTION, 'anyof', [filters.txnId]]);
    if (filters.dateFrom && filters.dateTo) push([C.FIELDS.LOG.TIMESTAMP, 'within', filters.dateFrom, filters.dateTo]);
    else if (filters.dateFrom) push([C.FIELDS.LOG.TIMESTAMP, 'onorafter', filters.dateFrom]);
    else if (filters.dateTo)   push([C.FIELDS.LOG.TIMESTAMP, 'onorbefore', filters.dateTo]);

    return search.create({
      type: C.RECORDS.LOG,
      filters: f,
      columns: [
        { name: C.FIELDS.LOG.TIMESTAMP, sort: search.Sort.DESC },
        { name: C.FIELDS.LOG.ACTOR },
        { name: C.FIELDS.LOG.ACTION },
        { name: C.FIELDS.LOG.SOURCE },
        { name: C.FIELDS.LOG.TRANSACTION },
        { name: C.FIELDS.LOG.STEP },
        { name: C.FIELDS.LOG.TARGET },
        { name: C.FIELDS.LOG.COMMENT }
      ]
    });
  }

  function fetchRows(searchObj, page) {
    const out = [];
    let total = 0;
    try {
      const pagedData = searchObj.runPaged({ pageSize: 1000 });
      total = pagedData.count;
      const startIdx = page * PAGE_SIZE;
      const endIdx   = startIdx + PAGE_SIZE;
      let scanned = 0;
      pagedData.pageRanges.forEach((pageRange) => {
        if (out.length >= PAGE_SIZE) return;
        const pg = pagedData.fetch({ index: pageRange.index });
        pg.data.forEach((r) => {
          if (out.length >= PAGE_SIZE) return;
          if (scanned++ < startIdx) return;
          out.push({
            timestamp:   r.getValue(C.FIELDS.LOG.TIMESTAMP) || '',
            actorId:     r.getValue(C.FIELDS.LOG.ACTOR) || '',
            actorName:   r.getText(C.FIELDS.LOG.ACTOR)  || '',
            action:      r.getValue(C.FIELDS.LOG.ACTION) || '',
            source:      r.getValue(C.FIELDS.LOG.SOURCE) || '',
            txnId:       r.getValue(C.FIELDS.LOG.TRANSACTION) || '',
            txnDoc:      r.getText(C.FIELDS.LOG.TRANSACTION)  || '',
            step:        r.getValue(C.FIELDS.LOG.STEP) || '',
            targetName:  r.getText(C.FIELDS.LOG.TARGET) || '',
            comment:     r.getValue(C.FIELDS.LOG.COMMENT) || ''
          });
        });
      });
    } catch (e) { /* graceful */ }
    return { rows: out, total };
  }

  function onRequest(context) {
    const req  = context.request;
    const resp = context.response;
    const p    = req.parameters || {};

    const filters = {
      actor:    p.oa_audit_actor || '',
      action:   p.oa_audit_action || '',
      source:   p.oa_audit_source || '',
      txnId:    p.oa_audit_txn || '',
      dateFrom: _toAccountDate(p.oa_audit_date_from || ''),
      dateTo:   _toAccountDate(p.oa_audit_date_to   || ''),
    };
    const page = Math.max(0, parseInt(p.oa_page || '0', 10) || 0);

    const searchObj = buildSearch(filters);
    const { rows, total } = fetchRows(searchObj, page);

    if (p.oa_audit_export === 'csv') {
      resp.setHeader({ name: 'Content-Type', value: 'text/csv; charset=utf-8' });
      resp.setHeader({ name: 'Content-Disposition', value: 'attachment; filename="oa-audit.csv"' });
      const header = ['Timestamp','Actor','Action','Source','Transaction','Step','Target','Comment'];
      const lines = [header.join(',')];
      rows.forEach(r => lines.push([
        r.timestamp, r.actorName, ACTION_LABELS[r.action] || r.action, SOURCE_LABELS[r.source] || r.source,
        r.txnDoc || ('id ' + r.txnId), r.step, r.targetName, r.comment
      ].map(_csvCell).join(',')));
      resp.write(lines.join('\n'));
      return;
    }

    resp.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
    const actors = loadActors();
    const dashUrl = url.resolveScript({ scriptId: 'customscript_oa_sl_dashboard', deploymentId: 'customdeploy_oa_sl_dashboard', returnExternalUrl: false });
    const selfUrl = url.resolveScript({ scriptId: 'customscript_oa_sl_audit', deploymentId: 'customdeploy_oa_sl_audit', returnExternalUrl: false });
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage   = Math.min(page, totalPages - 1);

    const _filterQs = (overrides) => {
      const out = ['script=customscript_oa_sl_audit', 'deploy=customdeploy_oa_sl_audit'];
      const merged = Object.assign({
        oa_audit_actor: p.oa_audit_actor || '', oa_audit_action: p.oa_audit_action || '',
        oa_audit_source: p.oa_audit_source || '', oa_audit_date_from: p.oa_audit_date_from || '',
        oa_audit_date_to: p.oa_audit_date_to || '', oa_audit_txn: p.oa_audit_txn || '',
      }, overrides || {});
      Object.entries(merged).forEach(([k, v]) => { if (v) out.push(`${k}=${encodeURIComponent(v)}`); });
      return out.join('&');
    };

    const actorOpts = actors.map(a => `<option value="${_esc(a.id)}"${filters.actor === String(a.id) ? ' selected' : ''}>${_esc(a.name)}</option>`).join('');
    const actionOpts = Object.entries(ACTION_LABELS).map(([k, v]) => `<option value="${k}"${filters.action === k ? ' selected' : ''}>${v}</option>`).join('');
    const sourceOpts = Object.entries(SOURCE_LABELS).map(([k, v]) => `<option value="${k}"${filters.source === k ? ' selected' : ''}>${v}</option>`).join('');

    const body = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>OA Audit Log</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f0efee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#312d2a;font-size:14px}
.topbar{background:#312d2a;padding:0 32px;height:52px;display:flex;align-items:center;gap:16px;justify-content:space-between}
.topbar-logo{color:#c74634;font-weight:700;font-size:16px;letter-spacing:.5px}
.topbar-title{color:#ccc;font-size:14px}
.topbar-link{color:#ccc;font-size:13px;text-decoration:none;padding:6px 14px;border-radius:6px;border:1px solid #4a4541}
.topbar-link:hover{background:#4a4541;color:#fff}
.main{max-width:1400px;margin:0 auto;padding:24px 24px 60px}
h1{font-size:22px;font-weight:700;margin-bottom:6px}
.h1-sub{font-size:13px;color:#888;margin-bottom:18px}
.filters{background:#fff;border-radius:12px;padding:14px 18px;display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-bottom:18px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.filters label{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;font-weight:600;display:block;margin-bottom:4px}
.filters input,.filters select{padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:inherit;background:#fff;min-width:140px}
.filters .group{flex:0 0 auto}
.btn{padding:7px 16px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.btn-primary{background:#c74634;color:#fff}
.btn-primary:hover{background:#a83a2a}
.btn-secondary{background:#fff;color:#312d2a;border:1px solid #ddd}
.summary{font-size:13px;color:#888;margin-bottom:8px}
.export-link{color:#1565c0;font-size:13px;text-decoration:none;float:right}
.export-link:hover{text-decoration:underline}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)}
thead{background:#fafafa}
th{padding:10px 12px;text-align:left;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #f0efee}
td{padding:10px 12px;font-size:13px;border-bottom:1px solid #f0efee;vertical-align:top}
tr:hover{background:#fafafa}
.tag{display:inline-block;padding:3px 9px;border-radius:10px;color:#fff;font-size:11px;font-weight:600;letter-spacing:.3px}
.muted{color:#aaa}
a{color:#1565c0;text-decoration:none}
a:hover{text-decoration:underline}
.empty{padding:32px;text-align:center;color:#aaa;font-style:italic}
.pagination{display:flex;align-items:center;gap:6px;margin-top:18px;justify-content:flex-end;flex-wrap:wrap}
.pagination .page-meta{color:#888;font-size:13px;margin-right:auto}
.pagination .page-link{display:inline-block;padding:6px 12px;border:1px solid #ddd;border-radius:6px;text-decoration:none;color:#312d2a;font-size:13px;background:#fff}
.pagination .page-link:hover{background:#f4f4f4}
.pagination .page-link.active{background:#c74634;color:#fff;border-color:#c74634;font-weight:600}
</style></head>
<body>
<div class="topbar">
  <span class="topbar-logo">OMNI:T</span>
  <span class="topbar-title">Omnit Approvals — Audit Log</span>
  <a href="${_esc(dashUrl)}" class="topbar-link" style="margin-left:auto">Bulk Approval ›</a>
</div>
<div class="main">
  <h1>Audit Log</h1>
  <div class="h1-sub">Every approve / decline / reassign / reset / delegation / submission across OA-routed transactions.</div>

  <form method="GET" action="/app/site/hosting/scriptlet.nl" class="filters">
    <input type="hidden" name="script" value="customscript_oa_sl_audit">
    <input type="hidden" name="deploy" value="customdeploy_oa_sl_audit">
    <div class="group"><label>Actor</label><select name="oa_audit_actor"><option value="">All actors</option>${actorOpts}</select></div>
    <div class="group"><label>Action</label><select name="oa_audit_action"><option value="">All actions</option>${actionOpts}</select></div>
    <div class="group"><label>Source</label><select name="oa_audit_source"><option value="">Both</option>${sourceOpts}</select></div>
    <div class="group"><label>Date from</label><input type="date" name="oa_audit_date_from" value="${_esc(p.oa_audit_date_from || '')}"></div>
    <div class="group"><label>Date to</label><input type="date" name="oa_audit_date_to" value="${_esc(p.oa_audit_date_to || '')}"></div>
    <div class="group"><label>Transaction id</label><input type="text" name="oa_audit_txn" value="${_esc(p.oa_audit_txn || '')}" placeholder="optional"></div>
    <div class="group"><button type="submit" class="btn btn-primary">Apply</button></div>
    <div class="group"><a href="/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_audit&deploy=customdeploy_oa_sl_audit" class="btn btn-secondary" style="display:inline-block;line-height:24px">Reset</a></div>
  </form>

  <div class="summary">
    Showing ${rows.length ? safePage * PAGE_SIZE + 1 : 0}–${safePage * PAGE_SIZE + rows.length} of ${total}
    <a href="/app/site/hosting/scriptlet.nl?${_filterQs({ oa_audit_export: 'csv' })}" class="export-link">Export CSV ↓</a>
  </div>

  <table>
    <thead>
      <tr>
        <th>When</th><th>Actor</th><th>Action</th><th>Source</th>
        <th>Transaction</th><th>Step</th><th>Target</th><th>Comment</th>
      </tr>
    </thead>
    <tbody>
      ${rows.length ? rows.map(r => `
        <tr>
          <td class="muted">${_esc(r.timestamp)}</td>
          <td>${_esc(r.actorName)}</td>
          <td><span class="tag" style="background:${ACTION_COLORS[r.action] || '#888'}">${_esc(ACTION_LABELS[r.action] || r.action)}</span></td>
          <td>${_esc(SOURCE_LABELS[r.source] || r.source) || '—'}</td>
          <td>${r.txnId ? `<a href="/app/accounting/transactions/transaction.nl?id=${_esc(r.txnId)}" target="_blank">${_esc(r.txnDoc || ('id ' + r.txnId))}</a>` : '—'}</td>
          <td>${_esc(r.step) || '—'}</td>
          <td>${_esc(r.targetName) || '—'}</td>
          <td>${_esc(r.comment) || '—'}</td>
        </tr>`).join('') : '<tr><td colspan="8" class="empty">No matching audit log entries</td></tr>'}
    </tbody>
  </table>

  ${(() => {
    if (totalPages <= 1) return '';
    const pageLinks = [];
    for (let pp = 0; pp < Math.min(totalPages, 12); pp++) {
      const cls = pp === safePage ? 'page-link active' : 'page-link';
      pageLinks.push(`<a class="${cls}" href="/app/site/hosting/scriptlet.nl?${_filterQs({ oa_page: String(pp) })}">${pp + 1}</a>`);
    }
    return `<div class="pagination"><span class="page-meta">Page ${safePage + 1} of ${totalPages}</span>${pageLinks.join('')}</div>`;
  })()}
</div></body></html>`;

    resp.write(body);
  }

  return { onRequest };
});
