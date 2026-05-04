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

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

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
      portlet.html = `<p style="color:#888;padding:12px;font-size:13px">Unable to load approvals: ${_esc(e.message)}</p>`;
    }
  }

  function _loadPending(userId) {
    const results = [];
    search.create({
      type:    'transaction',
      filters: [
        ['type',           'anyof', ['PurchOrd', 'VendBill']],
        'AND',
        ['approvalstatus', 'anyof', [C.APPROVAL_STATUS.PENDING]],
        'AND',
        ['custbody_oa_next_approver',   'anyof', [userId]]
      ],
      columns: [
        'internalid', 'type', 'tranid', 'entity', 'amount', 'currency',
        'trandate', 'subsidiary'
      ]
    }).run().getRange({ start: 0, end: 10 }).forEach(r => {
      const rawType = r.getValue('type');
      results.push({
        id:         r.id,
        recordType: rawType,
        typeLabel:  rawType === 'PurchOrd' ? 'PO' : 'VB',
        typeColor:  rawType === 'PurchOrd' ? '#1565c0' : '#6a1b9a',
        typeBg:     rawType === 'PurchOrd' ? '#e3f2fd' : '#f3e5f5',
        tranid:     r.getValue('tranid'),
        entity:     r.getText('entity') || '—',
        amount:     parseFloat(r.getValue('amount')) || 0,
        currency:   r.getText('currency') || '',
        trandate:   r.getValue('trandate') || '',
        subsidiary: r.getText('subsidiary') || ''
      });
    });
    return results;
  }

  function _tableHtml(rows, dashUrl) {
    // Collect distinct subsidiaries from this batch for the filter <select>
    const subsidiaries = [...new Set(rows.map(r => r.subsidiary).filter(Boolean))].sort();

    const tableRows = rows.map(r => {
      const approveUrl = `${dashUrl}&oa_quick_action=approve&oa_quick_id=${encodeURIComponent(r.id)}&oa_quick_type=${encodeURIComponent(r.recordType)}`;
      const declineUrl = `${dashUrl}&oa_quick_action=decline&oa_quick_id=${encodeURIComponent(r.id)}&oa_quick_type=${encodeURIComponent(r.recordType)}`;
      return `<tr data-vendor="${_esc(r.entity)}" data-amount="${r.amount}" data-date="${_esc(r.trandate)}" data-sub="${_esc(r.subsidiary)}">
        <td style="padding:8px 10px">
          <span style="background:${r.typeBg};color:${r.typeColor};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">${_esc(r.typeLabel)}</span>
        </td>
        <td style="padding:8px 10px;font-weight:500;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(r.entity)}</td>
        <td style="padding:8px 10px;font-family:monospace;font-size:12px;color:#555">${_esc(r.tranid)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600;white-space:nowrap">${_esc(r.currency)} ${r.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
        <td style="padding:8px 10px;text-align:center;white-space:nowrap">
          <a href="${approveUrl}" title="Approve" style="color:#2e7d32;font-size:15px;text-decoration:none;margin-right:8px">&#10003;</a><a href="${declineUrl}" title="Decline" style="color:#c62828;font-size:15px;text-decoration:none">&#10007;</a>
        </td>
      </tr>`;
    }).join('');

    const footer = rows.length === 10
      ? `<p style="text-align:center;font-size:12px;color:#aaa;margin:10px 0 4px">Showing first 10 — <a href="${dashUrl}" style="color:#c74634;text-decoration:none">see all</a></p>`
      : '';

    const subOptions = subsidiaries.map(s => `<option value="${_esc(s)}">${_esc(s)}</option>`).join('');

    return `<div id="oa-portlet-wrap" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 4px 8px;border-bottom:1px solid #f0efee;margin-bottom:2px">
        <input id="oaf-vendor" type="text" placeholder="Filter vendor…"
          style="flex:2 1 110px;min-width:80px;padding:4px 7px;border:1px solid #ddd;border-radius:5px;font-size:12px;outline:none">
        <input id="oaf-amount" type="number" min="0" step="100" placeholder="Min amount"
          style="flex:1 1 80px;min-width:70px;padding:4px 7px;border:1px solid #ddd;border-radius:5px;font-size:12px;outline:none">
        <select id="oaf-date"
          style="flex:1 1 90px;min-width:80px;padding:4px 7px;border:1px solid #ddd;border-radius:5px;font-size:12px;outline:none;background:#fff">
          <option value="all">All dates</option>
          <option value="today">Today</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
        </select>
        <select id="oaf-sub"
          style="flex:2 1 110px;min-width:90px;padding:4px 7px;border:1px solid #ddd;border-radius:5px;font-size:12px;outline:none;background:#fff">
          <option value="">All subsidiaries</option>
          ${subOptions}
        </select>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#fafafa">
            <th style="padding:7px 10px;text-align:left;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #f0efee">Type</th>
            <th style="padding:7px 10px;text-align:left;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #f0efee">Vendor</th>
            <th style="padding:7px 10px;text-align:left;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #f0efee">Doc #</th>
            <th style="padding:7px 10px;text-align:right;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #f0efee">Amount</th>
            <th style="padding:7px 10px;text-align:center;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #f0efee">Quick action</th>
          </tr>
        </thead>
        <tbody id="oa-portlet-tbody">${tableRows}</tbody>
      </table>
      <div id="oa-portlet-empty" style="display:none;padding:16px;text-align:center;color:#aaa;font-size:12px">No matching approvals.</div>
      ${footer}
      <div style="text-align:right;margin-top:14px">
        <a href="${dashUrl}" style="background:#c74634;color:#fff;padding:8px 18px;border-radius:7px;font-size:13px;font-weight:600;text-decoration:none">Open bulk approval →</a>
      </div>
    </div>
    <script>
    (function () {
      var wrap  = document.getElementById('oa-portlet-wrap');
      if (!wrap) return;
      var tbody = document.getElementById('oa-portlet-tbody');
      var empty = document.getElementById('oa-portlet-empty');

      function todayStr() {
        var d = new Date(); var m = d.getMonth() + 1; var dd = d.getDate();
        return d.getFullYear() + '/' + (m < 10 ? '0' + m : m) + '/' + (dd < 10 ? '0' + dd : dd);
      }
      function daysAgoStr(n) {
        var d = new Date(Date.now() - n * 86400000);
        var m = d.getMonth() + 1; var dd = d.getDate();
        return d.getFullYear() + '/' + (m < 10 ? '0' + m : m) + '/' + (dd < 10 ? '0' + dd : dd);
      }

      function applyFilters() {
        var vendor = (document.getElementById('oaf-vendor').value || '').toLowerCase().trim();
        var minAmt = parseFloat(document.getElementById('oaf-amount').value) || 0;
        var dateRange = document.getElementById('oaf-date').value;
        var sub = document.getElementById('oaf-sub').value;

        var cutoff = null;
        if (dateRange === 'today') { cutoff = todayStr(); }
        else if (dateRange === '7')  { cutoff = daysAgoStr(7); }
        else if (dateRange === '30') { cutoff = daysAgoStr(30); }

        var rows = tbody.getElementsByTagName('tr');
        var visible = 0;
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var rowVendor  = (r.getAttribute('data-vendor') || '').toLowerCase();
          var rowAmount  = parseFloat(r.getAttribute('data-amount')) || 0;
          var rowDate    = r.getAttribute('data-date') || '';
          var rowSub     = r.getAttribute('data-sub') || '';

          var show = true;
          if (vendor && rowVendor.indexOf(vendor) === -1) show = false;
          if (minAmt > 0 && rowAmount < minAmt) show = false;
          if (cutoff && rowDate < cutoff) show = false;
          if (sub && rowSub !== sub) show = false;

          r.style.display = show ? '' : 'none';
          if (show) visible++;
        }
        if (empty) empty.style.display = visible === 0 ? '' : 'none';
      }

      ['oaf-vendor', 'oaf-amount', 'oaf-date', 'oaf-sub'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', applyFilters);
      });
    }());
    </script>`;
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
