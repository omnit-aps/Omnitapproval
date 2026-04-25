/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */
define([
  'N/email',
  'N/render',
  'N/runtime',
  'N/search',
  'N/url',
  './lib/oa_constants',
  './lib/oa_utils',
  './lib/oa_email_template',
  './oa_engine'
], (email, render, runtime, search, url, C, utils, tpl, engine) => {
  'use strict';

  const PARAM_RECORD_ID   = 'custscript_oa_mr_record_id';
  const PARAM_RECORD_TYPE = 'custscript_oa_mr_record_type';

  utils.setHmacSecret(runtime.getCurrentScript().getParameter({ name: 'custscript_oa_mr_hmac_secret' }));

  function getInputData(inputContext) {
    const script     = runtime.getCurrentScript();
    const recordId   = script.getParameter({ name: PARAM_RECORD_ID });
    const recordType = script.getParameter({ name: PARAM_RECORD_TYPE });

    if (recordId && recordType) {
      return [{ recordId, recordType }];
    }

    // Scheduled sweep — find all pending transactions that have a nextapprover assigned
    const results = [];
    search.create({
      type:    'transaction',
      filters: [
        ['type', 'anyof', ['PurchOrd', 'VendBill']],
        'AND',
        ['approvalstatus', 'anyof', [C.APPROVAL_STATUS.PENDING]],
        'AND',
        ['nextapprover', 'isnotempty', null]
      ],
      columns: ['internalid', 'type']
    }).run().each(r => {
      results.push({
        recordId:   r.id,
        recordType: r.getValue('type') === 'PurchOrd' ? 'purchaseorder' : 'vendorbill'
      });
      return true;
    });
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

    try {
      const fields = search.lookupFields({
        type:    recordType,
        id:      recordId,
        columns: [
          'nextapprover',
          'approvalstatus',
          'tranid',
          'subsidiary',
          'amount',
          'currency'
        ]
      });

      if (utils.selectValue(fields.approvalstatus) !== C.APPROVAL_STATUS.PENDING) return;

      // nextapprover is a SELECT field — extract the scalar value
      const approverRaw = fields.nextapprover;
      const approverId  = Array.isArray(approverRaw) && approverRaw[0] ? approverRaw[0].value : null;
      if (!approverId) return;

      const useEmail = utils.lookupEmployeeField(approverId, C.FIELDS.EMPLOYEE.USE_EMAIL);
      if (!useEmail) return;

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
      if (!settings || !settings.email_enabled) return;

      const approveLabel = settings.approve_string || 'Approve';
      const declineLabel = settings.reject_string  || 'Reject';
      const supportEmail = '';
      const expiryDays   = settings.token_expiry_days ? parseInt(settings.token_expiry_days, 10) : 7;
      const emailSubject = (settings.email_subject || 'Approval required — {docNumber}')
        .replace('{docNumber}', documentNumber);
      const emailIntro   = settings.email_intro || '';

      const senderEmployeeId = settings.email_sender || runtime.getCurrentUser().id;

      const slUrl = url.resolveScript({
        scriptId:          'customscript_oa_sl_email_action',
        deploymentId:      'customdeploy_oa_sl_email_action',
        returnExternalUrl: true
      });

      // Stateless HMAC token — no storage needed on the transaction record
      const hmacToken  = utils.generateHmacToken(recordType, recordId, step, approverId, expiryDays);
      const approveUrl = `${slUrl}?oa_action=approve&oa_token=${encodeURIComponent(hmacToken)}`;
      const declineUrl = `${slUrl}?oa_action=decline&oa_token=${encodeURIComponent(hmacToken)}`;

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

    } catch (e) {
      log.error('OA MR reduce error', `Record ${recordId}: ${e.message}`);
    }
  }

  function summarize(summary) {
    if (summary.inputSummary.error) {
      log.error('OA MR getInputData error', summary.inputSummary.error);
    }
    summary.reduceSummary.errors.iterator().each((key, error) => {
      log.error('OA MR reduce error', `Key: ${key} | ${error}`);
      return true;
    });
    log.audit('OA MR complete', `Processed ${summary.reduceSummary.keys.iterator().count || 0} records`);
  }

  return { getInputData, map, reduce, summarize };
});
