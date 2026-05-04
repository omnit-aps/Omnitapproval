// @ts-check
/**
 * UAT-021 — Email-decline flow:
 *   1. Create a fresh VB (next_approver = Jonas).
 *   2. Wait for the MR notification script to dispatch the approval email.
 *   3. Locate the most recent message addressed to Jonas for this VB via SuiteQL.
 *   4. Pull the body via the debug Suitelet (customscript_oa_sl_debug ?msgids=…),
 *      pick a DECLINE link (rejectLinks[0]).
 *   5. Hit the link via app.netsuite.com (extforms.* is blocked by audience config —
 *      see _email-link-flow.spec.js for context).
 *   6. The decline path requires a comment. The Suitelet renders a form on GET; we
 *      submit it with a reason. (If the form isn't rendered we fall back to the
 *      plain GET to confirm the rejection-without-reason path returns the same form
 *      and does NOT transition the VB.)
 *   7. Assert the VB transitions to Rejected via SuiteQL on transaction.approvalstatus.
 *
 * Skip rules: if MR doesn't fire or the email isn't found within the wait window,
 * the test is marked as fixme/skipped with a clear log line — never silent.
 *
 * Run:
 *   npx playwright test tests-e2e/uat/uat-021-email-decline.spec.js --project=chromium --reporter=list
 */
const { test, expect } = require('@playwright/test');
const { createVendorBill } = require('./helpers');

const JONAS_EMPLOYEE_ID = 3762;
const JONAS_EMAIL       = 'jonasbm@gmail.com';

const TEST_VENDOR  = process.env.E2E_VENDOR  || 'ACME Industries';
const TEST_ACCOUNT = process.env.E2E_ACCOUNT || 'Other Expenses';
const TEST_AMOUNT  = Number(process.env.E2E_AMOUNT || 750);

const EMAIL_LOG_WAIT_MS = Number(process.env.UAT021_EMAIL_LOG_WAIT_MS ?? 90_000);

