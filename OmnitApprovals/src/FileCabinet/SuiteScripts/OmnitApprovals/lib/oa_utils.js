/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/crypto', 'N/runtime', 'N/search', 'N/encode'], (crypto, runtime, search, encode) => {
  'use strict';

  // Shared secret for stateless HMAC tokens — change per deployment
  const HMAC_SECRET = 'OA-OMNIT-2025-STATIC-SECRET-v1';

  // ─── HMAC token helpers ───────────────────────────────────────────────────────

  function _b64urlEncode(str) {
    return encode.convert({
      string:          str,
      inputEncoding:   encode.Encoding.UTF_8,
      outputEncoding:  encode.Encoding.BASE_64
    }).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function _b64urlDecode(b64url) {
    const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
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
   * Verify a token and return its payload, or null if invalid/expired.
   */
  function verifyHmacToken(token) {
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

  function getTransactionAmount(recordType, recordId) {
    const result = search.lookupFields({ type: recordType, id: recordId, columns: ['amount'] });
    return parseFloat(result.amount) || 0;
  }

  function lookupEmployeeField(employeeId, fieldId) {
    if (!employeeId) return null;
    const result = search.lookupFields({ type: 'employee', id: employeeId, columns: [fieldId] });
    const val = result[fieldId];
    if (Array.isArray(val)) return val[0] ? val[0].value : null;
    return val !== undefined ? val : null;
  }

  function today() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function formatCurrency(amount, symbol) {
    return (symbol || '') + ' ' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  return {
    generateHmacToken,
    verifyHmacToken,
    getCurrentUserId,
    getTransactionSubsidiary,
    getTransactionAmount,
    lookupEmployeeField,
    today,
    formatCurrency
  };
});
