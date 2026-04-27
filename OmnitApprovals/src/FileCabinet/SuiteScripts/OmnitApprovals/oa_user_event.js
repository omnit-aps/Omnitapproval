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
  'N/ui/serverWidget',
  './lib/oa_constants',
  './lib/oa_utils',
  './oa_engine'
], (record, runtime, search, task, url, serverWidget, C, utils, engine) => {
  'use strict';

  // ─── beforeSubmit ────────────────────────────────────────────────────────────
  // No business logic — only a breadcrumb so we can confirm in the Script
  // Execution Log that the deployment is actually bound to the record type.

  // beforeSubmit does the field writeback (approvalstatus + nextapprover + custbody fields)
  // BEFORE NetSuite's native APPROVALROUTING feature locks the nextapprover field.
  // afterSubmit doing record.load + setValue + save cannot persist nextapprover when
  // APPROVALROUTING is enabled — the writes are silently dropped.

  function beforeSubmit(context) {
    log.audit('OA-UE-PROOF BEFORE',
      'I AM RUNNING ctx=' + (context && context.type ? context.type : 'unknown') +
      ' id=' + (context && context.newRecord && context.newRecord.id ? context.newRecord.id : 'NEW') +
      ' execCtx=' + (runtime.executionContext || '?'));
    log.audit('OA-UE-BEFORE fired', 'entry');

    let rec, recordType, recordId, execContext;
    try {
      rec         = context.newRecord;
      recordType  = rec && rec.type;
      recordId    = rec && rec.id;
      execContext = runtime.executionContext;
      log.audit('OA-UE-BEFORE detail', {
        type:        context.type,
        recordType,
        recordId,
        userId:      runtime.getCurrentUser().id,
        role:        runtime.getCurrentUser().role,
        execContext
      });
    } catch (e) {
      log.error('OA-UE-BEFORE detail failed', e.message);
      return;
    }

    const TRIGGER = context.UserEventType;
    if (context.type !== TRIGGER.CREATE && context.type !== TRIGGER.EDIT) {
      log.audit('OA-UE-BEFORE skip', { reason: 'trigger not CREATE/EDIT', type: context.type, recordId });
      return;
    }

    const allowed = [
      runtime.ContextType.USER_INTERFACE,
      runtime.ContextType.WEBSERVICES,
      runtime.ContextType.RESTLET,
      runtime.ContextType.RESTWEBSERVICES
    ];
    if (!allowed.includes(execContext)) {
      log.audit('OA-UE-BEFORE skip', { reason: 'execContext not in allowed list', execContext, recordId });
      return;
    }

    if (context.type === TRIGGER.EDIT) {
      let hasOaHistory = false;
      try {
        search.create({
          type:    C.RECORDS.LOG,
          filters: [[C.FIELDS.LOG.TRANSACTION, 'equalto', recordId]],
          columns: ['internalid']
        }).run().each(() => { hasOaHistory = true; return false; });
      } catch (e) {
        log.error('OA-UE-BEFORE: OA log history check failed', e.message);
      }

      if (!hasOaHistory) {
        // EDIT on a record that was never put through OA — do not start a new flow.
        // Only CREATE, or EDIT on a previously-managed record (history exists), should trigger routing.
        log.audit('OA-UE-BEFORE skip', { reason: 'EDIT with no OA history — not a managed record', recordId });
        return;
      }

      if (hasOaHistory) {
        const currentStatus = rec.getValue('approvalstatus');

        if (currentStatus === C.APPROVAL_STATUS.REJECTED) {
          // UAT rule: REJECTED + edit → always re-route (submitter corrects and resubmits)
          log.audit('OA-UE-BEFORE re-route', { reason: 'EDIT on REJECTED record — re-routing for re-submission', recordId });
          // Fall through to routing below

        } else if (currentStatus === C.APPROVAL_STATUS.PENDING) {
          // UAT rule: PENDING + edit → never re-route (already in-flight)
          log.audit('OA-UE-BEFORE skip', { reason: 'EDIT on PENDING record — in-flight approval, skip re-routing', recordId });
          return;

        } else {
          // UAT rule: APPROVED + edit → only re-route if amount change exceeds threshold
          const subId    = rec.getValue('subsidiary');
          const settings = subId ? engine.getSettingsForSubsidiary(subId) : null;
          const pctCfg   = parseFloat(settings && settings.resubmit_threshold_pct) || 0;
          const absCfg   = parseFloat(settings && settings.resubmit_threshold_abs) || 0;

          if (pctCfg > 0 || absCfg > 0) {
            // Convert both old and new amounts to subsidiary base currency.
            // Re-submission threshold (resubmit_threshold_abs) is in base currency,
            // so absChg must also be in base currency for the comparison to make sense.
            const oldForeign = parseFloat(context.oldRecord.getValue('total') || context.oldRecord.getValue('amount') || 0) || 0;
            const newForeign = parseFloat(rec.getValue('total') || rec.getValue('usertotal') || rec.getValue('amount') || 0) || 0;
            const oldAmt     = utils.toBaseCurrency(context.oldRecord, oldForeign);
            const newAmt     = utils.toBaseCurrency(rec,                newForeign);
            const pctChg     = oldAmt > 0 ? Math.abs((newAmt - oldAmt) / oldAmt) * 100 : 0;
            const absChg     = Math.abs(newAmt - oldAmt);
            const exceeded = (pctCfg > 0 && pctChg >= pctCfg) || (absCfg > 0 && absChg >= absCfg);

            if (exceeded) {
              log.audit('OA-UE-BEFORE threshold exceeded — re-routing', { recordId, oldAmt, newAmt, pctChg: pctChg.toFixed(2), absChg });
              // Fall through to routing below
            } else {
              log.audit('OA-UE-BEFORE skip', { reason: 'EDIT within threshold', recordId, pctChg: pctChg.toFixed(2), absChg });
              return;
            }
          } else {
            log.audit('OA-UE-BEFORE skip', { reason: 'EDIT on APPROVED record, no threshold configured', recordId });
            return;
          }
        }
      }
    }

    const subsidiaryId = rec.getValue('subsidiary');
    if (!subsidiaryId) {
      log.audit('OA-UE-BEFORE skip', { reason: 'no subsidiary on record', recordId, recordType });
      return;
    }

    // Read amount directly from the record being submitted (recordId may be null on CREATE).
    // Convert to subsidiary base currency — approval matrix thresholds are in base currency,
    // so a 100,000 EUR PO must compare against base-currency thresholds, not the foreign 100,000.
    const foreignAmount = parseFloat(rec.getValue('total') || rec.getValue('usertotal') || rec.getValue('amount') || 0) || 0;
    const amount        = utils.toBaseCurrency(rec, foreignAmount);

    const result = engine.routeForApproval(recordType, recordId, subsidiaryId, amount);
    if (result.error) {
      log.audit('OA-UE-BEFORE skip', { reason: 'routeForApproval error', recordId, error: result.error });
      return;
    }
    const { approver1, hierarchyId } = result;
    if (!approver1) {
      log.audit('OA-UE-BEFORE skip', { reason: 'no approver resolved by routeForApproval', recordId, recordType });
      return;
    }

    // Write fields on context.newRecord — NetSuite persists these in its own save cycle,
    // which avoids the APPROVALROUTING lock that drops afterSubmit writes to nextapprover.
    rec.setValue({ fieldId: 'approvalstatus', value: C.APPROVAL_STATUS.PENDING });
    try { rec.setValue({ fieldId: 'nextapprover', value: approver1 }); } catch (e) { log.debug('OA: nextapprover not supported', recordType); }
    try { rec.setValue({ fieldId: C.FIELDS.TRANSACTION.SUBMITTED_BY, value: runtime.getCurrentUser().id }); } catch (e) {}
    try { if (hierarchyId) rec.setValue({ fieldId: C.FIELDS.TRANSACTION.HIERARCHY_USED, value: hierarchyId }); } catch (e) {}

    log.audit('OA-UE-BEFORE writeback set', { recordId, recordType, approver1, hierarchyId, amount });
  }

  // ─── afterSubmit ─────────────────────────────────────────────────────────────

  // afterSubmit handles bookkeeping that needs the saved recordId:
  // - audit log row in customrecord_oa_log
  // - schedule MR notification job
  // The actual field writeback (nextapprover etc.) happens in beforeSubmit.

  function afterSubmit(context) {
    log.audit('OA-UE-PROOF AFTER',
      'I AM RUNNING ctx=' + (context && context.type ? context.type : 'unknown') +
      ' id=' + (context && context.newRecord && context.newRecord.id ? context.newRecord.id : 'NEW') +
      ' execCtx=' + (runtime.executionContext || '?'));
    log.audit('OA-UE-AFTER fired', 'entry');

    let rec, recordType, recordId, execContext;
    try {
      rec         = context.newRecord;
      recordType  = rec && rec.type;
      recordId    = rec && rec.id;
      execContext = runtime.executionContext;
      log.audit('OA-UE-AFTER detail', {
        type:        context.type,
        recordType,
        recordId,
        userId:      runtime.getCurrentUser().id,
        role:        runtime.getCurrentUser().role,
        execContext
      });
    } catch (e) {
      log.error('OA-UE-AFTER detail failed', e.message);
      return;
    }

    const TRIGGER = context.UserEventType;
    if (context.type !== TRIGGER.CREATE && context.type !== TRIGGER.EDIT) {
      log.audit('OA-UE-AFTER skip', { reason: 'trigger not CREATE/EDIT', type: context.type, recordId });
      return;
    }

    const allowed = [
      runtime.ContextType.USER_INTERFACE,
      runtime.ContextType.WEBSERVICES,
      runtime.ContextType.RESTLET,
      runtime.ContextType.RESTWEBSERVICES
    ];
    if (!allowed.includes(execContext)) {
      log.audit('OA-UE-AFTER skip', { reason: 'execContext not in allowed list', execContext, recordId });
      return;
    }

    // The saved record carries the writes from beforeSubmit. If nextapprover is set,
    // we know beforeSubmit successfully routed and we should create the audit log + schedule MR.
    // If not, beforeSubmit either skipped (already routed, no settings, etc.) or the writeback
    // was somehow blocked — either way nothing to do here.
    const nextApprover = rec.getValue('nextapprover');
    if (!nextApprover) {
      log.audit('OA-UE-AFTER skip', { reason: 'no nextapprover on record (beforeSubmit did not route)', recordId, recordType });
      return;
    }

    // For EDIT: skip if both nextapprover AND approvalstatus are unchanged — means beforeSubmit
    // did not re-route (threshold not exceeded or no threshold configured). We must check both
    // because a re-route to the same approver (APPROVED→PENDING) only changes approvalstatus.
    if (context.type === TRIGGER.EDIT) {
      let oldNextApprover, oldStatus;
      try { oldNextApprover = context.oldRecord.getValue('nextapprover'); } catch (e) { oldNextApprover = null; }
      try { oldStatus       = context.oldRecord.getValue('approvalstatus'); } catch (e) { oldStatus = null; }
      const nextApproverUnchanged = String(oldNextApprover || '') === String(nextApprover || '');
      const statusUnchanged       = String(oldStatus || '') === String(rec.getValue('approvalstatus') || '');
      if (nextApproverUnchanged && statusUnchanged) {
        log.audit('OA-UE-AFTER skip', { reason: 'EDIT: nextapprover and approvalstatus unchanged — beforeSubmit did not re-route', recordId });
        return;
      }
    }

    log.audit('OA-UE-AFTER bookkeeping', { recordId, recordType, nextApprover });

    // Determine whether this is an initial submission or a threshold-triggered re-submission
    let isResubmission = false;
    if (context.type === TRIGGER.EDIT) {
      try {
        search.create({
          type:    C.RECORDS.LOG,
          filters: [[C.FIELDS.LOG.TRANSACTION, 'equalto', recordId], 'AND', [C.FIELDS.LOG.ACTION, 'is', C.LOG_ACTIONS.SUBMITTED]],
          columns: ['internalid']
        }).run().each(() => { isResubmission = true; return false; });
      } catch (e) { /* graceful */ }
    }

    engine.createAuditLog({
      transactionId: recordId,
      action:        isResubmission ? C.LOG_ACTIONS.RESUBMITTED : C.LOG_ACTIONS.SUBMITTED,
      actorId:       runtime.getCurrentUser().id,
      step:          1,
      source:        C.LOG_SOURCES.NETSUITE
    });

    try {
      task.create({
        taskType: task.TaskType.MAP_REDUCE,
        scriptId: 'customscript_oa_mr_notifications',
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
    form.clientScriptModulePath = '/SuiteScripts/OmnitApprovals/oa_client_script.js';
    const userId = runtime.getCurrentUser().id;
    const status = rec.getValue('approvalstatus');

    // ── OA info tab ──────────────────────────────────────────────────────────
    try {
      const oaTab = form.addTab({ id: 'custpage_oa_tab', label: 'Omnit Approvals' });
      const fg    = form.addFieldGroup({ id: 'custpage_oa_fg', label: 'Approval Status', tab: 'custpage_oa_tab' });

      const statusField = form.addField({ id: 'custpage_oa_status', type: serverWidget.FieldType.TEXT, label: 'Approval Status', container: 'custpage_oa_fg' });
      statusField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
      statusField.defaultValue = status === C.APPROVAL_STATUS.PENDING  ? 'Pending Approval'
                               : status === C.APPROVAL_STATUS.APPROVED ? 'Approved'
                               : status === C.APPROVAL_STATUS.REJECTED ? 'Rejected' : '—';

      const nextApproverId = rec.getValue('nextapprover');
      let nextApproverName = '—';
      if (nextApproverId) {
        try {
          const emp = search.lookupFields({ type: 'employee', id: nextApproverId, columns: ['firstname', 'lastname'] });
          nextApproverName = ((emp.firstname || '') + ' ' + (emp.lastname || '')).trim() || String(nextApproverId);
        } catch (e) { nextApproverName = String(nextApproverId); }
      }
      const approverField = form.addField({ id: 'custpage_oa_approver', type: serverWidget.FieldType.TEXT, label: 'Next Approver', container: 'custpage_oa_fg' });
      approverField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
      approverField.defaultValue = nextApproverName;

      // Submitted-by from OA log
      let submittedBy = '—';
      try {
        search.create({
          type:    C.RECORDS.LOG,
          filters: [[C.FIELDS.LOG.TRANSACTION, 'equalto', rec.id], 'AND', [C.FIELDS.LOG.ACTION, 'is', C.LOG_ACTIONS.SUBMITTED]],
          columns: [C.FIELDS.LOG.ACTOR]
        }).run().getRange({ start: 0, end: 1 }).forEach(r => { submittedBy = r.getText(C.FIELDS.LOG.ACTOR) || '—'; });
      } catch (e) { /* graceful */ }
      const submittedField = form.addField({ id: 'custpage_oa_submitted_by', type: serverWidget.FieldType.TEXT, label: 'Submitted By', container: 'custpage_oa_fg' });
      submittedField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
      submittedField.defaultValue = submittedBy;
    } catch (e) {
      log.error('OA-UE-LOAD: failed to add OA tab', e.message);
    }

    // Show history button when OA audit log entries exist for this record
    let hasLog = false;
    try {
      search.create({
        type:    C.RECORDS.LOG,
        filters: [[C.FIELDS.LOG.TRANSACTION, 'equalto', rec.id]],
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
    const canDelegate       = utils.parseBool(utils.lookupEmployeeField(userId, C.FIELDS.EMPLOYEE.CAN_DELEGATE));
    const isManager         = utils.parseBool(utils.lookupEmployeeField(userId, C.FIELDS.EMPLOYEE.IS_MANAGER));
    const isSuperApprover   = utils.parseBool(utils.lookupEmployeeField(userId, C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER));

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

    if (isSuperApprover && !isCurrentApprover) {
      form.addButton({ id: 'custpage_oa_super_approve', label: 'Super Approve', functionName: `OA_super_approve('${slUrl}')` });
      form.addButton({ id: 'custpage_oa_super_decline', label: 'Super Reject',  functionName: `OA_super_decline('${slUrl}')` });
    }
  }

  return { beforeSubmit, afterSubmit, beforeLoad };
});
