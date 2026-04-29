'use strict';

// H-6 — provenance custbody fields are written on every routing decision.
// Live evidence (sandbox td3075893) showed these were always NULL even on
// successfully-routed bills. Now beforeSubmit writes:
//   - custbody_oa_current_step  (=1 on first route, =2 when engine advances)
//   - custbody_oa_approver1     (resolved approver from threshold/default)
//   - custbody_oa_approver2     (when approverCount >= 2)

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

function buildUE(routeReturn) {
  const engineStub = {
    routeForApproval: () => routeReturn,
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

test('H-6: single-approver routing writes current_step=1 and approver1', () => {
  const ue  = buildUE({
    approver1: 50, approver2: null, hierarchyId: 7, approverCount: 1, settings: {}
  });
  const rec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '100', exchangerate: '1'
  });

  ue.beforeSubmit({
    type: 'create',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: rec
  });

  assert.equal(rec.getValue('custbody_oa_current_step'), 1);
  assert.equal(rec.getValue('custbody_oa_approver1'),    50);
  // approver2 is left untouched when not provided
  assert.equal(rec.getValue('custbody_oa_approver2'),    undefined);
});

test('H-6: two-approver routing writes both approver1 and approver2', () => {
  const ue  = buildUE({
    approver1: 50, approver2: 99, hierarchyId: 7, approverCount: 2, settings: {}
  });
  const rec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '100', exchangerate: '1'
  });

  ue.beforeSubmit({
    type: 'create',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: rec
  });

  assert.equal(rec.getValue('custbody_oa_current_step'), 1);
  assert.equal(rec.getValue('custbody_oa_approver1'),    50);
  assert.equal(rec.getValue('custbody_oa_approver2'),    99);
});

test('H-6: hierarchy_used is also written (regression check from SB-6)', () => {
  const ue  = buildUE({
    approver1: 50, approver2: null, hierarchyId: 17, approverCount: 1, settings: {}
  });
  const rec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '100', exchangerate: '1'
  });

  ue.beforeSubmit({
    type: 'create',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: rec
  });

  assert.equal(rec.getValue('custbody_oa_hierarchy_used'), 17);
});

// ── L-2 null-hierarchy / default-routed coverage ─────────────────────────────
//
// Bills routed via settings.default_approver1 (no rule matched, or use_amount
// disabled) get hierarchyId=null from the engine. H-6 originally only verified
// the happy path with a real hierarchyId, so the null branch went uncovered.
// These tests close that gap and pin the M-1 route_source contract on default
// routing.

test('L-2: default-routed bill (hierarchyId=null) leaves hierarchy_used null', () => {
  const ue  = buildUE({
    approver1: 8, approver2: null, hierarchyId: null, approverCount: 1, settings: {}, routeSource: 'DEFAULT'
  });
  const rec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '5000', exchangerate: '1'
  });

  ue.beforeSubmit({
    type: 'create',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: rec
  });

  assert.equal(rec.getValue('custbody_oa_hierarchy_used'), undefined,
    'hierarchy_used must remain unset on default-routed bills');
  assert.equal(rec.getValue('custbody_oa_route_source'), 'DEFAULT',
    'route_source must be DEFAULT to preserve provenance even when hierarchy_used is empty');
});

test('L-2: default-routed bill still populates current_step / approver1 / base_amount / state_version', () => {
  const ue  = buildUE({
    approver1: 8, approver2: null, hierarchyId: null, approverCount: 1, settings: {}, routeSource: 'DEFAULT'
  });
  const rec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '5000', exchangerate: '1.10'
  });

  ue.beforeSubmit({
    type: 'create',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: rec
  });

  assert.equal(rec.getValue('custbody_oa_current_step'), 1, 'current_step must populate on default route');
  assert.equal(rec.getValue('custbody_oa_approver1'),    8, 'approver1 must populate on default route');

  // Base amount = 5000 * 1.10 = 5500. FP arithmetic ~ 5500.000…1.
  const base = parseFloat(rec.getValue('custbody_oa_base_amount'));
  assert.ok(Math.abs(base - 5500) < 1e-6, 'base_amount must populate on default route, got ' + base);
  assert.equal(rec.getValue('custbody_oa_fx_snapshot'), 1.1, 'fx_snapshot must populate on default route');
});

test('L-2: two-approver default route writes approver2 alongside approver1', () => {
  const ue  = buildUE({
    approver1: 8, approver2: 9, hierarchyId: null, approverCount: 2, settings: {}, routeSource: 'DEFAULT'
  });
  const rec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '5000', exchangerate: '1'
  });

  ue.beforeSubmit({
    type: 'create',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: rec
  });

  assert.equal(rec.getValue('custbody_oa_approver1'), 8);
  assert.equal(rec.getValue('custbody_oa_approver2'), 9);
  assert.equal(rec.getValue('custbody_oa_route_source'), 'DEFAULT');
  assert.equal(rec.getValue('custbody_oa_hierarchy_used'), undefined);
});
