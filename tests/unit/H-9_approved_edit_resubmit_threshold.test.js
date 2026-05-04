'use strict';

// H-9 — when an APPROVED record is edited, the User Event re-routes only
// if the amount change exceeds the configured resubmit threshold(s).
// Threshold(s) live on the subsidiary settings record:
//   - custrecord_oas_resubmit_threshold_pct (e.g., 10 = ≥10% change)
//   - custrecord_oas_resubmit_threshold_abs (e.g., 1000 = ≥$1000 change)
// Either threshold being exceeded triggers re-route. Both 0/empty means
// no re-route on edits to APPROVED records (a noisy default would force
// re-approval on every cosmetic edit).

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const {
  makeRuntimeMock,
  makeRecordInstance,
  TASK_MOCK,
  URL_MOCK,
  SERVERWIDGET_MOCK,
  CRYPTO_MOCK,
  ENCODE_MOCK,
  ERROR_MOCK
} = require('../_mocks');

const UE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_user_event.js';

function buildUE({ pctCfg, absCfg, captureCalls }) {
  const log_ = { getValue: () => 'log-row' };
  const search_ = {
    create: () => ({ run: () => ({ each: (cb) => { cb(log_); }, getRange: () => [log_] }) }),
    lookupFields: () => ({})
  };

  const engineStub = {
    routeForApproval: (rt, rid, sid, amount) => {
      captureCalls.routes.push({ rt, rid, sid, amount });
      return { approver1: 999, approver2: null, hierarchyId: 7, approverCount: 1, settings: {} };
    },
    getSettingsForSubsidiary: () => ({
      id: 1,
      resubmit_threshold_pct: pctCfg,
      resubmit_threshold_abs: absCfg
    }),
    createAuditLog: () => null
  };

  return loadModule(UE_PATH, {
    'N/record':           { load: () => makeRecordInstance({}), create: () => makeRecordInstance({}) },
    'N/runtime':          makeRuntimeMock(),
    'N/search':           search_,
    'N/task':             TASK_MOCK,
    'N/url':              URL_MOCK,
    'N/error':            ERROR_MOCK,
    'N/ui/serverWidget':  SERVERWIDGET_MOCK,
    'N/crypto':           CRYPTO_MOCK,
    'N/encode':           ENCODE_MOCK,
    './oa_engine':        engineStub
  });
}

test('H-9 APPROVED edit, change well below pct threshold -> no re-route', () => {
  const calls = { routes: [] };
  const ue    = buildUE({ pctCfg: '20', absCfg: '0', captureCalls: calls });

  const oldRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '1000', exchangerate: '1',
    approvalstatus: '2' // APPROVED
  });
  const newRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '1050', exchangerate: '1', // +5%
    approvalstatus: '2'
  });

  ue.beforeSubmit({
    type: 'edit',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: newRec,
    oldRecord: oldRec
  });

  assert.equal(calls.routes.length, 0, '5% < 20% threshold — must NOT re-route');
});

test('H-9 APPROVED edit, change exactly at pct threshold -> re-route (>= boundary)', () => {
  const calls = { routes: [] };
  const ue    = buildUE({ pctCfg: '20', absCfg: '0', captureCalls: calls });

  const oldRec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '1000', exchangerate: '1', approvalstatus: '2' });
  const newRec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '1200', exchangerate: '1', approvalstatus: '2' }); // +20%

  ue.beforeSubmit({
    type: 'edit', UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: newRec, oldRecord: oldRec
  });

  assert.equal(calls.routes.length, 1, '20% >= 20% threshold — must re-route');
});

test('H-9 APPROVED edit, change above abs threshold even when pct under -> re-route', () => {
  const calls = { routes: [] };
  // pct is 50% (huge); abs is $500 — change is $600 absolute / 60% pct.
  // We test that abs alone can trigger re-route if pct=0/disabled.
  const ue    = buildUE({ pctCfg: '0', absCfg: '500', captureCalls: calls });

  const oldRec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '10000', exchangerate: '1', approvalstatus: '2' });
  const newRec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '10600', exchangerate: '1', approvalstatus: '2' }); // +6%, +$600 abs

  ue.beforeSubmit({
    type: 'edit', UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: newRec, oldRecord: oldRec
  });

  assert.equal(calls.routes.length, 1, '$600 >= $500 abs threshold — must re-route even though pct=0 (disabled)');
});

test('H-9 APPROVED edit, both thresholds zero/unconfigured -> never re-route', () => {
  const calls = { routes: [] };
  const ue    = buildUE({ pctCfg: '0', absCfg: '0', captureCalls: calls });

  const oldRec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '100', exchangerate: '1', approvalstatus: '2' });
  const newRec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '999999', exchangerate: '1', approvalstatus: '2' });

  ue.beforeSubmit({
    type: 'edit', UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: newRec, oldRecord: oldRec
  });

  assert.equal(calls.routes.length, 0, 'No threshold configured = no re-route on APPROVED edits, regardless of magnitude');
});

test('H-9 APPROVED edit, abs threshold uses BASE-currency, not foreign', () => {
  // Foreign amount: oldRec total=100 EUR, newRec total=300 EUR (+200 EUR foreign).
  // Exchange rate 1.5 EUR/USD: change in base is +$300 USD.
  // abs threshold = $250 USD. Change should exceed.
  const calls = { routes: [] };
  const ue    = buildUE({ pctCfg: '0', absCfg: '250', captureCalls: calls });

  const oldRec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '100', exchangerate: '1.5', approvalstatus: '2' });
  const newRec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '300', exchangerate: '1.5', approvalstatus: '2' });

  ue.beforeSubmit({
    type: 'edit', UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: newRec, oldRecord: oldRec
  });

  // (300 - 100) * 1.5 = 300 base-currency USD; 300 >= 250 threshold -> re-route.
  assert.equal(calls.routes.length, 1, 'abs threshold should be compared in base currency');
});
