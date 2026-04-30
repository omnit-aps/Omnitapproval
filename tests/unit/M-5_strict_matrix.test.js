'use strict';

// M-5 — strict tri-state matrix classifier.
//
// Live evidence (td3075893): pre-fix, $499.99 fell into a threshold gap on
// hierarchy 2 and silently routed via DEFAULT to Aaron. Per Jonas: "default
// approver in the setup should ONLY be used if an approval matrix is not
// covering who to approve."
//
// Tri-state semantics:
//   HIERARCHY                 — active hierarchy + matched threshold row.
//   NO_MATRIX_IN_SCOPE        — use_amount=F OR no active hierarchy → DEFAULT.
//   MATRIX_IN_SCOPE_NO_MATCH  — active hierarchy + amount in a gap → throw.

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

const ENGINE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js';
const UE_PATH     = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_user_event.js';

function buildEngine(settings, hierarchyOrNull) {
  const settingsResults  = settings ? [{ id: '1', getValue: f => settings[f] }] : [];
  const hierarchyResults = hierarchyOrNull ? [{ id: hierarchyOrNull.id, getValue: f => hierarchyOrNull[f] }] : [];
  const thresholdResults = (hierarchyOrNull && hierarchyOrNull.thresholds) || [];

  const search = {
    create: ({ type }) => {
      let rows = [];
      if (type === 'customrecord_oa_settings')  rows = settingsResults;
      if (type === 'customrecord_oa_hierarchy') rows = hierarchyResults;
      if (type === 'customrecord_oa_threshold') rows = thresholdResults;
      return { run: () => ({ each: (cb) => { for (const r of rows) { if (cb(r) === false) break; } }, getRange: () => rows }) };
    },
    lookupFields: () => ({})
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

const HIERARCHY_GAPPED = {
  id: '2',
  custrecord_oah_settings:     '1',
  custrecord_oah_name:         'VB-2026-Q2',
  custrecord_oah_record_type:  '2',
  custrecord_oah_status:       '2',
  custrecord_oah_highest_only: 'F',
  custrecord_oah_priority:     '10',
  // Two rows leaving gaps below 10 and between 500 and 1000.
  thresholds: [
    { id: 'A', getValue: f => ({
        custrecord_oat_label:      'tier-1',
        custrecord_oat_min_amount: '10',
        custrecord_oat_max_amount: '500',
        custrecord_oat_approver:   '50',
        custrecord_oat_approver2:  '',
        custrecord_oat_sort_order: '1'
      }[f]) },
    { id: 'B', getValue: f => ({
        custrecord_oat_label:      'tier-2',
        custrecord_oat_min_amount: '1000',
        custrecord_oat_max_amount: '5000',
        custrecord_oat_approver:   '60',
        custrecord_oat_approver2:  '',
        custrecord_oat_sort_order: '2'
      }[f]) }
  ]
};

const SETTINGS_USE_AMOUNT_T = {
  custrecord_oa_subsidiary:        '2',
  custrecord_oa_enable_vb:         'T',
  custrecord_oa_use_amount:        'T',
  custrecord_oa_approver_count:    '1',
  custrecord_oa_default_approver1: '8'  // present, but should NOT be used when matrix in scope
};

const SETTINGS_USE_AMOUNT_F = Object.assign({}, SETTINGS_USE_AMOUNT_T, {
  custrecord_oa_use_amount: 'F'
});

// ── HIERARCHY case (matched row) ────────────────────────────────────────────

test('M-5: matched threshold returns routeSource=HIERARCHY (no error)', () => {
  const engine = buildEngine(SETTINGS_USE_AMOUNT_T, HIERARCHY_GAPPED);
  const r = engine.routeForApproval('vendorbill', 999, '2', 100);
  assert.equal(r.error, undefined);
  assert.equal(r.approver1, '50');
  assert.equal(r.routeSource, 'HIERARCHY');
});

// ── NO_MATRIX_IN_SCOPE case (use_amount=F) ──────────────────────────────────

test('M-5: use_amount=F with default approver routes DEFAULT (NOT NO_THRESHOLD_MATCH)', () => {
  // Critical: the strict-matrix policy must not break the intentional
  // "no matrix configured" mode. use_amount=F means defaults are the
  // expected mechanism.
  const engine = buildEngine(SETTINGS_USE_AMOUNT_F, HIERARCHY_GAPPED);
  const r = engine.routeForApproval('vendorbill', 999, '2', 100);
  assert.equal(r.error, undefined);
  assert.equal(r.approver1, '8');
  assert.equal(r.routeSource, 'DEFAULT');
});

// ── NO_MATRIX_IN_SCOPE case (no active hierarchy bound to subsidiary+VB) ───

test('M-5: no active hierarchy + default approver routes DEFAULT', () => {
  const engine = buildEngine(SETTINGS_USE_AMOUNT_T, /*hierarchy=*/ null);
  const r = engine.routeForApproval('vendorbill', 999, '2', 100);
  assert.equal(r.error, undefined);
  assert.equal(r.approver1, '8');
  assert.equal(r.routeSource, 'DEFAULT');
});

// ── MATRIX_IN_SCOPE_NO_MATCH cases (active hierarchy, gap in coverage) ──────

test('M-5: amount below lowest row fires NO_THRESHOLD_MATCH (not DEFAULT)', () => {
  const engine = buildEngine(SETTINGS_USE_AMOUNT_T, HIERARCHY_GAPPED);
  const r = engine.routeForApproval('vendorbill', 999, '2', 5); // below 10
  assert.equal(r.error, 'NO_THRESHOLD_MATCH');
  assert.equal(r.hierarchyId, '2');
  assert.equal(r.hierarchyName, 'VB-2026-Q2');
  assert.equal(r.amount, 5);
  assert.equal(r.approver1, undefined, 'must NOT return a default approver');
});

test('M-5: amount in gap between rows fires NO_THRESHOLD_MATCH (the live $499.99 case)', () => {
  // tier-1 ends at 500 (exclusive per H-1 [min,max)), tier-2 starts at 1000.
  // 700 falls in the gap.
  const engine = buildEngine(SETTINGS_USE_AMOUNT_T, HIERARCHY_GAPPED);
  const r = engine.routeForApproval('vendorbill', 999, '2', 700);
  assert.equal(r.error, 'NO_THRESHOLD_MATCH');
  assert.equal(r.hierarchyName, 'VB-2026-Q2');
  assert.equal(r.amount, 700);
});

test('M-5: amount at exclusive upper bound (500) fires NO_THRESHOLD_MATCH', () => {
  // H-1 half-open [10, 500) — 500 is NOT in tier-1, and tier-2 starts at 1000.
  // Strict matrix: must throw, not fall through.
  const engine = buildEngine(SETTINGS_USE_AMOUNT_T, HIERARCHY_GAPPED);
  const r = engine.routeForApproval('vendorbill', 999, '2', 500);
  assert.equal(r.error, 'NO_THRESHOLD_MATCH');
});

test('M-5: amount above highest row fires NO_THRESHOLD_MATCH', () => {
  const engine = buildEngine(SETTINGS_USE_AMOUNT_T, HIERARCHY_GAPPED);
  const r = engine.routeForApproval('vendorbill', 999, '2', 100000);
  assert.equal(r.error, 'NO_THRESHOLD_MATCH');
});

// ── User Event surfaces NO_THRESHOLD_MATCH as OA_NO_THRESHOLD_MATCH ─────────

function buildUE(routeReturn) {
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
    './oa_engine': {
      routeForApproval: () => routeReturn,
      getSettingsForSubsidiary: () => ({ id: 1 }),
      createAuditLog: () => null
    }
  });
}

test('M-5 UE: NO_THRESHOLD_MATCH surfaces as OA_NO_THRESHOLD_MATCH with hierarchy + amount', () => {
  const ue  = buildUE({
    error: 'NO_THRESHOLD_MATCH',
    hierarchyId: '2', hierarchyName: 'VB-2026-Q2', amount: 499.99,
    thresholdRowCount: 2
  });
  const rec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '499.99', exchangerate: '1' });

  assert.throws(() => {
    ue.beforeSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: rec });
  }, /OA_NO_THRESHOLD_MATCH.*VB-2026-Q2.*499\.99/s);

  assert.equal(rec.getValue('approvalstatus'), undefined,
    'approvalstatus must remain unset when matrix-in-scope refuses');
});
