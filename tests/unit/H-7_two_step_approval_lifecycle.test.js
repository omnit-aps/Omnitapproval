'use strict';

// H-7 — two-step approval lifecycle.
//
// Settings configured with approver_count=2, default_approver1=A1, default_approver2=A2.
// The bill must walk: pending(next=A1) -> step1 approve by A1 -> pending(next=A2)
// -> step2 approve by A2 -> APPROVED. A1 must NOT be able to approve when it is
// A2's turn (next_approver != A1). Each non-final approval must schedule the
// MR notification; the final approval must NOT schedule one.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const ENGINE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js';

const A1 = 100;
const A2 = 200;

// Spy state shared into the engine via the closure-mocks below.
function makeHarness({ txnInitial, persistedVersion, approvedLogCount }) {
  const data = Object.assign({}, txnInitial || {});
  const fieldOf = (a) => (typeof a === 'string' ? a : a && a.fieldId);
  const txn = {
    type: data.type, id: data.id,
    getValue: (a) => data[fieldOf(a)],
    setValue: (a, val) => {
      const fid = fieldOf(a);
      const v   = (typeof a === 'string') ? val : a.value;
      data[fid] = v;
    },
    save: () => data.id || 1,
    _data: data
  };

  const auditLogs    = [];
  const tasksCreated = [];

  // Two-approver settings: approver_count=2, use_amount=F (so engine falls
  // back to default_approver1/2 — DEFAULT route), enable_vb=T.
  const settingsRow = {
    id: '1',
    getValue: (f) => ({
      custrecord_oa_subsidiary:        '2',
      custrecord_oa_enable_vb:         'T',
      custrecord_oa_enable_po:         'F',
      custrecord_oa_approver_count:    '2',
      custrecord_oa_use_amount:        'F',
      custrecord_oa_default_approver1: String(A1),
      custrecord_oa_default_approver2: String(A2)
    }[f])
  };

  // count-of-approved-logs is read by _countApprovedLogs to compute step.
  const approvedLogRows = [];
  for (let i = 0; i < approvedLogCount; i++) approvedLogRows.push({ id: String(i + 1), getValue: () => '' });

  const search = {
    create: ({ type }) => {
      let rows = [];
      if (type === 'customrecord_oa_settings')  rows = [settingsRow];
      if (type === 'customrecord_oa_hierarchy') rows = [];
      if (type === 'customrecord_oa_threshold') rows = [];
      if (type === 'customrecord_oa_log')       rows = approvedLogRows;
      return {
        run: () => ({
          each: (cb) => { for (const r of rows) { if (cb(r) === false) break; } },
          getRange: () => rows
        })
      };
    },
    lookupFields: ({ type, columns }) => {
      const out = {};
      (columns || []).forEach(c => {
        if (c === 'custbody_oa_state_version') out[c] = String(persistedVersion);
        else if (c === 'subsidiary')          out[c] = [{ value: '2' }];
        // Employee permission fields — A1/A2 are normal approvers, not super.
        else if (c === 'custentity_oa_is_super_approver') out[c] = 'F';
        else if (c === 'custentity_oa_is_manager')        out[c] = 'F';
        else if (c === 'custentity_oa_can_delegate')      out[c] = 'F';
        else if (c === 'custentity_oa_delegate_to')       out[c] = null;
        else if (c === 'custentity_oa_is_approver')       out[c] = 'T';
        else if (c === 'total')                           out[c] = '0';
        else if (c === 'exchangerate')                    out[c] = '1';
        else                                              out[c] = null;
      });
      return out;
    }
  };

  const recordMock = {
    load:   () => txn,
    create: () => {
      // Spy on createAuditLog writes.
      const logRec = {
        type: 'customrecord_oa_log',
        _data: {},
        setValue: (a, val) => {
          const fid = (typeof a === 'string') ? a : a.fieldId;
          const v   = (typeof a === 'string') ? val : a.value;
          logRec._data[fid] = v;
        },
        getValue: (a) => logRec._data[(typeof a === 'string') ? a : a.fieldId],
        save: () => {
          auditLogs.push(Object.assign({}, logRec._data));
          return auditLogs.length;
        }
      };
      return logRec;
    }
  };

  const taskMock = {
    TaskType: { MAP_REDUCE: 'MAPREDUCE' },
    create: (cfg) => ({ submit: () => { tasksCreated.push(cfg); return 'task-' + tasksCreated.length; } })
  };

  const engine = loadModule(ENGINE_PATH, {
    'N/record':  recordMock,
    'N/runtime': makeRuntimeMock(),
    'N/search':  search,
    'N/task':    taskMock,
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });

  return { engine, txn, data, auditLogs, tasksCreated };
}

