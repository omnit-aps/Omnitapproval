/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([
  'N/record',
  'N/search',
  'N/runtime',
  'N/task',
  './lib/oa_constants',
  './lib/oa_utils'
], (record, search, runtime, task, C, utils) => {
  'use strict';

  // ─── Settings ────────────────────────────────────────────────────────────────

  function getSettingsForSubsidiary(subsidiaryId) {
    const results = [];
    search.create({
      type:    C.RECORDS.SETTINGS,
      filters: [
        [C.FIELDS.SETTINGS.SUBSIDIARY, 'anyof', subsidiaryId],
        'AND',
        ['isinactive', 'is', 'F']
      ],
      columns: Object.values(C.FIELDS.SETTINGS)
    }).run().each(r => { results.push(r); return true; });

    if (!results.length) return null;
    if (results.length > 1) {
      results.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
      log.error('OA: Multiple active settings records for subsidiary ' + subsidiaryId + ' — using id=' + results[0].id);
    }
    const r   = results[0];
    const obj = { id: r.id };
    Object.entries(C.FIELDS.SETTINGS).forEach(([k, fid]) => {
      obj[k.toLowerCase()] = r.getValue(fid);
    });
    return obj;
  }

  // ─── Hierarchy ───────────────────────────────────────────────────────────────

  function getActiveHierarchy(settingsId, recordType) {
    const rtMap = {
      [C.RECORD_TYPES.PURCHASE_ORDER]: [C.HIERARCHY_RECORD_TYPES.PO,   C.HIERARCHY_RECORD_TYPES.BOTH],
      [C.RECORD_TYPES.VENDOR_BILL]:    [C.HIERARCHY_RECORD_TYPES.VB,   C.HIERARCHY_RECORD_TYPES.BOTH]
    };
    const validTypes = rtMap[recordType] || [];
    if (!validTypes.length) return null;

    // STATUS and RECORD_TYPE are TEXT fields — must use 'is', not 'anyof' (anyof on TEXT silently returns 0 matches)
    const filters = [
      [C.FIELDS.HIERARCHY.SETTINGS, 'equalto', settingsId],
      'AND',
      [C.FIELDS.HIERARCHY.STATUS, 'is', C.HIERARCHY_STATUS.ACTIVE],
      'AND',
      [[C.FIELDS.HIERARCHY.RECORD_TYPE, 'is', validTypes[0]], 'OR', [C.FIELDS.HIERARCHY.RECORD_TYPE, 'is', validTypes[1]]],
      'AND',
      [C.FIELDS.HIERARCHY.START_DATE, 'onorbefore', 'today'],
      'AND',
      [[C.FIELDS.HIERARCHY.END_DATE, 'isempty', null], 'OR', [C.FIELDS.HIERARCHY.END_DATE, 'onorafter', 'today']]
    ];

    const hierarchies = [];
    search.create({
      type:    C.RECORDS.HIERARCHY,
      filters,
      columns: Object.values(C.FIELDS.HIERARCHY)
    }).run().each(r => {
      hierarchies.push({
        id:          r.id,
        name:        r.getValue(C.FIELDS.HIERARCHY.NAME),
        recordType:  r.getValue(C.FIELDS.HIERARCHY.RECORD_TYPE),
        highestOnly: utils.parseBool(r.getValue(C.FIELDS.HIERARCHY.HIGHEST_ONLY)),
        priority:    parseInt(r.getValue(C.FIELDS.HIERARCHY.PRIORITY), 10) || 10
      });
      return true;
    });

    if (!hierarchies.length) return null;
    // Sort: lowest priority number wins (1 = highest priority, default 10).
    // Tie-break 1: specific record type (PO/VB) beats BOTH.
    // Tie-break 2: lowest internal id (oldest record) for full determinism.
    hierarchies.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const aGeneral = a.recordType === C.HIERARCHY_RECORD_TYPES.BOTH ? 1 : 0;
      const bGeneral = b.recordType === C.HIERARCHY_RECORD_TYPES.BOTH ? 1 : 0;
      if (aGeneral !== bGeneral) return aGeneral - bGeneral;
      return a.id - b.id;
    });
    const h = hierarchies[0];

    const thresholds = [];
    search.create({
      type:    C.RECORDS.THRESHOLD,
      filters: [[C.FIELDS.THRESHOLD.HIERARCHY, 'equalto', h.id]],
      columns: Object.values(C.FIELDS.THRESHOLD)
    }).run().each(r => {
      thresholds.push({
        id:        r.id,
        label:     r.getValue(C.FIELDS.THRESHOLD.LABEL),
        minAmount: parseFloat(r.getValue(C.FIELDS.THRESHOLD.MIN_AMOUNT)) || 0,
        maxAmount: r.getValue(C.FIELDS.THRESHOLD.MAX_AMOUNT) ? parseFloat(r.getValue(C.FIELDS.THRESHOLD.MAX_AMOUNT)) : Infinity,
        approver:  r.getValue(C.FIELDS.THRESHOLD.APPROVER),
        approver2: r.getValue(C.FIELDS.THRESHOLD.APPROVER2),
        sortOrder: parseInt(r.getValue(C.FIELDS.THRESHOLD.SORT_ORDER), 10) || 0
      });
      return true;
    });

    thresholds.sort((a, b) => a.sortOrder - b.sortOrder);
    h.thresholds = thresholds;
    return h;
  }

  // ─── Delegation ──────────────────────────────────────────────────────────────

  function resolveApprover(employeeId) {
    if (!employeeId) return null;
    const delegateTo = utils.lookupEmployeeField(employeeId, C.FIELDS.EMPLOYEE.DELEGATE_TO);
    if (delegateTo) return delegateTo;
    return employeeId;
  }

  // ─── Routing ─────────────────────────────────────────────────────────────────

  function routeForApproval(recordType, recordId, subsidiaryId, amountOverride) {
    const settings = getSettingsForSubsidiary(subsidiaryId);
    if (!settings) {
      log.audit('OA-ENGINE routeForApproval', { recordType, recordId, subsidiaryId, error: 'NO_SETTINGS' });
      return { error: 'NO_SETTINGS' };
    }

    const rtEnabled = recordType === C.RECORD_TYPES.PURCHASE_ORDER
      ? utils.parseBool(settings.enable_po)
      : utils.parseBool(settings.enable_vb);
    if (!rtEnabled) {
      log.audit('OA-ENGINE routeForApproval', { recordType, recordId, subsidiaryId, error: 'RECORD_TYPE_DISABLED' });
      return { error: 'RECORD_TYPE_DISABLED' };
    }

    const approverCount = parseInt(settings.approver_count, 10) || 1;
    let approver1 = null;
    let approver2 = null;
    let hierarchyId = null;
    let matchedThresholdId = null;
    let amount = null;

    if (utils.parseBool(settings.use_amount)) {
      const hierarchy = getActiveHierarchy(settings.id, recordType);
      if (hierarchy) {
        hierarchyId = hierarchy.id;
        amount = (typeof amountOverride === 'number') ? amountOverride : utils.getTransactionAmount(recordType, recordId);
        const matching = hierarchy.thresholds.filter(t => amount >= t.minAmount && amount <= t.maxAmount);

        let matched = null;
        if (hierarchy.highestOnly) {
          matched = matching.reduce((best, t) => !best || t.minAmount > best.minAmount ? t : best, null);
        } else {
          matched = matching[0] || null;
        }
        if (matched) {
          matchedThresholdId = matched.id || null;
          approver1 = matched.approver;
          if (approverCount >= 2) approver2 = matched.approver2 || null;
        }
      }
    }

    if (!approver1) approver1 = settings.default_approver1 || null;
    if (!approver2 && approverCount >= 2) approver2 = settings.default_approver2 || null;

    approver1 = resolveApprover(approver1);
    approver2 = resolveApprover(approver2);

    log.audit('OA-ENGINE routeForApproval', {
      recordType, recordId, subsidiaryId,
      use_amount: !!settings.use_amount,
      amount, hierarchyId, matchedThresholdId,
      approver1, approver2, approverCount,
      defaultApprover1: settings.default_approver1,
      defaultApprover2: settings.default_approver2
    });

    return { approver1, approver2, hierarchyId, approverCount, settings };
  }

  // ─── Step helper ─────────────────────────────────────────────────────────────

  function _countApprovedLogs(recordId) {
    // Count both normal approvals and super approver overrides — ACTION is a TEXT field.
    let count = 0;
    search.create({
      type:    C.RECORDS.LOG,
      filters: [
        [C.FIELDS.LOG.TRANSACTION, 'equalto', recordId],
        'AND',
        [[C.FIELDS.LOG.ACTION, 'is', C.LOG_ACTIONS.APPROVED], 'OR', [C.FIELDS.LOG.ACTION, 'is', C.LOG_ACTIONS.SUPER_APPROVED]]
      ],
      columns: ['internalid']
    }).run().each(() => { count++; return true; });
    return count;
  }

  // ─── Process Approval ────────────────────────────────────────────────────────

  function processApproval(recordId, recordType, actorId, source, superComment) {
    source = source || C.LOG_SOURCES.NETSUITE;
    let txn;
    try {
      txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    } catch (e) {
      return { success: false, message: 'Record not found.' };
    }

    const currentApprover = txn.getValue('nextapprover');
    const approvalStatus  = txn.getValue('approvalstatus');

    if (approvalStatus !== C.APPROVAL_STATUS.PENDING) {
      return { success: false, message: 'Transaction is not pending approval.' };
    }

    const isSuperOverride = !currentApprover || String(currentApprover) !== String(actorId);
    if (isSuperOverride) {
      if (!_isSuperApprover(actorId)) {
        return { success: false, message: 'You are not the assigned approver for this step.' };
      }
      if (!superComment || !superComment.trim()) {
        return { success: false, message: 'Super approver override requires a written justification.' };
      }
    }

    const step = _countApprovedLogs(recordId) + 1;

    if (!isSuperOverride) {
      // Normal flow: check if a step-2 approver is needed
      const subsidiaryId = utils.getTransactionSubsidiary(recordType, recordId);
      const routing      = routeForApproval(recordType, recordId, subsidiaryId);

      if (!routing.error && routing.approverCount >= 2 && step === 1 && routing.approver2) {
        _setNextApprover(txn, routing.approver2);
        try {
          txn.save({ ignoreMandatoryFields: true });
        } catch (e) {
          log.error('OA: save failed advancing to step 2', `recordId=${recordId}: ${e.message}`);
          return { success: false, message: 'Save failed: ' + e.message };
        }
        createAuditLog({ transactionId: recordId, action: C.LOG_ACTIONS.APPROVED, actorId, step: 1, source });
        _scheduleNotification(recordId, recordType);
        return { success: true, nextStep: 2, message: 'Advanced to step 2.' };
      }
    }

    // Final approval (normal or super override)
    txn.setValue({ fieldId: 'approvalstatus', value: C.APPROVAL_STATUS.APPROVED });
    _setNextApprover(txn, null);
    try {
      txn.save({ ignoreMandatoryFields: true });
    } catch (e) {
      log.error('OA: save failed on final approval', `recordId=${recordId}: ${e.message}`);
      return { success: false, message: 'Save failed: ' + e.message };
    }
    const logAction = isSuperOverride ? C.LOG_ACTIONS.SUPER_APPROVED : C.LOG_ACTIONS.APPROVED;
    createAuditLog({ transactionId: recordId, action: logAction, actorId, step, source, comment: superComment || undefined });
    return { success: true, nextStep: null, message: 'Transaction approved.' };
  }

  // ─── Process Decline ─────────────────────────────────────────────────────────

  function processDecline(recordId, recordType, actorId, comment, source, isSuperOverride) {
    source = source || C.LOG_SOURCES.NETSUITE;
    let txn;
    try {
      txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    } catch (e) {
      return { success: false, message: 'Record not found.' };
    }

    const currentApprover = txn.getValue('nextapprover');
    const approvalStatus  = txn.getValue('approvalstatus');

    if (approvalStatus !== C.APPROVAL_STATUS.PENDING) {
      return { success: false, message: 'Transaction is not pending approval.' };
    }

    const isNotAssigned = !currentApprover || String(currentApprover) !== String(actorId);
    if (isNotAssigned) {
      if (!isSuperOverride || !_isSuperApprover(actorId)) {
        return { success: false, message: 'You are not the assigned approver for this step.' };
      }
      if (!comment || !comment.trim()) {
        return { success: false, message: 'Super approver override requires a written justification.' };
      }
    }

    const step = _countApprovedLogs(recordId) + 1;

    txn.setValue({ fieldId: 'approvalstatus', value: C.APPROVAL_STATUS.REJECTED });
    _setNextApprover(txn, null);
    try {
      txn.save({ ignoreMandatoryFields: true });
    } catch (e) {
      log.error('OA: save failed on decline', `recordId=${recordId}: ${e.message}`);
      return { success: false, message: 'Save failed: ' + e.message };
    }
    const logAction = (isNotAssigned && isSuperOverride) ? C.LOG_ACTIONS.SUPER_REJECTED : C.LOG_ACTIONS.REJECTED;
    createAuditLog({ transactionId: recordId, action: logAction, actorId, step, comment, source });
    return { success: true, message: 'Transaction rejected.' };
  }

  // ─── Process Delegation ──────────────────────────────────────────────────────

  function processDelegation(recordId, recordType, actorId, targetId) {
    const canDelegate      = utils.parseBool(utils.lookupEmployeeField(actorId,  C.FIELDS.EMPLOYEE.CAN_DELEGATE));
    const targetIsApprover = utils.parseBool(utils.lookupEmployeeField(targetId, C.FIELDS.EMPLOYEE.IS_APPROVER));
    if (!canDelegate)      return { success: false, message: 'Actor cannot delegate.' };
    if (!targetIsApprover) return { success: false, message: 'Target is not an approver.' };

    let txn;
    try {
      txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    } catch (e) {
      return { success: false, message: 'Record not found.' };
    }

    const currentApprover = txn.getValue('nextapprover');
    if (!currentApprover || String(currentApprover) !== String(actorId)) {
      return { success: false, message: 'You are not the assigned approver for this step.' };
    }
    if (txn.getValue('approvalstatus') !== C.APPROVAL_STATUS.PENDING) {
      return { success: false, message: 'Transaction is not pending approval.' };
    }

    const step = _countApprovedLogs(recordId) + 1;
    _setNextApprover(txn, targetId);
    try {
      txn.save({ ignoreMandatoryFields: true });
    } catch (e) {
      log.error('OA: save failed on delegation', `recordId=${recordId}: ${e.message}`);
      return { success: false, message: 'Save failed: ' + e.message };
    }

    createAuditLog({ transactionId: recordId, action: C.LOG_ACTIONS.DELEGATED, actorId, targetId, step });
    _scheduleNotification(recordId, recordType);
    return { success: true, message: 'Delegated successfully.' };
  }

  // ─── Process Reset (Manager) ─────────────────────────────────────────────────

  function processReset(recordId, recordType, managerId, newApproverId) {
    const isManager        = utils.parseBool(utils.lookupEmployeeField(managerId,      C.FIELDS.EMPLOYEE.IS_MANAGER));
    const targetIsApprover = utils.parseBool(utils.lookupEmployeeField(newApproverId,  C.FIELDS.EMPLOYEE.IS_APPROVER));
    if (!isManager)        return { success: false, message: 'Actor is not a manager.' };
    if (!targetIsApprover) return { success: false, message: 'New approver does not have approver access.' };

    let txn;
    try {
      txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    } catch (e) {
      return { success: false, message: 'Record not found.' };
    }

    txn.setValue({ fieldId: 'approvalstatus', value: C.APPROVAL_STATUS.PENDING });
    _setNextApprover(txn, newApproverId);
    try {
      txn.save({ ignoreMandatoryFields: true });
    } catch (e) {
      log.error('OA: save failed on reset', `recordId=${recordId}: ${e.message}`);
      return { success: false, message: 'Save failed: ' + e.message };
    }

    createAuditLog({ transactionId: recordId, action: C.LOG_ACTIONS.RESET, actorId: managerId, targetId: newApproverId, step: 1 });
    _scheduleNotification(recordId, recordType);
    return { success: true, message: 'Flow reset with new approver.' };
  }

  // ─── Process Reassign (Manager) ──────────────────────────────────────────────
  // Like reset but keeps current approval status + step — only swaps the approver.

  function processReassign(recordId, recordType, managerId, newApproverId) {
    const isManager        = utils.parseBool(utils.lookupEmployeeField(managerId,      C.FIELDS.EMPLOYEE.IS_MANAGER));
    const targetIsApprover = utils.parseBool(utils.lookupEmployeeField(newApproverId,  C.FIELDS.EMPLOYEE.IS_APPROVER));
    if (!isManager)        return { success: false, message: 'Actor is not a manager.' };
    if (!targetIsApprover) return { success: false, message: 'New approver does not have approver access.' };

    let txn;
    try {
      txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    } catch (e) {
      return { success: false, message: 'Record not found.' };
    }

    if (txn.getValue('approvalstatus') !== C.APPROVAL_STATUS.PENDING) {
      return { success: false, message: 'Transaction is not pending — cannot reassign.' };
    }

    const step = _countApprovedLogs(recordId) + 1;
    _setNextApprover(txn, newApproverId);
    try {
      txn.save({ ignoreMandatoryFields: true });
    } catch (e) {
      log.error('OA: save failed on reassign', `recordId=${recordId}: ${e.message}`);
      return { success: false, message: 'Save failed: ' + e.message };
    }

    createAuditLog({ transactionId: recordId, action: C.LOG_ACTIONS.REASSIGNED, actorId: managerId, targetId: newApproverId, step });
    _scheduleNotification(recordId, recordType);
    return { success: true, message: 'Reassigned to new approver.' };
  }

  // ─── Audit Log ───────────────────────────────────────────────────────────────

  function createAuditLog(p) {
    try {
      const rec = record.create({ type: C.RECORDS.LOG, isDynamic: false });
      rec.setValue({ fieldId: C.FIELDS.LOG.TRANSACTION, value: p.transactionId });
      rec.setValue({ fieldId: C.FIELDS.LOG.ACTION,      value: p.action });
      // actor is mandatory in SDF + employee SELECT — only set if it's a valid (positive) employee ID.
      // System users like -5 (admin) are not valid employee records and would cause save() to throw.
      const actorIdNum = parseInt(p.actorId, 10);
      if (actorIdNum > 0) {
        rec.setValue({ fieldId: C.FIELDS.LOG.ACTOR, value: actorIdNum });
      }
      rec.setValue({ fieldId: C.FIELDS.LOG.STEP,        value: p.step || 1 });
      rec.setValue({ fieldId: C.FIELDS.LOG.SOURCE,      value: p.source || C.LOG_SOURCES.NETSUITE });
      if (p.targetId) rec.setValue({ fieldId: C.FIELDS.LOG.TARGET,   value: p.targetId });
      if (p.comment)  rec.setValue({ fieldId: C.FIELDS.LOG.COMMENT,  value: p.comment });
      rec.setValue({ fieldId: C.FIELDS.LOG.TIMESTAMP, value: new Date() });
      const id = rec.save({ ignoreMandatoryFields: true });
      log.audit('OA-ENGINE createAuditLog ok', { logId: id, transactionId: p.transactionId, action: p.action, actorId: actorIdNum });
      return id;
    } catch (e) {
      log.error('OA: Audit log save failed', { error: e.message, params: p });
      return null;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function _isSuperApprover(actorId) {
    return utils.parseBool(utils.lookupEmployeeField(actorId, C.FIELDS.EMPLOYEE.IS_SUPER_APPROVER));
  }

  function _setNextApprover(txn, employeeId) {
    try {
      txn.setValue({ fieldId: 'nextapprover', value: employeeId });
      const readback = txn.getValue('nextapprover');
      log.audit('OA-ENGINE _setNextApprover ok', { attempted: employeeId, readback, recordType: txn.type, recordId: txn.id });
    } catch (e) {
      log.audit('OA-ENGINE _setNextApprover FAILED', { attempted: employeeId, recordType: txn.type, recordId: txn.id, errorName: e.name, errorMessage: e.message });
    }
  }

  function _scheduleNotification(recordId, recordType) {
    try {
      // No deploymentId: let NS pick any available deployment so a busy deployment
      // does not block notifications queued from concurrent approvals.
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

  return {
    getSettingsForSubsidiary,
    getActiveHierarchy,
    resolveApprover,
    routeForApproval,
    processApproval,
    processDecline,
    processDelegation,
    processReset,
    processReassign,
    createAuditLog
  };
});
