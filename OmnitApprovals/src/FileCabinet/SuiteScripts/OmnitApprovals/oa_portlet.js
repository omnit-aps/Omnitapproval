/**
 * @NApiVersion 2.1
 * @NScriptType Portlet
 * @NModuleScope SameAccount
 */
define([
  'N/runtime',
  'N/search',
  'N/url',
  './lib/oa_constants'
], (runtime, search, url, C) => {
  'use strict';

  function render(context) {
    const portlet = context.portlet;
    portlet.title = 'Pending Approvals';

    try {
      const userId  = runtime.getCurrentUser().id;
      const dashUrl = url.resolveScript({
        scriptId:     'customscript_oa_sl_dashboard',
        deploymentId: 'customdeploy_oa_sl_dashboard',
        returnExternalUrl: false
      });

      const rows = _loadPending(userId);
      portlet.html = rows.length ? _tableHtml(rows, dashUrl) : _emptyHtml(dashUrl);
    } catch (e) {
      portlet.html = `<p style="color:#888;padding:12px;font-size:13px">Unable to load approvals: ${e.message}</p>`;
    }
  }

  function _loadPending(userId) {
    const results = [];
    search.create({
      type:    'transaction',
      filters: [
        ['type',            'anyof', ['PurchOrd', 'VendBill']],
        'AND',
        ['approvalstatus',  'anyof', [C.APPROVAL_STATUS.PENDING]],
        'AND',
        [
          [C.FIELDS.TRANSACTION.APPROVER1, 'anyof', [userId]],
          'OR',
          [C.FIELDS.TRANSACTION.APPROVER2, 'anyof', [userId]]
        ]
      ],
      columns: [
        'internalid', 'type', 'tranid', 'entity', 'amount', 'currency',
        C.FIELDS.TRANSACTION.CURRENT_STEP
      ]
    }).run().getRange({ start: 0, end: 10 }).forEach(r => {
      results.push({
        id:        r.id,
        typeLabel: r.getValue('type') === 'PurchOrd' ? 'PO' : 'VB',
        typeColor: r.getValue('type') === 'PurchOrd' ? '#1565c0' : '#6a1b9a',
        typeBg:    r.getValue('type') === 'PurchOrd' ? '#e3f2fd' : '#f3e5f5',
        tranid:    r.getValue('tranid'),
        entity:    r.getText('entity') || '—',
        amount:    parseFloat(r.getValue('amount')) || 0,
        currency:  r.getText('currency') || ''
      });
    });
    return results;
  }

  function _tableHtml(rows, dashUrl) {
    const tableRows = rows.map(r =>
      `<tr>
        <td style="padding:8px 10px">
          <span style="background:${r.typeBg};color:${r.typeColor};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">${r.typeLabel}</span>
        </td>
        <td style="padding:8px 10px;font-weight:500;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.entity}</td>
        <td style="padding:8px 10px;font-family:monospace;font-size:12px;color:#555">${r.tranid}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600;white-space:nowrap">${r.currency} ${r.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
      </tr>`
    ).join('');

    const footer = rows.length === 10
      ? `<p style="text-align:center;font-size:12px;color:#aaa;margin:10px 0 4px">Showing first 10 — <a href="${dashUrl}" style="color:#c74634;text-decoration:none">see all</a></p>`
      : '';

    return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#fafafa">
            <th style="padding:7px 10px;text-align:left;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #f0efee">Type</th>
            <th style="padding:7px 10px;text-align:left;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #f0efee">Vendor</th>
            <th style="padding:7px 10px;text-align:left;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #f0efee">Doc #</th>
            <th style="padding:7px 10px;text-align:right;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #f0efee">Amount</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${footer}
      <div style="text-align:right;margin-top:14px">
        <a href="${dashUrl}" style="background:#c74634;color:#fff;padding:8px 18px;border-radius:7px;font-size:13px;font-weight:600;text-decoration:none">Open bulk approval →</a>
      </div>
    </div>`;
  }

  function _emptyHtml(dashUrl) {
    return `<div style="text-align:center;padding:28px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
      <div style="font-size:28px;margin-bottom:8px">✓</div>
      <p style="color:#888;font-size:13px;margin-bottom:16px">No pending approvals for you right now.</p>
      <a href="${dashUrl}" style="color:#c74634;font-size:13px;text-decoration:none;font-weight:500">View approval dashboard →</a>
    </div>`;
  }

  return { render };
});
