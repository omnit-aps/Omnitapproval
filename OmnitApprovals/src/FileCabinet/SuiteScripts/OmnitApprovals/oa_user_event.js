/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define([
  'N/record',
  'N/runtime',
  'N/search',
  'N/task',
  'N/url',
  './lib/oa_constants',
  './lib/oa_utils',
  './oa_engine'
], (record, runtime, search, task, url, C, utils, engine) => {
  'use strict';

  // ─── afterSubmit ─────────────────────────────────────────────────────────────

  function afterSubmit(context) {
    const TRIGGER = context.UserEventType;
    if (context.type !== TRIGGER.CREATE && context.type !== TRIGGER.EDIT) return;

    const execContext = runtime.executionContext;
    if (![
      runtime.ContextType.USER_INTERFACE,
      runtime.ContextType.WEBSERVICES,
      runtime.ContextType.RESTLETS
    ].includes(execContext)) return;

    const rec        = context.newRecord;
    const recordType = rec.type;
    const recordId   = rec.id;

    const currentStatus = rec.getValue('approvalstatus');
    if (currentStatus === C.APPROVAL_STATUS.APPROVED) return;
    if (context.type === TRIGGER.EDIT && currentStatus === C.APPROVAL_STATUS.PENDING) return;

    const subsidiaryId = utils.getTransactionSubsidiary(recordType, recordId);
    if (!subsidiaryId) return;

    const result = engine.routeForApproval(recordType, recordId, subsidiaryId);
    if (result.error) {
      log.debug('OA routeForApproval skipped', result.error);
      return;
    }

    const { approver1, hierarchyId } = result;

    let txn;
    try {
      txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    } catch (e) {
      log.error('OA: record.load failed in afterSubmit', e.message);
      return;
    }

    txn.setValue({ fieldId: 'approvalstatus', value: C.APPROVAL_STATUS.PENDING });
    try { txn.setValue({ fieldId: 'nextapprover', value: approver1 }); } catch (e) { log.debug('OA: nextapprover not supported', recordType); }
    // custbody fields may not exist on all record types — best-effort writes
    try { txn.setValue({ fieldId: C.FIELDS.TRANSACTION.SUBMITTED_BY, value: runtime.getCurrentUser().id }); } catch (e) {}
    try { if (hierarchyId) txn.setValue({ fieldId: C.FIELDS.TRANSACTION.HIERARCHY_USED, value: hierarchyId }); } catch (e) {}
    txn.save({ ignoreMandatoryFields: true });

    engine.createAuditLog({
      transactionId: recordId,
      action:        C.LOG_ACTIONS.SUBMITTED,
      actorId:       runtime.getCurrentUser().id,
      step:          1,
      source:        C.LOG_SOURCES.NETSUITE
    });

    try {
      task.create({
        taskType:    task.TaskType.MAP_REDUCE,
        scriptId:    'customscript_oa_mr_notifications',
        deploymentId: 'customdeploy_oa_mr_notifications',
        params: {
          custscript_oa_mr_record_id:   recordId,
          custscript_oa_mr_record_type: recordType
        }
      }).submit();
    } catch (e) {
      log.error('OA: Failed to schedule MR notification', e.message);
    }
  }

  // ─── beforeLoad ──────────────────────────────────────────────────────────────

  function beforeLoad(context) {
    if (context.type !== context.UserEventType.VIEW && context.type !== context.UserEventType.EDIT) return;
    if (runtime.executionContext !== runtime.ContextType.USER_INTERFACE) return;

    const form   = context.form;
    const rec    = context.newRecord;
    const userId = runtime.getCurrentUser().id;
    const status = rec.getValue('approvalstatus');

    // Show history button when OA audit log entries exist for this record
    let hasLog = false;
    try {
      search.create({
        type:    C.RECORDS.LOG,
        filters: [[C.FIELDS.LOG.TRANSACTION, 'anyof', rec.id]],
        columns: ['internalid']
      }).run().getRange({ start: 0, end: 1 }).forEach(() => { hasLog = true; });
    } catch (e) { /* graceful */ }

    if (hasLog) {
      const histUrl = url.resolveScript({
        scriptId:          'customscript_oa_sl_approval_history',
        deploymentId:      'customdeploy_oa_sl_approval_history',
        returnExternalUrl: false
      });
      form.addButton({
        id:           'custpage_oa_history',
        label:        'Approval history',
        functionName: `OA_history('${histUrl}', '${rec.id}', '${rec.type}')`
      });
    }

    if (status !== C.APPROVAL_STATUS.PENDING) return;

    // nextapprover is the native NetSuite field — works on both PO and VB
    const currentApprover   = rec.getValue('nextapprover');
    const isCurrentApprover = currentApprover && String(currentApprover) === String(userId);
    const canDelegate       = utils.lookupEmployeeField(userId, C.FIELDS.EMPLOYEE.CAN_DELEGATE);
    const isManager         = utils.lookupEmployeeField(userId, C.FIELDS.EMPLOYEE.IS_MANAGER);

    const subsidiaryId = utils.getTransactionSubsidiary(rec.type, rec.id);
    const settings     = subsidiaryId ? engine.getSettingsForSubsidiary(subsidiaryId) : null;
    const approveLabel = (settings && settings.approve_string) || 'Approve';
    const rejectLabel  = (settings && settings.reject_string)  || 'Reject';

    const slUrl = url.resolveScript({
      scriptId:          'customscript_oa_sl_email_action',
      deploymentId:      'customdeploy_oa_sl_email_action',
      returnExternalUrl: false
    });

    if (isCurrentApprover) {
      form.addButton({ id: 'custpage_oa_approve', label: approveLabel, functionName: `OA_approve('${slUrl}')` });
      form.addButton({ id: 'custpage_oa_decline', label: rejectLabel,  functionName: `OA_decline('${slUrl}')` });
      if (canDelegate) {
        form.addButton({ id: 'custpage_oa_delegate', label: 'Delegate', functionName: `OA_delegate('${slUrl}')` });
      }
    }

    if (isManager) {
      form.addButton({ id: 'custpage_oa_reset',    label: 'Reset flow', functionName: `OA_reset('${slUrl}')` });
      form.addButton({ id: 'custpage_oa_reassign', label: 'Reassign',   functionName: `OA_reassign('${slUrl}')` });
    }
  }

  return { afterSubmit, beforeLoad };
});
