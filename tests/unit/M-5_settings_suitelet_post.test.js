'use strict';

// M-5 — oa_sl_settings.js POST handler validations.
//
// The Settings Suitelet's POST handler is the writeback path for the
// matrix-based config UI. Server-side validation rejects:
//   1. Saving with PO/VB enabled but no default approver 1.
//   2. Saving with use_amount=T and a matrix row missing approver 1
//      (client also blocks; server guards programmatic POSTs).
//   3. Saving when another active settings row already exists for the
//      same subsidiary.
//
// All errors must render an HTML response containing the error message
// (the renderError helper is used). On success, savedId is computed and
// saveMatrixRows is invoked for each enabled record type.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const SL_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_sl_settings.js';

function makeHarness({ duplicateActiveSubsidiaryRow = false, isManager = true } = {}) {
  const writes        = [];
  const responses     = [];

  const search = {
    create: ({ type }) => {
      const rows = [];
      if (type === 'customrecord_oa_settings' && duplicateActiveSubsidiaryRow) {
        // Pretend there's already an active settings row with id=999 for the same subsidiary.
        rows.push({ id: '999', getValue: () => '' });
      }
      return {
        run: () => ({
          each: (cb) => { for (const r of rows) { if (cb(r) === false) break; } },
          getRange: () => rows
        })
      };
    },
    lookupFields: ({ columns }) => {
      const out = {};
      (columns || []).forEach((c) => {
        if (c === 'custentity_oa_is_manager')        out[c] = isManager ? 'T' : 'F';
        else if (c === 'custentity_oa_is_super_approver') out[c] = 'F';
        else if (c === 'custentity_oa_is_approver')  out[c] = 'T';
        else                                          out[c] = null;
      });
      return out;
    }
  };

  const recordMock = {
    load: () => ({ setValue: () => {}, save: () => 1 }),
    create: () => ({ setValue: () => {}, save: () => writes.push('save') || 42 }),
    submitFields: (a) => writes.push(['submitFields', a])
  };

  const urlMock = {
    resolveScript: () => '/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_settings&deploy=customdeploy_oa_sl_settings'
  };

  const sl = loadModule(SL_PATH, {
    'N/record':  recordMock,
    'N/runtime': makeRuntimeMock(),
    'N/search':  search,
    'N/url':     urlMock,
    'N/file':    { load: () => ({ url: '/foo.js' }) },
    'N/task':    { TaskType: { MAP_REDUCE: 'MAPREDUCE' }, create: () => ({ submit: () => '1' }) },
    'N/error':   { create: ({ name, message }) => { const e = new Error(message); e.name = name || 'Error'; return e; } },
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });

  function makeReq(parameters) {
    return { method: 'POST', parameters };
  }
  function makeResp() {
    let body = '';
    return {
      setHeader: () => {},
      write: (s) => { body += s; responses.push(s); },
      _body: () => body
    };
  }

  return { sl, search, makeReq, makeResp, writes, responses };
}

test('M-5 PO/VB enabled but missing default_approver1 -> error response', () => {
  const h = makeHarness();
  const req  = h.makeReq({
    oa_enable_vb:         'T',
    oa_enable_po:         'F',
    oa_default_approver1: '',
    oa_use_amount:        'F',
    oa_subsidiary:        '2'
  });
  const resp = h.makeResp();
  h.sl.onRequest({ request: req, response: resp });
  assert.match(resp._body(), /Default Approver 1 is required/i);
});

test('M-5 use_amount=T with matrix row missing approver 1 -> error response', () => {
  const h = makeHarness();
  const req  = h.makeReq({
    oa_enable_vb:         'T',
    oa_default_approver1: '101',
    oa_use_amount:        'T',
    oa_subsidiary:        '2',
    vb_row_count:         '1',
    vb_row_0_approver1:   '' // missing
  });
  const resp = h.makeResp();
  h.sl.onRequest({ request: req, response: resp });
  assert.match(resp._body(), /matrix row 1.*Approver 1 is required/i);
});

test('M-5 duplicate active subsidiary settings -> error response', () => {
  const h = makeHarness({ duplicateActiveSubsidiaryRow: true });
  const req  = h.makeReq({
    oa_enable_vb:         'T',
    oa_default_approver1: '101',
    oa_use_amount:        'F',
    oa_subsidiary:        '2',
    oa_settings_id:       'new' // creating new but one already exists
  });
  const resp = h.makeResp();
  h.sl.onRequest({ request: req, response: resp });
  assert.match(resp._body(), /already exists for this subsidiary/i);
});

test('M-5 valid POST proceeds to save (no error in response, save called)', () => {
  const h = makeHarness();
  const req  = h.makeReq({
    oa_enable_vb:         'T',
    oa_default_approver1: '101',
    oa_default_approver2: '',
    oa_approver_count:    '1',
    oa_use_amount:        'F',
    oa_subsidiary:        '2',
    oa_subsidiary_name:   'HQ',
    oa_settings_id:       'new',
    oa_email_enabled:     'F',
    oa_token_expiry_days: '7',
    oa_approve_string:    'Approve',
    oa_reject_string:     'Reject'
  });
  const resp = h.makeResp();
  h.sl.onRequest({ request: req, response: resp });
  // No error wording in body.
  assert.doesNotMatch(resp._body(), /required|already exists|Cannot save/i,
    'valid POST must not render an error');
  // record.create was triggered (save call recorded).
  assert.ok(h.writes.includes('save') || h.writes.length > 0,
    'should have written to the settings record');
});