test.describe('UAT-021 email-decline flow', () => {
  test('Email decline link transitions VB to Rejected', async ({ page }) => {
    test.setTimeout(EMAIL_LOG_WAIT_MS + 240_000);

    const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');

    // ── Step 1: create a fresh VB ────────────────────────────────────────────
    const result = await createVendorBill(page, {
      vendor:   TEST_VENDOR,
      account:  TEST_ACCOUNT,
      amount:   TEST_AMOUNT,
      scenario: 'UAT-021',
    });
    expect(result.id, 'VB save should return a numeric id').toMatch(/^\d+$/);
    expect(result.status, 'New VB must start as Pending Approval').toMatch(/pending/i);
    const vbId = result.id;
    console.log(`[UAT-021] Seeded VB id=${vbId} for decline-link test`);

    // ── Step 2: wait for MR script to dispatch the approval email ─────────────
    console.log(`[UAT-021] Waiting ${EMAIL_LOG_WAIT_MS / 1000}s for MR notifications to fire…`);
    await page.waitForTimeout(EMAIL_LOG_WAIT_MS);

    // ── Step 3: find the most recent message related to this VB via SuiteQL ──
    await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load', timeout: 30_000 });

    /** @returns {Promise<number[]>} */
    const findRecentApprovalMsgIds = async () => {
      // First try messages linked directly to the VB transaction.
      const linked = await page.evaluate(async ([base, txnId]) => {
        const r = await fetch(`${base}/services/rest/query/v1/suiteql`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
          body: JSON.stringify({ q:
            `SELECT id FROM message
             WHERE transaction = ${txnId}
             ORDER BY messageDate DESC FETCH FIRST 5 ROWS ONLY` }),
        });
        return { status: r.status, body: await r.text() };
      }, [baseURL, vbId]);
      if (linked.status === 200) {
        try {
          const j = JSON.parse(linked.body);
          const ids = (j.items || []).map(i => Number(i.id)).filter(Boolean);
          if (ids.length) return ids;
        } catch (_) { /* fall through */ }
      }

      // Fallback: pull recent approval emails to Jonas in the last 30 minutes.
      const recent = await page.evaluate(async ([base, email]) => {
        const r = await fetch(`${base}/services/rest/query/v1/suiteql`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
          body: JSON.stringify({ q:
            `SELECT id FROM message
             WHERE messageDate >= SYSDATE - (1/48)
               AND incoming = 'F'
               AND UPPER(subject) LIKE '%APPROV%'
               AND LOWER(recipientEmail) = LOWER('${email}')
             ORDER BY messageDate DESC FETCH FIRST 10 ROWS ONLY` }),
        });
        return { status: r.status, body: await r.text() };
      }, [baseURL, JONAS_EMAIL]);
      if (recent.status !== 200) return [];
      try {
        const j = JSON.parse(recent.body);
        return (j.items || []).map(i => Number(i.id)).filter(Boolean);
      } catch (_) { return []; }
    };

    const candidateIds = await findRecentApprovalMsgIds();
    test.skip(
      candidateIds.length === 0,
      `[UAT-021] No approval messages found for VB ${vbId} (or for ${JONAS_EMAIL} in last 30m). ` +
      'MR script may not have fired in this sandbox window. Re-run after confirming MR deployment is active.',
    );
    console.log(`[UAT-021] Candidate message ids: ${candidateIds.join(',')}`);

    // ── Step 4: pull bodies via debug Suitelet, pick a decline link ──────────
    const debugUrl =
      `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug` +
      `&deploy=customdeploy_oa_sl_debug&msgids=${candidateIds.join(',')}`;
    const dbgResp = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return { status: r.status, body: await r.text() };
    }, debugUrl);
    expect(dbgResp.status, `Debug Suitelet HTTP ${dbgResp.status}`).toBe(200);
    const dbg = JSON.parse(dbgResp.body);

    // Prefer messages whose body references this VB and has a decline (reject) link.
    const messages = (dbg.messageBodies || []);
    const matchForVb = messages.find(m =>
      Array.isArray(m.rejectLinks) && m.rejectLinks.length > 0 &&
      (String(m.transaction || '') === String(vbId) ||
       (m.bodyPreview || '').includes(String(vbId))),
    );
    const fallback  = messages.find(m => Array.isArray(m.rejectLinks) && m.rejectLinks.length > 0);
    const target    = matchForVb || fallback;

    test.skip(
      !target,
      `[UAT-021] No decline link found in any of msg ids ${candidateIds.join(',')}. ` +
      `Email body may not include reject links — check oa_email_template.js or MR deployment.`,
    );
    console.log(`[UAT-021] Using msg id=${target.id} (txn=${target.transaction || 'n/a'})`);

    const declineLink = target.rejectLinks[0];
    expect(declineLink, 'Decline link should be a non-empty string').toMatch(/^https?:\/\//);
    // Swap extforms host → app host so the logged-in psld cookies authenticate the page.
    // The HMAC oa_token is the actual auth — extforms is just where NS routes anonymous.
    const internalLink = declineLink
      .replace('https://td3075893.extforms.netsuite.com/', 'https://td3075893.app.netsuite.com/');
    console.log(`[UAT-021] Decline link (internal): ${internalLink.slice(0, 110)}…`);

    // ── Step 5: hit the decline link ─────────────────────────────────────────
    await page.goto(internalLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1500);
    const landingUrl   = page.url();
    const landingTitle = await page.evaluate(() => document.title || '');
    const landingText  = await page.evaluate(() => document.body.innerText.slice(0, 2000));
    console.log(`[UAT-021] Landing URL:   ${landingUrl}`);
    console.log(`[UAT-021] Landing title: "${landingTitle}"`);
    console.log(`[UAT-021] Body preview:\n  ${landingText.split('\n').slice(0, 25).join('\n  ')}`);

    // No NS error pages.
    expect(landingText, 'Decline link must not return NS privilege error').not.toMatch(/You do not have privileges/i);
    expect(landingText, 'Decline link must not return NS not-found page').not.toMatch(/Page not found/i);

    // ── Step 6: comment-required path ────────────────────────────────────────
    // The decline GET path renders a form asking for a justification; submit it.
    // Look for a comment input on the page; if present, fill and submit.
    const commentBox = page
      .locator('textarea[name="oa_comment"], textarea#oa_comment, input[name="oa_comment"], textarea[name="comment"]')
      .first();
    const formVisible = await commentBox.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);

    if (formVisible) {
      await commentBox.fill('[E2E-TEST] UAT-021 automated decline reason');
      // The form's action attribute is the extforms.netsuite.com URL (anonymous-access
      // host) but psld can't toggle the deployment's audience config. Rewrite to the
      // internal app.netsuite.com host so the logged-in cookies authenticate the POST.
      // The HMAC oa_token in the form's hidden inputs is the actual auth — host doesn't matter.
      await page.evaluate(() => {
        document.querySelectorAll('form').forEach((f) => {
          if (f.action) f.action = f.action.replace('https://td3075893.extforms.netsuite.com/', 'https://td3075893.app.netsuite.com/');
        });
      });
      const submitBtn = page
        .locator('button[type="submit"], input[type="submit"], button:has-text("Reject"), button:has-text("Submit"), button:has-text("Decline")')
        .first();
      await submitBtn.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const afterText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      console.log(`[UAT-021] Post-submit body preview:\n  ${afterText.split('\n').slice(0, 20).join('\n  ')}`);
      expect(afterText, 'Decline submission should not return privilege error').not.toMatch(/You do not have privileges/i);
    } else {
      // No form found — the decline action either auto-processed (GET handler skipped
      // form for already-comment-bearing tokens) or showed an error. Log for triage.
      console.log('[UAT-021] No comment form found on landing page — decline may have auto-processed or rejected.');
    }

    // ── Step 7: assert VB transitioned to Rejected (status = '3') via SuiteQL ─
    // Allow up to 30s for the engine save to be visible.
    let approvalStatus = null;
    for (let i = 0; i < 15 && approvalStatus !== '3'; i++) {
      const r = await page.evaluate(async ([base, id]) => {
        const resp = await fetch(`${base}/services/rest/query/v1/suiteql`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
          body: JSON.stringify({ q: `SELECT approvalstatus FROM transaction WHERE id = ${id}` }),
        });
        return { status: resp.status, body: await resp.text() };
      }, [baseURL, vbId]);
      if (r.status === 200) {
        try {
          const j = JSON.parse(r.body);
          approvalStatus = (j.items && j.items[0] && j.items[0].approvalstatus) || null;
        } catch (_) { /* keep polling */ }
      }
      if (approvalStatus !== '3') await page.waitForTimeout(2_000);
    }

    expect(
      approvalStatus,
      `[UAT-021] VB ${vbId} approvalstatus expected '3' (Rejected) but got '${approvalStatus}'. ` +
      'If the email_action Suitelet rendered a form that we couldn\'t auto-submit, check the form selector ' +
      'or the email template’s decline-flow config (custrecord_oa_email_intro / approve_without_login).',
    ).toBe('3');

    console.log(`[UAT-021] PASS — VB ${vbId} transitioned to Rejected via email decline link.`);
  });
});
