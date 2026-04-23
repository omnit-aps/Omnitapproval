/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define([
  'N/record',
  'N/runtime',
  'N/search',
  'N/https',
  './lib/oa_constants',
  './lib/oa_utils',
  './lib/oa_email_template',
  './oa_engine'
], (record, runtime, search, https, C, utils, tpl, engine) => {
  'use strict';

  function onRequest(context) {
    const req  = context.request;
    const resp = context.response;

    if (req.method === 'GET') return handleGet(req, resp);
    if (req.method === 'POST') return handlePost(req, resp);
  }

  // ─── GET: email link clicks ───────────────────────────────────────────────────

  function handleGet(req, resp) {
    const token      = req.parameters.oa_token;
    const action     = req.parameters.oa_action;
    const recordType = req.parameters.oa_record_type;
    const recordId   = req.parameters.oa_record_id;

    if (!token || !action || !recordType || !recordId) {
      resp.write(_errorPage('Invalid request. Please use the link from your approval email.'));
      return;
    }

    const fields = search.lookupFields({
      type:    recordType,
      id:      recordId,
      columns: [
        C.FIELDS.TRANSACTION.APPROVAL_TOKEN,
        C.FIELDS.TRANSACTION.TOKEN_CREATED,
        C.FIELDS.TRANSACTION.CURRENT_STEP,
        'approvalstatus',
        'tranid',
        'subsidiary',
        'amount',
        'currency'
      ]
    });

    const storedHash = fields[C.FIELDS.TRANSACTION.APPROVAL_TOKEN];
    if (!storedHash || utils.hashToken(token) !== storedHash) {
      resp.write(_errorPage('Invalid or already used token. This link cannot be used again.'));
      return;
    }

    const settings   = _loadSettings(fields['subsidiary'] && fields['subsidiary'][0] && fields['subsidiary'][0].value);
    const expiryDays = (settings && settings.token_expiry_days) ? parseInt(settings.token_expiry_days, 10) : 7;

    if (utils.isTokenExpired(fields[C.FIELDS.TRANSACTION.TOKEN_CREATED], expiryDays)) {
      resp.write(_errorPage('This link has expired. Please log in to NetSuite to process the transaction.'));
      return;
    }

    if (fields['approvalstatus'] !== C.APPROVAL_STATUS.PENDING) {
      resp.write(_errorPage('This transaction has already been processed.'));
      return;
    }

    const step = parseInt(fields[C.FIELDS.TRANSACTION.CURRENT_STEP], 10) || 1;

    if (action === 'approve') {
      const approverField  = step === 1 ? C.FIELDS.TRANSACTION.APPROVER1 : C.FIELDS.TRANSACTION.APPROVER2;
      const approverArr    = search.lookupFields({ type: recordType, id: recordId, columns: [approverField] })[approverField];
      const actorId        = Array.isArray(approverArr) && approverArr[0] ? approverArr[0].value : null;
      engine.processApproval(recordId, recordType, actorId, step, C.LOG_SOURCES.EMAIL);
      resp.write(tpl.buildConfirmationPage('approve'));
      return;
    }

    if (action === 'decline') {
      const actionUrl      = _selfUrl(req);
      const currencyVal    = fields['currency'] && fields['currency'][0] ? fields['currency'][0].text : '';
      resp.write(tpl.buildDeclineCommentPage({
        documentNumber: fields['tranid'],
        subsidiaryName: fields['subsidiary'] && fields['subsidiary'][0] ? fields['subsidiary'][0].text : '',
        currency:       currencyVal,
        amount:         parseFloat(fields['amount']) || 0,
        recordType,
        recordId,
        token,
        actionUrl
      }));
    }
  }

  // ─── POST: UI button actions + decline form submit ────────────────────────────

  function handlePost(req, resp) {
    const action     = req.parameters.oa_action;
    const recordId   = req.parameters.oa_record_id;
    const recordType = req.parameters.oa_record_type;

    // Email decline form submit (token-based, no login required)
    if (action === 'decline' && req.parameters.oa_token) {
      const token   = req.parameters.oa_token;
      const comment = req.parameters.oa_comment;
      if (!comment || !comment.trim()) {
        resp.write(_errorPage('A reason for rejection is required.'));
        return;
      }

      const fields = search.lookupFields({
        type:    recordType,
        id:      recordId,
        columns: [C.FIELDS.TRANSACTION.APPROVAL_TOKEN, C.FIELDS.TRANSACTION.TOKEN_CREATED, C.FIELDS.TRANSACTION.CURRENT_STEP]
      });
      if (utils.hashToken(token) !== fields[C.FIELDS.TRANSACTION.APPROVAL_TOKEN]) {
        resp.write(_errorPage('Invalid token.'));
        return;
      }

      const step          = parseInt(fields[C.FIELDS.TRANSACTION.CURRENT_STEP], 10) || 1;
      const approverField = step === 1 ? C.FIELDS.TRANSACTION.APPROVER1 : C.FIELDS.TRANSACTION.APPROVER2;
      const approverArr   = search.lookupFields({ type: recordType, id: recordId, columns: [approverField] })[approverField];
      const actorId       = Array.isArray(approverArr) && approverArr[0] ? approverArr[0].value : null;
      engine.processDecline(recordId, recordType, actorId, comment, C.LOG_SOURCES.EMAIL);
      resp.write(tpl.buildConfirmationPage('decline'));
      return;
    }

    // UI-triggered actions (require login)
    const userId = runtime.getCurrentUser().id;
    const step   = parseInt(req.parameters.oa_step, 10) || 1;
    let result;

    switch (action) {
      case 'approve':
        result = engine.processApproval(recordId, recordType, userId, step);
        break;
      case 'decline':
        result = engine.processDecline(recordId, recordType, userId, req.parameters.oa_comment);
        break;
      case 'delegate':
        result = engine.processDelegation(recordId, recordType, userId, req.parameters.oa_target);
        break;
      case 'reset':
      case 'reassign':
        result = engine.processReset(recordId, recordType, userId, req.parameters.oa_new_approver);
        break;
      default:
        result = { success: false, message: 'Unknown action.' };
    }

    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    resp.write(JSON.stringify(result));
  }

  function _selfUrl(req) {
    return req.url.split('?')[0];
  }

  function _loadSettings(subsidiaryId) {
    if (!subsidiaryId) return null;
    return engine.getSettingsForSubsidiary(subsidiaryId);
  }

  function _errorPage(msg) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:-apple-system,sans-serif;padding:40px;background:#f4f4f4}
.card{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 12px rgba(0,0,0,.09)}
h2{color:#c74634;margin:0 0 12px}p{color:#555;line-height:1.7}</style></head>
<body><div class="card"><h2>Error</h2><p>${msg}</p></div></body></html>`;
  }

  return { onRequest };
});
