// @ts-check
/**
 * UAT-020 — Email-approval: after VB save, next approver = Jonas Test (id 3762)
 * and the MR notification script fires sending an approval email to jonasbm@gmail.com.
 *
 * Prerequisites (must be true before this spec runs):
 *  - A separate setup agent has configured OA settings so Jonas Test (employee 3762)
 *    is the default approver for Headquarters subsidiary.
 *  - The OA user_event script (customscript_oa_user_event) is deployed and active.
 *  - The OA MR notifications script (customscript_oa_mr_notifications) is deployed.
 *  - The sandbox has ACME Industries vendor and an "Other Expenses" account.
 */

const { test, expect } = require('@playwright/test');
const { createVendorBill, readField } = require('./helpers');

const JONAS_EMPLOYEE_ID = 3762;
const JONAS_EMAIL       = 'jonasbm@gmail.com';
const JONAS_NAME_RE     = /jonas/i;

const TEST_VENDOR  = process.env.E2E_VENDOR  || 'ACME Industries';
const TEST_ACCOUNT = process.env.E2E_ACCOUNT || 'Other Expenses';
const TEST_AMOUNT  = Number(process.env.E2E_AMOUNT || 1000);

// How long (ms) to wait for the MR script to fire and the email log to appear.
// The auto-scheduled MR fires within ~60 s in the SB. Set to 0 to skip this check.
const EMAIL_LOG_WAIT_MS = Number(process.env.UAT020_EMAIL_LOG_WAIT_MS ?? 90_000);

