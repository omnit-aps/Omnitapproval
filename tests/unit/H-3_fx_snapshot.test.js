'use strict';

// H-3 — at first submit, the User Event freezes the base-currency amount
// and exchange rate on custbody_oa_base_amount + custbody_oa_fx_snapshot.
// Subsequent EDIT submissions must reuse the snapshot, not recompute from
// (possibly stale) exchangerate / total fields.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule }              = require('../_amd');
const { makeRuntimeMock,
        makeSearchMock,
        makeRecordInstance,
        TASK_MOCK,
        URL_MOCK,
        SERVERWIDGET_MOCK,
        CRYPTO_MOCK,
        ENCODE_MOCK,
        ERROR_MOCK }               = require('../_mocks');

const UE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_user_event.js';

function buildUE(engineCalls) {
  const engineStub = {
    routeForApproval: (recordType, recordId, subsidiaryId, amount) => {
      engineCalls.push({ recordType, recordId, subsidiaryId, amount });
      return { approver1: 123, approver2: null, hierarchyId: 7, approverCount: 1, settings: {} };
    },
    getSettingsForSubsidiary: () => ({ id: 1 }),
    createAuditLog: () => null
  };
  return loadModule(UE_PATH, {
    'N/record':           { load: () => makeRecordInstance({}), create: () => makeRecordInstance({}) },
    'N/runtime':          makeRuntimeMock(),
    'N/search':           makeSearchMock({}),
    'N/task':             TASK_MOCK,
    'N/url':              URL_MOCK,
    'N/error':            ERROR_MOCK,
    'N/ui/serverWidget':  SERVERWIDGET_MOCK,
    'N/crypto':           CRYPTO_MOCK,
    'N/encode':           ENCODE_MOCK,
    './oa_engine':        engineStub
  });
}

test('H-3: first CREATE submit persists base amount and FX rate', () => {
  const calls = [];
  const ue    = buildUE(calls);
  const rec   = makeRecordInstance({
    type: 'vendorbill',
    subsidiary:   '2',
    total:        '100',     // 100 EUR
    exchangerate: '1.10'      // 1 EUR = 1.10 USD
  });

  ue.beforeSubmit({
    type: 'create',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: rec
  });

  // Engine was called with 110 (base USD amount; FP arithmetic ~110.0000…1)
  assert.equal(calls.length, 1);
  assert.ok(Math.abs(calls[0].amount - 110) < 1e-6,
    'engine amount expected ~110, got ' + calls[0].amount);

  // Snapshot persisted on the record
  assert.ok(Math.abs(rec.getValue('custbody_oa_base_amount') - 110) < 1e-6);
  assert.equal(rec.getValue('custbody_oa_fx_snapshot'), 1.1);
});

test('H-3: subsequent EDIT submit reuses the frozen amount even if FX moved', () => {
  const calls = [];
  const ue    = buildUE(calls);

  // Bill is EDITed AFTER initial submit — exchange rate has moved from 1.10 -> 1.50
  // but the snapshot was frozen at 110 USD. Engine must be called with 110, not 150.
  const oldRec = makeRecordInstance({
    type: 'vendorbill',
    subsidiary:   '2',
    total:        '100',
    exchangerate: '1.10',
    custbody_oa_base_amount: 110,
    custbody_oa_fx_snapshot: 1.10,
    approvalstatus: '3'  // REJECTED — re-route is allowed
  });

  // Make sure search.create returns a single OA log row so the EDIT is treated
  // as a managed-record EDIT (otherwise the UE skips the route).
  const log_ = { getValue: () => 'log-row' };
  const ueWithLog = (() => {
    const engineStub = {
      routeForApproval: (recordType, recordId, subsidiaryId, amount) => {
        calls.push({ recordType, recordId, subsidiaryId, amount });
        return { approver1: 123, approver2: null, hierarchyId: 7, approverCount: 1, settings: {} };
      },
      getSettingsForSubsidiary: () => ({ id: 1, resubmit_threshold_pct: 0, resubmit_threshold_abs: 0 }),
      createAuditLog: () => null
    };
    return loadModule(UE_PATH, {
      'N/record':           { load: () => makeRecordInstance({}), create: () => makeRecordInstance({}) },
      'N/runtime':          makeRuntimeMock(),
      'N/search':           {
        create: () => ({ run: () => ({ each: (cb) => { cb(log_); }, getRange: () => [log_] }) }),
        lookupFields: () => ({})
      },
      'N/task':             TASK_MOCK,
      'N/url':              URL_MOCK,
      'N/error':            ERROR_MOCK,
      'N/ui/serverWidget':  SERVERWIDGET_MOCK,
      'N/crypto':           CRYPTO_MOCK,
      'N/encode':           ENCODE_MOCK,
      './oa_engine':        engineStub
    });
  })();

  // The "new" record now reflects a fresh exchange rate (1.50).
  const newRec = makeRecordInstance({
    type: 'vendorbill',
    id: 999,
    subsidiary:   '2',
    total:        '100',
    exchangerate: '1.50',
    custbody_oa_base_amount: 110,
    custbody_oa_fx_snapshot: 1.10,
    approvalstatus: '3'
  });

  ueWithLog.beforeSubmit({
    type: 'edit',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: newRec,
    oldRecord: oldRec
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].amount, 110, 'must reuse the snapshot, not recompute against new rate');

  // Snapshot must NOT be overwritten on the EDIT path.
  assert.equal(newRec.getValue('custbody_oa_fx_snapshot'), 1.10);
});
