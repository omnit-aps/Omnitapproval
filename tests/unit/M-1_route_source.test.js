'use strict';

// M-1 — engine returns a route_source code on every successful route, and the
// User Event writes it to custbody_oa_route_source unconditionally.
//
//   HIERARCHY  — a threshold rule matched
//   DEFAULT    — fell back to settings.default_approver1
//   FAILSAFE   — reserved (currently unused)
//
// Closes the audit gap where default-routed bills had hierarchy_used=null and
// no other field explaining why the approver was picked.

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
  const hierarchyResults = hierarchyOrNull
    ? [{ id: hierarchyOrNull.id, getValue: f => hierarchyOrNull[f] }]
    : [];
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

const HIERARCHY = {
  id: '7',
  custrecord_oah_settings:     '1',
  custrecord_oah_record_type:  '2',
  custrecord_oah_status:       '2',
  custrecord_oah_highest_only: 'F',
  custrecord_oah_priority:     '10',
  thresholds: [{
    id: '101',
    getValue: f => ({
      custrecord_oat_label:      'low',
      custrecord_oat_min_amount: '0',
      custrecord_oat_max_amount: '500',
      custrecord_oat_approver:   '50',
      custrecord_oat_approver2:  '',
      custrecord_oat_sort_order: '1'
    }[f])
  }]
};

const SETTINGS_WITH_DEFAULT = {
  custrecord_oa_subsidiary:        '2',
  custrecord_oa_enable_vb:         'T',
  custrecord_oa_use_amount:        'T',
  custrecord_oa_approver_count:    '1',
  custrecord_oa_default_approver1: '8'
};

test('M-1 engine: rule match returns routeSource=HIERARCHY', () => {
  const engine = buildEngine(SETTINGS_WITH_DEFAULT, HIERARCHY);
  const r = engine.routeForApproval('vendorbill', 999, '2', 50);
  assert.equal(r.error, undefined);
  assert.equal(r.approver1, '50');
  assert.equal(r.routeSource, 'HIERARCHY');
});

test('M-1 engine: NO active hierarchy → falls back to default and returns routeSource=DEFAULT', () => {
  // Post-M-5: amount-outside-band triggers NO_THRESHOLD_MATCH, not DEFAULT.
  // The DEFAULT route_source now only applies when the matrix is OUT OF
  // SCOPE — i.e., no active hierarchy bound to (settings, recordType).
  const engine = buildEngine(SETTINGS_WITH_DEFAULT, /*hierarchy=*/ null);
  const r = engine.routeForApproval('vendorbill', 999, '2', 5000);
  assert.equal(r.error, undefined);
  assert.equal(r.approver1, '8');
  assert.equal(r.routeSource, 'DEFAULT');
});

test('M-1 engine: use_amount=false routes via default and returns routeSource=DEFAULT', () => {
  const settings = Object.assign({}, SETTINGS_WITH_DEFAULT, { custrecord_oa_use_amount: 'F' });
  const engine   = buildEngine(settings, HIERARCHY);
  const r = engine.routeForApproval('vendorbill', 999, '2', 50);
  assert.equal(r.error, undefined);
  assert.equal(r.approver1, '8');
  assert.equal(r.routeSource, 'DEFAULT');
});

// ── User Event writes the field ─────────────────────────────────────────────

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
    './oa_engine':        {
      routeForApproval: () => routeReturn,
      getSettingsForSubsidiary: () => ({ id: 1 }),
      createAuditLog: () => null
    }
  });
}

test('M-1 UE: writes route_source=HIERARCHY when engine reports it', () => {
  const ue  = buildUE({ approver1: 50, approver2: null, hierarchyId: 7,  approverCount: 1, settings: {}, routeSource: 'HIERARCHY' });
  const rec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '100', exchangerate: '1' });
  ue.beforeSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: rec });
  assert.equal(rec.getValue('custbody_oa_route_source'), 'HIERARCHY');
  assert.equal(rec.getValue('custbody_oa_hierarchy_used'), 7);
});

test('M-1 UE: writes route_source=DEFAULT when engine reports default fallback (hierarchyId=null)', () => {
  const ue  = buildUE({ approver1: 8, approver2: null, hierarchyId: null, approverCount: 1, settings: {}, routeSource: 'DEFAULT' });
  const rec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '5000', exchangerate: '1' });
  ue.beforeSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: rec });
  assert.equal(rec.getValue('custbody_oa_route_source'), 'DEFAULT');
  // hierarchy_used left untouched on the default path — that's the bug M-1 closes
  assert.equal(rec.getValue('custbody_oa_hierarchy_used'), undefined);
});

test('M-1 UE: defaults to DEFAULT when engine omits routeSource (defensive)', () => {
  const ue  = buildUE({ approver1: 8, approver2: null, hierarchyId: null, approverCount: 1, settings: {} /* no routeSource */ });
  const rec = makeRecordInstance({ type: 'vendorbill', subsidiary: '2', total: '5000', exchangerate: '1' });
  ue.beforeSubmit({ type: 'create', UserEventType: { CREATE: 'create', EDIT: 'edit' }, newRecord: rec });
  assert.equal(rec.getValue('custbody_oa_route_source'), 'DEFAULT');
});
