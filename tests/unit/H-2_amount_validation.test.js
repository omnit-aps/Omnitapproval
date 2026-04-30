'use strict';

// H-2 — routeForApproval rejects null / undefined / NaN amounts and (by default)
// negative amounts. Negative amounts are allowed only when the subsidiary
// settings record sets custrecord_oa_allow_negative_amount = T (credit-note rule).

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule }            = require('../_amd');
const { makeRuntimeMock,
        TASK_MOCK }              = require('../_mocks');

const ENGINE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js';

function buildEngine(settings, hierarchy) {
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

const SETTINGS_NO_NEG = {
  custrecord_oa_subsidiary:        '2',
  custrecord_oa_enable_vb:         'T',
  custrecord_oa_use_amount:        'T',
  custrecord_oa_approver_count:    '1',
  custrecord_oa_default_approver1: '8',
  custrecord_oa_allow_negative_amount: 'F'
};

const SETTINGS_ALLOW_NEG = Object.assign({}, SETTINGS_NO_NEG, {
  custrecord_oa_allow_negative_amount: 'T'
});

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

test('H-2: null amount is rejected', () => {
  const engine = buildEngine(SETTINGS_NO_NEG, HIERARCHY);
  const result = engine.routeForApproval('vendorbill', 999, '2', null);
  assert.equal(result.error, 'INVALID_AMOUNT');
});

test('H-2: undefined amount is rejected', () => {
  const engine = buildEngine(SETTINGS_NO_NEG, HIERARCHY);
  const result = engine.routeForApproval('vendorbill', 999, '2', undefined);
  assert.equal(result.error, 'INVALID_AMOUNT');
});

test('H-2: NaN amount is rejected', () => {
  const engine = buildEngine(SETTINGS_NO_NEG, HIERARCHY);
  const result = engine.routeForApproval('vendorbill', 999, '2', NaN);
  assert.equal(result.error, 'INVALID_AMOUNT');
});

test('H-2: 0 amount is allowed (matches the low band)', () => {
  const engine = buildEngine(SETTINGS_NO_NEG, HIERARCHY);
  const result = engine.routeForApproval('vendorbill', 999, '2', 0);
  assert.equal(result.error, undefined);
  assert.equal(result.approver1, '50');
});

test('H-2: -1 is rejected when allow_negative_amount is OFF', () => {
  const engine = buildEngine(SETTINGS_NO_NEG, HIERARCHY);
  const result = engine.routeForApproval('vendorbill', 999, '2', -1);
  assert.equal(result.error, 'NEGATIVE_AMOUNT_REJECTED');
});

test('H-2: -100 is rejected when allow_negative_amount is OFF', () => {
  const engine = buildEngine(SETTINGS_NO_NEG, HIERARCHY);
  const result = engine.routeForApproval('vendorbill', 999, '2', -100);
  assert.equal(result.error, 'NEGATIVE_AMOUNT_REJECTED');
});

test('H-2: -100 is permitted when allow_negative_amount is ON (matrix has covering row)', () => {
  // Post-M-5 strict matrix: when use_amount=T and the matrix is in scope,
  // the amount must match a row. To exercise the negative-amount allow flag
  // we need a hierarchy with a row that covers negatives. This is the realistic
  // production setup for a credit-note rule.
  const HIERARCHY_WITH_NEGATIVES = {
    id: '7',
    custrecord_oah_settings:     '1',
    custrecord_oah_record_type:  '2',
    custrecord_oah_status:       '2',
    custrecord_oah_highest_only: 'F',
    custrecord_oah_priority:     '10',
    thresholds: [
      {
        id: '100',
        getValue: f => ({
          custrecord_oat_label:      'credit-notes',
          custrecord_oat_min_amount: '-1000',
          custrecord_oat_max_amount: '0',
          custrecord_oat_approver:   '77',
          custrecord_oat_approver2:  '',
          custrecord_oat_sort_order: '0'
        }[f])
      },
      {
        id: '101',
        getValue: f => ({
          custrecord_oat_label:      'low',
          custrecord_oat_min_amount: '0',
          custrecord_oat_max_amount: '500',
          custrecord_oat_approver:   '50',
          custrecord_oat_approver2:  '',
          custrecord_oat_sort_order: '1'
        }[f])
      }
    ]
  };
  const engine = buildEngine(SETTINGS_ALLOW_NEG, HIERARCHY_WITH_NEGATIVES);
  const result = engine.routeForApproval('vendorbill', 999, '2', -100);
  assert.equal(result.error, undefined);
  assert.equal(result.approver1, '77', 'must route via the negative-covering row');
  assert.equal(result.routeSource, 'HIERARCHY');
});
