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
