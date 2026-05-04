'use strict';

// M-2 — engine.processDelegation: actor with `can_delegate=T` may hand off
// their pending step to another approver. Hard guards:
//   1. actor must have `custentity_oa_can_delegate=T`
//   2. target must have `custentity_oa_is_approver=T`
//   3. actor must be the CURRENT next_approver on the record
//   4. transaction must be in PENDING approval status
//
// Happy path: next_approver flips to target, audit log row carries action=
// DELEGATED + target id, state_version bumps, MR notification is scheduled.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const ENGINE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js';

const ACTOR  = 100;
const TARGET = 200;

function makeHarness({ txnInitial, persistedVersion, employeeFlags }) {
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

  // No approved logs — step = 1.
  const search = {
    create: ({ type }) => {
      const rows = (type === 'customrecord_oa_log') ? [] : [];
      return {
        run: () => ({
          each: (cb) => { for (const r of rows) { if (cb(r) === false) break; } },
          getRange: () => rows
        })
      };
    },
    lookupFields: ({ type, id, columns }) => {
      const out = {};
      (columns || []).forEach((c) => {
        // Per-employee flag lookups (engine uses utils.lookupEmployeeField).
        const flags = employeeFlags[String(id)] || {};
        if (c === 'custentity_oa_can_delegate')      out[c] = flags.can_delegate     || 'F';
        else if (c === 'custentity_oa_is_approver')  out[c] = flags.is_approver      || 'F';
        else if (c === 'custentity_oa_use_email')    out[c] = flags.use_email        || 'F';
        else if (c === 'custentity_oa_is_super_approver') out[c] = flags.is_super    || 'F';
        else if (c === 'custentity_oa_is_manager')   out[c] = flags.is_manager       || 'F';
        else if (c === 'custentity_oa_delegate_to')  out[c] = null;
        // Persisted state-version probe used by _concurrencyCheckAndBump.
        else if (c === 'custbody_oa_state_version') out[c] = String(persistedVersion);
        else if (c === 'subsidiary')                out[c] = [{ value: '2' }];
        else                                        out[c] = null;
      });
      return out;
    }
  };

  const recordMock = {
    load:   () => txn,
    create: () => {
      const logRec = {
        type: 'customrecord_oa_log',
        _data: {},
        setValue: (a, val) => {
          const fid = (typeof a === 'string') ? a : a.fieldId;
          const v   = (typeof a === 'string') ? val : a.value;
          logRec._data[fid] = v;
        },
        getValue: (a) => logRec._data[(typeof a === 'string') ? a : a.fieldId],
        save: () => { auditLogs.push(Object.assign({}, logRec._data)); return auditLogs.length; }
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
    'N/error':   { create: ({ name, message }) => { const e = new Error(message); e.name = name || 'Error'; return e; } },
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });

  return { engine, txn, data, auditLogs, tasksCreated };
}

test('M-2 happy path: delegate from ACTOR to TARGET — next_approver, log, version bump, MR scheduled', () => {
  const h = makeHarness({
    persistedVersion: 5,
    employeeFlags: {
      [ACTOR]:  { can_delegate: 'T' },
      [TARGET]: { is_approver:  'T' }
    },
    txnInitial: {
      type: 'vendorbill', id: 1,
      approvalstatus: '1',
      custbody_oa_next_approver: ACTOR,
      custbody_oa_state_version: 5
    }
  });

  const r = h.engine.processDelegation(1, 'vendorbill', ACTOR, TARGET);

  assert.equal(r.success, true);
  assert.equal(String(h.data.custbody_oa_next_approver), String(TARGET));
  assert.equal(h.data.custbody_oa_state_version, 6);
  assert.equal(h.auditLogs.length, 1);
  assert.equal(h.auditLogs[0].custrecord_oal_action, '4'); // LOG_ACTIONS.DELEGATED
  assert.equal(String(h.auditLogs[0].custrecord_oal_target), String(TARGET));
  assert.equal(h.tasksCreated.length, 1, 'MR notification should be scheduled for the new approver');
});

test('M-2 actor lacks can_delegate -> rejected; no save, no log, no MR', () => {
  const h = makeHarness({
    persistedVersion: 5,
    employeeFlags: {
      [ACTOR]:  { can_delegate: 'F' },
      [TARGET]: { is_approver:  'T' }
    },
    txnInitial: { type: 'vendorbill', id: 1, approvalstatus: '1', custbody_oa_next_approver: ACTOR, custbody_oa_state_version: 5 }
  });

  const r = h.engine.processDelegation(1, 'vendorbill', ACTOR, TARGET);

  assert.equal(r.success, false);
  assert.match(r.message, /cannot delegate/i);
  assert.equal(h.auditLogs.length, 0);
  assert.equal(h.tasksCreated.length, 0);
  // Original approver unchanged.
  assert.equal(String(h.data.custbody_oa_next_approver), String(ACTOR));
});

test('M-2 target is not an approver -> rejected', () => {
  const h = makeHarness({
    persistedVersion: 5,
    employeeFlags: {
      [ACTOR]:  { can_delegate: 'T' },
      [TARGET]: { is_approver:  'F' }
    },
    txnInitial: { type: 'vendorbill', id: 1, approvalstatus: '1', custbody_oa_next_approver: ACTOR, custbody_oa_state_version: 5 }
  });

  const r = h.engine.processDelegation(1, 'vendorbill', ACTOR, TARGET);

  assert.equal(r.success, false);
  assert.match(r.message, /not.*approver/i);
  assert.equal(h.auditLogs.length, 0);
});

test('M-2 actor is not currently assigned -> rejected', () => {
  const h = makeHarness({
    persistedVersion: 5,
    employeeFlags: {
      [ACTOR]:  { can_delegate: 'T' },
      [TARGET]: { is_approver:  'T' }
    },
    txnInitial: {
      type: 'vendorbill', id: 1, approvalstatus: '1',
      custbody_oa_next_approver: 999, // someone else
      custbody_oa_state_version: 5
    }
  });

  const r = h.engine.processDelegation(1, 'vendorbill', ACTOR, TARGET);

  assert.equal(r.success, false);
  assert.match(r.message, /assigned/i);
  assert.equal(h.auditLogs.length, 0);
});

test('M-2 transaction not pending -> rejected', () => {
  const h = makeHarness({
    persistedVersion: 5,
    employeeFlags: {
      [ACTOR]:  { can_delegate: 'T' },
      [TARGET]: { is_approver:  'T' }
    },
    txnInitial: {
      type: 'vendorbill', id: 1,
      approvalstatus: '2', // APPROVED
      custbody_oa_next_approver: ACTOR,
      custbody_oa_state_version: 5
    }
  });

  const r = h.engine.processDelegation(1, 'vendorbill', ACTOR, TARGET);

  assert.equal(r.success, false);
  assert.match(r.message, /not pending/i);
});
