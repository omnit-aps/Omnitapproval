/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define(['N/currentRecord', 'N/https', 'N/ui/dialog'], (currentRecord, https, dialog) => {
  'use strict';

  function pageInit() {
    // Intentionally empty — button handlers wired via beforeLoad
  }

  // ─── Approve ─────────────────────────────────────────────────────────────────

  function OA_approve(slUrl) {
    dialog.confirm({ title: 'Approve transaction', message: 'Are you sure you want to approve this transaction?' })
      .then(confirmed => {
        if (!confirmed) return;
        const rec = currentRecord.get();
        _post(slUrl, {
          oa_action:      'approve',
          oa_record_id:   rec.id,
          oa_record_type: rec.type
        });
      });
  }

  // ─── Decline ─────────────────────────────────────────────────────────────────

  function OA_decline(slUrl) {
    _promptComment('Reject transaction', 'Enter reason for rejection (required):')
      .then(comment => {
        if (comment === null) return;
        const rec = currentRecord.get();
        _post(slUrl, {
          oa_action:      'decline',
          oa_record_id:   rec.id,
          oa_record_type: rec.type,
          oa_comment:     comment
        });
      });
  }

  // ─── Delegate ────────────────────────────────────────────────────────────────

  function OA_delegate(slUrl) {
    const targetId = prompt('Enter the internal ID of the employee to delegate to:');
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
    const newApprover = prompt('Enter the internal ID of the new approver:');
    if (!newApprover) return;
    const rec = currentRecord.get();
    _post(slUrl, {
      oa_action:       'reset',
      oa_record_id:    rec.id,
      oa_record_type:  rec.type,
      oa_new_approver: newApprover
    });
  }

  // ─── Reassign (Manager) ──────────────────────────────────────────────────────
  // Reassign keeps current approval state — only swaps the assigned approver.
  // Reset (above) cancels the flow and restarts at step 1.

  function OA_reassign(slUrl) {
    const newApprover = prompt('Enter the internal ID of the new approver:');
    if (!newApprover) return;
    const rec = currentRecord.get();
    _post(slUrl, {
      oa_action:       'reassign',
      oa_record_id:    rec.id,
      oa_record_type:  rec.type,
      oa_new_approver: newApprover
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function _post(slUrl, params) {
    const body = Object.keys(params)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k] !== null && params[k] !== undefined ? params[k] : ''))
      .join('&');

    let response;
    try {
      response = https.post({
        url:     slUrl,
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } catch (e) {
      dialog.alert({ title: 'Error', message: 'Request failed. Please try again.' });
      return;
    }

    let result;
    try { result = JSON.parse(response.body); } catch (e) { result = {}; }

    if (response.code === 200 && result.success !== false) {
      window.location.reload();
    } else {
      const msg = result.message || 'An error occurred. Please try again.';
      dialog.alert({ title: 'Error', message: msg });
    }
  }

  function _promptComment(title, message) {
    return new Promise(resolve => {
      const comment = prompt(`${title}\n${message}`);
      if (comment === null) { resolve(null); return; }
      if (!comment.trim()) {
        dialog.alert({ title: 'Required field', message: 'A reason is required.' })
          .then(() => resolve(null));
        return;
      }
      resolve(comment);
    });
  }

  function OA_history(histUrl, recordId, recordType) {
    window.open(
      histUrl + '&oa_record_id=' + encodeURIComponent(recordId) + '&oa_record_type=' + encodeURIComponent(recordType),
      '_blank',
      'width=960,height=700,resizable=yes,scrollbars=yes'
    );
  }

  return { pageInit, OA_approve, OA_decline, OA_delegate, OA_reset, OA_reassign, OA_history };
});
