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
        ENCODE_MOCK,
        ERROR_MOCK }               = require('../_mocks');

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
    'N/error':            ERROR_MOCK,
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

// ── L-1 negative paths: SB-0 contexts must also enforce SB-1/SB-6 fail-closed
// behaviour. Removing the allow-list filter is only meaningful if every context
// carries the SB-1/SB-6 guarantees too. These tests pin that contract.

function refusingEngine(error) {
  return {
    _calls: [],
    getSettingsForSubsidiary: () => ({ id: 1 }),
    routeForApproval: function (recordType, recordId, subsidiaryId, amount) {
      this._calls.push({ recordType, recordId, subsidiaryId, amount });
      return error ? { error } : { approver1: null, approver2: null, approverCount: 1, settings: {} };
    },
    createAuditLog: () => null
  };
}

const NEGATIVE_CASES = [
  { ctx: 'RESTWEBSERVICES', engine: refusingEngine('NO_SETTINGS'),       expect: /OA_ROUTING_REFUSED|NO_SETTINGS/ },
  { ctx: 'WEBSERVICES',     engine: refusingEngine('RECORD_TYPE_DISABLED'), expect: /OA_ROUTING_REFUSED|RECORD_TYPE_DISABLED/ },
  { ctx: 'RESTLET',         engine: refusingEngine('NO_RULE_MATCH'),      expect: /OA_ROUTING_REFUSED|NO_RULE_MATCH/ },
  { ctx: 'CSVIMPORT',       engine: refusingEngine(null),                 expect: /OA_NO_APPROVER/ },
  { ctx: 'SCHEDULED',       engine: refusingEngine(null),                 expect: /OA_NO_APPROVER/ },
  { ctx: 'USEREVENT',       engine: refusingEngine('INVALID_AMOUNT'),     expect: /OA_ROUTING_REFUSED|INVALID_AMOUNT/ }
];

for (const tc of NEGATIVE_CASES) {
  test(`L-1: beforeSubmit fails closed in execContext=${tc.ctx} when engine refuses`, () => {
    const ue = buildUE(tc.ctx, tc.engine);
    const newRec = makeRecordInstance({
      type: 'vendorbill', id: null,
      subsidiary: '2', total: '500.00', exchangerate: '1'
    });
    const TRIGGER = { CREATE: 'create', EDIT: 'edit' };

    assert.throws(() => {
      ue.beforeSubmit({ type: TRIGGER.CREATE, UserEventType: TRIGGER, newRecord: newRec });
    }, tc.expect, `expected SB-1 throw in execContext=${tc.ctx} matching ${tc.expect}`);

    // Most importantly: approvalstatus was NOT mutated, so the bill cannot
    // leak into the save pipeline as a half-routed record.
    assert.equal(newRec.getValue({ fieldId: 'approvalstatus' }), undefined,
      `approvalstatus must not be mutated when routing refuses (execContext=${tc.ctx})`);
  });
}

// SB-6 fail-closed in a non-UI context: a critical setValue failure must abort
// the save with OA_WRITE_*_FAILED rather than letting the record persist.
test('L-1: beforeSubmit aborts in RESTWEBSERVICES when approvalstatus write fails', () => {
  const engineStub = {
    routeForApproval: () => ({ approver1: 123, approver2: null, hierarchyId: 7, approverCount: 1, settings: {}, routeSource: 'HIERARCHY' }),
    getSettingsForSubsidiary: () => ({ id: 1 }),
    createAuditLog: () => null
  };
  const ue = buildUE('RESTWEBSERVICES', engineStub);

  const data = { type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1' };
  const fieldOf = (a) => (typeof a === 'string' ? a : a && a.fieldId);
  const failingRec = {
    type: data.type, id: null,
    getValue: (a) => data[fieldOf(a)],
    setValue: (a) => {
      const fid = fieldOf(a);
      if (fid === 'approvalstatus') throw new Error('SS_VALUE_REQUIRED approvalstatus');
      data[fid] = (typeof a === 'string') ? null : a.value;
    },
    save: () => 1
  };

  assert.throws(() => {
    ue.beforeSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: failingRec });
  }, /OA_WRITE_APPROVALSTATUS_FAILED/);
});
