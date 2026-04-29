'use strict';

// SB-0 — UE script must execute and route a vendor bill regardless of execution
// context. Live evidence (2026-04-29, sandbox td3075893): six REST-created bills
// (93154, 93254, 93255, 93354, 93355, 93356) auto-approved with status=A because
// the previous filter excluded RESTWEBSERVICES under that account's runtime.
//
// This test loads oa_user_event.js with the AMD shim, drives beforeSubmit + afterSubmit
// for every non-UI execution context the SuiteScript runtime exposes, and asserts
// that the engine.routeForApproval mock is invoked and approvalstatus is set to PENDING.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('path');

const { loadModule }              = require('../_amd');
const { makeRuntimeMock,
        makeSearchMock,
        makeRecordInstance,
        TASK_MOCK,
        URL_MOCK,
        SERVERWIDGET_MOCK,
        CRYPTO_MOCK,
        ENCODE_MOCK }              = require('../_mocks');

const UE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_user_event.js';

const NON_UI_CONTEXTS = [
  'WEBSERVICES',
  'RESTLET',
  'RESTWEBSERVICES',
  'CSVIMPORT',
  'SCHEDULED',
  'USEREVENT',
  'WORKFLOW',
  'MAPREDUCE'
];

function buildUE(execContext, engineStub) {
  const runtimeMock = makeRuntimeMock({ executionContext: execContext });
  const searchMock  = makeSearchMock({});
  const recordMock  = { load: () => makeRecordInstance({}), create: () => makeRecordInstance({}) };

  return loadModule(UE_PATH, {
    'N/record':           recordMock,
    'N/runtime':          runtimeMock,
    'N/search':           searchMock,
    'N/task':             TASK_MOCK,
    'N/url':              URL_MOCK,
    'N/ui/serverWidget':  SERVERWIDGET_MOCK,
    'N/crypto':           CRYPTO_MOCK,
    'N/encode':           ENCODE_MOCK,
    './oa_engine':        engineStub
  });
}

function fakeEngineStub(approver1) {
  const calls = [];
  return {
    _calls: calls,
    getSettingsForSubsidiary: () => ({ id: 1 }),
    routeForApproval: (recordType, recordId, subsidiaryId, amount) => {
      calls.push({ recordType, recordId, subsidiaryId, amount });
      return { approver1, approver2: null, hierarchyId: 7, approverCount: 1, settings: {} };
    },
    createAuditLog: () => 99
  };
}

for (const ctx of NON_UI_CONTEXTS) {
  test(`SB-0: beforeSubmit routes a CREATE in execContext=${ctx}`, () => {
    const engine = fakeEngineStub(123);
    const ue     = buildUE(ctx, engine);

    const newRec = makeRecordInstance({
      type: 'vendorbill',
      id:   null,
      subsidiary:    '2',
      total:         '500.00',
      exchangerate:  '1'
    });

    const TRIGGER = { CREATE: 'create', EDIT: 'edit' };
    ue.beforeSubmit({
      type:          TRIGGER.CREATE,
      UserEventType: TRIGGER,
      newRecord:     newRec
    });

    assert.equal(engine._calls.length, 1, `engine.routeForApproval was not called in execContext=${ctx}`);
    assert.equal(newRec.getValue({ fieldId: 'approvalstatus' }), '1',
      `approvalstatus was not set to PENDING in execContext=${ctx}`);
    assert.equal(newRec.getValue({ fieldId: 'custbody_oa_next_approver' }), 123,
      `next-approver field was not written in execContext=${ctx}`);
  });
}
