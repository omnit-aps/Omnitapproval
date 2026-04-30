'use strict';

// H-7 — tamper preflight blocks unauthorised writes to OA-controlled body fields.
// Live evidence (td3075893, 2026-04-30): REST PATCH /vendorbill/94155 with
// {"custbody_oa_state_version": 5, "custbody_oa_current_step": 2} was accepted
// because the pre-fix UE didn't run on XEDIT and didn't validate control-field
// integrity in REST/CSV contexts.
//
// Tests cover:
//   - REST PATCH (EDIT/XEDIT in RESTWEBSERVICES) of state_version, current_step,
//     approvalstatus, custbody_oa_approver1 — all throw OA_TAMPER_DETECTED.
//   - Engine transition in SUITELET context — control-field changes pass.
//   - MR write of APPROVAL_TOKEN/TOKEN_CREATED — passes.
//   - MR write of NEXT_APPROVER (out of MR's allow-list) — throws.

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

function buildUE(execContext) {
  return loadModule(UE_PATH, {
    'N/record':           { load: () => makeRecordInstance({}), create: () => makeRecordInstance({}) },
    'N/runtime':          makeRuntimeMock({ executionContext: execContext }),
    'N/search':           makeSearchMock({}),
    'N/task':             TASK_MOCK,
    'N/url':              URL_MOCK,
    'N/error':            ERROR_MOCK,
    'N/ui/serverWidget':  SERVERWIDGET_MOCK,
    'N/crypto':           CRYPTO_MOCK,
    'N/encode':           ENCODE_MOCK,
    './oa_engine': {
      // For SUITELET path the tamper preflight passes BEFORE routing runs,
      // and after that the engine is invoked. Provide a passthrough stub so
      // the SUITELET test can still observe the post-preflight flow.
      routeForApproval: () => ({ approver1: 50, approver2: null, hierarchyId: 7, approverCount: 1, settings: {}, routeSource: 'HIERARCHY' }),
      getSettingsForSubsidiary: () => ({ id: 1, resubmit_threshold_pct: 0, resubmit_threshold_abs: 0 }),
      createAuditLog: () => null
    }
  });
}

const TRIGGER = { CREATE: 'create', EDIT: 'edit', XEDIT: 'xedit', VIEW: 'view', DELETE: 'delete' };

// Helper: managed-bill records (matching old vs new record state) for tamper tests.
function pendingPair({ oldOverrides, newOverrides }) {
  const base = {
    type: 'vendorbill', id: 1,
    subsidiary: '2', total: '500', exchangerate: '1', entity: '7',
    approvalstatus: '1',
    custbody_oa_next_approver:  100,
    custbody_oa_state_version:  3,
    custbody_oa_current_step:   1,
    custbody_oa_approver1:      100
  };
  return {
    oldRecord: makeRecordInstance(Object.assign({}, base, oldOverrides || {})),
    newRecord: makeRecordInstance(Object.assign({}, base, newOverrides || {}))
  };
}

// ── REST PATCH paths (RESTWEBSERVICES context) — must throw ─────────────────

test('H-7: REST PATCH of custbody_oa_state_version throws OA_TAMPER_DETECTED', () => {
  const ue   = buildUE('RESTWEBSERVICES');
  const pair = pendingPair({ newOverrides: { custbody_oa_state_version: 5 } });

  assert.throws(() => {
    ue.beforeSubmit({ type: TRIGGER.EDIT, UserEventType: TRIGGER, oldRecord: pair.oldRecord, newRecord: pair.newRecord });
  }, /OA_TAMPER_DETECTED.*custbody_oa_state_version/s);

  assert.equal(pair.newRecord.getValue('custbody_oa_state_version'), 5,
    'newRecord still carries the attempted value but the throw aborts the save');
});

test('H-7: REST PATCH of custbody_oa_current_step throws OA_TAMPER_DETECTED', () => {
  const ue   = buildUE('RESTWEBSERVICES');
  const pair = pendingPair({ newOverrides: { custbody_oa_current_step: 2 } });

  assert.throws(() => {
    ue.beforeSubmit({ type: TRIGGER.EDIT, UserEventType: TRIGGER, oldRecord: pair.oldRecord, newRecord: pair.newRecord });
  }, /OA_TAMPER_DETECTED.*custbody_oa_current_step/s);
});

test('H-7: REST PATCH of approvalstatus throws OA_TAMPER_DETECTED', () => {
  const ue   = buildUE('RESTWEBSERVICES');
  const pair = pendingPair({ newOverrides: { approvalstatus: '2' } }); // 2 = APPROVED

  assert.throws(() => {
    ue.beforeSubmit({ type: TRIGGER.EDIT, UserEventType: TRIGGER, oldRecord: pair.oldRecord, newRecord: pair.newRecord });
  }, /OA_TAMPER_DETECTED.*approvalstatus/s);
});

test('H-7: XEDIT (inline edit / submitFields) of custbody_oa_approver1 throws', () => {
  const ue   = buildUE('RESTWEBSERVICES');
  const pair = pendingPair({ newOverrides: { custbody_oa_approver1: 999 } });

  assert.throws(() => {
    ue.beforeSubmit({ type: TRIGGER.XEDIT, UserEventType: TRIGGER, oldRecord: pair.oldRecord, newRecord: pair.newRecord });
  }, /OA_TAMPER_DETECTED.*custbody_oa_approver1/s);
});

