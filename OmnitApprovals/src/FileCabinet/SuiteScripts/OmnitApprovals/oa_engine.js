/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([
  'N/record',
  'N/search',
  'N/runtime',
  './lib/oa_constants',
  './lib/oa_utils'
], (record, search, runtime, C, utils) => {
  'use strict';

  // ─── Settings ────────────────────────────────────────────────────────────────

  function getSettingsForSubsidiary(subsidiaryId) {
    const results = [];
    search.create({
      type: C.RECORDS.SETTINGS,
      filters: [[C.FIELDS.SETTINGS.SUBSIDIARY, 'anyof', subsidiaryId]],
      columns: Object.values(C.FIELDS.SETTINGS)
    }).run().each(r => { results.push(r); return false; });

    if (!results.length) return null;
    const r = results[0];
    const obj = { id: r.id };
    Object.entries(C.FIELDS.SETTINGS).forEach(([k, fid]) => {
      const val = r.getValue(fid);
      obj[k.toLowerCase()] = val;
    });
    return obj;
  }

  // ─── Hierarchy ───────────────────────────────────────────────────────────────

  function getActiveHierarchy(settingsId, recordType) {
    const today = utils.today();
    const rtMap = {
      [C.RECORD_TYPES.PURCHASE_ORDER]: [C.HIERARCHY_RECORD_TYPES.PO,   C.HIERARCHY_RECORD_TYPES.BOTH],
      [C.RECORD_TYPES.VENDOR_BILL]:    [C.HIERARCHY_RECORD_TYPES.VB,   C.HIERARCHY_RECORD_TYPES.BOTH]
    };
    const validTypes = rtMap[recordType] || [];

    const filters = [
      [C.FIELDS.HIERARCHY.SETTINGS, 'anyof', settingsId],
      'AND',
      [C.FIELDS.HIERARCHY.STATUS, 'anyof', C.HIERARCHY_STATUS.ACTIVE],
      'AND',
      [C.FIELDS.HIERARCHY.RECORD_TYPE, 'anyof', validTypes],
      'AND',
      [C.FIELDS.HIERARCHY.START_DATE, 'onorbefore', 'today'],
      'AND',
      [[C.FIELDS.HIERARCHY.END_DATE, 'isempty', null], 'OR', [C.FIELDS.HIERARCHY.END_DATE, 'onorafter', 'today']]
    ];

    const hierarchies = [];
    search.create({
      type: C.RECORDS.HIERARCHY,
      filters,
      columns: Object.values(C.FIELDS.HIERARCHY)
    }).run().each(r => {
      hierarchies.push({
        id:          r.id,
        name:        r.getValue(C.FIELDS.HIERARCHY.NAME),
        highestOnly: r.getValue(C.FIELDS.HIERARCHY.HIGHEST_ONLY)
      });
      return true;
    });

    if (!hierarchies.length) return null;
    const h = hierarchies[0];

    // Load thresholds for this hierarchy, sorted by sort_order
    const thresholds = [];
    search.create({
      type: C.RECORDS.THRESHOLD,
      filters: [[C.FIELDS.THRESHOLD.HIERARCHY, 'equalto', h.id]],
      columns: Object.values(C.FIELDS.THRESHOLD)
    }).run().each(r => {
      thresholds.push({
        id:         r.id,
        label:      r.getValue(C.FIELDS.THRESHOLD.LABEL),
        minAmount:  parseFloat(r.getValue(C.FIELDS.THRESHOLD.MIN_AMOUNT)) || 0,
        maxAmount:  r.getValue(C.FIELDS.THRESHOLD.MAX_AMOUNT) ? parseFloat(r.getValue(C.FIELDS.THRESHOLD.MAX_AMOUNT)) : Infinity,
        approver:   r.getValue(C.FIELDS.THRESHOLD.APPROVER),
        approver2:  r.getValue(C.FIELDS.THRESHOLD.APPROVER2),
        sortOrder:  parseInt(r.getValue(C.FIELDS.THRESHOLD.SORT_ORDER), 10) || 0
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
    // Max 1 hop to prevent loops
    if (delegateTo) return delegateTo;
    return employeeId;
  }

  // ─── Routing ─────────────────────────────────────────────────────────────────

  function routeForApproval(recordType, recordId, subsidiaryId) {
    const settings = getSettingsForSubsidiary(subsidiaryId);
    if (!settings) return { error: 'NO_SETTINGS' };

    const rtEnabled = recordType === C.RECORD_TYPES.PURCHASE_ORDER
      ? settings.enable_po
      : settings.enable_vb;
    if (!rtEnabled) return { error: 'RECORD_TYPE_DISABLED' };

    const approverCount = parseInt(settings.approver_count, 10) || 1;
    let approver1 = null;
    let approver2 = null;
    let hierarchyId = null;

    if (settings.use_amount) {
      const hierarchy = getActiveHierarchy(settings.id, recordType);
      if (hierarchy) {
        hierarchyId = hierarchy.id;
        const amount = utils.getTransactionAmount(recordType, recordId);
        const matching = hierarchy.thresholds.filter(t => amount >= t.minAmount && amount <= t.maxAmount);

        if (hierarchy.highestOnly) {
          // Use only the threshold with the highest minAmount
          const highest = matching.reduce((best, t) => t.minAmount > (best ? best.minAmount : -1) ? t : best, null);
          if (highest) {
            approver1 = highest.approver;
            if (approverCount >= 2) approver2 = highest.approver2 || null;
          }
        } else {
          // Each threshold row carries both approvers
          if (matching[0]) {
            approver1 = matching[0].approver;
            if (approverCount >= 2) approver2 = matching[0].approver2 || null;
          }
        }
      }
    }

    // Fall back to default approvers
    if (!approver1) approver1 = settings.default_approver1 || null;
    if (!approver2 && approverCount >= 2) approver2 = settings.default_approver2 || null;

    // Resolve delegation (max 1 hop)
    approver1 = resolveApprover(approver1);
    approver2 = resolveApprover(approver2);

    return { approver1, approver2, hierarchyId, approverCount, settings };
  }

  // ─── Process Approval ────────────────────────────────────────────────────────

  function processApproval(recordId, recordType, actorId, step, source) {
    source = source || C.LOG_SOURCES.NETSUITE;
    const txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    const currentStep = parseInt(txn.getValue(C.FIELDS.TRANSACTION.CURRENT_STEP), 10) || 1;
    const approver1   = txn.getValue(C.FIELDS.TRANSACTION.APPROVER1);
    const approver2   = txn.getValue(C.FIELDS.TRANSACTION.APPROVER2);

    // Optimistic lock: ensure step hasn't changed under us
    if (currentStep !== step) return { success: false, message: 'Step mismatch — record may have already been processed.' };

    if (step === 1 && approver2) {
      // Advance to step 2
      txn.setValue({ fieldId: C.FIELDS.TRANSACTION.CURRENT_STEP, value: 2 });
      txn.setValue({ fieldId: 'nextapprover', value: approver2 });
      txn.save({ ignoreMandatoryFields: true });
      createAuditLog({ transactionId: recordId, action: C.LOG_ACTIONS.APPROVED, actorId, step: 1, source });
      return { success: true, nextStep: 2, message: 'Advanced to step 2.' };
    }

    // Final approval
    txn.setValue({ fieldId: 'approvalstatus', value: C.APPROVAL_STATUS.APPROVED });
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.APPROVAL_TOKEN, value: '' });
    txn.save({ ignoreMandatoryFields: true });
    createAuditLog({ transactionId: recordId, action: C.LOG_ACTIONS.APPROVED, actorId, step, source });
    return { success: true, nextStep: null, message: 'Transaction approved.' };
  }

  // ─── Process Decline ─────────────────────────────────────────────────────────

  function processDecline(recordId, recordType, actorId, comment, source) {
    source = source || C.LOG_SOURCES.NETSUITE;
    const txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    const step = parseInt(txn.getValue(C.FIELDS.TRANSACTION.CURRENT_STEP), 10) || 1;

    txn.setValue({ fieldId: 'approvalstatus', value: C.APPROVAL_STATUS.REJECTED });
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.APPROVAL_TOKEN, value: '' });
    txn.save({ ignoreMandatoryFields: true });

    createAuditLog({ transactionId: recordId, action: C.LOG_ACTIONS.REJECTED, actorId, step, comment, source });

    // Identify fallback managers for notification (returned to caller for scheduling)
    return { success: true, message: 'Transaction rejected.' };
  }

  // ─── Process Delegation ──────────────────────────────────────────────────────

  function processDelegation(recordId, recordType, actorId, targetId) {
    const canDelegate = utils.lookupEmployeeField(actorId, C.FIELDS.EMPLOYEE.CAN_DELEGATE);
    const targetIsApprover = utils.lookupEmployeeField(targetId, C.FIELDS.EMPLOYEE.IS_APPROVER);
    if (!canDelegate) return { success: false, message: 'Actor cannot delegate.' };
    if (!targetIsApprover) return { success: false, message: 'Target is not an approver.' };

    const txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    const step = parseInt(txn.getValue(C.FIELDS.TRANSACTION.CURRENT_STEP), 10) || 1;
    const stepField = step === 1 ? C.FIELDS.TRANSACTION.APPROVER1 : C.FIELDS.TRANSACTION.APPROVER2;

    txn.setValue({ fieldId: stepField, value: targetId });
    txn.setValue({ fieldId: 'nextapprover', value: targetId });
    txn.save({ ignoreMandatoryFields: true });

    createAuditLog({ transactionId: recordId, action: C.LOG_ACTIONS.DELEGATED, actorId, targetId, step });
    return { success: true, message: 'Delegated successfully.' };
  }

  // ─── Process Reset (Manager) ─────────────────────────────────────────────────

  function processReset(recordId, recordType, managerId, newApproverId) {
    const isManager = utils.lookupEmployeeField(managerId, C.FIELDS.EMPLOYEE.IS_MANAGER);
    if (!isManager) return { success: false, message: 'Actor is not a manager.' };

    const txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.CURRENT_STEP, value: 1 });
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.APPROVER1,    value: newApproverId });
    txn.setValue({ fieldId: 'approvalstatus', value: C.APPROVAL_STATUS.PENDING });
    txn.setValue({ fieldId: 'nextapprover',   value: newApproverId });
    txn.save({ ignoreMandatoryFields: true });

    createAuditLog({ transactionId: recordId, action: C.LOG_ACTIONS.RESET, actorId: managerId, targetId: newApproverId, step: 1 });
    return { success: true, message: 'Flow reset with new approver.' };
  }

  // ─── Audit Log ───────────────────────────────────────────────────────────────

  function createAuditLog(p) {
    const log = record.create({ type: C.RECORDS.LOG, isDynamic: false });
    log.setValue({ fieldId: C.FIELDS.LOG.TRANSACTION, value: p.transactionId });
    log.setValue({ fieldId: C.FIELDS.LOG.ACTION,      value: p.action });
    log.setValue({ fieldId: C.FIELDS.LOG.ACTOR,       value: p.actorId });
    log.setValue({ fieldId: C.FIELDS.LOG.STEP,        value: p.step || 1 });
    log.setValue({ fieldId: C.FIELDS.LOG.SOURCE,      value: p.source || C.LOG_SOURCES.NETSUITE });
    if (p.targetId) log.setValue({ fieldId: C.FIELDS.LOG.TARGET,   value: p.targetId });
    if (p.comment)  log.setValue({ fieldId: C.FIELDS.LOG.COMMENT,  value: p.comment });
    return log.save();
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
    createAuditLog
  };
});
