'use strict';

// M-3 — engine.getActiveHierarchy(settingsId, recordType) tie-break rules.
//
// When multiple hierarchies match a settings/recordType combination, the
// engine picks deterministically:
//   1. lowest priority value wins (1 = highest priority; default 10)
//   2. on priority tie: a record-type-specific hierarchy (PO or VB) beats
//      a BOTH hierarchy
//   3. on full tie: lowest internal id wins
//
// Status/date filtering is done via NS search filters (NOT in code), so the
// unit harness only exercises the tie-break logic — the test pre-filters
// the mock rows to mirror what NS would return for ACTIVE + within-window.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const ENGINE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js';

// Hierarchy record-type constant codes (from C.HIERARCHY_RECORD_TYPES):
const PO   = '1';
const VB   = '2';
const BOTH = '3';

function makeHarness({ hierarchies }) {
  // Build mocked hierarchy rows. Each entry: { id, name, recordType, highestOnly?, priority? }.
  const hierRows = hierarchies.map((h) => ({
    id: h.id,
    getValue: (col) => {
      const map = {
        custrecord_oah_name:           h.name || ('H-' + h.id),
        custrecord_oah_record_type:    h.recordType,
        custrecord_oah_highest_only:   h.highestOnly ? 'T' : 'F',
        custrecord_oah_priority:       String(h.priority == null ? 10 : h.priority),
        custrecord_oah_settings:       h.settings || '1',
        custrecord_oah_status:         h.status || '2',
        custrecord_oah_start_date:     h.startDate || '01/01/2020',
        custrecord_oah_end_date:       h.endDate || ''
      };
      return map[col] != null ? map[col] : '';
    }
  }));

  const search = {
    create: ({ type }) => {
      let rows = [];
      if (type === 'customrecord_oa_hierarchy') rows = hierRows;
      if (type === 'customrecord_oa_threshold') rows = []; // not under test here
      if (type === 'customrecord_oa_settings')  rows = [];
      return {
        run: () => ({
          each: (cb) => { for (const r of rows) { if (cb(r) === false) break; } },
          getRange: () => rows
        })
      };
    },
    lookupFields: () => ({})
  };

  const engine = loadModule(ENGINE_PATH, {
    'N/record':  { load: () => ({}), create: () => ({ setValue: () => {}, save: () => 1 }) },
    'N/runtime': makeRuntimeMock(),
    'N/search':  search,
    'N/task':    { TaskType: { MAP_REDUCE: 'MAPREDUCE' }, create: () => ({ submit: () => '1' }) },
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });

  return { engine };
}

test('M-3 PO-specific beats BOTH when priorities tie (recordType=purchaseorder)', () => {
  const { engine } = makeHarness({
    hierarchies: [
      { id: 1, recordType: BOTH, priority: 5, name: 'general' },
      { id: 2, recordType: PO,   priority: 5, name: 'po-specific' }
    ]
  });
  const h = engine.getActiveHierarchy('1', 'purchaseorder');
  assert.ok(h, 'should pick a hierarchy');
  assert.equal(h.id, 2, 'PO-specific should win on priority tie');
  assert.equal(h.name, 'po-specific');
});

test('M-3 VB-specific beats BOTH when priorities tie (recordType=vendorbill)', () => {
  const { engine } = makeHarness({
    hierarchies: [
      { id: 1, recordType: BOTH, priority: 3, name: 'general' },
      { id: 2, recordType: VB,   priority: 3, name: 'vb-specific' }
    ]
  });
  const h = engine.getActiveHierarchy('1', 'vendorbill');
  assert.equal(h.id, 2);
});

test('M-3 lower priority value wins regardless of record-type', () => {
  const { engine } = makeHarness({
    hierarchies: [
      { id: 1, recordType: VB,   priority: 5, name: 'vb-specific-low-prio' },
      { id: 2, recordType: BOTH, priority: 1, name: 'general-high-prio' }
    ]
  });
  const h = engine.getActiveHierarchy('1', 'vendorbill');
  assert.equal(h.id, 2, 'priority 1 beats priority 5 even though VB-specific exists');
});

test('M-3 full tie: lowest internal id wins', () => {
  const { engine } = makeHarness({
    hierarchies: [
      { id: 7, recordType: VB, priority: 5 },
      { id: 3, recordType: VB, priority: 5 }
    ]
  });
  const h = engine.getActiveHierarchy('1', 'vendorbill');
  assert.equal(h.id, 3, 'lowest id breaks tie');
});

test('M-3 no matching hierarchies -> null', () => {
  const { engine } = makeHarness({ hierarchies: [] });
  const h = engine.getActiveHierarchy('1', 'vendorbill');
  assert.equal(h, null);
});

test('M-3 unknown record type -> null (not crashy)', () => {
  const { engine } = makeHarness({
    hierarchies: [{ id: 1, recordType: VB, priority: 1 }]
  });
  const h = engine.getActiveHierarchy('1', 'cashsale'); // not PO or VB
  assert.equal(h, null);
});
