/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([], () => {
  'use strict';

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function buildApprovalEmail(p) {
    const recordLabel = p.recordType === 'purchaseorder' ? 'Purchase Order' : 'Vendor Bill';
    const introText   = p.introText
      || 'A new {recordType} from {subsidiary} has been entered in NetSuite and requires your approval. Please see the attached document for full details.';
    const intro = introText
      .replace('{recordType}', recordLabel)
      .replace('{subsidiary}', p.subsidiaryName || '')
      .replace('{docNumber}',  p.documentNumber || '')
      .replace('{requester}',  p.requesterName  || '');

    const safeApproverName   = _esc(p.approverName);
    const safeDocNumber      = _esc(p.documentNumber);
    const safeRecordLabel    = _esc(recordLabel);
    const safeCurrency       = _esc(p.currency);
    const safeAmount         = _esc(p.amount);
    const safeRequesterName  = _esc(p.requesterName);
    const safeSubsidiaryName = _esc(p.subsidiaryName);
    const safeDeclineLabel   = _esc(p.declineLabel || 'Reject');
    const safeApproveLabel   = _esc(p.approveLabel || 'Approve');
    const safeSupportEmail   = _esc(p.supportEmail || 'support@omnit.dk');
    const safeIntro          = _esc(intro);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#312d2a}
  .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.09)}
  .hdr{background:#312d2a;padding:28px 36px}
  .logo{color:#c74634;font-size:22px;font-weight:700;letter-spacing:.5px}
  .logo-sub{color:#ccc;font-size:12px;margin-top:3px}
  .body{padding:36px}
  h1{font-size:22px;font-weight:700;margin:0 0 8px}
  .sub{font-size:16px;color:#c74634;font-weight:600;margin:0 0 20px}
  p{font-size:15px;line-height:1.7;margin:0 0 16px;color:#555}
  .meta{background:#f8f8f8;border-radius:8px;padding:20px 24px;margin:20px 0}
  .row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #ececec;font-size:14px}
  .row:last-child{border-bottom:none}
  .lbl{color:#888;font-weight:500}
  .val{color:#312d2a;font-weight:600;text-align:right}
  .btns{display:flex;gap:12px;margin:28px 0}
  .btn{display:block;padding:15px 0;border-radius:8px;font-size:15px;font-weight:700;text-decoration:none;text-align:center;flex:1;letter-spacing:.3px}
  .btn-decline{background:#c74634;color:#fff}
  .btn-approve{background:#2e7d32;color:#fff}
  hr{border:none;border-top:1px solid #ececec;margin:24px 0}
  .faq{font-size:13px;color:#999;line-height:1.7}
  .faq strong{color:#666}
  .ftr{background:#f8f8f8;padding:18px 36px;font-size:12px;color:#bbb;border-top:1px solid #ececec}
  .ftr a{color:#c74634;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <div class="logo">OMNI:T</div>
    <div class="logo-sub">Omnit Approvals</div>
  </div>
  <div class="body">
    <h1>Hi ${safeApproverName},</h1>
    <p class="sub">Your approval is required</p>
    <p>${safeIntro}</p>
    <div class="meta">
      <div class="row"><span class="lbl">Document number</span><span class="val">${safeDocNumber}</span></div>
      <div class="row"><span class="lbl">Type</span><span class="val">${safeRecordLabel}</span></div>
      <div class="row"><span class="lbl">Amount</span><span class="val">${safeCurrency} ${safeAmount}</span></div>
      <div class="row"><span class="lbl">Submitted by</span><span class="val">${safeRequesterName}</span></div>
      <div class="row"><span class="lbl">Subsidiary</span><span class="val">${safeSubsidiaryName}</span></div>
    </div>
    <p>Please approve or reject this transaction as soon as possible.</p>
    <div class="btns">
      <a href="${p.declineUrl}" class="btn btn-decline">${safeDeclineLabel}</a>
      <a href="${p.approveUrl}" class="btn btn-approve">${safeApproveLabel}</a>
    </div>
    <hr>
    <div class="faq">
      <strong>Why am I receiving this email?</strong><br>
      You are registered as an approver for ${safeSubsidiaryName} in Omnit Approvals.<br><br>
      <strong>Approve via NetSuite:</strong> Log in and open the Omnit Approvals dashboard to process pending transactions in bulk.
    </div>
  </div>
  <div class="ftr">
    Questions? Contact the accounting team or <a href="mailto:${safeSupportEmail}">${safeSupportEmail}</a>
  </div>
</div>
</body></html>`;
  }

  function buildDeclineCommentPage(p) {
    const safeDocNumber      = _esc(p.documentNumber);
    const safeSubsidiaryName = _esc(p.subsidiaryName);
    const safeCurrency       = _esc(p.currency);
    const safeAmount         = _esc(p.amount);
    const safeToken          = _esc(p.token);
    const safeRecordType     = _esc(p.recordType);
    const safeRecordId       = _esc(p.recordId);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Reject transaction</title>
<style>
  body{margin:0;padding:40px;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#312d2a}
  .card{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 16px rgba(0,0,0,.09)}
  h2{margin:0 0 8px;font-size:20px}
  .sub{color:#c74634;font-size:14px;margin-bottom:24px}
  label{display:block;font-size:14px;font-weight:600;margin-bottom:8px}
  textarea{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;min-height:120px}
  .btn{display:block;width:100%;padding:14px;background:#c74634;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;margin-top:16px}
  .doc{background:#f8f8f8;border-radius:8px;padding:14px 18px;margin-bottom:20px;font-size:14px}
</style>
</head>
<body>
<div class="card">
  <h2>Reject transaction</h2>
  <p class="sub">${safeDocNumber} &mdash; ${safeSubsidiaryName}</p>
  <div class="doc">Amount: <strong>${safeCurrency} ${safeAmount}</strong></div>
  <form method="POST" action="${p.actionUrl}">
    <input type="hidden" name="oa_token" value="${safeToken}">
    <input type="hidden" name="oa_action" value="decline">
    <input type="hidden" name="oa_record_type" value="${safeRecordType}">
    <input type="hidden" name="oa_record_id" value="${safeRecordId}">
    <label for="comment">Reason for rejection (required):</label>
    <textarea id="comment" name="oa_comment" required placeholder="Describe why you are rejecting this transaction..."></textarea>
    <button type="submit" class="btn">Confirm rejection</button>
  </form>
</div>
</body></html>`;
  }

  function buildConfirmationPage(action) {
    const approved = action === 'approve';
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${approved ? 'Approved' : 'Rejected'}</title>
<style>
  body{margin:0;padding:40px;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh}
  .card{background:#fff;border-radius:12px;padding:48px 40px;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,.09);max-width:400px}
  .icon{font-size:48px;margin-bottom:16px}
  h2{margin:0 0 10px;color:${approved ? '#2e7d32' : '#c74634'}}
  p{color:#888;font-size:15px;margin:0}
</style></head>
<body><div class="card">
  <div class="icon">${approved ? '✓' : '✗'}</div>
  <h2>Transaction ${approved ? 'approved' : 'rejected'}</h2>
  <p>You can now close this window.</p>
</div></body></html>`;
  }

  return { buildApprovalEmail, buildDeclineCommentPage, buildConfirmationPage };
});
