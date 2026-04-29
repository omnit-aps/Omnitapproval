'use strict';

// SB-6 — critical-write failures block the save instead of being swallowed.

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

function makeFailingRecord(initial, failOnField) {
  const data = Object.assign({}, initial || {});
  const fieldOf = (a) => (typeof a === 'string' ? a : a && a.fieldId);
  return {
    type: data.type, id: data.id,
    getValue: (a) => data[fieldOf(a)],
    setValue: (a) => {
      const fid = fieldOf(a);
      if (fid === failOnField) throw new Error('SS_VALUE_REQUIRED ' + failOnField);
      data[fid] = (typeof a === 'string') ? null : a.value;
    },
    save: () => 1
  };
}

const goodEngine = {
  routeForApproval: () => ({ approver1: 123, approver2: null, hierarchyId: 7, approverCount: 1, settings: {} }),
  getSettingsForSubsidiary: () => ({ id: 1 }),
  createAuditLog: () => null
};

test('SB-6: throws when approvalstatus write fails', () => {
  const ue  = buildUE(goodEngine);
  const rec = makeFailingRecord({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1'
  }, 'approvalstatus');
  assert.throws(() => {
    ue.beforeSubmit({
      type: 'create',
      UserEventType: { CREATE: 'create', EDIT: 'edit' },
      newRecord: rec
    });
  }, /OA_WRITE_APPROVALSTATUS_FAILED/);
});

test('SB-6: throws when next_approver write fails', () => {
  const ue  = buildUE(goodEngine);
  const rec = makeFailingRecord({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1'
  }, 'custbody_oa_next_approver');
  assert.throws(() => {
    ue.beforeSubmit({
      type: 'create',
      UserEventType: { CREATE: 'create', EDIT: 'edit' },
      newRecord: rec
    });
  }, /OA_WRITE_NEXT_APPROVER_FAILED/);
});

test('SB-6: throws when hierarchy_used write fails', () => {
  const ue  = buildUE(goodEngine);
  const rec = makeFailingRecord({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1'
  }, 'custbody_oa_hierarchy_used');
  assert.throws(() => {
    ue.beforeSubmit({
      type: 'create',
      UserEventType: { CREATE: 'create', EDIT: 'edit' },
      newRecord: rec
    });
  }, /OA_WRITE_HIERARCHY_USED_FAILED/);
});

test('SB-6: submitted_by failure does NOT block (informational)', () => {
  const ue  = buildUE(goodEngine);
  const rec = makeFailingRecord({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1'
  }, 'custbody_oa_submitted_by');
  assert.doesNotThrow(() => {
    ue.beforeSubmit({
      type: 'create',
      UserEventType: { CREATE: 'create', EDIT: 'edit' },
      newRecord: rec
    });
  });
});
