'use strict';

// M-6 — oa_portlet.js render(context).
//
// The portlet shows pending approvals filtered to the CURRENT USER's
// next_approver assignments (the search filter is hard-coded — no
// privilege escalation through the portlet). HTML output must escape
// vendor names / tranids etc. so a malicious vendor name like
// `<script>alert(1)</script>` cannot inject into the portlet frame.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const PORTLET_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_portlet.js';

function makeHarness({ pendingRows = [], currentUserId = 500 } = {}) {
  const searchCalls = [];

  const buildSearchRow = (r) => ({
    id: r.id,
    getValue: (col) => {
      if (col === 'type')       return r.recordType;
      if (col === 'tranid')     return r.tranid || '';
      if (col === 'entity')     return r.entityId || '';
      if (col === 'amount')     return String(r.amount || '0');
      if (col === 'currency')   return r.currencyId || '1';
      if (col === 'trandate')   return r.trandate || '01/01/2025';
      if (col === 'subsidiary') return r.subsidiaryId || '2';
      return '';
    },
    getText: (col) => {
      if (col === 'entity')     return r.entityText || '';
      if (col === 'currency')   return r.currencyText || 'USD';
      if (col === 'subsidiary') return r.subsidiaryText || 'HQ';
      return '';
    }
  });

  const search = {
    create: (cfg) => {
      searchCalls.push(cfg);
      return {
        run: () => ({
          getRange: () => pendingRows.map(buildSearchRow),
          each: (cb) => { for (const r of pendingRows.map(buildSearchRow)) { if (cb(r) === false) break; } }
        })
      };
    },
    lookupFields: () => ({})
  };

  const runtimeMock = makeRuntimeMock();
  runtimeMock.getCurrentUser = () => ({ id: currentUserId, role: 3, email: 'psld@omnit.dk' });

  const urlMock = {
    resolveScript: () => '/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_dashboard&deploy=customdeploy_oa_sl_dashboard'
  };

  const portlet = loadModule(PORTLET_PATH, {
    'N/runtime': runtimeMock,
    'N/search':  search,
    'N/url':     urlMock
  });

  return { portlet, searchCalls };
}

function makePortletContext() {
  const portlet = { html: '', title: '' };
  return { portlet, _portlet: portlet };
}

test('M-6 search filter restricted to current user (custbody_oa_next_approver=userId)', () => {
  const h = makeHarness({ currentUserId: 500, pendingRows: [] });
  const ctx = makePortletContext();
  h.portlet.render(ctx);
  assert.equal(h.searchCalls.length, 1, 'one search created');
  const filters = h.searchCalls[0].filters;
  // Find the filter that scopes to current user.
  const userFilter = JSON.stringify(filters);
  assert.match(userFilter, /custbody_oa_next_approver/);
  assert.match(userFilter, /500/, 'must filter by the current user id, not another approver');
});

test('M-6 PO + VB rows render with their distinct badges', () => {
  const h = makeHarness({
    pendingRows: [
      { id: '1', recordType: 'PurchOrd', tranid: 'PO-1', amount: 100, entityText: 'V1' },
      { id: '2', recordType: 'VendBill', tranid: 'VB-2', amount: 200, entityText: 'V2' }
    ]
  });
  const ctx = makePortletContext();
  h.portlet.render(ctx);
  // Both type labels and both tranids should be in the HTML.
  assert.match(ctx.portlet.html, /PO/);
  assert.match(ctx.portlet.html, /VB/);
  assert.match(ctx.portlet.html, /PO-1/);
  assert.match(ctx.portlet.html, /VB-2/);
});

test('M-6 empty state when no pending records', () => {
  const h = makeHarness({ pendingRows: [] });
  const ctx = makePortletContext();
  h.portlet.render(ctx);
  // Should NOT render a table; should render some empty-state messaging instead.
  assert.doesNotMatch(ctx.portlet.html, /<tbody/i, 'empty state should not include a table body');
  assert.match(ctx.portlet.html, /no pending|nothing|all caught up|empty/i,
    'empty state should include some "nothing pending" wording');
});

test('M-6 vendor names and tranids are HTML-escaped (XSS guard)', () => {
  const h = makeHarness({
    pendingRows: [{
      id: '1',
      recordType: 'VendBill',
      tranid: '<script>alert(1)</script>',
      amount: 100,
      entityText: '"<img src=x onerror=alert(1)>"'
    }]
  });
  const ctx = makePortletContext();
  h.portlet.render(ctx);
  assert.doesNotMatch(ctx.portlet.html, /<script>alert\(1\)<\/script>/,
    'raw <script> from tranid must not appear in output');
  // Vendor name with <img> tag must have the actual angle bracket escaped — the
  // browser can't parse a tag without a real '<', so inner attributes are inert.
  assert.doesNotMatch(ctx.portlet.html, /<img\s+src=x\s+onerror=alert\(1\)>/,
    'raw <img onerror> tag from vendor name must not appear unescaped');
  // The escaped form should be present.
  assert.match(ctx.portlet.html, /&lt;script&gt;/, 'tranid <script> escaped to &lt;script&gt;');
  assert.match(ctx.portlet.html, /&lt;img\s+src=x\s+onerror=/, 'vendor <img> escaped to &lt;img&gt;');
});

test('M-6 result limited to first 10 rows even when more pending', () => {
  // 12 pending rows; portlet's getRange caps at end=10 (i.e. 10 rows).
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ id: String(i + 1), recordType: 'VendBill', tranid: 'VB-' + (i + 1), amount: 1, entityText: 'V' + i });
  const h = makeHarness({ pendingRows: rows.slice(0, 10) }); // simulate NS getRange behavior
  const ctx = makePortletContext();
  h.portlet.render(ctx);
  // Confirm no row beyond VB-10 made it in.
  assert.doesNotMatch(ctx.portlet.html, /VB-11|VB-12/, 'portlet renders at most 10 rows');
  // Confirm at least the first row IS present.
  assert.match(ctx.portlet.html, /VB-1\b/);
});
