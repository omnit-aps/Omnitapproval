/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/crypto', 'N/runtime', 'N/search'], (crypto, runtime, search) => {
  'use strict';

  function generateToken() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function hashToken(token) {
    const hasher = crypto.createHash({ algorithm: crypto.HashAlg.SHA256 });
    hasher.update({ input: token });
    return hasher.digest({ outputEncoding: crypto.Encoding.HEX });
  }

  function isTokenExpired(tokenCreated, expiryDays) {
    if (!tokenCreated) return true;
    const expiry = new Date(new Date(tokenCreated).getTime() + (expiryDays || 7) * 86400000);
    return new Date() > expiry;
  }

  function getCurrentUserId() {
    return runtime.getCurrentUser().id;
  }

  function getTransactionSubsidiary(recordType, recordId) {
    const result = search.lookupFields({ type: recordType, id: recordId, columns: ['subsidiary'] });
    return result.subsidiary && result.subsidiary[0] ? result.subsidiary[0].value : null;
  }

  function getTransactionAmount(recordType, recordId) {
    // basetotalamount = total in subsidiary base currency; falls back to amount for single-currency accounts
    const result = search.lookupFields({ type: recordType, id: recordId, columns: ['amount', 'basetotalamount'] });
    const base   = parseFloat(result.basetotalamount);
    return (!isNaN(base) && base > 0) ? base : (parseFloat(result.amount) || 0);
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
    generateToken,
    hashToken,
    isTokenExpired,
    getCurrentUserId,
    getTransactionSubsidiary,
    getTransactionAmount,
    lookupEmployeeField,
    today,
    formatCurrency
  };
});
