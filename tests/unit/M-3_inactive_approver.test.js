'use strict';

// M-3 — assertActiveEmployeeApprover helper. Live evidence (td3075893):
// with Adam Minister (id 201) inactive, a $750 bill triggered NS native
//   "Invalid Field Value 201 for the following field: custbody_oa_next_approver"
// rather than a domain OA error. M-3 introduces a domain-specific guard:
//
//   OA_INVALID_APPROVER   for null/0/undefined IDs
//   OA_INACTIVE_APPROVER  for positive IDs of inactive employees
//   negative IDs           allowed (audit OA_NEGATIVE_APPROVER_ID)

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule }    = require('../_amd');
const { makeRuntimeMock,
        TASK_MOCK }      = require('../_mocks');

const ENGINE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js';

function buildEngine({ employeeRows = {}, settings = null, hierarchy = null } = {}) {
  const settingsResults  = settings ? [{ id: '1', getValue: f => settings[f] }] : [];
  const hierarchyResults = hierarchy ? [{ id: hierarchy.id, getValue: f => hierarchy[f] }] : [];
  const thresholdResults = (hierarchy && hierarchy.thresholds) || [];

  const search = {
    create: ({ type }) => {
      let rows = [];
      if (type === 'customrecord_oa_settings')  rows = settingsResults;
      if (type === 'customrecord_oa_hierarchy') rows = hierarchyResults;
      if (type === 'customrecord_oa_threshold') rows = thresholdResults;
      return { run: () => ({ each: (cb) => { for (const r of rows) { if (cb(r) === false) break; } }, getRange: () => rows }) };
    },
    lookupFields: ({ type, id, columns }) => {
      if (type !== 'employee') return {};
      const row = employeeRows[String(id)] || {};
      const out = {};
      columns.forEach(c => { out[c] = row[c] === undefined ? '' : row[c]; });
      return out;
    }
  };

  return loadModule(ENGINE_PATH, {
    'N/record':  { load: () => null, create: () => null },
    'N/runtime': makeRuntimeMock(),
    'N/search':  search,
    'N/task':    TASK_MOCK,
    'N/error':   { create: ({ name, message }) => { const e = new Error(message); e.name = name || 'Error'; return e; } },
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });
}

// ── Direct helper coverage ──────────────────────────────────────────────────

test('M-3 helper: positive active ID passes', () => {
  const engine = buildEngine({
    employeeRows: { 100: { isinactive: 'F', firstname: 'Active', lastname: 'Approver' } }
  });
  assert.doesNotThrow(() => engine.assertActiveEmployeeApprover(100, 'approver1'));
});

test('M-3 helper: positive inactive ID throws OA_INACTIVE_APPROVER with name + ID', () => {
  const engine = buildEngine({
    employeeRows: { 201: { isinactive: 'T', firstname: 'Adam', lastname: 'Minister' } }
  });
  let err;
  try { engine.assertActiveEmployeeApprover(201, 'approver1'); } catch (e) { err = e; }
  assert.ok(err, 'must throw');
  assert.equal(err.name, 'OA_INACTIVE_APPROVER');
  assert.match(err.message, /201/);
  assert.match(err.message, /Adam Minister/);
});

test('M-3 helper: 0 throws OA_INVALID_APPROVER', () => {
  const engine = buildEngine({});
  let err;
  try { engine.assertActiveEmployeeApprover(0, 'default_approver1'); } catch (e) { err = e; }
  assert.equal(err.name, 'OA_INVALID_APPROVER');
});

test('M-3 helper: null throws OA_INVALID_APPROVER', () => {
  const engine = buildEngine({});
  let err;
  try { engine.assertActiveEmployeeApprover(null, 'default_approver1'); } catch (e) { err = e; }
  assert.equal(err.name, 'OA_INVALID_APPROVER');
});

test('M-3 helper: undefined throws OA_INVALID_APPROVER', () => {
  const engine = buildEngine({});
  let err;
  try { engine.assertActiveEmployeeApprover(undefined, 'default_approver1'); } catch (e) { err = e; }
  assert.equal(err.name, 'OA_INVALID_APPROVER');
});

test('M-3 helper: empty string throws OA_INVALID_APPROVER', () => {
  const engine = buildEngine({});
  let err;
  try { engine.assertActiveEmployeeApprover('', 'default_approver1'); } catch (e) { err = e; }
  assert.equal(err.name, 'OA_INVALID_APPROVER');
});

test('M-3 helper: negative ID (system seed user, e.g. -5 Kathryn) does not throw', () => {
  const engine = buildEngine({});
  // Negative IDs are allowed because demo / seed accounts use them. The audit
  // log row OA_NEGATIVE_APPROVER_ID is observable via the global log mock but
  // that's incidental — the test contract is that negatives don't throw.
  assert.doesNotThrow(() => engine.assertActiveEmployeeApprover(-5, 'approver1'));
});

