'use strict';

// M-4 — submitter self-approval policy.
//
// Live evidence (td3075893): bill 94060 routed to Kathryn (-5) at step 1 via
// HIERARCHY. Kathryn was also custbody_oa_submitted_by=-5 (REST integration ran
// as her). She could click Godkend on her own submission — silent self-approval.
//
// Policy (per Jonas + ChatGPT 5.5):
//   submitter == approver1 + approver2 exists + approver2 != submitter
//     → SKIP step 1: next_approver = approver2, current_step = 2,
//       audit row OA_SUBMITTER_AUTOSKIP written.
//   submitter == approver1, no approver2 (1-step matrix)
//     → HARD FAIL with OA_SELF_APPROVAL_NO_ALTERNATE.
//   submitter == approver2 at step-2 advancement
//     → HARD FAIL with OA_SELF_APPROVAL_AT_STEP_2 (engine-level guard).

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

const UE_PATH     = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_user_event.js';
const ENGINE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js';

function buildUE(routeReturn, currentUserId) {
  const auditRows = [];
  return {
    auditRows,
    ue: loadModule(UE_PATH, {
      'N/record':           { load: () => makeRecordInstance({}), create: () => makeRecordInstance({}) },
      'N/runtime':          makeRuntimeMock({ getCurrentUser: () => ({ id: currentUserId, role: 3 }) }),
      'N/search':           makeSearchMock({}),
      'N/task':             TASK_MOCK,
      'N/url':              URL_MOCK,
      'N/error':            ERROR_MOCK,
      'N/ui/serverWidget':  SERVERWIDGET_MOCK,
      'N/crypto':           CRYPTO_MOCK,
      'N/encode':           ENCODE_MOCK,
      './oa_engine': {
        routeForApproval: () => routeReturn,
        getSettingsForSubsidiary: () => ({ id: 1 }),
        createAuditLog: (p) => { auditRows.push(p); return auditRows.length; }
      }
    })
  };
}

// ── Initial routing — autoskip and hard-fail paths ──────────────────────────

test('M-4: 1-step matrix + submitter == approver1 → OA_SELF_APPROVAL_NO_ALTERNATE', () => {
  const SUBMITTER = 50;
  const { ue } = buildUE({
    approver1: SUBMITTER, approver2: null, hierarchyId: 7, approverCount: 1, settings: {}, routeSource: 'HIERARCHY'
  }, SUBMITTER);

  const rec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1' });

  assert.throws(() => {
    ue.beforeSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: rec });
  }, /OA_SELF_APPROVAL_NO_ALTERNATE/);

  // No partial state mutation
  assert.equal(rec.getValue('approvalstatus'), undefined);
});

test('M-4: 2-step matrix + submitter == approver1 + approver2 != submitter → autoskip', () => {
  const SUBMITTER = 50;
  const APPROVER2 = 99;
  const { ue, auditRows } = buildUE({
    approver1: SUBMITTER, approver2: APPROVER2, hierarchyId: 7, approverCount: 2, settings: {}, routeSource: 'HIERARCHY'
  }, SUBMITTER);

  const rec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1' });

  ue.beforeSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: rec });

  // Bill saves Pending with next_approver = approver2, current_step = 2
  assert.equal(rec.getValue('approvalstatus'), '1', 'must save as PENDING');
  assert.equal(rec.getValue('custbody_oa_next_approver'), APPROVER2, 'next_approver must be approver2');
  assert.equal(rec.getValue('custbody_oa_current_step'), 2, 'current_step must be 2 after autoskip');

  // approver1/approver2 still recorded for provenance
  assert.equal(rec.getValue('custbody_oa_approver1'), SUBMITTER);
  assert.equal(rec.getValue('custbody_oa_approver2'), APPROVER2);

  // No audit rows yet — afterSubmit writes them. Run afterSubmit:
  ue.afterSubmit({
    type: 'create',
    UserEventType: { CREATE: 'create', EDIT: 'edit' },
    newRecord: Object.assign(rec, { id: 1234 })
  });

  // afterSubmit should have written:
  //   1) SUBMITTED  with target = approver1
  //   2) OA_SUBMITTER_AUTOSKIP with target = approver2
  const submitted = auditRows.find(r => r.action === '1');
  const autoskip  = auditRows.find(r => r.action === '10');
  assert.ok(submitted, 'SUBMITTED row must be written');
  assert.equal(String(submitted.targetId), String(SUBMITTER), 'SUBMITTED target should be approver1 (the originally intended step-1 approver)');
  assert.ok(autoskip, 'OA_SUBMITTER_AUTOSKIP row must be written');
  assert.equal(String(autoskip.targetId), String(APPROVER2), 'AUTOSKIP target should be approver2 (where the flow advanced)');
  assert.match(autoskip.comment || '', /auto-skipped/i);
});

