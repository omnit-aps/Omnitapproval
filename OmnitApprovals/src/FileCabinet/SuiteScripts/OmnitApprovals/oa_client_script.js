/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define(['N/currentRecord', 'N/https', 'N/url', 'N/ui/dialog'], (currentRecord, https, url, dialog) => {
  'use strict';

  function pageInit() {
    // Intentionally empty — button handlers wired via beforeLoad
  }

  // ─── Approve ─────────────────────────────────────────────────────────────────

  function OA_approve(slUrl) {
    dialog.confirm({ title: 'Godkend transaktion', message: 'Er du sikker på at du vil godkende denne transaktion?' })
      .then(confirmed => {
        if (!confirmed) return;
        const rec = currentRecord.get();
        _post(slUrl, {
          oa_action:      'approve',
          oa_record_id:   rec.id,
          oa_record_type: rec.type,
          oa_step:        rec.getValue({ fieldId: 'custbody_oa_current_step' })
        });
      });
  }

  // ─── Decline ─────────────────────────────────────────────────────────────────

  function OA_decline(slUrl) {
    _promptComment('Afvis transaktion', 'Angiv årsag til afvisning (påkrævet):')
      .then(comment => {
        if (comment === null) return;
        const rec = currentRecord.get();
        _post(slUrl, {
          oa_action:      'decline',
          oa_record_id:   rec.id,
          oa_record_type: rec.type,
          oa_step:        rec.getValue({ fieldId: 'custbody_oa_current_step' }),
          oa_comment:     comment
        });
      });
  }

  // ─── Delegate ────────────────────────────────────────────────────────────────

  function OA_delegate(slUrl) {
    const targetId = prompt('Angiv medarbejder-ID for ny godkender:');
    if (!targetId) return;
    const rec = currentRecord.get();
    _post(slUrl, {
      oa_action:      'delegate',
      oa_record_id:   rec.id,
      oa_record_type: rec.type,
      oa_target:      targetId
    });
  }

  // ─── Reset (Manager) ─────────────────────────────────────────────────────────

  function OA_reset(slUrl) {
    const newApprover = prompt('Angiv medarbejder-ID for ny godkender 1:');
    if (!newApprover) return;
    const rec = currentRecord.get();
    _post(slUrl, {
      oa_action:        'reset',
      oa_record_id:     rec.id,
      oa_record_type:   rec.type,
      oa_new_approver:  newApprover
    });
  }

  // ─── Reassign (Manager) ──────────────────────────────────────────────────────

  function OA_reassign(slUrl) {
    OA_reset(slUrl);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function _post(slUrl, params) {
    const response = https.post({ url: slUrl, body: params });
    if (response.code === 200) {
      window.location.reload();
    } else {
      dialog.alert({ title: 'Fejl', message: 'Der opstod en fejl. Prøv igen.' });
    }
  }

  function _promptComment(title, message) {
    return new Promise(resolve => {
      const comment = prompt(`${title}\n${message}`);
      if (comment === null) { resolve(null); return; }
      if (!comment.trim()) {
        dialog.alert({ title: 'Påkrævet felt', message: 'Du skal angive en årsag.' })
          .then(() => resolve(null));
        return;
      }
      resolve(comment);
    });
  }

  return { pageInit, OA_approve, OA_decline, OA_delegate, OA_reset, OA_reassign };
});
