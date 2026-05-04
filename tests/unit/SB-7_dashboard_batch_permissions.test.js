'use strict';

// SB-7 — per-action privilege check in oa_sl_dashboard.handleBatchPost
// (commit 42d3a69). Without this guard a base approver could craft a POST
// containing super_approve / super_decline / reassign / reset and the
// dashboard would forward it to the engine. The engine has its own checks
// for some of these, but the dashboard MUST refuse before the engine ever
// sees them — defence in depth.
//
// Setup: actor has isApprover=true, isManager=false, isSuperApprover=false.
// We stub the engine so any call that slips through is observable, then
// assert each action's outcome.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const DASHBOARD_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_sl_dashboard.js';

function buildDashboard({ assignedToActor }) {
  const engineCalls = [];
  const engineStub = {
    processApproval: (...args) => { engineCalls.push(['approve', args]); return { success: true, message: 'engine approved' }; },
    processDecline:  (...args) => { engineCalls.push(['decline', args]); return { success: true, message: 'engine declined' }; },
    processReassign: (...args) => { engineCalls.push(['reassign', args]); return { success: true, message: 'engine reassigned' }; },
    processReset:    (...args) => { engineCalls.push(['reset', args]); return { success: true, message: 'engine reset' }; },
    // Other exports the suitelet pulls but never touches in batch POST
    routeForApproval: () => ({}), getSettingsForSubsidiary: () => null
  };

  // Base approver: isApprover=T, isManager=F, isSuperApprover=F.
  // The per-record assigned check looks at custbody_oa_next_approver.
  const ACTOR_ID = 1;
  const search = {
    create: () => ({ run: () => ({ each: () => {}, getRange: () => [] }) }),
    lookupFields: ({ type, columns }) => {
      const out = {};
      (columns || []).forEach(c => {
        if (type === 'employee') {
          if (c === 'custentity_oa_is_approver')       out[c] = 'T';
          else if (c === 'custentity_oa_is_manager')        out[c] = 'F';
          else if (c === 'custentity_oa_is_super_approver') out[c] = 'F';
          else                                              out[c] = null;
        } else {
          // Transaction field check for assignment
          if (c === 'custbody_oa_next_approver') {
            out[c] = assignedToActor ? [{ value: String(ACTOR_ID) }] : [{ value: '999' }];
          } else {
            out[c] = null;
          }
        }
      });
      return out;
    }
  };

  const dashboard = loadModule(DASHBOARD_PATH, {
    'N/runtime': makeRuntimeMock({ getCurrentUser: () => ({ id: ACTOR_ID, role: 3 }) }),
    'N/search':  search,
    'N/url':     { resolveScript: () => '/app/site/url' },
    'N/format':  { Type: { DATE: 'date' }, format: ({ value }) => (value && value.toISOString ? value.toISOString().slice(0, 10) : String(value)) },
    // lib/oa_utils.js (transitively required) needs N/crypto + N/encode.
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string },
    './oa_engine': engineStub
  });

  return { dashboard, engineCalls, ACTOR_ID };
}

// Drive a single batch POST through onRequest and parse the JSON response.
function postBatch(dashboard, actions) {
  let body = '';
  const ctx = {
    request:  { method: 'POST', body: JSON.stringify({ actions }), parameters: {} },
    response: {
      setHeader: () => {},
      write:    (s) => { body += s; }
    }
  };
  dashboard.onRequest(ctx);
  return JSON.parse(body);
}

test('SB-7: base approver can approve a record assigned to them', () => {
  const h = buildDashboard({ assignedToActor: true });
  const out = postBatch(h.dashboard, [
    { action: 'approve', recordId: 555, recordType: 'vendorbill' }
  ]);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].success, true);
  // Engine was actually invoked
  assert.equal(h.engineCalls.length, 1);
  assert.equal(h.engineCalls[0][0], 'approve');
});

test('SB-7: base approver cannot approve a record NOT assigned to them', () => {
  const h = buildDashboard({ assignedToActor: false });
  const out = postBatch(h.dashboard, [
    { action: 'approve', recordId: 555, recordType: 'vendorbill' }
  ]);
  assert.equal(out.results[0].success, false);
  assert.match(out.results[0].message, /not the assigned approver/i);
  // Engine must NOT have been called
  assert.equal(h.engineCalls.length, 0);
});

test('SB-7: base approver cannot decline a record NOT assigned to them', () => {
  const h = buildDashboard({ assignedToActor: false });
  const out = postBatch(h.dashboard, [
    { action: 'decline', recordId: 555, recordType: 'vendorbill', comment: 'nope' }
  ]);
  assert.equal(out.results[0].success, false);
  assert.match(out.results[0].message, /not the assigned approver/i);
  assert.equal(h.engineCalls.length, 0);
});

test('SB-7: base approver is refused super_approve with super.*required', () => {
  const h = buildDashboard({ assignedToActor: true });
  const out = postBatch(h.dashboard, [
    { action: 'super_approve', recordId: 555, recordType: 'vendorbill', comment: 'override' }
  ]);
  assert.equal(out.results[0].success, false);
  assert.match(out.results[0].message, /super.*required/i);
  assert.equal(h.engineCalls.length, 0);
});

test('SB-7: base approver is refused super_decline with super.*required', () => {
  const h = buildDashboard({ assignedToActor: true });
  const out = postBatch(h.dashboard, [
    { action: 'super_decline', recordId: 555, recordType: 'vendorbill', comment: 'override' }
  ]);
  assert.equal(out.results[0].success, false);
  assert.match(out.results[0].message, /super.*required/i);
  assert.equal(h.engineCalls.length, 0);
});

test('SB-7: base approver is refused reassign with manager.*required', () => {
  const h = buildDashboard({ assignedToActor: true });
  const out = postBatch(h.dashboard, [
    { action: 'reassign', recordId: 555, recordType: 'vendorbill', newApprover: 200 }
  ]);
  assert.equal(out.results[0].success, false);
  assert.match(out.results[0].message, /manager.*required/i);
  assert.equal(h.engineCalls.length, 0);
});

test('SB-7: base approver is refused reset with manager.*required', () => {
  const h = buildDashboard({ assignedToActor: true });
  const out = postBatch(h.dashboard, [
    { action: 'reset', recordId: 555, recordType: 'vendorbill', newApprover: 200 }
  ]);
  assert.equal(out.results[0].success, false);
  assert.match(out.results[0].message, /manager.*required/i);
  assert.equal(h.engineCalls.length, 0);
});

test('SB-7: mixed batch — approve(assigned)+reassign+super_approve — only approve succeeds', () => {
  const h = buildDashboard({ assignedToActor: true });
  const out = postBatch(h.dashboard, [
    { action: 'approve',       recordId: 1, recordType: 'vendorbill' },
    { action: 'reassign',      recordId: 2, recordType: 'vendorbill', newApprover: 200 },
    { action: 'super_approve', recordId: 3, recordType: 'vendorbill', comment: 'x' }
  ]);
  assert.equal(out.results.length, 3);
  assert.equal(out.results[0].success, true);
  assert.equal(out.results[1].success, false);
  assert.match(out.results[1].message, /manager.*required/i);
  assert.equal(out.results[2].success, false);
  assert.match(out.results[2].message, /super.*required/i);
  // Only the first action reached the engine
  assert.equal(h.engineCalls.length, 1);
  assert.equal(h.engineCalls[0][0], 'approve');
});