test('M-4: 2-step matrix + submitter == approver1 == approver2 → OA_SELF_APPROVAL_NO_ALTERNATE', () => {
  const SUBMITTER = 50;
  const { ue } = buildUE({
    approver1: SUBMITTER, approver2: SUBMITTER, hierarchyId: 7, approverCount: 2, settings: {}, routeSource: 'HIERARCHY'
  }, SUBMITTER);

  const rec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1' });

  assert.throws(() => {
    ue.beforeSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: rec });
  }, /OA_SELF_APPROVAL_NO_ALTERNATE/);
});

test('M-4: submitter != approver1 → no autoskip, normal step-1 flow', () => {
  const SUBMITTER = 50;
  const APPROVER1 = 100;
  const APPROVER2 = 200;
  const { ue, auditRows } = buildUE({
    approver1: APPROVER1, approver2: APPROVER2, hierarchyId: 7, approverCount: 2, settings: {}, routeSource: 'HIERARCHY'
  }, SUBMITTER);

  const rec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '500', exchangerate: '1' });
  ue.beforeSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: rec });

  assert.equal(rec.getValue('custbody_oa_next_approver'), APPROVER1, 'normal flow routes to approver1');
  assert.equal(rec.getValue('custbody_oa_current_step'), 1);

  ue.afterSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: Object.assign(rec, { id: 1234 }) });
  const autoskip = auditRows.find(r => r.action === '10');
  assert.equal(autoskip, undefined, 'no autoskip row when no self-approval condition');
});

// ── Engine-level step-2 guard ───────────────────────────────────────────────

function buildEngine({ logRows = [], submitterId = 0, approver2 = 200 } = {}) {
  const search = {
    create: ({ type }) => {
      if (type === 'customrecord_oa_log') {
        return { run: () => ({ each: (cb) => { for (const r of logRows) { if (cb(r) === false) break; } }, getRange: () => logRows }) };
      }
      // settings + hierarchy lookups for routeForApproval inside processApproval
      if (type === 'customrecord_oa_settings') {
        return { run: () => ({ each: (cb) => { cb({ id: '1', getValue: f => ({
          custrecord_oa_subsidiary:        '2',
          custrecord_oa_enable_vb:         'T',
          custrecord_oa_use_amount:        'F',  // simplest: matrix out of scope
          custrecord_oa_approver_count:    '2',
          custrecord_oa_default_approver1: '100',
          custrecord_oa_default_approver2: String(approver2)
        }[f]) }); }, getRange: () => [] }) };
      }
      return { run: () => ({ each: () => {}, getRange: () => [] }) };
    },
    lookupFields: ({ type, id, columns }) => {
      if (type === 'employee') {
        // Always active for these tests
        const out = {};
        columns.forEach(c => {
          if (c === 'isinactive') out[c] = 'F';
          else if (c === 'firstname') out[c] = 'X';
          else if (c === 'lastname')  out[c] = 'Y';
          else                        out[c] = '';
        });
        return out;
      }
      if (type === 'vendorbill') {
        const out = {};
        columns.forEach(c => {
          if (c === 'custbody_oa_state_version') out[c] = '0';
          else if (c === 'subsidiary')           out[c] = [{ value: '2' }];
          else                                    out[c] = '';
        });
        return out;
      }
      return {};
    }
  };

  // Mock txn for record.load.
  const txnData = {
    type: 'vendorbill', id: 1,
    approvalstatus:                          '1',
    custbody_oa_next_approver:               100,
    custbody_oa_state_version:               0,
    custbody_oa_submitted_by:                submitterId,
    custbody_oa_base_amount:                 0,
    custbody_oa_current_step:                1
  };
  const fieldOf = (a) => (typeof a === 'string' ? a : a && a.fieldId);
  const txn = {
    type: 'vendorbill', id: 1,
    getValue: (a) => txnData[fieldOf(a)],
    setValue: (a) => { txnData[fieldOf(a)] = (typeof a === 'string') ? null : a.value; },
    save:     () => 1,
    _data: txnData
  };

  return loadModule(ENGINE_PATH, {
    'N/record':  { load: () => txn, create: () => null },
    'N/runtime': makeRuntimeMock(),
    'N/search':  search,
    'N/task':    TASK_MOCK,
    'N/error':   { create: ({ name, message }) => { const e = new Error(message); e.name = name || 'Error'; return e; } },
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });
}

