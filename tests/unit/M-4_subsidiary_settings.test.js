'use strict';

// M-4 — engine.getSettingsForSubsidiary(subsidiaryId).
//
// Returns the row's fields keyed by lowercase constant name. Multiple active
// settings for the same subsidiary is a misconfiguration; the engine sorts by
// id and uses the lowest (deterministic) but logs an error so admins notice.
// No row at all -> returns null (caller decides how to handle).

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const ENGINE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js';

function makeHarness({ settings }) {
  const settingsRows = (settings || []).map((s) => ({
    id: s.id,
    getValue: (col) => {
      const map = {
        custrecord_oa_subsidiary:           s.subsidiary || '2',
        custrecord_oa_enable_po:            s.enable_po  || 'F',
        custrecord_oa_enable_vb:            s.enable_vb  || 'T',
        custrecord_oa_approver_count:       String(s.approver_count == null ? 1 : s.approver_count),
        custrecord_oa_use_amount:           s.use_amount || 'F',
        custrecord_oa_default_approver1:    s.approver1  || '',
        custrecord_oa_default_approver2:    s.approver2  || '',
        custrecord_oa_approve_string:       s.approve_string || 'APPROVE',
        custrecord_oa_reject_string:        s.reject_string  || 'REJECT',
        custrecord_oa_email_enabled:        s.email_enabled  || 'F',
        custrecord_oa_token_expiry_days:    s.token_expiry_days || '7',
        custrecord_oa_email_sender:         s.email_sender   || '',
        custrecord_oa_email_subject:        s.email_subject  || '',
        custrecord_oa_email_intro:          s.email_intro    || '',
        custrecord_oa_approve_without_login: s.approve_without_login || 'F',
        custrecord_oas_resubmit_threshold_pct: s.resubmit_threshold_pct || '0',
        custrecord_oas_resubmit_threshold_abs: s.resubmit_threshold_abs || '0',
        custrecord_oa_hmac_secret:          s.hmac_secret   || '',
        custrecord_oa_allow_negative_amount: s.allow_negative_amount || 'F'
      };
      return map[col] != null ? map[col] : '';
    }
  }));

  const search = {
    create: ({ type }) => {
      const rows = (type === 'customrecord_oa_settings') ? settingsRows : [];
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

test('M-4 returns the configured row, fields keyed by lowercase constant name', () => {
  const { engine } = makeHarness({
    settings: [{
      id: '7',
      subsidiary: '2',
      enable_vb: 'T',
      approver_count: 2,
      approver1: '101',
      approver2: '202',
      hmac_secret: 'secret-A',
      email_enabled: 'T'
    }]
  });
  const s = engine.getSettingsForSubsidiary('2');
  assert.ok(s, 'should return a settings object');
  assert.equal(s.id, '7');
  assert.equal(s.subsidiary, '2');
  assert.equal(s.approver_count, '2');
  assert.equal(s.default_approver1, '101');
  assert.equal(s.default_approver2, '202');
  assert.equal(s.hmac_secret, 'secret-A');
  assert.equal(s.email_enabled, 'T');
});

test('M-4 returns null when no settings row exists for subsidiary', () => {
  const { engine } = makeHarness({ settings: [] });
  const s = engine.getSettingsForSubsidiary('99');
  assert.equal(s, null);
});

test('M-4 deterministic on duplicate active settings: lowest id wins', () => {
  const { engine } = makeHarness({
    settings: [
      { id: '20', subsidiary: '2', approver1: '20-row', hmac_secret: 'B' },
      { id: '5',  subsidiary: '2', approver1: '5-row',  hmac_secret: 'A' },
      { id: '12', subsidiary: '2', approver1: '12-row', hmac_secret: 'C' }
    ]
  });
  const s = engine.getSettingsForSubsidiary('2');
  assert.equal(s.id, '5', 'lowest internal id wins on duplicate');
  assert.equal(s.default_approver1, '5-row');
  assert.equal(s.hmac_secret, 'A');
});

test('M-4 per-subsidiary HMAC secret is exposed', () => {
  const { engine } = makeHarness({
    settings: [{ id: '1', subsidiary: '3', hmac_secret: 'subsidiary-3-secret' }]
  });
  const s = engine.getSettingsForSubsidiary('3');
  assert.equal(s.hmac_secret, 'subsidiary-3-secret');
});

test('M-4 PO/VB enable flags are exposed', () => {
  const { engine } = makeHarness({
    settings: [{ id: '1', subsidiary: '4', enable_po: 'T', enable_vb: 'F' }]
  });
  const s = engine.getSettingsForSubsidiary('4');
  assert.equal(s.enable_po, 'T');
  assert.equal(s.enable_vb, 'F');
});

test('M-4 missing/empty optional fields default to empty string (not undefined)', () => {
  const { engine } = makeHarness({
    settings: [{ id: '1', subsidiary: '2' }]
  });
  const s = engine.getSettingsForSubsidiary('2');
  assert.ok(s);
  assert.equal(s.email_subject, '');
  assert.equal(s.email_intro, '');
  // Numeric defaults preserved as strings (NS getValue returns strings).
  assert.equal(s.token_expiry_days, '7');
});
