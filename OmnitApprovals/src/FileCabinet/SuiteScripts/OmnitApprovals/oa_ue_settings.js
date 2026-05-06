/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search', 'N/error'], (record, search, error) => {
  'use strict';

  // On save of an active settings record, deactivate all other active records
  // for the same subsidiary — prevents getSettingsForSubsidiary returning
  // ambiguous results and ensures "save this one" is a visible admin action.
  function beforeSubmit(context) {
    const TRIGGER = context.UserEventType;
    if (context.type !== TRIGGER.CREATE && context.type !== TRIGGER.EDIT) return;

    const rec = context.newRecord;
    if (rec.getValue('isinactive')) return;

    const subsidiaryId = rec.getValue('custrecord_oa_subsidiary');
    if (!subsidiaryId) return;

    const currentId = rec.id || null;

    // UAT-068: block changing the subsidiary on a settings record that has
    // any in-flight (Pending) transactions still routing through it. The
    // rule: settings records are immutable on `subsidiary` once in use;
    // admins must mark the old record inactive and create a new one.
    // This protects against silently orphaning routed transactions.
    if (context.type === TRIGGER.EDIT && context.oldRecord) {
      let oldSubId = '';
      try { oldSubId = context.oldRecord.getValue('custrecord_oa_subsidiary'); } catch (_) {}
      if (oldSubId && String(oldSubId) !== String(subsidiaryId)) {
        // Count pending transactions for the OLD subsidiary that are still
        // routing through OA. If any exist, refuse the change.
        let inFlight = 0;
        try {
          search.create({
            type: 'transaction',
            filters: [
              ['type', 'anyof', ['PurchOrd', 'VendBill']],
              'AND', ['mainline', 'is', 'T'],
              'AND', ['subsidiary', 'anyof', [oldSubId]],
              'AND', ['approvalstatus', 'anyof', ['1']],
              'AND', ['custbody_oa_next_approver', 'noneof', ['@NONE@']]
            ],
            columns: ['internalid']
          }).run().each(() => { inFlight++; return inFlight < 1000; });
        } catch (_) { /* graceful — assume zero */ }
        if (inFlight > 0) {
          throw error.create({
            name:    'OA_SETTINGS_SUBSIDIARY_CHANGE_BLOCKED',
            message: 'Cannot change subsidiary on this settings record: ' + inFlight +
                     ' pending OA-routed transaction(s) still reference subsidiary id=' +
                     oldSubId + '. Mark this record inactive and create a new one ' +
                     'instead, or wait for the pending transactions to clear.',
            notifyOff: true
          });
        }
      }
    }

    const filters = [
      ['custrecord_oa_subsidiary', 'anyof', subsidiaryId],
      'AND',
      ['isinactive', 'is', 'F']
    ];
    if (currentId) {
      filters.push('AND', ['internalid', 'noneof', [currentId]]);
    }

    const duplicates = [];
    search.create({
      type:    'customrecord_oa_settings',
      filters,
      columns: ['internalid']
    }).run().each(r => { duplicates.push(r.id); return true; });

    if (!duplicates.length) return;

    log.audit('OA-SETTINGS: deactivating ' + duplicates.length + ' duplicate(s)', { subsidiaryId, duplicates });
    duplicates.forEach(dupId => {
      try {
        record.submitFields({
          type:    'customrecord_oa_settings',
          id:      dupId,
          values:  { isinactive: true },
          options: { ignoreMandatoryFields: true }
        });
      } catch (e) {
        log.error('OA-SETTINGS: could not deactivate duplicate', 'id=' + dupId + ': ' + e.message);
      }
    });
  }

  return { beforeSubmit };
});
