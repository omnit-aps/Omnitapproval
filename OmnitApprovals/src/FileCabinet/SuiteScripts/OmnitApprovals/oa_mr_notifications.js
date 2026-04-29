/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */
define([
  'N/email',
  'N/record',
  'N/render',
  'N/runtime',
  'N/search',
  'N/url',
  './lib/oa_constants',
  './lib/oa_utils',
  './lib/oa_email_template',
  './oa_engine'
], (email, record, render, runtime, search, url, C, utils, tpl, engine) => {
  'use strict';

  const PARAM_RECORD_ID   = 'custscript_oa_mr_record_id';
  const PARAM_RECORD_TYPE = 'custscript_oa_mr_record_type';

  // Script-parameter secret is a fallback. Preferred source is custrecord_oa_hmac_secret
  // on the subsidiary settings record — set per-reduce call so both MR and Email Action
  // scripts use the same value without requiring identical script-parameter configuration.
  const SCRIPT_PARAM_SECRET = runtime.getCurrentScript().getParameter({ name: 'custscript_oa_mr_hmac_secret' }) || '';
  utils.setHmacSecret(SCRIPT_PARAM_SECRET);

  function getInputData(inputContext) {
    const script     = runtime.getCurrentScript();
    const recordId   = script.getParameter({ name: PARAM_RECORD_ID });
    const recordType = script.getParameter({ name: PARAM_RECORD_TYPE });

    if (recordId && recordType) {
      // Triggered run — notify for a single specific record
      return [{ recordId, recordType, isSweep: false }];
    }

    // Scheduled sweep — audit only; emails are NOT sent in sweep mode to prevent
    // re-notification spam. Email is always sent by the afterSubmit-triggered run.
    const results = [];
    search.create({
      type:    'transaction',
      filters: [
        ['type', 'anyof', ['PurchOrd', 'VendBill']],
        'AND',
        ['approvalstatus', 'anyof', [C.APPROVAL_STATUS.PENDING]],
        'AND',
        ['custbody_oa_next_approver', 'noneof', ['@NONE@']],
        'AND',
        [C.FIELDS.TRANSACTION.SUBMITTED_BY, 'noneof', ['@NONE@']]
      ],
      columns: ['internalid', 'type']
    }).run().each(r => {
      results.push({
        recordId:   r.id,
        recordType: r.getValue('type') === 'PurchOrd' ? 'purchaseorder' : 'vendorbill',
        isSweep:    true
      });
      return true;
    });
    log.audit('OA MR sweep', `Found ${results.length} pending transaction(s) without completion.`);
    return results;
  }

  function map(mapContext) {
    const item = JSON.parse(mapContext.value);
    mapContext.write({ key: item.recordId, value: JSON.stringify(item) });
  }

  function reduce(reduceContext) {
    const item       = JSON.parse(reduceContext.values[0]);
    const recordId   = item.recordId;
    const recordType = item.recordType;
    const isSweep    = !!item.isSweep;

    // Sweep runs are audit-only — no emails to prevent re-notification spam
    if (isSweep) {
      log.audit('OA MR sweep pending', { recordId, recordType });
      return;
    }

    try {
      const fields = search.lookupFields({
        type:    recordType,
        id:      recordId,
        columns: [
          'custbody_oa_next_approver',
          'approvalstatus',
          'tranid',
          'subsidiary',
          'amount',
          'currency'
        ]
      });

      if (utils.selectValue(fields.approvalstatus) !== C.APPROVAL_STATUS.PENDING) return;

      // nextapprover is a SELECT field — extract the scalar value
      const approverRaw = fields.custbody_oa_next_approver;
      const approverId  = Array.isArray(approverRaw) && approverRaw[0] ? approverRaw[0].value : null;
      if (!approverId) return;

      const useEmail = utils.lookupEmployeeField(approverId, C.FIELDS.EMPLOYEE.USE_EMAIL);
      if (!utils.parseBool(useEmail)) return;

      const approverLookup = search.lookupFields({ type: 'employee', id: approverId, columns: ['firstname', 'lastname', 'email'] });
      const approverName   = `${approverLookup.firstname || ''} ${approverLookup.lastname || ''}`.trim();
      const approverEmail  = approverLookup.email;
      if (!approverEmail) return;

      const subsidiaryId   = fields.subsidiary && fields.subsidiary[0] ? fields.subsidiary[0].value : null;
      const subsidiaryName = fields.subsidiary && fields.subsidiary[0] ? fields.subsidiary[0].text  : '';
      const documentNumber = fields.tranid;
      const amount         = parseFloat(fields.amount) || 0;
      const currencySymbol = (fields.currency && fields.currency[0] ? fields.currency[0].text : '') || '';

      // Determine current step from audit log (0 approved → step 1)
      let approvedCount = 0;
      search.create({
        type:    C.RECORDS.LOG,
        filters: [
          [C.FIELDS.LOG.TRANSACTION, 'equalto', recordId],
          'AND',
          [C.FIELDS.LOG.ACTION, 'is', C.LOG_ACTIONS.APPROVED]
        ],
        columns: ['internalid']
      }).run().each(() => { approvedCount++; return true; });
      const step = approvedCount + 1;

      // Get submitted-by name from SUBMITTED log entry
      let requesterName = 'System';
      search.create({
        type:    C.RECORDS.LOG,
        filters: [
          [C.FIELDS.LOG.TRANSACTION, 'equalto', recordId],
          'AND',
          [C.FIELDS.LOG.ACTION, 'is', C.LOG_ACTIONS.SUBMITTED]
        ],
        columns: [C.FIELDS.LOG.ACTOR]
      }).run().each(r => {
        requesterName = r.getText(C.FIELDS.LOG.ACTOR) || 'System';
        return false;
      });

      const settings = subsidiaryId ? engine.getSettingsForSubsidiary(subsidiaryId) : null;
      if (!settings || !utils.parseBool(settings.email_enabled)) return;

      // Prefer settings-record secret so MR and Email Action share the same value
      // without requiring identical script-parameter configuration on both deployments.
      const settingsSecret = settings.hmac_secret || '';
      utils.setHmacSecret(settingsSecret || SCRIPT_PARAM_SECRET);
      if (!settingsSecret && !SCRIPT_PARAM_SECRET) {
        log.error('OA MR: email is enabled but no HMAC secret configured — set custrecord_oa_hmac_secret on the settings record', { subsidiaryId, recordId });
        return;
      }
      if (!settingsSecret && SCRIPT_PARAM_SECRET) {
        log.warn('OA MR: HMAC secret falling back to script parameter — set custrecord_oa_hmac_secret on the settings record for production', { subsidiaryId });
      }

      const approveLabel = settings.approve_string || 'Approve';
      const declineLabel = settings.reject_string  || 'Reject';
      const supportEmail = '';
      const expiryDays   = settings.token_expiry_days ? parseInt(settings.token_expiry_days, 10) : 7;
      const emailSubject = (settings.email_subject || 'Approval required — {docNumber}')
        .replace('{docNumber}', documentNumber);
      const emailIntro   = settings.email_intro || '';

      // Validate sender: MR "current user" is often a system/script context (non-employee).
      // Prefer the configured email_sender; fall back only if it's a valid employee ID.
      const configuredSender = settings.email_sender ? parseInt(settings.email_sender, 10) : 0;
      const runtimeUserId    = runtime.getCurrentUser().id;
      const senderEmployeeId = configuredSender > 0 ? configuredSender
                             : runtimeUserId > 0    ? runtimeUserId
                             : null;
      if (!senderEmployeeId) {
        log.error('OA MR: no valid sender employee — configure email_sender in subsidiary settings', { recordId, subsidiaryId });
        return;
      }

      // Stateless HMAC token — no storage needed on the transaction record
      const hmacToken = utils.generateHmacToken(recordType, recordId, step, approverId, expiryDays);
      if (!hmacToken) {
        log.error('OA MR: skipping email — HMAC secret not configured', { recordId, recordType, approverId });
        return;
      }

      // Use params in resolveScript so NS appends correctly (URL already contains ?script=&deploy=)
      const approveUrl = url.resolveScript({
        scriptId:          'customscript_oa_sl_email_action',
        deploymentId:      'customdeploy_oa_sl_email_action',
        returnExternalUrl: true,
        params:            { oa_action: 'approve', oa_token: hmacToken }
      });
      const declineUrl = url.resolveScript({
        scriptId:          'customscript_oa_sl_email_action',
        deploymentId:      'customdeploy_oa_sl_email_action',
        returnExternalUrl: true,
        params:            { oa_action: 'decline', oa_token: hmacToken }
      });

      const htmlBody = tpl.buildApprovalEmail({
        approverName,
        subsidiaryName,
        recordType,
        documentNumber,
        amount:       amount.toLocaleString('en-US', { minimumFractionDigits: 2 }),
        currency:     currencySymbol,
        requesterName,
        approveUrl,
        declineUrl,
        approveLabel,
        declineLabel,
        supportEmail,
        introText:    emailIntro
      });

      let pdfFile = null;
      try {
        pdfFile = render.transaction({ entityId: parseInt(recordId, 10), printMode: render.PrintMode.PDF });
      } catch (e) {
        log.error('OA MR: PDF render failed', e.message);
      }

      const emailParams = {
        author:     senderEmployeeId,
        recipients: [approverEmail],
        subject:    emailSubject,
        body:       htmlBody,
        isHtml:     true
      };
      if (pdfFile) emailParams.attachments = [pdfFile];

      email.send(emailParams);
      log.audit('OA MR: Email sent', `Approver: ${approverEmail} | Record: ${recordType} ${recordId} | Step: ${step}`);

      // H-6: persist token diagnostics — token verification is stateless (HMAC),
      // these fields exist purely for forensic correlation. If a token-based
      // approval lands later, audit can match the inbound token against
      // custbody_oa_approval_token and confirm token_created is recent enough.
      try {
        record.submitFields({
          type:    recordType,
          id:      recordId,
          values:  {
            [C.FIELDS.TRANSACTION.APPROVAL_TOKEN]: hmacToken,
            [C.FIELDS.TRANSACTION.TOKEN_CREATED]: new Date()
          },
          options: { ignoreMandatoryFields: true, enableSourcing: false }
        });
      } catch (e) {
        log.error('OA MR: token diagnostics write failed (non-blocking)', { recordId, recordType, err: e.message });
      }

    } catch (e) {
      log.error('OA MR reduce error', `Record ${recordId}: ${e.message}`);
    }
  }

  function summarize(summary) {
    if (summary.inputSummary.error) {
      log.error('OA MR getInputData error', summary.inputSummary.error);
    }
    let errorCount = 0;
    summary.reduceSummary.errors.iterator().each((key, error) => {
      log.error('OA MR reduce error', `Key: ${key} | ${error}`);
      errorCount++;
      return true;
    });
    let processedCount = 0;
    summary.reduceSummary.keys.iterator().each(() => { processedCount++; return true; });
    log.audit('OA MR complete', `Processed ${processedCount} record(s), ${errorCount} error(s)`);
  }

  return { getInputData, map, reduce, summarize };
});
