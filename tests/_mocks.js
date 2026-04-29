'use strict';

// Reusable SuiteScript module mocks for unit tests.

function makeRuntimeMock(overrides) {
  return Object.assign({
    executionContext: 'USERINTERFACE',
    ContextType: {
      USER_INTERFACE:    'USERINTERFACE',
      WEBSERVICES:       'WEBSERVICES',
      RESTLET:           'RESTLET',
      RESTWEBSERVICES:   'RESTWEBSERVICES',
      CSV_IMPORT:        'CSVIMPORT',
      SCHEDULED:         'SCHEDULED',
      USEREVENT:         'USEREVENT',
      SUITELET:          'SUITELET',
      MAP_REDUCE:        'MAPREDUCE',
      WORKFLOW:          'WORKFLOW',
      BUNDLE_INSTALLATION: 'BUNDLEINSTALLATION'
    },
    getCurrentUser: () => ({ id: 1, role: 3 })
  }, overrides || {});
}

function makeSearchMock(programmedResults) {
  // programmedResults is a map keyed by recordType returning an array of "rows"
  // where each row exposes getValue(fieldId).
  return {
    create: ({ type }) => {
      const rows = (programmedResults && programmedResults[type]) || [];
      return {
        run: () => ({
          each: (cb) => {
            for (const row of rows) {
              const cont = cb(row);
              if (cont === false) break;
            }
          },
          getRange: ({ start, end }) => rows.slice(start || 0, end || rows.length)
        })
      };
    },
    lookupFields: ({ columns }) => {
      const out = {};
      (columns || []).forEach(c => { out[c] = ''; });
      return out;
    }
  };
}

function makeRecordMock() {
  return {
    load:   () => makeRecordInstance({}),
    create: () => makeRecordInstance({})
  };
}

function makeRecordInstance(initial) {
  const data = Object.assign({}, initial || {});
  // NS getValue/setValue accept either ({fieldId, value}) or a plain string fieldId.
  const fieldOf = (arg) => (typeof arg === 'string' ? arg : arg && arg.fieldId);
  return {
    type: initial && initial.type,
    id:   initial && initial.id,
    getValue: (arg) => data[fieldOf(arg)],
    setValue: (arg, val) => {
      const fid = fieldOf(arg);
      const v   = (typeof arg === 'string') ? val : arg.value;
      data[fid] = v;
    },
    save: () => data.id || 1,
    _data: data
  };
}

const TASK_MOCK = {
  TaskType: { MAP_REDUCE: 'MAPREDUCE' },
  create:   () => ({ submit: () => 'task-1' })
};

const URL_MOCK = {
  resolveScript: () => '/app/site/url'
};

const SERVERWIDGET_MOCK = {
  FieldType:        { TEXT: 'TEXT' },
  FieldDisplayType: { INLINE: 'INLINE', NORMAL: 'NORMAL' }
};

const CRYPTO_MOCK = {
  HashAlg:  { SHA256: 'SHA256' },
  Encoding: { HEX: 'HEX' },
  createHash: () => {
    const buf = [];
    return {
      update: ({ input }) => buf.push(String(input)),
      digest: () => require('crypto').createHash('sha256').update(buf.join('')).digest('hex')
    };
  }
};

const ERROR_MOCK = {
  create: ({ name, message }) => {
    const e = new Error(message);
    e.name = name || 'Error';
    return e;
  }
};

const ENCODE_MOCK = {
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

module.exports = {
  makeRuntimeMock,
  makeSearchMock,
  makeRecordMock,
  makeRecordInstance,
  TASK_MOCK,
  URL_MOCK,
  SERVERWIDGET_MOCK,
  CRYPTO_MOCK,
  ENCODE_MOCK,
  ERROR_MOCK
};