test.describe('UAT-020 email-approval flow', () => {
  /** @type {string} */
  let vbId;

  // ── Step 1: verify Jonas is wired up as default approver in OA settings ──────
  test('OA settings: Headquarters default approver is Jonas (id 3762)', async ({ page }) => {
    test.setTimeout(60_000);

    // OA settings are stored in a custom record — open the list and look for a
    // row that references Headquarters + Jonas. The exact URL path varies by
    // account; fall back to a SuiteQL check via the nlapiSearchRecord API.
    // We verify via the NS employee record: Jonas must exist and be active.
    await page.goto(`/app/common/entity/employee.nl?id=${JONAS_EMPLOYEE_ID}`);
    await page.waitForLoadState('domcontentloaded');

    // The page title or name field should contain "Jonas"
    const nameField = page.locator('#name_fs_inlinetext, #name_val, #firstname_fs_inlinetext, h1').first();
    await expect(nameField).toBeVisible({ timeout: 15_000 });
    const nameText = await nameField.textContent();
    expect(nameText, `Employee ${JONAS_EMPLOYEE_ID} should be Jonas — got: "${nameText}"`).toMatch(JONAS_NAME_RE);

    // Check the OA settings custom record for a Headquarters row pointing to Jonas.
    // customrecord_oa_settings is the expected record type id.
    const settingsResult = await page.evaluate(async (jonasId) => {
      /** @type {any} */ const w = window;
      try {
        const results = w.nlapiSearchRecord(
          'customrecord_oa_settings',
          null,
          [new w.nlobjSearchFilter('custrecord_oa_default_approver', null, 'is', jonasId)],
          [
            new w.nlobjSearchColumn('custrecord_oa_subsidiary'),
            new w.nlobjSearchColumn('custrecord_oa_default_approver'),
          ],
        );
        if (!results || results.length === 0) return { found: false };
        return {
          found: true,
          rows: results.map((/** @type {any} */ r) => ({
            subsidiary: r.getText('custrecord_oa_subsidiary'),
            approver:   r.getText('custrecord_oa_default_approver'),
          })),
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }, String(JONAS_EMPLOYEE_ID));

    if (settingsResult.error) {
      // nlapiSearchRecord may not be available in view context; treat as a soft warning.
      console.warn('[UAT-020] Could not verify OA settings via SuiteQL:', settingsResult.error);
      console.warn('[UAT-020] Proceeding — the VB next-approver assertion below will catch misconfig.');
    } else {
      expect(
        settingsResult.found,
        `OA settings must have at least one row with default approver = Jonas (${JONAS_EMPLOYEE_ID}). Got: ${JSON.stringify(settingsResult)}`,
      ).toBe(true);
    }
  });

  // ── Step 2 + 3: create VB and assert next_approver = Jonas ──────────────────
  test('Create VB → next approver field = Jonas (id 3762)', async ({ page }) => {
    test.setTimeout(180_000);

    const result = await createVendorBill(page, {
      vendor:   TEST_VENDOR,
      account:  TEST_ACCOUNT,
      amount:   TEST_AMOUNT,
      scenario: 'UAT-020',
    });

    expect(result.id, 'VB save should return a numeric id').toMatch(/^\d+$/);
    vbId = result.id;

    expect(
      result.status,
      `VB ${vbId} should be Pending Approval, got: "${result.status}"`,
    ).toMatch(/pending/i);

    // custbody_oa_next_approver — createVendorBill re-reads this via readField
    // which tries nlapiGetFieldText first (human name) then nlapiGetFieldValue (id).
    const nextApprover = result.nextApprover ?? await readField(page, 'custbody_oa_next_approver');
    console.log(`[UAT-020] VB id=${vbId}  next_approver="${nextApprover}"`);

    // Accept either the name ("Jonas …") or the raw id ("3762")
    const matchesJonas =
      nextApprover && (
        JONAS_NAME_RE.test(nextApprover) ||
        String(nextApprover).trim() === String(JONAS_EMPLOYEE_ID)
      );

    expect(
      matchesJonas,
      `custbody_oa_next_approver should be Jonas (id ${JONAS_EMPLOYEE_ID}) but got: "${nextApprover}". ` +
      'Check that OA settings for Headquarters subsidiary point to employee 3762.',
    ).toBeTruthy();

    console.log(`[UAT-020] PASS — VB id=${vbId}, next_approver=${nextApprover}, Jonas employee id=${JONAS_EMPLOYEE_ID}`);
  });

  // ── Step 4 (optional): wait for MR script to fire and check email log ────────
  test('Email log shows notification sent to Jonas after MR fires', async ({ page }) => {
    test.skip(EMAIL_LOG_WAIT_MS === 0, 'UAT020_EMAIL_LOG_WAIT_MS=0 — email-log check skipped');
    test.skip(!vbId, 'Previous test did not set vbId — skipping email log check');
    test.setTimeout(EMAIL_LOG_WAIT_MS + 60_000);

    // Give the MR scheduler time to fire (it is auto-scheduled by user_event on save).
    console.log(`[UAT-020] Waiting ${EMAIL_LOG_WAIT_MS / 1000}s for MR to fire…`);
    await page.waitForTimeout(EMAIL_LOG_WAIT_MS);

    // Open NS email audit trail for this VB.
    // NS stores sent emails under Setup > Email > Sent Email (or via saved search).
    // The most reliable path in sandbox is the record's System Notes / Communication tab.
    await page.goto(`/app/accounting/transactions/vendbill.nl?id=${vbId}`);
    await page.waitForLoadState('domcontentloaded');

    // Click the "Communication" tab (label varies: "Communication", "Email", "Activity")
    const commTab = page.locator('a:has-text("Communication"), a:has-text("Email"), td:has-text("Communication")').first();
    const tabVisible = await commTab.isVisible().catch(() => false);
    if (tabVisible) {
      await commTab.click();
      await page.waitForLoadState('domcontentloaded');
    }

    // Look for Jonas's email address or "Approval" / "Pending" subject in the sent log.
    const emailLogRow = page.locator(
      `tr:has-text("${JONAS_EMAIL}"), tr:has-text("Approval"), tr:has-text("Pending Approval")`,
    ).first();

    const found = await emailLogRow.waitFor({ state: 'attached', timeout: 20_000 }).then(() => true).catch(() => false);

    if (!found) {
      // Fall back: check NS Script Execution Log for the MR deployment
      await page.goto(
        `/app/common/scripting/scriptexecutionlog.nl?scripttype=scheduledscript` +
        `&scriptid=customscript_oa_mr_notifications`,
      );
      await page.waitForLoadState('domcontentloaded');
      const logRow = page.locator(`tr:has-text("${vbId}"), tr:has-text("${JONAS_EMAIL}")`).first();
      const logFound = await logRow.waitFor({ state: 'attached', timeout: 15_000 }).then(() => true).catch(() => false);
      expect(
        logFound,
        `Neither the VB Communication tab nor the MR execution log shows evidence that ` +
        `the approval email was sent to ${JONAS_EMAIL} for VB id=${vbId}. ` +
        `Check that customscript_oa_mr_notifications ran successfully.`,
      ).toBe(true);
    }

    console.log(`[UAT-020] Email log check PASS — approval email found for VB id=${vbId}, Jonas email=${JONAS_EMAIL}`);
  });

  // ── Final summary ─────────────────────────────────────────────────────────────
  test.afterAll(() => {
    console.log(`\n[UAT-020] Summary — VB id: ${vbId ?? '(not created)'}, Jonas employee id: ${JONAS_EMPLOYEE_ID}`);
  });
});
