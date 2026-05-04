'use strict';

// MR-1 — oa_mr_notifications.js reduce stage.
//
// Sweep mode (isSweep=true) is audit-only — must NOT send email even if
// the record is pending and routed; only the afterSubmit-triggered MR run
// sends notifications, to prevent re-notification spam on retry sweeps.
//
// Triggered mode (isSweep=false): builds an HMAC-signed link, calls
// email.send with relatedRecords.transactionId and the body containing
// approve+decline URLs. Subject falls back to '#<recordId>' when tranid
// is empty (post-fix introduced 2026-05-02 in commit 3ffc524 + the
// hardening in eac4ea1).

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const MR_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_mr_notifications.js';

function makeHarness({ tranid = 'VB-12345', approverEmail = 'jonas@test.com', subsidiaryName = 'HQ', useEmail = 'T' } = {}) {
  const emailSendCalls = [];
  const auditCalls     = [];

  // Settings stub — used by oa_engine.getSettingsForSubsidiary, but the MR
  // script reaches into the engine for that.
  const settingsRow = {
    id: '1',
    getValue: (col) => {
      const map = {
        custrecord_oa_subsidiary:           '2',
        custrecord_oa_email_enabled:        'T',
        custrecord_oa_hmac_secret:          'subsidiary-secret-A',
        custrecord_oa_email_sender:         '101',
        custrecord_oa_email_subject:        'Approval required — {docNumber}',
        custrecord_oa_email_intro:          'Please review.',
        custrecord_oa_token_expiry_days:    '7',
        custrecord_oa_approver_count:       '1',
        custrecord_oa_default_approver1:    '500',
      };
      return map[col] != null ? map[col] : '';
    }
  };

  const search = {
    create: ({ type }) => {
      const rows = (type === 'customrecord_oa_settings') ? [settingsRow] : [];
      return { run: () => ({ each: (cb) => { for (const r of rows) cb(r); } }) };
    },
    lookupFields: ({ type, columns }) => {
      const out = {};
      (columns || []).forEach((c) => {
        if (c === 'approvalstatus')                 out[c] = '1'; // PENDING
        else if (c === 'tranid')                    out[c] = tranid;
        else if (c === 'subsidiary')                out[c] = [{ value: '2', text: subsidiaryName }];
        else if (c === 'currency')                  out[c] = [{ value: '1', text: 'USD' }];
        else if (c === 'amount')                    out[c] = '1000';
        else if (c === 'custbody_oa_next_approver') out[c] = [{ value: '500', text: 'Jonas Test' }];
        else if (c === 'firstname')                 out[c] = 'Jonas';
        else if (c === 'lastname')                  out[c] = 'Test';
        else if (c === 'email')                     out[c] = approverEmail;
        else if (c === 'custentity_oa_use_email')   out[c] = useEmail;
        else                                        out[c] = null;
      });
      return out;
    }
  };

  const emailMock = {
    send: (params) => { emailSendCalls.push(params); }
  };

  const renderMock = {
    PrintMode: { PDF: 'PDF' },
    transaction: () => null // no PDF
  };

  const runtimeMock = makeRuntimeMock();
  // Override getCurrentScript to expose the MR's script-param helpers.
  runtimeMock.getCurrentScript = () => ({
    getParameter: () => ''  // No PARAM_RECORD_ID / PARAM_RECORD_TYPE / PARAM_HMAC_SECRET
  });

  const urlMock = {
    resolveScript: ({ scriptId, deploymentId, returnExternalUrl, params }) => {
      const qs = params ? '&' + Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
      const host = returnExternalUrl ? 'https://td3075893.extforms.netsuite.com' : 'https://td3075893.app.netsuite.com';
      return `${host}/app/site/hosting/scriptlet.nl?script=${scriptId}&deploy=${deploymentId}${qs}`;
    }
  };

  // Engine reaches into a few helpers used by mr; load the real engine through the loader so its
  // getSettingsForSubsidiary lookup behaves naturally against our search mock.
  const mr = loadModule(MR_PATH, {
    'N/email':   emailMock,
    'N/record':  { load: () => ({}), submitFields: () => null, create: () => ({ setValue: () => {}, save: () => 1 }) },
    'N/render':  renderMock,
    'N/runtime': runtimeMock,
    'N/search':  search,
    'N/url':     urlMock,
    'N/log':     { audit: (...a) => auditCalls.push(['audit', ...a]), error: (...a) => auditCalls.push(['error', ...a]) },
    'N/task':    { TaskType: { MAP_REDUCE: 'MAPREDUCE' }, create: () => ({ submit: () => '1' }) },
    'N/error':   { create: ({ name, message }) => { const e = new Error(message); e.name = name || 'Error'; return e; } },
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => 'abc' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });

  return { mr, emailSendCalls, auditCalls };
}

test('MR-1 sweep mode (isSweep=true): email.send NOT called, audit log only', () => {
  const h = makeHarness();
  const reduceContext = {
    values: [JSON.stringify({ recordId: '94319', recordType: 'vendorbill', isSweep: true })]
  };
  h.mr.reduce(reduceContext);
  assert.equal(h.emailSendCalls.length, 0, 'sweep mode must NOT send email');
});

test('MR-1 triggered mode: email.send called with relatedRecords.transactionId', () => {
  const h = makeHarness({ tranid: 'VB-12345' });
  const reduceContext = {
    values: [JSON.stringify({ recordId: '94319', recordType: 'vendorbill', isSweep: false })]
  };
  h.mr.reduce(reduceContext);
  assert.equal(h.emailSendCalls.length, 1, 'triggered mode must send exactly one email');
  const call = h.emailSendCalls[0];
  assert.ok(call.relatedRecords && call.relatedRecords.transactionId === 94319,
    `relatedRecords.transactionId should be 94319 (got ${JSON.stringify(call.relatedRecords)})`);
  assert.deepEqual(call.recipients, ['jonas@test.com']);
  assert.match(call.subject, /Approval required.*VB-12345/);
});

test('MR-1 subject falls back to #<recordId> when tranid is empty', () => {
  const h = makeHarness({ tranid: '' });
  const reduceContext = {
    values: [JSON.stringify({ recordId: '94319', recordType: 'vendorbill', isSweep: false })]
  };
  h.mr.reduce(reduceContext);
  assert.equal(h.emailSendCalls.length, 1);
  assert.match(h.emailSendCalls[0].subject, /Approval required.*#94319/,
    'empty tranid must fall back to #<recordId> (the eac4ea1 hardening)');
});

test('MR-1 approver with use_email=F is skipped (no email)', () => {
  const h = makeHarness({ useEmail: 'F' });
  const reduceContext = {
    values: [JSON.stringify({ recordId: '94319', recordType: 'vendorbill', isSweep: false })]
  };
  h.mr.reduce(reduceContext);
  assert.equal(h.emailSendCalls.length, 0, 'approver without use_email opt-in must not get email');
});
