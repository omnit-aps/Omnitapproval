'use strict';

// M-7 — UAT-068. oa_ue_settings.js beforeSubmit guard refuses to change
// the subsidiary on an active settings record while pending OA-routed
// transactions still reference the old subsidiary. Admins must inactivate
// the record and create a new one instead.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const UE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_ue_settings.js';

function makeRecMock(values) {
  return {
    id: values.__id || null,
    getValue: (f) => (typeof f === 'string' ? values[f] : values[f.fieldId]),
  };
}

function makeHarness({ pendingForOldSub = 0 } = {}) {
  const submitFieldsCalls = [];
  const search = {
    create: ({ type, filters }) => {
      // Two callers: settings duplicate dedupe, and the new in-flight check.
      // Distinguish by `type`.
      const rows = [];
      if (type === 'transaction') {
        for (let i = 0; i < pendingForOldSub; i++) rows.push({ id: i + 1, getValue: () => '' });
      }
      return {
        run: () => ({
          each: (cb) => { for (const r of rows) { if (cb(r) === false) break; } },
          getRange: () => rows
        })
      };
    },
    lookupFields: () => ({})
  };
  const recordMock = {
    submitFields: (a) => submitFieldsCalls.push(a),
    load: () => ({}),
    create: () => ({ setValue: () => {}, save: () => 1 })
  };
  const errorMock = {
    create: ({ name, message }) => { const e = new Error(message); e.name = name || 'Error'; return e; }
  };
  const ue = loadModule(UE_PATH, {
    'N/record':  recordMock,
    'N/runtime': makeRuntimeMock(),
    'N/search':  search,
    'N/error':   errorMock,
  });
  return { ue, submitFieldsCalls };
}

const TRIGGER = { CREATE: 'create', EDIT: 'edit' };

test('M-7: subsidiary change with NO pending transactions -> allowed', () => {
  const h = makeHarness({ pendingForOldSub: 0 });
  const newRec = makeRecMock({ __id: '5', custrecord_oa_subsidiary: '7', isinactive: false });
  const oldRec = makeRecMock({ __id: '5', custrecord_oa_subsidiary: '2', isinactive: false });
  // Should not throw — no in-flight blocks the change.
  h.ue.beforeSubmit({
    type: TRIGGER.EDIT,
    UserEventType: TRIGGER,
    newRecord: newRec,
    oldRecord: oldRec,
  });
});

test('M-7: subsidiary change WITH pending transactions -> throws', () => {
  const h = makeHarness({ pendingForOldSub: 3 });
  const newRec = makeRecMock({ __id: '5', custrecord_oa_subsidiary: '7', isinactive: false });
  const oldRec = makeRecMock({ __id: '5', custrecord_oa_subsidiary: '2', isinactive: false });
  assert.throws(() => {
    h.ue.beforeSubmit({
      type: TRIGGER.EDIT, UserEventType: TRIGGER,
      newRecord: newRec, oldRecord: oldRec,
    });
  }, (e) => {
    assert.equal(e.name, 'OA_SETTINGS_SUBSIDIARY_CHANGE_BLOCKED');
    assert.match(e.message, /3 pending/);
    return true;
  });
});

test('M-7: subsidiary unchanged on EDIT -> allowed (no guard fired)', () => {
  const h = makeHarness({ pendingForOldSub: 99 });  // even with pending, no change = no block
  const newRec = makeRecMock({ __id: '5', custrecord_oa_subsidiary: '2', isinactive: false });
  const oldRec = makeRecMock({ __id: '5', custrecord_oa_subsidiary: '2', isinactive: false });
  h.ue.beforeSubmit({
    type: TRIGGER.EDIT, UserEventType: TRIGGER,
    newRecord: newRec, oldRecord: oldRec,
  });
});

test('M-7: CREATE never triggers the subsidiary-change guard', () => {
  const h = makeHarness({ pendingForOldSub: 99 });
  const newRec = makeRecMock({ custrecord_oa_subsidiary: '7', isinactive: false });
  h.ue.beforeSubmit({
    type: TRIGGER.CREATE, UserEventType: TRIGGER,
    newRecord: newRec,
    oldRecord: null,  // CREATE has no oldRecord
  });
});

test('M-7: making the record inactive bypasses the guard', () => {
  const h = makeHarness({ pendingForOldSub: 99 });
  const newRec = makeRecMock({ __id: '5', custrecord_oa_subsidiary: '7', isinactive: true });
  const oldRec = makeRecMock({ __id: '5', custrecord_oa_subsidiary: '2', isinactive: false });
  // Early-return on isinactive avoids the subsidiary check entirely.
  h.ue.beforeSubmit({
    type: TRIGGER.EDIT, UserEventType: TRIGGER,
    newRecord: newRec, oldRecord: oldRec,
  });
});
