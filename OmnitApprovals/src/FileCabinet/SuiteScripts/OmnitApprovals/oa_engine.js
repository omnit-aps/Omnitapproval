/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([
  'N/record',
  'N/search',
  'N/runtime',
  'N/task',
  'N/error',
  './lib/oa_constants',
  './lib/oa_utils'
], (record, search, runtime, task, error, C, utils) => {
  'use strict';

  // ─── M-3 active-approver guard ──────────────────────────────────────────────
  //
  // Live evidence (td3075893): with Adam Minister (id 201) inactive, a $750
  // bill on subsidiary 1 triggered NS native USER_ERROR
  // "Invalid Field Value 201 for the following field: custbody_oa_next_approver"
  // — a generic platform error rather than a domain-specific OA error. UAT
  // engineers couldn't tell whether they'd hit a config bug, a custom-field
  // misconfiguration, or a runtime regression.
  //
  // assertActiveEmployeeApprover throws:
  //   OA_INVALID_APPROVER   for null / 0 / undefined IDs
  //   OA_INACTIVE_APPROVER  for positive IDs of inactive employees
  // Negative IDs (e.g., -5 Kathryn in td3075893 demo seed) are allowed —
  // production NS records have positive IDs, but seed and system users
  // sometimes have negative IDs and we don't want to break demo/test
  // environments. Each negative-ID call audits OA_NEGATIVE_APPROVER_ID so
  // that a misconfigured production setup is still detectable in logs.
  //
  // Memoised via a module-scoped Map so the same employee is only looked up
  // once per script execution. SuiteScript loads modules fresh per execution,
  // so the cache resets naturally between invocations.

  const activeCheckCache = new Map();

  function assertActiveEmployeeApprover(employeeId, label) {
    if (employeeId === null || employeeId === undefined || employeeId === '' || employeeId === 0 || employeeId === '0') {
      throw error.create({
        name:    'OA_INVALID_APPROVER',
        message: 'OmnitApprovals approver "' + (label || 'approver') +
                 '" is not configured (got ' + JSON.stringify(employeeId) + ').',
        notifyOff: true
      });
    }

    const idNum = parseInt(employeeId, 10);
    if (isNaN(idNum)) {
      throw error.create({
        name:    'OA_INVALID_APPROVER',
        message: 'OmnitApprovals approver "' + (label || 'approver') +
                 '" is not a numeric employee ID (got ' + JSON.stringify(employeeId) + ').',
        notifyOff: true
      });
    }

    if (idNum < 0) {
      log.audit('OA-ENGINE OA_NEGATIVE_APPROVER_ID (allowed; demo/system seed user)', { employeeId: idNum, label });
      return;
    }

    if (activeCheckCache.has(idNum)) {
      const cached = activeCheckCache.get(idNum);
      if (!cached.valid) {
        throw error.create({
          name:    'OA_INACTIVE_APPROVER',
          message: 'Approver ' + idNum + ' (' + (cached.name || 'unknown') +
                   ') is inactive. Update the threshold/default approver in settings, ' +
                   'or contact your administrator.',
          notifyOff: true
        });
      }
      return;
    }

    let result;
    try {
      result = search.lookupFields({
        type:    'employee',
        id:      idNum,
        columns: ['isinactive', 'firstname', 'lastname']
      });
    } catch (e) {
      // Lookup itself failed (employee record may not exist, or NS hiccupped).
      // Fail closed: a missing employee record is a domain error too.
      log.error('OA-ENGINE assertActiveEmployeeApprover lookup failed', {
        employeeId: idNum, label, err: e.message
      });
      throw error.create({
        name:    'OA_INVALID_APPROVER',
        message: 'OmnitApprovals could not validate approver ' + idNum +
                 ' (' + (label || 'approver') + '): ' + e.message,
        notifyOff: true
      });
    }

    const isInactive = utils.parseBool(result.isinactive);
    const name       = ((result.firstname || '') + ' ' + (result.lastname || '')).trim();
    activeCheckCache.set(idNum, { valid: !isInactive, name });

    if (isInactive) {
      throw error.create({
        name:    'OA_INACTIVE_APPROVER',
        message: 'Approver ' + idNum + ' (' + (name || 'unknown') + ') is inactive. ' +
                 'Update the threshold/default approver in settings, or contact your administrator.',
        notifyOff: true
      });
    }
  }

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

  // ─── Threshold matching ──────────────────────────────────────────────────────
  //
  // Standardized to half-open [min, max): a threshold matches when
  //   amount >= minAmount  AND  amount < maxAmount
  //
  // Inclusive on the lower bound, EXCLUSIVE on the upper. This makes adjacent
  // thresholds (e.g. 0–500, 500–5000, 5000+) cover the number line exactly once
  // — no gaps, no double-matches at the boundary. A threshold with no maxAmount
  // matches up to +Infinity.
  //
  // Pre-fix code used inclusive-inclusive [min, max] which caused 500.00 and
  // 5000.00 to match two adjacent rules simultaneously. With sortOrder
  // tie-breaking the actual approver was deterministic but the boundary
  // semantics were ambiguous and produced confusing audit logs.

  function matchThresholds(thresholds, amount) {
    return (thresholds || []).filter(t => amount >= t.minAmount && amount < t.maxAmount);
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
    // arguments.length tells us whether the caller passed amountOverride at all.
    // An *explicit* `undefined` is a real upstream failure ("I tried to compute it
    // and got nothing") and must be rejected, not silently re-fetched. A
    // 3-argument call ("don't have it, look it up") is the route the engine takes
    // when invoked from processApproval / processDecline / processReassign.
    const overrideProvided = arguments.length >= 4;
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
    let hierarchyName = null;
    let matchedThresholdId = null;
    let amount = null;

    // ── M-5 strict tri-state matrix classifier ──────────────────────────────
    //
    // Live evidence (td3075893): pre-fix, $499.99 fell into a threshold gap on
    // hierarchy 2 and silently routed via DEFAULT to Aaron — masquerading as a
    // successful route. Per Jonas: "default approver in the setup should ONLY
    // be used if an approval matrix is not covering who to approve." Falling
    // back to default when an in-scope matrix has a hole is a bug, not a
    // feature.
    //
    // Tri-state:
    //   HIERARCHY              — active hierarchy for (sub, recordType) AND a
    //                            threshold row matched the amount.
    //   NO_MATRIX_IN_SCOPE     — use_amount=F OR no active hierarchy →
    //                            fall to settings.default_approver1.
    //   MATRIX_IN_SCOPE_NO_MATCH — active hierarchy exists AND amount fell in
    //                            a gap → throw NO_THRESHOLD_MATCH.
    //
    // use_amount=F is preserved as the intentional "always use default" knob
    // for clients with no matrix; it short-circuits the in-scope check.
    const useAmount = utils.parseBool(settings.use_amount);
    let matrixInScope = false;
    let hierarchy = null;

    if (useAmount) {
      hierarchy = getActiveHierarchy(settings.id, recordType);
      if (hierarchy) {
        matrixInScope = true;
        hierarchyId   = hierarchy.id;
        hierarchyName = hierarchy.name;
      }
    }

    if (matrixInScope) {
      // No 4th argument -> look it up from the record.
      // 4th argument provided (even if null/undefined) -> trust the caller and validate.
      if (!overrideProvided) {
        amount = utils.getTransactionAmount(recordType, recordId);
      } else {
        amount = amountOverride;
      }

      // Reject inputs that cannot be matched against any band:
      //   null / undefined  -> caller failed to read total, refuse
      //   NaN               -> parse failure upstream, refuse
      //   negative          -> credit notes / reversals — opt-in via
      //                        custrecord_oa_allow_negative_amount only
      if (amount === null || amount === undefined || (typeof amount !== 'number') || isNaN(amount)) {
        log.error('OA-ENGINE INVALID_AMOUNT', { recordType, recordId, subsidiaryId, amount });
        return { error: 'INVALID_AMOUNT', amount };
      }
      if (amount < 0 && !utils.parseBool(settings.allow_negative_amount)) {
        log.error('OA-ENGINE NEGATIVE_AMOUNT_REJECTED', { recordType, recordId, subsidiaryId, amount });
        return { error: 'NEGATIVE_AMOUNT_REJECTED', amount };
      }

      const matching = matchThresholds(hierarchy.thresholds, amount);
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
      } else {
        // M-5: matrix is in scope, but the amount fell into a gap between rows
        // (or below the lowest minAmount, or above the highest maxAmount where
        // no row covers it). DO NOT fall through to defaults — defaults are
        // for the no-matrix case only. Hard-fail with a code the UE turns into
        // OA_NO_THRESHOLD_MATCH so the bill cannot save.
        log.error('OA-ENGINE NO_THRESHOLD_MATCH (matrix in scope, no row matched)', {
          recordType, recordId, subsidiaryId,
          hierarchyId, hierarchyName, amount,
          rowCount: hierarchy.thresholds.length
        });
        return {
          error:         'NO_THRESHOLD_MATCH',
          hierarchyId,
          hierarchyName,
          amount,
          thresholdRowCount: hierarchy.thresholds.length
        };
      }
    }

    // From here, either use_amount=F, or use_amount=T with no active hierarchy
    // (NO_MATRIX_IN_SCOPE). In both cases falling back to defaults is the
    // intended outcome.
    const ruleMatched = !!approver1;

    // M-1 route_source provenance. Tracks WHY this approver was picked, so audit
    // can answer the question custbody_oa_hierarchy_used can't on default-routed
    // bills (where hierarchyId is null and the field stays empty):
    //   HIERARCHY — a threshold rule matched
    //   DEFAULT   — fell back to settings.default_approver1
    //   FAILSAFE  — reserved for future "no rule, no default, super-approver" flow
    let routeSource = null;
    if (ruleMatched) routeSource = C.ROUTE_SOURCES.HIERARCHY;

    if (!approver1) approver1 = settings.default_approver1 || null;
    if (!approver2 && approverCount >= 2) approver2 = settings.default_approver2 || null;

    if (!routeSource && approver1) routeSource = C.ROUTE_SOURCES.DEFAULT;

    approver1 = resolveApprover(approver1);
    approver2 = resolveApprover(approver2);

    // M-3: validate the FINAL resolved approvers (post-delegation). A delegate
    // target who is inactive should fail just as cleanly as an inactive
    // primary — both produce an unsuable next_approver.
    try {
      if (approver1) assertActiveEmployeeApprover(approver1, 'approver1');
      if (approver2) assertActiveEmployeeApprover(approver2, 'approver2');
    } catch (e) {
      // Convert to engine error-code convention so the UE consumer can
      // surface a domain-specific throw via its existing translation table.
      log.error('OA-ENGINE approver validation failed', { name: e.name, message: e.message, approver1, approver2 });
      return { error: e.name === 'OA_INACTIVE_APPROVER' ? 'INACTIVE_APPROVER' : 'INVALID_APPROVER',
               message: e.message,
               approver1, approver2 };
    }

    log.audit('OA-ENGINE routeForApproval', {
      recordType, recordId, subsidiaryId,
      use_amount: !!settings.use_amount,
      amount, hierarchyId, matchedThresholdId,
      ruleMatched, routeSource,
      approver1, approver2, approverCount,
      defaultApprover1: settings.default_approver1,
      defaultApprover2: settings.default_approver2
    });

    if (!approver1) {
      log.error('OA-ENGINE NO_RULE_MATCH', {
        recordType, recordId, subsidiaryId, amount, hierarchyId,
        matchedThresholdId, defaultApprover1: settings.default_approver1
      });
      return { error: 'NO_RULE_MATCH', hierarchyId, amount };
    }

    return { approver1, approver2, hierarchyId, approverCount, settings, routeSource };
  }

  // ─── Optimistic concurrency ──────────────────────────────────────────────────
  //
  // Two approvers loading the same bill, both clicking Approve at roughly the
  // same moment, both posting through the same RESTlet — pre-fix code happily
  // wrote both transitions and produced two APPROVED audit rows for one bill.
  // Worse, in step-2 flows you could land in step 2 then step 2 again instead
  // of step 1 -> step 2.
  //
  // Each protected transition (approve, decline, reset, reassign, delegate)
  // now goes through _concurrencyCheckAndBump:
  //   1. Capture loadedVersion = txn.getValue('custbody_oa_state_version').
  //   2. Apply business changes to txn.
  //   3. Re-read the *persisted* version with lookupFields. If it doesn't
  //      match loadedVersion, another transition slipped in — abort with
  //      OA_CONCURRENT_UPDATE so the caller can retry from a fresh load.
  //   4. Set version = loadedVersion + 1, save.
  //
  // This is not atomic (NS has no CAS). The check-then-save window is small
  // (one record save), but two writers timing within that window could both
  // pass. We accept that residual risk and surface OA_CONCURRENT_UPDATE in
  // the much more common case of a few seconds of skew.

  function _readLoadedVersion(txn) {
    const v = parseInt(txn.getValue(C.FIELDS.TRANSACTION.STATE_VERSION), 10);
    return isNaN(v) ? 0 : v;
  }

  function _readPersistedVersion(recordType, recordId) {
    try {
      const r = search.lookupFields({
        type:    recordType,
        id:      recordId,
        columns: [C.FIELDS.TRANSACTION.STATE_VERSION]
      });
      const raw = r[C.FIELDS.TRANSACTION.STATE_VERSION];
      const v   = parseInt(Array.isArray(raw) ? (raw[0] && raw[0].value) : raw, 10);
      return isNaN(v) ? 0 : v;
    } catch (e) {
      log.error('OA-ENGINE concurrency lookup failed', { recordType, recordId, err: e.message });
      return null;
    }
  }

  // Returns { ok: true, newVersion } on success, { ok: false, message } on conflict.
  function _concurrencyCheckAndBump(txn, recordType, recordId, loadedVersion) {
    const persisted = _readPersistedVersion(recordType, recordId);
    if (persisted === null) {
      // Lookup failed — fall through and let the save itself fail loudly.
      return { ok: true, newVersion: loadedVersion + 1 };
    }
    if (persisted !== loadedVersion) {
      log.error('OA-ENGINE OA_CONCURRENT_UPDATE', {
        recordType, recordId, loadedVersion, persisted
      });
      return { ok: false, message: 'OA_CONCURRENT_UPDATE: another approver acted on this transaction. Reload and try again.' };
    }
    txn.setValue({ fieldId: C.FIELDS.TRANSACTION.STATE_VERSION, value: loadedVersion + 1 });
    return { ok: true, newVersion: loadedVersion + 1 };
  }

  // ─── Step helper ─────────────────────────────────────────────────────────────

  function _countApprovedLogs(recordId) {
    // Count rows that consume a step:
    //   APPROVED            (normal step approval)
    //   SUPER_APPROVED      (super-approver override, treated as approval-equivalent)
    //   SUBMITTER_AUTOSKIP  (M-4 step-1 skip; the next step picks up from step 2)
    // ACTION is a TEXT field, so use 'is' with explicit OR groups.
    let count = 0;
    search.create({
      type:    C.RECORDS.LOG,
      filters: [
        [C.FIELDS.LOG.TRANSACTION, 'equalto', recordId],
        'AND',
        [
          [C.FIELDS.LOG.ACTION, 'is', C.LOG_ACTIONS.APPROVED],
          'OR',
          [C.FIELDS.LOG.ACTION, 'is', C.LOG_ACTIONS.SUPER_APPROVED],
          'OR',
          [C.FIELDS.LOG.ACTION, 'is', C.LOG_ACTIONS.SUBMITTER_AUTOSKIP]
        ]
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

    const currentApprover = txn.getValue(C.FIELDS.TRANSACTION.NEXT_APPROVER);
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

    const step           = _countApprovedLogs(recordId) + 1;
    const loadedVersion  = _readLoadedVersion(txn);

    if (!isSuperOverride) {
      // Normal flow: check if a step-2 approver is needed.
      //
      // FX snapshot policy (H-3): re-route against the SAME amount that was
      // routed at first submit. If the bill carries a custbody_oa_base_amount,
      // pass it explicitly so the engine doesn't re-fetch the (possibly stale)
      // exchange rate from the record. If the snapshot is missing (legacy bills
      // submitted before this commit) fall back to the engine self-fetch path.
      const subsidiaryId    = utils.getTransactionSubsidiary(recordType, recordId);
      const snapshotBase    = parseFloat(txn.getValue(C.FIELDS.TRANSACTION.BASE_AMOUNT)) || 0;
      const routing         = (snapshotBase > 0)
        ? routeForApproval(recordType, recordId, subsidiaryId, snapshotBase)
        : routeForApproval(recordType, recordId, subsidiaryId);

      if (!routing.error && routing.approverCount >= 2 && step === 1 && routing.approver2) {
        // M-4 step-2 guard. If the submitter (the person who originally
        // posted the bill) IS the approver2 the engine is about to route
        // toward, hard-fail rather than silently advance and let them
        // self-approve at step 2. The autoskip-at-initial-route path covers
        // submitter==approver1; this guard covers submitter==approver2 in
        // a 2-step matrix where approver1 was someone else.
        const submitterRaw = txn.getValue(C.FIELDS.TRANSACTION.SUBMITTED_BY);
        const submitter    = String(submitterRaw || '');
        if (submitter && String(routing.approver2) === submitter) {
          log.error('OA-ENGINE OA_SELF_APPROVAL_AT_STEP_2', {
            recordId, recordType, submitter, approver2: routing.approver2
          });
          return {
            success: false,
            message: 'OA_SELF_APPROVAL_AT_STEP_2: submitter (' + submitter +
                     ') is also approver2. Manager must reassign step 2 to a ' +
                     'different employee.'
          };
        }

        _setNextApprover(txn, routing.approver2);
        // H-6: bump current_step provenance so observers (UI tab, MR notifications,
        // SuiteAnalytics queries) can tell which step this bill is on.
        try {
          txn.setValue({ fieldId: C.FIELDS.TRANSACTION.CURRENT_STEP, value: 2 });
        } catch (e) { /* informational; do not block */ }
        const guard = _concurrencyCheckAndBump(txn, recordType, recordId, loadedVersion);
        if (!guard.ok) return { success: false, message: guard.message };
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
    const guard = _concurrencyCheckAndBump(txn, recordType, recordId, loadedVersion);
    if (!guard.ok) return { success: false, message: guard.message };
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

    const currentApprover = txn.getValue(C.FIELDS.TRANSACTION.NEXT_APPROVER);
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

    const step          = _countApprovedLogs(recordId) + 1;
    const loadedVersion = _readLoadedVersion(txn);

    txn.setValue({ fieldId: 'approvalstatus', value: C.APPROVAL_STATUS.REJECTED });
    _setNextApprover(txn, null);
    const guard = _concurrencyCheckAndBump(txn, recordType, recordId, loadedVersion);
    if (!guard.ok) return { success: false, message: guard.message };
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

    // M-3: target must be active. Catch the throw and surface as
    // {success:false, message} matching the existing transition convention.
    try { assertActiveEmployeeApprover(targetId, 'delegate target'); }
    catch (e) { return { success: false, message: e.name + ': ' + e.message }; }

    let txn;
    try {
      txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    } catch (e) {
      return { success: false, message: 'Record not found.' };
    }

    const currentApprover = txn.getValue(C.FIELDS.TRANSACTION.NEXT_APPROVER);
    if (!currentApprover || String(currentApprover) !== String(actorId)) {
      return { success: false, message: 'You are not the assigned approver for this step.' };
    }
    if (txn.getValue('approvalstatus') !== C.APPROVAL_STATUS.PENDING) {
      return { success: false, message: 'Transaction is not pending approval.' };
    }

    const step          = _countApprovedLogs(recordId) + 1;
    const loadedVersion = _readLoadedVersion(txn);
    _setNextApprover(txn, targetId);
    const guard = _concurrencyCheckAndBump(txn, recordType, recordId, loadedVersion);
    if (!guard.ok) return { success: false, message: guard.message };
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

    // M-3: new approver must be active.
    try { assertActiveEmployeeApprover(newApproverId, 'reset target'); }
    catch (e) { return { success: false, message: e.name + ': ' + e.message }; }

    let txn;
    try {
      txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    } catch (e) {
      return { success: false, message: 'Record not found.' };
    }

    const loadedVersion = _readLoadedVersion(txn);
    txn.setValue({ fieldId: 'approvalstatus', value: C.APPROVAL_STATUS.PENDING });
    _setNextApprover(txn, newApproverId);
    const guard = _concurrencyCheckAndBump(txn, recordType, recordId, loadedVersion);
    if (!guard.ok) return { success: false, message: guard.message };
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

    // M-3: new approver must be active.
    try { assertActiveEmployeeApprover(newApproverId, 'reassign target'); }
    catch (e) { return { success: false, message: e.name + ': ' + e.message }; }

    let txn;
    try {
      txn = record.load({ type: recordType, id: recordId, isDynamic: false });
    } catch (e) {
      return { success: false, message: 'Record not found.' };
    }

    if (txn.getValue('approvalstatus') !== C.APPROVAL_STATUS.PENDING) {
      return { success: false, message: 'Transaction is not pending — cannot reassign.' };
    }

    const step          = _countApprovedLogs(recordId) + 1;
    const loadedVersion = _readLoadedVersion(txn);
    _setNextApprover(txn, newApproverId);
    const guard = _concurrencyCheckAndBump(txn, recordType, recordId, loadedVersion);
    if (!guard.ok) return { success: false, message: guard.message };
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
      txn.setValue({ fieldId: C.FIELDS.TRANSACTION.NEXT_APPROVER, value: employeeId });
      const readback = txn.getValue(C.FIELDS.TRANSACTION.NEXT_APPROVER);
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
    createAuditLog,
    matchThresholds,
    assertActiveEmployeeApprover
  };
});