test('H-7 step 1: A1 approves -> advances to A2, current_step=2, MR scheduled, log step=1 APPROVED', () => {
  const h = makeHarness({
    persistedVersion: 5,
    approvedLogCount: 0, // no prior approvals -> step = 1
    txnInitial: {
      type: 'vendorbill', id: 1,
      approvalstatus: '1',                  // PENDING
      custbody_oa_next_approver: A1,
      custbody_oa_state_version: 5,
      custbody_oa_base_amount: '100'        // engine routes via DEFAULT (use_amount=F)
    }
  });

  const r = h.engine.processApproval(1, 'vendorbill', A1, '1');

  assert.equal(r.success, true);
  assert.equal(r.nextStep, 2);
  // approval status stays PENDING (advanced to step 2, not finalized)
  assert.equal(h.data.approvalstatus, '1');
  // next_approver advanced to A2
  assert.equal(String(h.data.custbody_oa_next_approver), String(A2));
  // current_step provenance bumped to 2
  assert.equal(h.data.custbody_oa_current_step, 2);
  // version optimistically bumped
  assert.equal(h.data.custbody_oa_state_version, 6);

  // Audit log written: APPROVED, step=1
  assert.equal(h.auditLogs.length, 1);
  assert.equal(h.auditLogs[0].custrecord_oal_action, '2'); // LOG_ACTIONS.APPROVED
  assert.equal(h.auditLogs[0].custrecord_oal_step, 1);

  // MR notification scheduled for step-2 reviewer
  assert.equal(h.tasksCreated.length, 1);
  assert.equal(h.tasksCreated[0].scriptId, 'customscript_oa_mr_notifications');
});

test('H-7 step 2: A2 approves -> APPROVED final, log step=2, NO MR scheduled', () => {
  const h = makeHarness({
    persistedVersion: 6,
    approvedLogCount: 1, // one prior approval -> step = 2
    txnInitial: {
      type: 'vendorbill', id: 1,
      approvalstatus: '1',
      custbody_oa_next_approver: A2,        // A2 is now next
      custbody_oa_state_version: 6,
      custbody_oa_current_step: 2,
      custbody_oa_base_amount: '100'
    }
  });

  const r = h.engine.processApproval(1, 'vendorbill', A2, '1');

  assert.equal(r.success, true);
  assert.equal(r.nextStep, null);
  // Final approval: status flips to APPROVED ('2')
  assert.equal(h.data.approvalstatus, '2');
  // next_approver cleared
  assert.equal(h.data.custbody_oa_next_approver, null);
  // version bumped optimistically
  assert.equal(h.data.custbody_oa_state_version, 7);

  // Audit log: APPROVED, step=2
  assert.equal(h.auditLogs.length, 1);
  assert.equal(h.auditLogs[0].custrecord_oal_action, '2');
  assert.equal(h.auditLogs[0].custrecord_oal_step, 2);

  // No further MR scheduled (final approval doesn't notify a next reviewer)
  assert.equal(h.tasksCreated.length, 0);
});

test('H-7 negative: A1 cannot approve at step 2 (not assigned, not super)', () => {
  const h = makeHarness({
    persistedVersion: 6,
    approvedLogCount: 1,
    txnInitial: {
      type: 'vendorbill', id: 1,
      approvalstatus: '1',
      custbody_oa_next_approver: A2,        // it's A2's turn
      custbody_oa_state_version: 6,
      custbody_oa_current_step: 2,
      custbody_oa_base_amount: '100'
    }
  });

  // A1 attempts to approve. Without super privilege the engine refuses.
  const r = h.engine.processApproval(1, 'vendorbill', A1, '1');

  assert.equal(r.success, false);
  assert.match(r.message, /not the assigned approver/i);
  // No state change, no audit log, no notification
  assert.equal(h.data.approvalstatus, '1');
  assert.equal(String(h.data.custbody_oa_next_approver), String(A2));
  assert.equal(h.auditLogs.length, 0);
  assert.equal(h.tasksCreated.length, 0);
});
