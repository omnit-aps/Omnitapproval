/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define([
  'N/record',
  'N/runtime',
  'N/task',
  'N/url',
  './lib/oa_constants',
  './lib/oa_utils',
  './oa_engine'
], (record, runtime, task, url, C, utils, engine) => {
  'use strict';

  // ─── afterSubmit ─────────────────────────────────────────────────────────────

  function afterSubmit(context) {
    const TRIGGER = context.UserEventType;
    if (context.type !== TRIGGER.CREATE && context.type !== TRIGGER.EDIT) return;

    const execContext = runtime.executionContext;
    // Only trigger from UI or web services, not internal system operations
    if (![
      runtime.ContextType.USER_INTERFACE,
      runtime.ContextType.WEBSERVICES,
      runtime.ContextType.RESTLETS
    ].includes(execContext)) return;

    const rec        = context.newRecord;
    const recordType = rec.type;
    const recordId   = rec.id;

    // Only re-route if status is pending or if this is a fresh create
    const currentStatus = rec.getValue('approvalstatus');
    if (currentStatus === C.APPROVAL_STATUS.APPROVED) return;

    const subsidiaryId = utils.getTransactionSubsidiary(recordType, recordId);
    if (!subsidiaryId) return;

    const result = engine.routeForApproval(recordType, recordId, subsidiaryId);
    if (result.error) {
      log.debug('OA routeForApproval skipped', result.error);
      return;
    }

    const { approver1, approver2, hierarchyId, approverCount } = result;

    // Generate email token
    const rawToken = utils.generateToken();
    const hashedToken = utils.hashToken(rawToken);

    const txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    txn.setValue({ fieldId: 'approvalstatus',                         value: C.APPROVAL_STATUS.PENDING });
    txn.setValue({ fieldId: 'nextapprover',                           value: approver1 });
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.CURRENT_STEP,        value: 1 });
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.APPROVER1,           value: approver1 });
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.APPROVER2,           value: approver2 || '' });
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.SUBMITTED_BY,        value: runtime.getCurrentUser().id });
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.APPROVAL_TOKEN,      value: hashedToken });
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.TOKEN_CREATED,       value: new Date() });
    if (hierarchyId) {
      txn.setValue({ fieldId: C.FIELDS.TRANSACTION.HIERARCHY_USED, value: hierarchyId });
    }
    txn.save({ ignoreMandatoryFields: true });

    engine.createAuditLog({
      transactionId: recordId,
      action:        C.LOG_ACTIONS.SUBMITTED,
      actorId:       runtime.getCurrentUser().id,
      step:          1,
      source:        C.LOG_SOURCES.NETSUITE
    });

    // Schedule email notification via Map/Reduce (keeps UE within governance limits)
    try {
      task.create({
        taskType:   task.TaskType.MAP_REDUCE,
        scriptId:   'customscript_oa_mr_notifications',
        deploymentId: 'customdeploy_oa_mr_notifications',
        params: {
          custscript_oa_mr_record_id:   recordId,
          custscript_oa_mr_record_type: recordType,
          custscript_oa_mr_raw_token:   rawToken
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

    const form      = context.form;
    const rec       = context.newRecord;
    const userId    = runtime.getCurrentUser().id;
    const step      = parseInt(rec.getValue(C.FIELDS.TRANSACTION.CURRENT_STEP), 10) || 0;
    const approver1 = rec.getValue(C.FIELDS.TRANSACTION.APPROVER1);
    const approver2 = rec.getValue(C.FIELDS.TRANSACTION.APPROVER2);
    const status    = rec.getValue('approvalstatus');

    if (status !== C.APPROVAL_STATUS.PENDING || !step) return;

    const currentApprover = step === 1 ? approver1 : approver2;
    const isCurrentApprover = String(currentApprover) === String(userId);
    const canDelegate    = utils.lookupEmployeeField(userId, C.FIELDS.EMPLOYEE.CAN_DELEGATE);
    const isManager      = utils.lookupEmployeeField(userId, C.FIELDS.EMPLOYEE.IS_MANAGER);

    // Load button labels from settings
    const subsidiaryId = utils.getTransactionSubsidiary(rec.type, rec.id);
    const settings     = subsidiaryId ? engine.getSettingsForSubsidiary(subsidiaryId) : null;
    const approveLabel = (settings && settings.approve_string) || 'Godkend';
    const rejectLabel  = (settings && settings.reject_string)  || 'Afvis';

    const slUrl = url.resolveScript({
      scriptId:     'customscript_oa_sl_email_action',
      deploymentId: 'customdeploy_oa_sl_email_action',
      returnExternalUrl: false
    });

    if (isCurrentApprover) {
      form.addButton({ id: 'custpage_oa_approve', label: approveLabel, functionName: `OA_approve('${slUrl}')` });
      form.addButton({ id: 'custpage_oa_decline', label: rejectLabel,  functionName: `OA_decline('${slUrl}')` });
      if (canDelegate) {
        form.addButton({ id: 'custpage_oa_delegate', label: 'Delegér', functionName: `OA_delegate('${slUrl}')` });
      }
    }

    if (isManager) {
      form.addButton({ id: 'custpage_oa_reset',    label: 'Nulstil flow',  functionName: `OA_reset('${slUrl}')` });
      form.addButton({ id: 'custpage_oa_reassign', label: 'Omfordel',      functionName: `OA_reassign('${slUrl}')` });
    }
  }

  return { afterSubmit, beforeLoad };
});
