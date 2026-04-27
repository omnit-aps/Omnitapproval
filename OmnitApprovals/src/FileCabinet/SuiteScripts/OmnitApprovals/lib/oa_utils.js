/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/crypto', 'N/runtime', 'N/search', 'N/encode'], (crypto, runtime, search, encode) => {
  'use strict';

  // HMAC secret — must be set via setHmacSecret() at script startup.
  // No built-in fallback: token generation and verification fail closed
  // (return null) if the secret has not been configured via script parameter.
  let HMAC_SECRET = '';
  function setHmacSecret(s) { if (s) HMAC_SECRET = s; }

  // ─── HMAC token helpers ───────────────────────────────────────────────────────

  function _b64urlEncode(str) {
    return encode.convert({
      string:          str,
      inputEncoding:   encode.Encoding.UTF_8,
      outputEncoding:  encode.Encoding.BASE_64
    }).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function _b64urlDecode(b64url) {
    const base64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    // Re-add = padding so length is a multiple of 4 (stripped by _b64urlEncode)
    const pad     = base64.length % 4;
    const padded  = pad ? base64 + '='.repeat(4 - pad) : base64;
    return encode.convert({
      string:         padded,
      inputEncoding:  encode.Encoding.BASE_64,
      outputEncoding: encode.Encoding.UTF_8
    });
  }

  function _sign(data) {
    const h = crypto.createHash({ algorithm: crypto.HashAlg.SHA256 });
    h.update({ input: HMAC_SECRET + '|' + data });
    return h.digest({ outputEncoding: crypto.Encoding.HEX });
  }

  /**
   * Generate a stateless HMAC token. No storage needed.
   * Format: base64url(payload) + "." + sha256(SECRET|base64url(payload))
   */
  function generateHmacToken(recordType, recordId, step, approverId, expiryDays) {
    if (!HMAC_SECRET) { log.error('OA: HMAC secret not configured — token generation skipped'); return null; }
    const exp  = Date.now() + (expiryDays || 7) * 86400000;
    const body = _b64urlEncode(JSON.stringify({
      rt:  recordType,
      rid: String(recordId),
      s:   step,
      aid: String(approverId),
      exp
    }));
    return body + '.' + _sign(body);
  }

  /**
   * Verify a token and return its payload, or null if invalid/expired/unconfigured.
   */
  function verifyHmacToken(token) {
    if (!HMAC_SECRET) { log.error('OA: HMAC secret not configured — token verification rejected'); return null; }
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig  = token.slice(dot + 1);
    if (_sign(body) !== sig) return null;
    try {
      const p = JSON.parse(_b64urlDecode(body));
      if (Date.now() > p.exp) return null;
      return p;
    } catch (e) { return null; }
  }

  // ─── General helpers ──────────────────────────────────────────────────────────

  function getCurrentUserId() {
    return runtime.getCurrentUser().id;
  }

  function getTransactionSubsidiary(recordType, recordId) {
    const result = search.lookupFields({ type: recordType, id: recordId, columns: ['subsidiary'] });
    return result.subsidiary && result.subsidiary[0] ? result.subsidiary[0].value : null;
  }

  // Returns the transaction grand total in the SUBSIDIARY BASE CURRENCY.
  // Hierarchy thresholds are always defined in subsidiary base currency, so
  // foreign-currency POs/Vendor Bills must be converted before threshold matching.
  // Uses `total` (tax-inclusive grand total) consistent with the field read in beforeSubmit.
  function getTransactionAmount(recordType, recordId) {
    const result = search.lookupFields({ type: recordType, id: recordId, columns: ['total', 'exchangerate'] });
    const foreignTotal = parseFloat(result.total) || 0;
    const rate         = parseFloat(result.exchangerate) || 1;
    return foreignTotal * rate;
  }

  // Convert a foreign-currency amount read from a record (rec.getValue) to base
  // currency using the record's exchangerate field. Falls back to rate=1 when
  // unavailable (e.g. base-currency transactions).
  function toBaseCurrency(rec, foreignAmount) {
    const rate = parseFloat(rec.getValue('exchangerate')) || 1;
    return (parseFloat(foreignAmount) || 0) * rate;
  }

  function lookupEmployeeField(employeeId, fieldId) {
    if (!employeeId) return null;
    const result = search.lookupFields({ type: 'employee', id: employeeId, columns: [fieldId] });
    const val = result[fieldId];
    if (Array.isArray(val)) return val[0] ? val[0].value : null;
    return val !== undefined ? val : null;
  }

  // selectValue — extract scalar from search.lookupFields() select-field result (returns [{value,text}]).
  // Use whenever comparing approvalstatus, nextapprover, or any SELECT field from lookupFields.
  function selectValue(v) {
    return Array.isArray(v) && v[0] ? String(v[0].value) : String(v || '');
  }

  function today() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function formatCurrency(amount, symbol) {
    return (symbol || '') + ' ' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // parseBool — normalise checkbox values from search results.
  // search.Result.getValue() returns boolean true/false for CHECKBOX columns in most contexts,
  // but some NS builds return 'T'/'F' strings. Handle both to be safe.
  function parseBool(val) {
    if (typeof val === 'boolean') return val;
    return val === 'T' || val === 'true' || val === '1';
  }

  return {
    setHmacSecret,
    generateHmacToken,
    verifyHmacToken,
    getCurrentUserId,
    getTransactionSubsidiary,
    getTransactionAmount,
    toBaseCurrency,
    lookupEmployeeField,
    selectValue,
    parseBool,
    today,
    formatCurrency
  };
});
