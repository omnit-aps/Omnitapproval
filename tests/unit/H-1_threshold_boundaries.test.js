'use strict';

// H-1 — threshold matching is half-open [min, max). Adjacent thresholds cover
// the number line exactly once. Boundaries 0, 0.01, 499.99, 500.00, 500.01,
// 4999.99, 5000.00, 5000.01 all hit exactly one rule.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { loadModule }            = require('../_amd');
const { makeRuntimeMock,
        TASK_MOCK }              = require('../_mocks');

const ENGINE_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js';

function loadEngine() {
  return loadModule(ENGINE_PATH, {
    'N/record':  { load: () => null, create: () => null },
    'N/runtime': makeRuntimeMock(),
    'N/search':  { create: () => ({ run: () => ({ each: () => {}, getRange: () => [] }) }), lookupFields: () => ({}) },
    'N/task':    TASK_MOCK,
    'N/error':   { create: ({ name, message }) => { const e = new Error(message); e.name = name || 'Error'; return e; } },
    'N/crypto':  { createHash: () => ({ update: () => {}, digest: () => '' }), HashAlg: { SHA256: 'SHA256' }, Encoding: { HEX: 'HEX' } },
    'N/encode':  { Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' }, convert: ({ string }) => string }
  });
}

const engine = loadEngine();

// Three contiguous rules: 0–500, 500–5000, 5000–Infinity. Half-open semantics
// means 500.00 belongs to row B (not A), 5000.00 belongs to row C (not B).
const THRESHOLDS = [
  { id: 'A', minAmount:    0, maxAmount:  500,      sortOrder: 1, approver: 'low'  },
  { id: 'B', minAmount:  500, maxAmount: 5000,      sortOrder: 2, approver: 'mid'  },
  { id: 'C', minAmount: 5000, maxAmount: Infinity,  sortOrder: 3, approver: 'high' }
];

const cases = [
  { amount:    0.00, expected: ['A'],      label: '0.00 -> low' },
  { amount:    0.01, expected: ['A'],      label: '0.01 -> low' },
  { amount:  499.98, expected: ['A'],      label: '499.98 -> low' },
  { amount:  499.99, expected: ['A'],      label: '499.99 -> low' },
  { amount:  500.00, expected: ['B'],      label: '500.00 -> mid (boundary belongs upward)' },
  { amount:  500.01, expected: ['B'],      label: '500.01 -> mid' },
  { amount: 4999.99, expected: ['B'],      label: '4999.99 -> mid' },
  { amount: 5000.00, expected: ['C'],      label: '5000.00 -> high (boundary belongs upward)' },
  { amount: 5000.01, expected: ['C'],      label: '5000.01 -> high' }
];

for (const c of cases) {
  test(`H-1 boundary: ${c.label}`, () => {
    const matches = engine.matchThresholds(THRESHOLDS, c.amount).map(t => t.id);
    assert.deepEqual(matches, c.expected,
      `amount=${c.amount} matched ${JSON.stringify(matches)}, expected ${JSON.stringify(c.expected)}`);
  });
}

test('H-1: every test amount matches exactly one rule (no gaps, no overlaps)', () => {
  for (const c of cases) {
    const matches = engine.matchThresholds(THRESHOLDS, c.amount);
    assert.equal(matches.length, 1, `amount=${c.amount} matched ${matches.length} rules`);
  }
});
