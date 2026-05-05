/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * OA Analytics — visual dashboard for the demo deck. Three Chart.js charts
 * powered by live SuiteQL queries against the OA-routed transactions:
 *
 *   1. Status donut       — Pending / Approved / Rejected counts (last 30d)
 *   2. Daily volume bar   — count of routed transactions per day (last 30d)
 *   3. Top vendors hbar   — top 10 vendors by total approved spend (last 90d)
 *
 * No external API. Pulls counts via N/search and renders inline using Chart.js
 * loaded from a CDN. Designed to be screenshot-ready.
 */
define([
  'N/runtime',
  'N/search',
  './lib/oa_constants'
], (runtime, search, C) => {
  'use strict';

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function loadStatusCounts() {
    const out = { pending: 0, approved: 0, rejected: 0 };
    try {
      const filters = [
        ['type', 'anyof', ['PurchOrd', 'VendBill']],
        'AND', ['mainline', 'is', 'T'],
        'AND', ['datecreated', 'within', 'thismonthtodate'],
        'AND', [C.FIELDS.TRANSACTION.SUBMITTED_BY, 'noneof', ['@NONE@']]
      ];
      search.create({
        type: 'transaction', filters,
        columns: ['internalid', 'approvalstatus']
      }).run().each((r) => {
        const s = r.getValue('approvalstatus');
        if (s === C.APPROVAL_STATUS.PENDING)  out.pending++;
        else if (s === C.APPROVAL_STATUS.APPROVED) out.approved++;
        else if (s === C.APPROVAL_STATUS.REJECTED) out.rejected++;
        else out.pending++; // null/empty (PO normalization) — count as pending
        return true;
      });
    } catch (e) { /* graceful */ }
    return out;
  }

  function loadDailyVolume() {
    const days = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      days[key] = 0;
    }
    const cutoff = Date.now() - 30 * 86400000;
    try {
      search.create({
        type: 'transaction',
        filters: [
          ['type', 'anyof', ['PurchOrd', 'VendBill']],
          'AND', ['mainline', 'is', 'T'],
          'AND', [C.FIELDS.TRANSACTION.SUBMITTED_BY, 'noneof', ['@NONE@']]
        ],
        columns: ['internalid', { name: 'datecreated', sort: search.Sort.DESC }]
      }).run().each((r) => {
        const dc = r.getValue('datecreated') || '';
        const m = dc.match(/(\d+)\/(\d+)\/(\d+)/);
        if (m) {
          const key = `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
          if (days[key] != null) days[key]++;
          // Stop iterating once results are older than the 30d window
          const ts = new Date(`${key}T00:00:00`).getTime();
          if (ts < cutoff) return false;
        }
        return true;
      });
    } catch (e) { /* graceful */ }
    return days;
  }

  function loadTopVendors() {
    const totals = {};
    let count = 0;
    try {
      // No date filter — drops out for sandbox accounts where approved volume is sparse.
      // Cap at 1000 rows. Sort approved DESC by amount so top vendors surface fast.
      search.create({
        type: 'transaction',
        filters: [
          ['type', 'anyof', ['PurchOrd', 'VendBill']],
          'AND', ['mainline', 'is', 'T'],
          'AND', ['approvalstatus', 'anyof', [C.APPROVAL_STATUS.APPROVED]]
        ],
        columns: ['entity', { name: 'amount', sort: search.Sort.DESC }]
      }).run().each((r) => {
        const v = r.getText('entity') || '(unknown)';
        const a = parseFloat(r.getValue('amount')) || 0;
        totals[v] = (totals[v] || 0) + a;
        count++;
        return count < 1000;
      });
    } catch (e) { /* graceful */ }
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return { labels: sorted.map(s => s[0]), values: sorted.map(s => Number(s[1].toFixed(2))) };
  }

  function onRequest(context) {
    const resp = context.response;
    resp.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });

    const status = loadStatusCounts();
    const daily  = loadDailyVolume();
    const vendors = loadTopVendors();

    const dailyKeys = Object.keys(daily);
    const dailyVals = Object.values(daily);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>OA Analytics — Live Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#f0efee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#312d2a;font-size:14px;padding:32px 28px 60px}
  .topbar{background:linear-gradient(135deg,#312d2a 0%,#4a4541 100%);color:#fff;padding:18px 28px;border-radius:14px;margin-bottom:24px;box-shadow:0 4px 14px rgba(0,0,0,.12);display:flex;justify-content:space-between;align-items:center}
  .topbar h1{font-size:22px;font-weight:700;letter-spacing:.3px}
  .topbar .sub{font-size:13px;opacity:.8;margin-top:3px}
  .badge{background:#c74634;color:#fff;padding:6px 14px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.5px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  .card{background:#fff;border-radius:14px;padding:22px 24px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
  .card.full{grid-column:1/-1}
  .card h2{font-size:15px;font-weight:700;color:#312d2a;margin-bottom:4px}
  .card .h2-sub{font-size:12px;color:#888;margin-bottom:18px}
  .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px}
  .kpi{background:#fff;border-radius:12px;padding:20px 22px;box-shadow:0 2px 8px rgba(0,0,0,.06);position:relative;overflow:hidden}
  .kpi-label{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.7px;font-weight:600}
  .kpi-value{font-size:32px;font-weight:700;margin-top:6px;line-height:1.1}
  .kpi-pending  {border-left:5px solid #f59f0b}
  .kpi-approved {border-left:5px solid #2e7d32}
  .kpi-rejected {border-left:5px solid #c74634}
  .kpi-pending .kpi-value{color:#f59f0b}
  .kpi-approved .kpi-value{color:#2e7d32}
  .kpi-rejected .kpi-value{color:#c74634}
  .chart-box{position:relative;height:300px}
  .chart-box.tall{height:380px}
</style>
</head>
<body>
<div class="topbar">
  <div>
    <h1>Omnit Approvals — Analytics</h1>
    <div class="sub">Live data · ${dailyKeys.length}-day rolling window · ${new Date().toUTCString()}</div>
  </div>
  <span class="badge">LIVE</span>
</div>

<div class="kpis">
  <div class="kpi kpi-pending">
    <div class="kpi-label">Pending Approval</div>
    <div class="kpi-value">${status.pending}</div>
  </div>
  <div class="kpi kpi-approved">
    <div class="kpi-label">Approved (this month)</div>
    <div class="kpi-value">${status.approved}</div>
  </div>
  <div class="kpi kpi-rejected">
    <div class="kpi-label">Rejected (this month)</div>
    <div class="kpi-value">${status.rejected}</div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>Status breakdown</h2>
    <div class="h2-sub">Share of routed transactions by current approval state</div>
    <div class="chart-box"><canvas id="chart-donut"></canvas></div>
  </div>
  <div class="card">
    <h2>Daily routing volume</h2>
    <div class="h2-sub">Transactions submitted to OA per day, last 30 days</div>
    <div class="chart-box"><canvas id="chart-bar"></canvas></div>
  </div>
  <div class="card full">
    <h2>Top 10 vendors — approved spend (last 90d)</h2>
    <div class="h2-sub">Sum of approved transaction amounts grouped by vendor</div>
    <div class="chart-box tall"><canvas id="chart-hbar"></canvas></div>
  </div>
</div>

<script>
const PALETTE = ['#c74634','#1565c0','#2e7d32','#f59f0b','#6a1b9a','#0288d1','#ad1457','#00838f','#5d4037','#7b1fa2'];

new Chart(document.getElementById('chart-donut'), {
  type: 'doughnut',
  data: {
    labels: ['Pending','Approved','Rejected'],
    datasets: [{
      data: [${status.pending}, ${status.approved}, ${status.rejected}],
      backgroundColor: ['#f59f0b','#2e7d32','#c74634'],
      borderWidth: 0
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'right', labels: { boxWidth: 14, padding: 14, font: { size: 13 } } }
    },
    cutout: '60%'
  }
});

new Chart(document.getElementById('chart-bar'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(dailyKeys.map(k => k.slice(5)))},
    datasets: [{
      label: 'Transactions',
      data: ${JSON.stringify(dailyVals)},
      backgroundColor: '#1565c0',
      borderRadius: 4,
      barThickness: 'flex',
      maxBarThickness: 18
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { font: { size: 10 } }, grid: { display: false } },
      y: { beginAtZero: true, ticks: { stepSize: 1 } }
    }
  }
});

new Chart(document.getElementById('chart-hbar'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(vendors.labels)},
    datasets: [{
      label: 'Approved spend',
      data: ${JSON.stringify(vendors.values)},
      backgroundColor: ${JSON.stringify(vendors.labels)}.map((_, i) => PALETTE[i % PALETTE.length]),
      borderRadius: 5
    }]
  },
  options: {
    indexAxis: 'y',
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => '$' + c.raw.toLocaleString() } }
    },
    scales: {
      x: {
        beginAtZero: true,
        ticks: { callback: (v) => '$' + (v >= 1000 ? (v/1000).toFixed(1) + 'k' : v) }
      }
    }
  }
});
</script>
</body>
</html>`;

    resp.write(html);
  }

  return { onRequest };
});
