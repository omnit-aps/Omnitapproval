'use strict';

// H-4 — when a PENDING bill is edited and a material field changed
// (amount/vendor/subsidiary), the User Event must reset the flow to step 1
// and re-route so the new bill is approved by whoever the routing rule
// picks for the new amount.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule }              = require('../_amd');
const { makeRuntimeMock,
        makeRecordInstance,
        TASK_MOCK,
        URL_MOCK,
        SERVERWIDGET_MOCK,
        CRYPTO_MOCK,
        ENCODE_MOCK,
        ERROR_MOCK }               = require('../_mocks');

const UE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_user_event.js';

function buildUE(captureCalls) {
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
    getSettingsForSubsidiary: () => ({ id: 1, resubmit_threshold_pct: 0, resubmit_threshold_abs: 0 }),
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

test('H-4: amount change while PENDING re-routes', () => {
  const calls = { routes: [] };
  const ue    = buildUE(calls);

  const oldRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1', entity: '7', approvalstatus: '1',
    custbody_oa_base_amount: 500, custbody_oa_fx_snapshot: 1
  });
  const newRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '6000', exchangerate: '1', entity: '7', approvalstatus: '1',
    custbody_oa_base_amount: 500, custbody_oa_fx_snapshot: 1
  });

  ue.beforeSubmit({
    type: 'edit',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: newRec,
    oldRecord: oldRec
  });

  assert.equal(calls.routes.length, 1, 'must re-route');
  // Snapshot was cleared so the route used the fresh foreign-amount conversion (6000 * 1 = 6000)
  assert.equal(calls.routes[0].amount, 6000);
  assert.equal(newRec.getValue('approvalstatus'), '1');
});

test('H-4: vendor change while PENDING re-routes', () => {
  const calls = { routes: [] };
  const ue    = buildUE(calls);

  const oldRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1', entity: '7', approvalstatus: '1'
  });
  const newRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1', entity: '99', approvalstatus: '1'
  });

  ue.beforeSubmit({
    type: 'edit',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: newRec,
    oldRecord: oldRec
  });

  assert.equal(calls.routes.length, 1, 'must re-route on vendor change');
});

test('H-4: subsidiary change while PENDING re-routes', () => {
  const calls = { routes: [] };
  const ue    = buildUE(calls);

  const oldRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1', entity: '7', approvalstatus: '1'
  });
  const newRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '3', total: '500', exchangerate: '1', entity: '7', approvalstatus: '1'
  });

  ue.beforeSubmit({
    type: 'edit',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: newRec,
    oldRecord: oldRec
  });

  assert.equal(calls.routes.length, 1, 'must re-route on subsidiary change');
});

test('H-4: non-material edit while PENDING is a no-op', () => {
  const calls = { routes: [] };
  const ue    = buildUE(calls);

  const oldRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1', entity: '7',
    memo: 'original',  approvalstatus: '1'
  });
  const newRec = makeRecordInstance({
    type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1', entity: '7',
    memo: 'updated note', approvalstatus: '1'
  });

  ue.beforeSubmit({
    type: 'edit',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: newRec,
    oldRecord: oldRec
  });

  assert.equal(calls.routes.length, 0, 'must NOT re-route on non-material change');
});
