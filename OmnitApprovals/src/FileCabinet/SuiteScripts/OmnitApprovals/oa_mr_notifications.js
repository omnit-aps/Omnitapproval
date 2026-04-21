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

  // Script parameters passed from the scheduling UE
  const PARAM_RECORD_ID   = 'custscript_oa_mr_record_id';
  const PARAM_RECORD_TYPE = 'custscript_oa_mr_record_type';
  const PARAM_RAW_TOKEN   = 'custscript_oa_mr_raw_token';

  function getInputData(inputContext) {
    const params     = runtime.getCurrentScript().getParameter;
    const recordId   = params({ name: PARAM_RECORD_ID });
    const recordType = params({ name: PARAM_RECORD_TYPE });

    if (recordId && recordType) {
      return [{ recordId, recordType }];
    }

    // Fallback: find all pending transactions with no notification sent yet
    // (for bulk re-notification scenarios)
    const results = [];
    search.create({
      type:    'transaction',
      filters: [
        ['type', 'anyof', ['PurchOrd', 'VendBill']],
        'AND',
        ['approvalstatus', 'anyof', [C.APPROVAL_STATUS.PENDING]],
        'AND',
        [C.FIELDS.TRANSACTION.APPROVER1, 'isnotempty', null]
      ],
      columns: ['internalid', 'type']
    }).run().each(r => {
      results.push({ recordId: r.id, recordType: r.getValue('type') === 'PurchOrd' ? 'purchaseorder' : 'vendorbill' });
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
          C.FIELDS.TRANSACTION.APPROVER1,
          C.FIELDS.TRANSACTION.APPROVER2,
          C.FIELDS.TRANSACTION.CURRENT_STEP,
          C.FIELDS.TRANSACTION.APPROVAL_TOKEN,
          C.FIELDS.TRANSACTION.SUBMITTED_BY,
          'tranid',
          'subsidiary',
          'amount',
          'currencysymbol',
          'approvalstatus'
        ]
      });

      if (fields['approvalstatus'] !== C.APPROVAL_STATUS.PENDING) return;

      const step            = parseInt(fields[C.FIELDS.TRANSACTION.CURRENT_STEP], 10) || 1;
      const approverId      = step === 1
        ? fields[C.FIELDS.TRANSACTION.APPROVER1]
        : fields[C.FIELDS.TRANSACTION.APPROVER2];
      const submittedBy     = fields[C.FIELDS.TRANSACTION.SUBMITTED_BY];
      const subsidiaryId    = fields['subsidiary'] && fields['subsidiary'][0] ? fields['subsidiary'][0].value : null;
      const subsidiaryName  = fields['subsidiary'] && fields['subsidiary'][0] ? fields['subsidiary'][0].text : '';
      const documentNumber  = fields['tranid'];
      const amount          = parseFloat(fields['amount']) || 0;
      const currencySymbol  = fields['currencysymbol'] || '';

      if (!approverId) return;

      const useEmail = utils.lookupEmployeeField(approverId, C.FIELDS.EMPLOYEE.USE_EMAIL);
      if (!useEmail) return; // Only send email to employees with email approval enabled

      const approverLookup = search.lookupFields({ type: 'employee', id: approverId, columns: ['firstname', 'lastname', 'email'] });
      const approverName   = `${approverLookup.firstname || ''} ${approverLookup.lastname || ''}`.trim();
      const approverEmail  = approverLookup.email;

      if (!approverEmail) return;

      const requesterLookup = submittedBy
        ? search.lookupFields({ type: 'employee', id: submittedBy, columns: ['firstname', 'lastname'] })
        : {};
      const requesterName = `${requesterLookup.firstname || ''} ${requesterLookup.lastname || ''}`.trim() || 'System';

      const settings    = subsidiaryId ? engine.getSettingsForSubsidiary(subsidiaryId) : null;
      const approveLabel = (settings && settings.approve_string) || 'Godkend';
      const declineLabel = (settings && settings.reject_string)  || 'Afvis';
      const supportEmail = (settings && settings.support_email)  || 'support@omnit.dk';

      // Retrieve raw token from script params (only available on first run per transaction)
      const rawToken = runtime.getCurrentScript().getParameter({ name: PARAM_RAW_TOKEN }) || '';

      const slUrl = url.resolveScript({
        scriptId:          'customscript_oa_sl_email_action',
        deploymentId:      'customdeploy_oa_sl_email_action',
        returnExternalUrl: true
      });

      const baseParams = `oa_record_type=${recordType}&oa_record_id=${recordId}&oa_token=${rawToken}`;
      const approveUrl = `${slUrl}?oa_action=approve&${baseParams}`;
      const declineUrl = `${slUrl}?oa_action=decline&${baseParams}`;

      const htmlBody = tpl.buildApprovalEmail({
        approverName,
        subsidiaryName,
        recordType,
        documentNumber,
        amount:       amount.toLocaleString('da-DK', { minimumFractionDigits: 2 }),
        currency:     currencySymbol,
        requesterName,
        approveUrl,
        declineUrl,
        approveLabel,
        declineLabel,
        supportEmail
      });

      // Render PDF of the transaction
      let pdfFile = null;
      try {
        pdfFile = render.transaction({ entityId: parseInt(recordId, 10), printMode: render.PrintMode.PDF });
      } catch (e) {
        log.error('OA MR: PDF render failed', e.message);
      }

      const emailParams = {
        author:    runtime.getCurrentUser().id,
        recipients: [approverEmail],
        subject:   `Godkendelsesanmodning — ${documentNumber}`,
        body:      htmlBody,
        isHtml:    true
      };
      if (pdfFile) emailParams.attachments = [pdfFile];

      email.send(emailParams);
      log.audit('OA MR: Email sent', `Approver: ${approverEmail} | Record: ${recordType} ${recordId}`);

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
    log.audit('OA MR complete', `Processed: ${summary.reduceSummary.keys.iterator().count || 0} records`);
  }

  return { getInputData, map, reduce, summarize };
});
