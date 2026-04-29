'use strict';

// Minimal AMD shim for SuiteScript 2.1 modules. Each test file:
//   const { loadModule } = require('../_amd');
//   const engine = loadModule('OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_engine.js', mocks);
// where `mocks` is a map of dependency-id -> mock object. Relative deps
// ('./lib/oa_constants') are resolved against the loaded file's directory.

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function loadModule(relPath, mocks) {
  const absPath = path.resolve(REPO_ROOT, relPath);
  const dir     = path.dirname(absPath);
  const src     = fs.readFileSync(absPath, 'utf8');

  let captured = null;

  const define = (deps, factory) => {
    const resolved = deps.map(dep => {
      if (mocks && Object.prototype.hasOwnProperty.call(mocks, dep)) return mocks[dep];
      if (dep.startsWith('./') || dep.startsWith('../')) {
        // Recursively load the relative module with the same mock dictionary.
        const childAbs = path.resolve(dir, dep + (dep.endsWith('.js') ? '' : '.js'));
        const childRel = path.relative(REPO_ROOT, childAbs);
        return loadModule(childRel, mocks);
      }
      throw new Error(`AMD shim: no mock provided for dependency '${dep}'`);
    });
    captured = factory.apply(null, resolved);
  };

  // Provide a minimal `log` since SuiteScripts call log.audit/log.error at top
  // and inside functions — the production global is N's `log` namespace.
  const log = {
    audit: () => {},
    error: () => {},
    debug: () => {},
    emergency: () => {}
  };

  // eslint-disable-next-line no-new-func
  const fn = new Function('define', 'log', src);
  fn(define, log);

  return captured;
}

module.exports = { loadModule, REPO_ROOT };
