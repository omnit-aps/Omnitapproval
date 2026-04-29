'use strict';

// SB-1 — when routeForApproval cannot resolve an approver, the User Event must
// throw a blocking error so the bill cannot persist in an ungoverned state.
//
// Two failure modes are exercised:
//   1. routeForApproval returns { error: 'NO_SETTINGS' }            -> throw
//   2. routeForApproval returns { approver1: null, approver2: null } -> throw

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

function buildUE(engineStub) {
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

test('SB-1: beforeSubmit throws when routeForApproval surfaces error code', () => {
  const ue = buildUE({
    routeForApproval: () => ({ error: 'NO_SETTINGS' }),
    getSettingsForSubsidiary: () => null,
    createAuditLog: () => null
  });

  const newRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1'
  });

  assert.throws(() => {
    ue.beforeSubmit({
      type:          'create',
      UserEventType: { CREATE: 'create', EDIT: 'edit' },
      newRecord:     newRec
    });
  }, /OA_ROUTING_REFUSED|NO_SETTINGS/);
});

test('SB-1: beforeSubmit throws when no approver was resolved', () => {
  const ue = buildUE({
    routeForApproval: () => ({ approver1: null, approver2: null, hierarchyId: null, approverCount: 1, settings: {} }),
    getSettingsForSubsidiary: () => ({ id: 1 }),
    createAuditLog: () => null
  });

  const newRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1'
  });

  assert.throws(() => {
    ue.beforeSubmit({
      type:          'create',
      UserEventType: { CREATE: 'create', EDIT: 'edit' },
      newRecord:     newRec
    });
  }, /OA_NO_APPROVER/);

  // Critical: approvalstatus must NOT have been flipped to PENDING before the throw.
  // The thrown error aborts the save, but downstream code (afterSubmit, NS native
  // approvalrouting) might still observe a partial mutation if we wrote first.
  assert.equal(newRec.getValue('approvalstatus'), undefined,
    'approvalstatus must remain unset when routing fails');
});
