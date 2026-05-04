'use strict';

// H-8 — verifyHmacToken in lib/oa_utils.js must reject every form of
// invalid/expired/tampered/unsecreted token. The whole "approve via email
// without logging in" flow rests on this — if verifyHmacToken returns a
// non-null payload for a tampered or expired token, anybody who has ever
// received an OA email can replay or rewrite an approval.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

const { loadModule } = require('../_amd');
const { makeRuntimeMock } = require('../_mocks');

const UTILS_PATH = 'OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/lib/oa_utils.js';

// Mocks that mimic the real N/crypto SHA256/HEX + N/encode UTF8<->BASE64
// the lib uses. Shared across tests so generation and verification agree.
const cryptoMock = {
  HashAlg:  { SHA256: 'SHA256' },
  Encoding: { HEX: 'HEX' },
  createHash: () => {
    const h = nodeCrypto.createHash('sha256');
    return {
      update: ({ input }) => h.update(String(input)),
      digest: () => h.digest('hex')
    };
  }
};
const encodeMock = {
  Encoding: { UTF_8: 'UTF_8', BASE_64: 'BASE_64' },
  convert: ({ string, inputEncoding, outputEncoding }) => {
    if (inputEncoding === 'UTF_8' && outputEncoding === 'BASE_64') {
      return Buffer.from(string, 'utf8').toString('base64');
    }
    if (inputEncoding === 'BASE_64' && outputEncoding === 'UTF_8') {
      return Buffer.from(string, 'base64').toString('utf8');
    }
    throw new Error('encode mock: unsupported pair');
  }
};

function buildUtils() {
  return loadModule(UTILS_PATH, {
    'N/crypto':  cryptoMock,
    'N/runtime': makeRuntimeMock(),
    'N/search':  { lookupFields: () => ({}) },
    'N/encode':  encodeMock
  });
}

test('H-8: valid token verifies and returns the payload', () => {
  const utils = buildUtils();
  utils.setHmacSecret('shared-secret-A');
  const tok = utils.generateHmacToken('vendorbill', 999, 1, 100, 7);
  assert.ok(tok, 'generate must return a token when secret is set');
  const p = utils.verifyHmacToken(tok);
  assert.ok(p, 'verify must return a payload object');
  assert.equal(p.rt,  'vendorbill');
  assert.equal(p.rid, '999');
  assert.equal(p.s,    1);
  assert.equal(p.aid, '100');
  assert.ok(p.exp > Date.now(), 'exp should be in the future');
});

test('H-8: expired token (exp in past) returns null', () => {
  const utils = buildUtils();
  utils.setHmacSecret('shared-secret-A');
  // expiryDays = -1 -> exp ~ 1 day in the past
  const tok = utils.generateHmacToken('vendorbill', 1, 1, 100, -1);
  assert.equal(utils.verifyHmacToken(tok), null);
});

test('H-8: tampered body (re-encoded with different rid) returns null', () => {
  const utils = buildUtils();
  utils.setHmacSecret('shared-secret-A');
  const tok = utils.generateHmacToken('vendorbill', 999, 1, 100, 7);
  const dot = tok.lastIndexOf('.');
  const body = tok.slice(0, dot);
  const sig  = tok.slice(dot + 1);

  // Decode + mutate + re-encode with the SAME signature so only the body changed.
  const padded = body + '='.repeat((4 - body.length % 4) % 4);
  const json   = JSON.parse(Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  json.rid = '777';
  const newBody = Buffer.from(JSON.stringify(json), 'utf8').toString('base64')
                    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tampered = newBody + '.' + sig;

  assert.equal(utils.verifyHmacToken(tampered), null);
});

test('H-8: tampered signature returns null', () => {
  const utils = buildUtils();
  utils.setHmacSecret('shared-secret-A');
  const tok  = utils.generateHmacToken('vendorbill', 999, 1, 100, 7);
  const dot  = tok.lastIndexOf('.');
  // flip one hex char of the signature
  const sig  = tok.slice(dot + 1);
  const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  const tampered = tok.slice(0, dot + 1) + flipped;
  assert.equal(utils.verifyHmacToken(tampered), null);
});

test('H-8: token signed with secret A does not verify under secret B', () => {
  // Generate under secret A
  const utilsA = buildUtils();
  utilsA.setHmacSecret('shared-secret-A');
  const tok = utilsA.generateHmacToken('vendorbill', 999, 1, 100, 7);

  // Re-load utils with a different secret (simulates a different subsidiary)
  const utilsB = buildUtils();
  utilsB.setHmacSecret('different-secret-B');
  assert.equal(utilsB.verifyHmacToken(tok), null);
});

test('H-8: missing/blank secret causes verify to return null', () => {
  // Generate with a real secret so we have a structurally valid token.
  const utilsGen = buildUtils();
  utilsGen.setHmacSecret('shared-secret-A');
  const tok = utilsGen.generateHmacToken('vendorbill', 999, 1, 100, 7);

  // Fresh module instance, no setHmacSecret call -> HMAC_SECRET=''
  const utilsFresh = buildUtils();
  assert.equal(utilsFresh.verifyHmacToken(tok), null,
    'verify must fail closed when secret was never configured');

  // Same: generate must also refuse
  assert.equal(utilsFresh.generateHmacToken('vendorbill', 1, 1, 100, 7), null);
});

test('H-8: malformed token (no dot separator) returns null', () => {
  const utils = buildUtils();
  utils.setHmacSecret('shared-secret-A');
  assert.equal(utils.verifyHmacToken('not-a-valid-token'), null);
  assert.equal(utils.verifyHmacToken(''), null);
  assert.equal(utils.verifyHmacToken(null), null);
});
