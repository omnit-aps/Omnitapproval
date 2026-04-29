/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define([
  'N/record',
  'N/runtime',
  'N/search',
  'N/url',
  './lib/oa_constants',
  './lib/oa_utils',
  './lib/oa_email_template',
  './oa_engine'
], (record, runtime, search, url, C, utils, tpl, engine) => {
  'use strict';

  // Script-parameter secret is a fallback. Preferred source is custrecord_oa_hmac_secret on the
  // subsidiary settings record — resolved per-request in handleGet/handlePost before token verify.
  const SCRIPT_PARAM_SECRET = runtime.getCurrentScript().getParameter({ name: 'custscript_oa_ea_hmac_secret' }) || '';
  utils.setHmacSecret(SCRIPT_PARAM_SECRET);

  function onRequest(context) {
    const req  = context.request;
    const resp = context.response;

    if (req.method === 'GET') return handleGet(req, resp);
    if (req.method === 'POST') return handlePost(req, resp);
  }

  // ─── GET: email link clicks ───────────────────────────────────────────────────

  function handleGet(req, resp) {
    const token  = req.parameters.oa_token;
    const action = req.parameters.oa_action;

    if (!token || !action) {
      resp.write(_errorPage('Invalid request. Please use the link from your approval email.'));
      return;
    }

    // Parse token body WITHOUT verifying so we can look up the subsidiary settings
    // record and use its HMAC secret before verification — eliminates the need for
    // custscript_oa_mr_hmac_secret and custscript_oa_ea_hmac_secret to be identical.
    const unverified = utils.parseHmacTokenBody(token);
    if (unverified) {
      try {
        const f     = search.lookupFields({ type: unverified.rt, id: unverified.rid, columns: ['subsidiary'] });
        const subId = f.subsidiary && f.subsidiary[0] ? f.subsidiary[0].value : null;
        const s     = subId ? engine.getSettingsForSubsidiary(subId) : null;
        if (s && s.hmac_secret) {
          utils.setHmacSecret(s.hmac_secret);
        } else if (s && !s.hmac_secret && SCRIPT_PARAM_SECRET) {
          log.warn('OA EA: HMAC secret falling back to script parameter — set custrecord_oa_hmac_secret on the settings record for production', { subId });
        }
      } catch (e) { /* graceful — fall back to SCRIPT_PARAM_SECRET already set */ }
    }

    // Verify HMAC token — contains recordType, recordId, step, approverId, expiry
    const payload = utils.verifyHmacToken(token);
    if (!payload) {
      resp.write(_errorPage('This link has expired or is invalid. Please log in to NetSuite to process the transaction.'));
      return;
    }

    const recordType = payload.rt;
    const recordId   = payload.rid;
    const approverId = payload.aid;

    // Load live record state to verify current approval status and assigned approver
    let fields;
    try {
      fields = search.lookupFields({
        type:    recordType,
        id:      recordId,
        columns: ['approvalstatus', 'custbody_oa_next_approver', 'tranid', 'subsidiary', 'amount', 'currency']
      });
    } catch (e) {
      resp.write(_errorPage('Transaction not found.'));
      return;
    }

    const subsidiaryId   = fields.subsidiary && fields.subsidiary[0] ? fields.subsidiary[0].value : null;
    const subsidiaryName = fields.subsidiary && fields.subsidiary[0] ? fields.subsidiary[0].text  : '';
    const settings       = subsidiaryId ? engine.getSettingsForSubsidiary(subsidiaryId) : null;

    // For unauthenticated requests check that the subsidiary allows it
    if (runtime.getCurrentUser().id <= 0 && !(settings && utils.parseBool(settings.approve_without_login))) {
      resp.write(_errorPage('Approval without login is not enabled for this subsidiary. Please log in to NetSuite to approve this transaction.'));
      return;
    }

    if (utils.selectValue(fields.approvalstatus) !== C.APPROVAL_STATUS.PENDING) {
      resp.write(_errorPage('This transaction has already been processed.'));
      return;
    }

    // Verify the token's approver still matches the live nextapprover on the record
    const liveApprover = fields.custbody_oa_next_approver && fields.custbody_oa_next_approver[0] ? String(fields.custbody_oa_next_approver[0].value) : null;
    if (liveApprover !== String(approverId)) {
      resp.write(_errorPage('This link is no longer valid — the assigned approver has changed. Please log in to NetSuite.'));
      return;
    }

    if (action === 'approve') {
      const result = engine.processApproval(recordId, recordType, approverId, C.LOG_SOURCES.EMAIL);
      if (!result || !result.success) {
        resp.write(_errorPage((result && result.message) || 'Approval could not be processed.'));
        return;
      }
      resp.write(tpl.buildConfirmationPage('approve'));
      return;
    }

    if (action === 'decline') {
      const actionUrl  = url.resolveScript({ scriptId: 'customscript_oa_sl_email_action', deploymentId: 'customdeploy_oa_sl_email_action', returnExternalUrl: true });
      const currency   = fields.currency && fields.currency[0] ? fields.currency[0].text : '';
      resp.write(tpl.buildDeclineCommentPage({
        documentNumber: fields.tranid,
        subsidiaryName,
        currency,
        amount:      parseFloat(fields.amount) || 0,
        recordType,
        recordId,
        token,
        actionUrl
      }));
      return;
    }

    resp.write(_errorPage('Unknown action. Please use the link from your approval email.'));
  }

  // ─── POST: UI button actions + decline form submit ────────────────────────────

  function handlePost(req, resp) {
    const action     = req.parameters.oa_action;
    const recordId   = req.parameters.oa_record_id;
    const recordType = req.parameters.oa_record_type;

    // Email decline form submit — HMAC token authenticates the request
    if (action === 'decline' && req.parameters.oa_token) {
      const token   = req.parameters.oa_token;
      const comment = req.parameters.oa_comment;
      if (!comment || !comment.trim()) {
        resp.write(_errorPage('A reason for rejection is required.'));
        return;
      }

      // Same subsidiary-secret lookup as GET flow before token verification
      const unverifiedPost = utils.parseHmacTokenBody(token);
      if (unverifiedPost) {
        try {
          const f     = search.lookupFields({ type: unverifiedPost.rt, id: unverifiedPost.rid, columns: ['subsidiary'] });
          const subId = f.subsidiary && f.subsidiary[0] ? f.subsidiary[0].value : null;
          const s     = subId ? engine.getSettingsForSubsidiary(subId) : null;
          if (s && s.hmac_secret) {
            utils.setHmacSecret(s.hmac_secret);
          } else if (s && !s.hmac_secret && SCRIPT_PARAM_SECRET) {
            log.warn('OA EA: HMAC secret falling back to script parameter — set custrecord_oa_hmac_secret on the settings record for production', { subId: unverifiedPost && unverifiedPost.sid });
          }
        } catch (e) { /* graceful fallback */ }
      }

      const payload = utils.verifyHmacToken(token);
      if (!payload) {
        resp.write(_errorPage('This link has expired or is invalid.'));
        return;
      }

      // Apply the same approve_without_login gate as the GET flow — unauthenticated
      // users must be explicitly permitted by the subsidiary settings.
      if (runtime.getCurrentUser().id <= 0) {
        let declineFields;
        try {
          declineFields = search.lookupFields({ type: payload.rt, id: payload.rid, columns: ['subsidiary'] });
        } catch (e) { declineFields = null; }
        const subId    = declineFields && declineFields.subsidiary && declineFields.subsidiary[0] ? declineFields.subsidiary[0].value : null;
        const settings = subId ? engine.getSettingsForSubsidiary(subId) : null;
        if (!(settings && utils.parseBool(settings.approve_without_login))) {
          resp.write(_errorPage('Approval without login is not enabled for this subsidiary. Please log in to NetSuite.'));
          return;
        }
      }

      // Verify live state
      let fields;
      try {
        fields = search.lookupFields({ type: payload.rt, id: payload.rid, columns: ['custbody_oa_next_approver', 'approvalstatus'] });
      } catch (e) {
        resp.write(_errorPage('Transaction not found or is no longer accessible.'));
        return;
      }
      const liveApprover = fields.custbody_oa_next_approver && fields.custbody_oa_next_approver[0] ? String(fields.custbody_oa_next_approver[0].value) : null;
      if (liveApprover !== String(payload.aid)) {
        resp.write(_errorPage('This link is no longer valid.'));
        return;
      }

      const result = engine.processDecline(payload.rid, payload.rt, payload.aid, comment, C.LOG_SOURCES.EMAIL);
      if (!result || !result.success) {
        resp.write(_errorPage((result && result.message) || 'Rejection could not be processed.'));
        return;
      }
      resp.write(tpl.buildConfirmationPage('decline'));
      return;
    }

    // UI-triggered actions require an authenticated NetSuite session
    const userId = runtime.getCurrentUser().id;
    if (userId <= 0) {
      resp.setHeader({ name: 'Content-Type', value: 'application/json' });
      resp.write(JSON.stringify({ success: false, message: 'Authentication required. Please log in to NetSuite.' }));
      return;
    }
    let result;

    switch (action) {
      case 'approve':
        result = engine.processApproval(recordId, recordType, userId);
        break;
      case 'decline':
        result = engine.processDecline(recordId, recordType, userId, req.parameters.oa_comment);
        break;
      case 'super_approve':
        result = engine.processApproval(recordId, recordType, userId, C.LOG_SOURCES.NETSUITE, req.parameters.oa_comment);
        break;
      case 'super_decline':
        result = engine.processDecline(recordId, recordType, userId, req.parameters.oa_comment, C.LOG_SOURCES.NETSUITE, true);
        break;
      case 'delegate':
        result = engine.processDelegation(recordId, recordType, userId, req.parameters.oa_target);
        break;
      case 'reset':
        result = engine.processReset(recordId, recordType, userId, req.parameters.oa_new_approver);
        break;
      case 'reassign':
        result = engine.processReassign(recordId, recordType, userId, req.parameters.oa_new_approver);
        break;
      default:
        result = { success: false, message: 'Unknown action.' };
    }

    resp.setHeader({ name: 'Content-Type', value: 'application/json' });
    resp.write(JSON.stringify(result));
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _errorPage(msg) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:-apple-system,sans-serif;padding:40px;background:#f4f4f4}
.card{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 12px rgba(0,0,0,.09)}
h2{color:#c74634;margin:0 0 12px}p{color:#555;line-height:1.7}</style></head>
<body><div class="card"><h2>Error</h2><p>${_esc(msg)}</p></div></body></html>`;
  }

  return { onRequest };
});
