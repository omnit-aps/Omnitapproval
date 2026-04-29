'use strict';

// SB-2 — required-fallback policy. routeForApproval must hard-fail with
// NO_RULE_MATCH when no threshold rule matches AND no default approver
// is configured. SB-1 then turns that into a blocking save error.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule }            = require('../_amd');
const { makeRuntimeMock,
        TASK_MOCK }              = require('../_mocks');

const ENGINE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js';

function buildEngine(settings, hierarchyOrNull) {
  // Custom search mock that returns the settings then the hierarchy.
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
      return {
        run: () => ({
          each: (cb) => { for (const r of rows) { if (cb(r) === false) break; } },
          getRange: () => rows
        })
      };
    },
    lookupFields: () => ({})
  };

  return loadModule(ENGINE_PATH, {
    'N/record':  { load: () => null, create: () => null },
    'N/runtime': makeRuntimeMock(),
    'N/search':  search,
    'N/task':    TASK_MOCK,
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });
}

test('SB-2: NO_RULE_MATCH when no rule and no default approver', () => {
  const settings = {
    custrecord_oa_subsidiary:        '2',
    custrecord_oa_enable_vb:         'T',
    custrecord_oa_enable_po:         'F',
    custrecord_oa_use_amount:        'T',
    custrecord_oa_approver_count:    '1',
    custrecord_oa_default_approver1: '', // blank
    custrecord_oa_default_approver2: ''
  };
  const hierarchy = {
    id:                          '7',
    custrecord_oah_settings:     '1',
    custrecord_oah_name:         'VB-2026',
    custrecord_oah_record_type:  '2',
    custrecord_oah_status:       '2',
    custrecord_oah_highest_only: 'F',
    custrecord_oah_priority:     '10',
    thresholds: [{
      id: '101',
      getValue: f => ({
        custrecord_oat_label:      'low',
        custrecord_oat_min_amount: '0',
        custrecord_oat_max_amount: '100',
        custrecord_oat_approver:   '50',
        custrecord_oat_approver2:  '',
        custrecord_oat_sort_order: '1'
      }[f])
    }]
  };

  const engine = buildEngine(settings, hierarchy);
  const result = engine.routeForApproval('vendorbill', 999, '2', /*amount=*/ 5000); // outside threshold

  assert.equal(result.error, 'NO_RULE_MATCH', 'must surface deterministic refusal code');
  assert.equal(result.approver1, undefined, 'must not return an approver');
});

test('SB-2: rule match returns approver and no error', () => {
  const settings = {
    custrecord_oa_subsidiary:        '2',
    custrecord_oa_enable_vb:         'T',
    custrecord_oa_use_amount:        'T',
    custrecord_oa_approver_count:    '1',
    custrecord_oa_default_approver1: '',
    custrecord_oa_default_approver2: ''
  };
  const hierarchy = {
    id:                          '7',
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
        custrecord_oat_max_amount: '100',
        custrecord_oat_approver:   '50',
        custrecord_oat_approver2:  '',
        custrecord_oat_sort_order: '1'
      }[f])
    }]
  };

  const engine = buildEngine(settings, hierarchy);
  const result = engine.routeForApproval('vendorbill', 999, '2', /*amount=*/ 50);

  assert.equal(result.error, undefined);
  assert.equal(result.approver1, '50');
});

test('SB-2: default approver picks up when no rule matches', () => {
  const settings = {
    custrecord_oa_subsidiary:        '2',
    custrecord_oa_enable_vb:         'T',
    custrecord_oa_use_amount:        'T',
    custrecord_oa_approver_count:    '1',
    custrecord_oa_default_approver1: '8',
    custrecord_oa_default_approver2: ''
  };
  const hierarchy = {
    id:                          '7',
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
        custrecord_oat_max_amount: '100',
        custrecord_oat_approver:   '50',
        custrecord_oat_approver2:  '',
        custrecord_oat_sort_order: '1'
      }[f])
    }]
  };

  const engine = buildEngine(settings, hierarchy);
  const result = engine.routeForApproval('vendorbill', 999, '2', /*amount=*/ 5000);

  assert.equal(result.error, undefined);
  assert.equal(result.approver1, '8', 'must fall back to default_approver1');
});
