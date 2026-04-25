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

  // ─── beforeSubmit ────────────────────────────────────────────────────────────
  // No business logic — only a breadcrumb so we can confirm in the Script
  // Execution Log that the deployment is actually bound to the record type.

  function beforeSubmit(context) {
    log.audit('OA-UE-BEFORE fired', 'entry');  // bulletproof first-line — no property access

    try {
      const rec  = context.newRecord;
      const user = runtime.getCurrentUser();
      log.audit('OA-UE-BEFORE detail', {
        type:        context.type,
        recordType:  rec && rec.type,
        recordId:    rec && rec.id,
        role:        user && user.role,
        userId:      user && user.id,
        execContext: runtime.executionContext
      });
    } catch (e) {
      log.error('OA-UE-BEFORE detail failed', e.message);
    }
  }

  // ─── afterSubmit ─────────────────────────────────────────────────────────────

  function afterSubmit(context) {
    log.audit('OA-UE-AFTER fired', 'entry');  // bulletproof first-line — no property access

    let rec, recordType, recordId, execContext, user;
    try {
      rec         = context.newRecord;
      recordType  = rec && rec.type;
      recordId    = rec && rec.id;
      execContext = runtime.executionContext;
      user        = runtime.getCurrentUser();
      log.audit('OA-UE-AFTER detail', {
        type:        context.type,
        recordType,
        recordId,
        role:        user && user.role,
        userId:      user && user.id,
        execContext
      });
    } catch (e) {
      log.error('OA-UE-AFTER detail failed', e.message);
      return;
    }

    const TRIGGER = context.UserEventType;
    if (context.type !== TRIGGER.CREATE && context.type !== TRIGGER.EDIT) {
      log.audit('OA-UE skip', { reason: 'trigger not CREATE/EDIT', type: context.type, recordId });
      return;
    }

    // Allow human-driven and integration-driven creates (UI, SOAP, Restlets, REST Web Services).
    // Exclude background contexts (CSV, scheduled, map/reduce, workflow, mass update) so bulk loads don't auto-route.
    const allowed = [
      runtime.ContextType.USER_INTERFACE,
      runtime.ContextType.WEBSERVICES,
      runtime.ContextType.RESTLET,
      runtime.ContextType.RESTWEBSERVICES
    ];
    if (!allowed.includes(execContext)) {
      log.audit('OA-UE skip', { reason: 'execContext not in allowed list', execContext, recordId });
      return;
    }

    // ── Status guard ─────────────────────────────────────────────────────────
    // CREATE: always route. NetSuite defaults approvalstatus=2 (Approved) on
    //   new transactions when no native approval workflow is configured —
    //   that "Approved" is just a default, not a real prior approval.
    // EDIT:   skip ONLY if this transaction already has OA audit log entries.
    //   No OA history → was never routed by OA → eligible, route as if CREATE.
    //   Has OA history → already managed by OA, skip.
    const currentStatus = rec.getValue('approvalstatus');

    if (context.type === TRIGGER.EDIT) {
      let hasOaHistory = false;
      try {
        search.create({
          type:    C.RECORDS.LOG,
          filters: [[C.FIELDS.LOG.TRANSACTION, 'anyof', recordId]],
          columns: ['internalid']
        }).run().each(() => { hasOaHistory = true; return false; });
      } catch (e) {
        log.error('OA-UE: OA log history check failed', e.message);
      }
      if (hasOaHistory) {
        log.audit('OA-UE skip', { reason: 'EDIT on record with existing OA history', recordId, currentStatus });
        return;
      }
      log.audit('OA-UE: EDIT on unrouted record — routing as if CREATE', { recordId, currentStatus });
    }

    const subsidiaryId = utils.getTransactionSubsidiary(recordType, recordId);
    if (!subsidiaryId) {
      log.audit('OA-UE skip', { reason: 'no subsidiary on record', recordId, recordType });
      return;
    }

    const result = engine.routeForApproval(recordType, recordId, subsidiaryId);
    if (result.error) {
      log.audit('OA-UE skip', { reason: 'routeForApproval error', recordId, error: result.error });
      return;
    }
    log.audit('OA-UE routing', { recordId, approver1: result.approver1, hierarchyId: result.hierarchyId });

    const { approver1, hierarchyId } = result;

    if (!approver1) {
      log.audit('OA-UE skip', { reason: 'no approver resolved by routeForApproval', recordId, recordType });
      return;
    }

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
    log.audit('OA-UE-LOAD fired', 'entry');  // bulletproof first-line — no property access

    let rec, recordType, recordId, execContext;
    try {
      rec         = context.newRecord;
      recordType  = rec && rec.type;
      recordId    = rec && rec.id;
      execContext = runtime.executionContext;
      log.audit('OA-UE-LOAD detail', { type: context.type, recordType, recordId, execContext });
    } catch (e) {
      log.error('OA-UE-LOAD detail failed', e.message);
      return;
    }

    if (context.type !== context.UserEventType.VIEW && context.type !== context.UserEventType.EDIT) {
      log.audit('OA-UE-LOAD skip', { reason: 'trigger not VIEW/EDIT', type: context.type, recordId });
      return;
    }
    if (execContext !== runtime.ContextType.USER_INTERFACE) {
      log.audit('OA-UE-LOAD skip', { reason: 'execContext not USER_INTERFACE', execContext, recordId });
      return;
    }

    const form   = context.form;
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

  return { beforeSubmit, afterSubmit, beforeLoad };
});