// Note: the buildEngine() helper above references `C.FIELDS_T_STATE_VERSION`
// inside the search.lookupFields mock; that property is undefined, so the
// branch is never hit and the engine's _readPersistedVersion gets an empty
// object back (parseInt('') -> NaN -> 0). That's the desired fallback for
// these tests since version handling is exercised by H-5, not M-4.

test('M-4 engine: submitter == approver2 at step-2 advancement → OA_SELF_APPROVAL_AT_STEP_2', () => {
  const SUBMITTER = 200;
  const engine = buildEngine({ logRows: [], submitterId: SUBMITTER, approver2: SUBMITTER });
  // Caller (approver1=100) clicks Approve. Engine tries to advance to step 2,
  // sees that approver2 (=200) is also the submitter (=200), and refuses.
  const r = engine.processApproval(1, 'vendorbill', 100, '1');
  assert.equal(r.success, false);
  assert.match(r.message, /OA_SELF_APPROVAL_AT_STEP_2/);
});

test('M-4 engine: submitter != approver2 → step-2 advancement proceeds normally', () => {
  const engine = buildEngine({ logRows: [], submitterId: 999, approver2: 200 });
  const r = engine.processApproval(1, 'vendorbill', 100, '1');
  assert.equal(r.success, true);
  assert.equal(r.nextStep, 2, 'advanced to step 2 because no self-approval conflict');
});

// ── _countApprovedLogs counts SUBMITTER_AUTOSKIP ────────────────────────────

test('M-4 engine: _countApprovedLogs counts OA_SUBMITTER_AUTOSKIP rows so step is correctly numbered', () => {
  // Simulate one autoskip row already in the OA log → next step is 2.
  const autoskipRow = { getValue: () => '10' };
  const engine = buildEngine({
    logRows: [autoskipRow],   // _countApprovedLogs returns 1 → step = 2
    submitterId: 999,
    approver2: 200
  });
  // Approver100 clicks Approve at step 2 (because autoskip already counted as
  // step 1). Engine's step calculation is `_countApprovedLogs(rid) + 1`.
  // With autoskip counted, this is now step 2 — engine should final-approve
  // (no further step-2 advancement, because it's already step 2).
  const r = engine.processApproval(1, 'vendorbill', 100, '1');
  // Final approval since step==2 (would-be advance only fires when step===1).
  assert.equal(r.success, true);
  // nextStep is null on final approval, 2 on advancement-to-step-2. M-4's step
  // numbering with autoskip means we go straight to final.
  assert.equal(r.nextStep, null);
});