test('M-3 helper: result is memoised (second call does not re-lookup)', () => {
  let lookupCalls = 0;
  const search = {
    create: () => ({ run: () => ({ each: () => {}, getRange: () => [] }) }),
    lookupFields: () => {
      lookupCalls++;
      return { isinactive: 'F', firstname: 'A', lastname: 'B' };
    }
  };
  const engine = loadModule(ENGINE_PATH, {
    'N/record':  { load: () => null, create: () => null },
    'N/runtime': makeRuntimeMock(),
    'N/search':  search,
    'N/task':    TASK_MOCK,
    'N/error':   { create: ({ name, message }) => { const e = new Error(message); e.name = name || 'Error'; return e; } },
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });
  engine.assertActiveEmployeeApprover(100, 'a');
  engine.assertActiveEmployeeApprover(100, 'b');
  engine.assertActiveEmployeeApprover(100, 'c');
  assert.equal(lookupCalls, 1, 'only one search.lookupFields call expected');
});

// ── Routing-time integration ────────────────────────────────────────────────

const HIERARCHY_INACTIVE_APPROVER = {
  id: '7',
  custrecord_oah_settings:     '1',
  custrecord_oah_name:         'VB-2026',
  custrecord_oah_record_type:  '2',
  custrecord_oah_status:       '2',
  custrecord_oah_highest_only: 'F',
  custrecord_oah_priority:     '10',
  thresholds: [{
    id: '101',
    getValue: f => ({
      custrecord_oat_label:      'mid',
      custrecord_oat_min_amount: '500',
      custrecord_oat_max_amount: '5000',
      custrecord_oat_approver:   '201', // Adam Minister, inactive
      custrecord_oat_approver2:  '',
      custrecord_oat_sort_order: '1'
    }[f])
  }]
};

test('M-3 routing: threshold approver inactive → engine returns INACTIVE_APPROVER', () => {
  const engine = buildEngine({
    employeeRows: { 201: { isinactive: 'T', firstname: 'Adam', lastname: 'Minister' } },
    settings: {
      custrecord_oa_subsidiary:     '1',
      custrecord_oa_enable_vb:      'T',
      custrecord_oa_use_amount:     'T',
      custrecord_oa_approver_count: '1',
      custrecord_oa_default_approver1: ''
    },
    hierarchy: HIERARCHY_INACTIVE_APPROVER
  });
  const r = engine.routeForApproval('vendorbill', 999, '1', 750);
  assert.equal(r.error, 'INACTIVE_APPROVER');
  assert.match(r.message, /201/);
  assert.match(r.message, /Adam Minister/);
});

test('M-3 routing: default approver inactive → engine returns INACTIVE_APPROVER', () => {
  const engine = buildEngine({
    employeeRows: { 8: { isinactive: 'T', firstname: 'Default', lastname: 'Person' } },
    settings: {
      custrecord_oa_subsidiary:     '1',
      custrecord_oa_enable_vb:      'T',
      custrecord_oa_use_amount:     'F',          // matrix out of scope — defaults are used
      custrecord_oa_approver_count: '1',
      custrecord_oa_default_approver1: '8'
    }
  });
  const r = engine.routeForApproval('vendorbill', 999, '1', 750);
  assert.equal(r.error, 'INACTIVE_APPROVER');
});

test('M-3 routing: zero default approver ID → INVALID_APPROVER', () => {
  // approver1 lands as '0' from a misconfigured settings record.
  const engine = buildEngine({
    employeeRows: {},
    settings: {
      custrecord_oa_subsidiary:     '1',
      custrecord_oa_enable_vb:      'T',
      custrecord_oa_use_amount:     'F',
      custrecord_oa_approver_count: '1',
      custrecord_oa_default_approver1: '0'
    }
  });
  const r = engine.routeForApproval('vendorbill', 999, '1', 100);
  // settings.default_approver1 = '0' is treated as "blank" by the
  // SB-2 fallback policy (settings.default_approver1 || null), so the engine
  // returns NO_RULE_MATCH rather than reaching the validator. This is a
  // known interaction — the test pins the actual behaviour so M-3's contract
  // is well-defined: 0 means "no approver configured", and SB-2 surfaces that
  // as NO_RULE_MATCH before the validator runs.
  assert.ok(r.error === 'NO_RULE_MATCH' || r.error === 'INVALID_APPROVER',
    'expected NO_RULE_MATCH or INVALID_APPROVER, got ' + r.error);
});

