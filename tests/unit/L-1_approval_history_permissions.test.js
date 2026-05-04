'use strict';

// L-1 — oa_sl_approval_history.js _canViewHistory access guard.
//
// History view is gated to:
//   1. managers (custentity_oa_is_manager = T) — always allowed.
//   2. the CURRENT next_approver on the record.
//   3. anyone who has appeared as an `actor` in the audit log for this record
//      (submitter, prior approver, prior delegator).
// Anyone else gets the "You do not have permission" error page.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const SL_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_sl_approval_history.js';

function makeHarness({ userId, isManager = false, nextApproverOnTxn = null, pastActors = [] } = {}) {
  const search = {
    create: ({ type, filters }) => {
      // _canViewHistory's "was-actor" search looks at log records and filters
      // by the current user id. If the user is in pastActors, return one row.
      const filterStr = JSON.stringify(filters || []);
      const userIdMatch = filterStr.match(/\[(\d+)\]/);
      const queriedUser = userIdMatch ? userIdMatch[1] : null;
      const matched = (type === 'customrecord_oa_log') && pastActors.map(String).includes(String(queriedUser));
      const rows = matched ? [{ id: '1', getValue: () => '' }] : [];
      return {
        run: () => ({
          getRange: () => rows,
          each: (cb) => { for (const r of rows) { if (cb(r) === false) break; } }
        })
      };
    },
    lookupFields: ({ type, id, columns }) => {
      const out = {};
      (columns || []).forEach((c) => {
        if (c === 'custentity_oa_is_manager')          out[c] = isManager ? 'T' : 'F';
        else if (c === 'custbody_oa_next_approver')    out[c] = nextApproverOnTxn ? [{ value: String(nextApproverOnTxn), text: 'NextApp' }] : null;
        else if (c === 'tranid')                       out[c] = 'VB-1';
        else if (c === 'approvalstatus')               out[c] = '1';
        else if (c === 'amount')                       out[c] = '1000';
        else if (c === 'currency')                     out[c] = [{ value: '1', text: 'USD' }];
        else if (c === 'subsidiary')                   out[c] = [{ value: '2', text: 'HQ' }];
        else                                           out[c] = null;
      });
      return out;
    }
  };

  const runtimeMock = makeRuntimeMock();
  runtimeMock.getCurrentUser = () => ({ id: userId, role: 3, email: 'u@example.com' });

  const sl = loadModule(SL_PATH, {
    'N/runtime': runtimeMock,
    'N/search':  search,
    'N/url':     { resolveScript: () => '/' },
    'N/error':   { create: ({ name, message }) => { const e = new Error(message); e.name = name || 'Error'; return e; } },
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });

  return { sl };
}

function buildContext({ recordId = '94319', recordType = 'vendorbill' } = {}) {
  const responses = [];
  return {
    request: { parameters: { oa_record_id: recordId, oa_record_type: recordType } },
    response: {
      setHeader: () => {},
      write: (s) => responses.push(s),
      _body: () => responses.join('')
    },
    _responses: responses
  };
}

test('L-1 manager: allowed (no further checks needed)', () => {
  const h = makeHarness({ userId: 100, isManager: true });
  const ctx = buildContext();
  h.sl.onRequest(ctx);
  assert.doesNotMatch(ctx.response._body(), /do not have permission/i,
    'manager must see history page');
});

test('L-1 current next_approver: allowed', () => {
  const h = makeHarness({ userId: 200, isManager: false, nextApproverOnTxn: 200 });
  const ctx = buildContext();
  h.sl.onRequest(ctx);
  assert.doesNotMatch(ctx.response._body(), /do not have permission/i,
    'current next_approver must see history');
});

test('L-1 past actor in log: allowed', () => {
  const h = makeHarness({ userId: 300, isManager: false, nextApproverOnTxn: null, pastActors: [300] });
  const ctx = buildContext();
  h.sl.onRequest(ctx);
  assert.doesNotMatch(ctx.response._body(), /do not have permission/i,
    'employee who acted on this record in the past must see history');
});

test('L-1 unrelated employee: denied', () => {
  const h = makeHarness({ userId: 999, isManager: false, nextApproverOnTxn: 200, pastActors: [100, 300] });
  const ctx = buildContext();
  h.sl.onRequest(ctx);
  assert.match(ctx.response._body(), /do not have permission/i,
    'unrelated employee must be denied');
});

test('L-1 missing recordId/recordType params: error response', () => {
  const h = makeHarness({ userId: 999 });
  const ctx = {
    request: { parameters: {} },
    response: {
      setHeader: () => {},
      write: (s) => { ctx.response._body = (ctx.response._body || '') + s; }
    }
  };
  h.sl.onRequest(ctx);
  assert.match(ctx.response._body, /Missing parameters/i);
});