test('H-7: USER_INTERFACE manual edit of next_approver throws', () => {
  const ue   = buildUE('USERINTERFACE');
  const pair = pendingPair({ newOverrides: { custbody_oa_next_approver: 999 } });

  assert.throws(() => {
    ue.beforeSubmit({ type: TRIGGER.EDIT, UserEventType: TRIGGER, oldRecord: pair.oldRecord, newRecord: pair.newRecord });
  }, /OA_TAMPER_DETECTED.*custbody_oa_next_approver/s);
});

// ── SUITELET path (engine transition) — must pass ───────────────────────────

test('H-7: SUITELET context allows control-field changes (engine transition)', () => {
  const ue   = buildUE('SUITELET');
  // Engine.processApproval would change next_approver, current_step, state_version
  // simultaneously — all on the trusted SUITELET path.
  const pair = pendingPair({
    newOverrides: {
      custbody_oa_next_approver: 200,
      custbody_oa_current_step:  2,
      custbody_oa_state_version: 4
    }
  });

  assert.doesNotThrow(() => {
    ue.beforeSubmit({ type: TRIGGER.EDIT, UserEventType: TRIGGER, oldRecord: pair.oldRecord, newRecord: pair.newRecord });
  });
});

// ── MAP_REDUCE narrowed allow-list ─────────────────────────────────────────

test('H-7: MAP_REDUCE write of approval_token + token_created passes', () => {
  const ue   = buildUE('MAPREDUCE');
  const pair = pendingPair({
    newOverrides: {
      custbody_oa_approval_token: 'abc.def',
      custbody_oa_token_created:  new Date('2026-04-30T10:00:00Z')
    }
  });

  assert.doesNotThrow(() => {
    ue.beforeSubmit({ type: TRIGGER.XEDIT, UserEventType: TRIGGER, oldRecord: pair.oldRecord, newRecord: pair.newRecord });
  });
});

test('H-7: MAP_REDUCE write of next_approver (outside MR allow-list) throws', () => {
  const ue   = buildUE('MAPREDUCE');
  const pair = pendingPair({
    newOverrides: {
      custbody_oa_approval_token: 'abc.def',
      custbody_oa_next_approver:  999
    }
  });

  assert.throws(() => {
    ue.beforeSubmit({ type: TRIGGER.XEDIT, UserEventType: TRIGGER, oldRecord: pair.oldRecord, newRecord: pair.newRecord });
  }, /OA_TAMPER_DETECTED/);
});

test('H-7: MAP_REDUCE write of state_version (outside MR allow-list) throws', () => {
  const ue   = buildUE('MAPREDUCE');
  const pair = pendingPair({
    newOverrides: {
      custbody_oa_state_version: 99
    }
  });

  assert.throws(() => {
    ue.beforeSubmit({ type: TRIGGER.XEDIT, UserEventType: TRIGGER, oldRecord: pair.oldRecord, newRecord: pair.newRecord });
  }, /OA_TAMPER_DETECTED/);
});

// ── Negative-control: non-control field edits pass cleanly ─────────────────

test('H-7: REST PATCH of memo (non-control field) does not trigger tamper preflight', () => {
  const ue   = buildUE('RESTWEBSERVICES');
  const pair = pendingPair({
    oldOverrides: { memo: 'before' },
    newOverrides: { memo: 'after' }
  });

  // Tamper preflight must pass. Routing logic may then run downstream via H-4.
  // We only assert tamper does not fire here (no OA_TAMPER_DETECTED in throw path).
  // The underlying record is still an OA-managed bill, so H-4 might re-route, but
  // that's fine — no tamper.
  let err;
  try {
    ue.beforeSubmit({ type: TRIGGER.EDIT, UserEventType: TRIGGER, oldRecord: pair.oldRecord, newRecord: pair.newRecord });
  } catch (e) { err = e; }
  if (err) {
    assert.ok(!/OA_TAMPER_DETECTED/.test(err.message),
      'memo edit must not be flagged as tamper; got: ' + err.message);
  }
});

// ── CREATE is not subject to tamper preflight (caller-supplied control fields
// will be overwritten by the engine on initial routing) ─────────────────────

test('H-7: CREATE with caller-supplied custbody_oa_state_version does not trigger tamper preflight', () => {
  const ue  = buildUE('RESTWEBSERVICES');
  const rec = makeRecordInstance({
    type: 'vendorbill', id: null,
    subsidiary: '2', total: '500', exchangerate: '1',
    custbody_oa_state_version: 99 // attempt to seed; engine will overwrite where it matters
  });

  // CREATE with no oldRecord. Must not throw OA_TAMPER_DETECTED — only EDIT/XEDIT
  // run the preflight. The engine route writes its own approvalstatus / next_approver
  // values which trump the caller's.
  let err;
  try {
    ue.beforeSubmit({ type: TRIGGER.CREATE, UserEventType: TRIGGER, newRecord: rec });
  } catch (e) { err = e; }
  if (err) {
    assert.ok(!/OA_TAMPER_DETECTED/.test(err.message), 'CREATE must not trigger tamper; got: ' + err.message);
  }
});
