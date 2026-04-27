/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search'], (record, search) => {
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
