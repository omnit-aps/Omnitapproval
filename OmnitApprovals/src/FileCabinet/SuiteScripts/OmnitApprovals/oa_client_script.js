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
    _inputModal('Reject transaction', 'Enter reason for rejection (required)').then(comment => {
      if (!comment) return;
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
    _inputModal('Delegate approval', 'Employee internal ID to delegate to').then(targetId => {
      if (!targetId) return;
      const rec = currentRecord.get();
      _post(slUrl, {
        oa_action:      'delegate',
        oa_record_id:   rec.id,
        oa_record_type: rec.type,
        oa_target:      targetId
      });
    });
  }

  // ─── Reset (Manager) ─────────────────────────────────────────────────────────

  function OA_reset(slUrl) {
    _inputModal('Reset flow', 'Employee internal ID of new approver').then(newApprover => {
      if (!newApprover) return;
      const rec = currentRecord.get();
      _post(slUrl, {
        oa_action:       'reset',
        oa_record_id:    rec.id,
        oa_record_type:  rec.type,
        oa_new_approver: newApprover
      });
    });
  }

  // ─── Reassign (Manager) ──────────────────────────────────────────────────────

  function OA_reassign(slUrl) {
    _inputModal('Reassign approver', 'Employee internal ID of new approver').then(newApprover => {
      if (!newApprover) return;
      const rec = currentRecord.get();
      _post(slUrl, {
        oa_action:       'reassign',
        oa_record_id:    rec.id,
        oa_record_type:  rec.type,
        oa_new_approver: newApprover
      });
    });
  }

  // ─── Super Approve (override) ────────────────────────────────────────────────

  function OA_super_approve(slUrl) {
    _inputModal('Super Approve — override', 'Justification for override (required)').then(comment => {
      if (!comment) return;
      const rec = currentRecord.get();
      _post(slUrl, {
        oa_action:      'super_approve',
        oa_record_id:   rec.id,
        oa_record_type: rec.type,
        oa_comment:     comment
      });
    });
  }

  // ─── Super Reject (override) ─────────────────────────────────────────────────

  function OA_super_decline(slUrl) {
    _inputModal('Super Reject — override', 'Reason for rejection and justification for override (required)').then(comment => {
      if (!comment) return;
      const rec = currentRecord.get();
      _post(slUrl, {
        oa_action:      'super_decline',
        oa_record_id:   rec.id,
        oa_record_type: rec.type,
        oa_comment:     comment
      });
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function _inputModal(title, placeholder) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center';

      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:10px;padding:28px 24px 20px;min-width:340px;box-shadow:0 8px 32px rgba(0,0,0,.22);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

      const h = document.createElement('div');
      h.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:14px;color:#1a1a1a';
      h.textContent = title;

      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder || '';
      inp.style.cssText = 'width:100%;padding:9px 12px;border:1.5px solid #ccc;border-radius:6px;font-size:14px;margin-bottom:18px;box-sizing:border-box;outline:none';
      inp.addEventListener('focus', () => { inp.style.borderColor = '#c74634'; });
      inp.addEventListener('blur',  () => { inp.style.borderColor = '#ccc'; });

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.style.cssText = 'padding:8px 18px;border:1.5px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;font-size:14px;color:#555';

      const ok = document.createElement('button');
      ok.textContent = 'OK';
      ok.style.cssText = 'padding:8px 18px;border:none;border-radius:6px;background:#c74634;color:#fff;cursor:pointer;font-size:14px;font-weight:600';

      const close = val => { document.body.removeChild(overlay); resolve(val); };
      cancel.addEventListener('click', () => close(null));
      ok.addEventListener('click',     () => close(inp.value.trim() || null));
      inp.addEventListener('keydown',  e => { if (e.key === 'Enter') ok.click(); if (e.key === 'Escape') cancel.click(); });

      row.appendChild(cancel); row.appendChild(ok);
      box.appendChild(h); box.appendChild(inp); box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      setTimeout(() => inp.focus(), 50);
    });
  }

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

  function OA_history(histUrl, recordId, recordType) {
    window.open(
      histUrl + '&oa_record_id=' + encodeURIComponent(recordId) + '&oa_record_type=' + encodeURIComponent(recordType),
      '_blank',
      'width=960,height=700,resizable=yes,scrollbars=yes'
    );
  }

  return { pageInit, OA_approve, OA_decline, OA_delegate, OA_reset, OA_reassign, OA_history, OA_super_approve, OA_super_decline };
});