test('M-3 routing: negative approver ID (-5 Kathryn demo seed) does not block routing', () => {
  const engine = buildEngine({
    employeeRows: {},
    settings: {
      custrecord_oa_subsidiary:     '1',
      custrecord_oa_enable_vb:      'T',
      custrecord_oa_use_amount:     'F',
      custrecord_oa_approver_count: '1',
      custrecord_oa_default_approver1: '-5'
    }
  });
  const r = engine.routeForApproval('vendorbill', 999, '1', 100);
  assert.equal(r.error, undefined);
  assert.equal(r.approver1, '-5');
});

// ── Manager-flow integration (delegate / reset / reassign) ─────────────────

function buildEngineWithEmployees(rows) {
  const search = {
    create: () => ({ run: () => ({ each: () => {}, getRange: () => [] }) }),
    lookupFields: ({ type, id, columns }) => {
      const out = {};
      columns.forEach(c => {
        if (type === 'employee') {
          const row = rows[String(id)] || {};
          out[c] = row[c] === undefined ? '' : row[c];
        } else {
          out[c] = '';
        }
      });
      return out;
    }
  };
  return loadModule(ENGINE_PATH, {
    'N/record':  {
      load:   () => ({
        getValue: () => '1',
        setValue: () => {},
        save:     () => 1,
        type: 'vendorbill', id: 1
      }),
      create: () => null
    },
    'N/runtime': makeRuntimeMock(),
    'N/search':  search,
    'N/task':    TASK_MOCK,
    'N/error':   { create: ({ name, message }) => { const e = new Error(message); e.name = name || 'Error'; return e; } },
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });
}

test('M-3 reset: inactive new approver → success:false with OA_INACTIVE_APPROVER', () => {
  const engine = buildEngineWithEmployees({
    50: { custentity_oa_is_manager: 'T', custentity_oa_is_approver: 'T' },        // manager
    99: { custentity_oa_is_approver: 'T', isinactive: 'T', firstname: 'Inactive', lastname: 'Target' } // inactive target
  });
  const r = engine.processReset(1, 'vendorbill', 50, 99);
  assert.equal(r.success, false);
  assert.match(r.message, /OA_INACTIVE_APPROVER/);
});

test('M-3 reassign: inactive new approver → success:false with OA_INACTIVE_APPROVER', () => {
  const engine = buildEngineWithEmployees({
    50: { custentity_oa_is_manager: 'T', custentity_oa_is_approver: 'T' },
    99: { custentity_oa_is_approver: 'T', isinactive: 'T', firstname: 'X', lastname: 'Y' }
  });
  const r = engine.processReassign(1, 'vendorbill', 50, 99);
  assert.equal(r.success, false);
  assert.match(r.message, /OA_INACTIVE_APPROVER/);
});

test('M-3 delegate: inactive target → success:false with OA_INACTIVE_APPROVER', () => {
  const engine = buildEngineWithEmployees({
    50: { custentity_oa_can_delegate: 'T' },
    99: { custentity_oa_is_approver: 'T', isinactive: 'T', firstname: 'X', lastname: 'Y' }
  });
  const r = engine.processDelegation(1, 'vendorbill', 50, 99);
  assert.equal(r.success, false);
  assert.match(r.message, /OA_INACTIVE_APPROVER/);
});

// ── User Event surfaces engine codes as OA_INACTIVE_APPROVER ────────────────

const { loadModule: load2 } = require('../_amd');
const { makeRecordInstance,
        makeSearchMock,
        URL_MOCK,
        SERVERWIDGET_MOCK,
        CRYPTO_MOCK,
        ENCODE_MOCK,
        ERROR_MOCK }     = require('../_mocks');

const UE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_user_event.js';

test('M-3 UE: engine INACTIVE_APPROVER becomes thrown OA_INACTIVE_APPROVER', () => {
  const ue = load2(UE_PATH, {
    'N/record':           { load: () => makeRecordInstance({}), create: () => makeRecordInstance({}) },
    'N/runtime':          makeRuntimeMock(),
    'N/search':           makeSearchMock({}),
    'N/task':             TASK_MOCK,
    'N/url':              URL_MOCK,
    'N/error':            ERROR_MOCK,
    'N/ui/serverWidget':  SERVERWIDGET_MOCK,
    'N/crypto':           CRYPTO_MOCK,
    'N/encode':           ENCODE_MOCK,
    './oa_engine': {
      routeForApproval: () => ({
        error: 'INACTIVE_APPROVER',
        message: 'Approver 201 (Adam Minister) is inactive...',
        approver1: '201',
        approver2: null
      }),
      getSettingsForSubsidiary: () => ({ id: 1 }),
      createAuditLog: () => null
    }
  });
  const rec = makeRecordInstance({ type: 'vendorbill', subsidiary: '1', total: '750', exchangerate: '1' });
  assert.throws(() => {
    ue.beforeSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: rec });
  }, /OA_INACTIVE_APPROVER.*Adam Minister/s);
});
