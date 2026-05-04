// @ts-check
/**
 * UAT-053 — Manager actions: Reassign and Reset & Re-route to Jonas (3762).
 *
 * Pre-conditions:
 *   - psld must have custentity_oa_is_manager = 'T' on their employee record.
 *     If not, the spec skips with a clear message — the dashboard suppresses
 *     reassign/reset options for non-managers.
 *
 * Reassign flow (test 1):
 *   1. Create a fresh VB.
 *   2. Open the dashboard, pick "Reassign", select Jonas (3762), submit.
 *   3. Assert custbody_oa_next_approver = 3762 and a REASSIGNED audit log row exists.
 *
 * Reset flow (test 2):
 *   1. Create a SECOND fresh VB.
 *   2. Pick "Reset & Re-route", select Jonas (3762), submit.
 *   3. Assert custbody_oa_next_approver = 3762 AND a RESET audit-log row
 *      (custrecord_oal_action = '6') exists for that transaction.
 *
 * Run:
 *   npx playwright test tests-e2e/uat/uat-053-manager-reassign-reset.spec.js --project=chromium --reporter=list
 */
const { test, expect } = require('@playwright/test');
const { createVendorBill } = require('./helpers');

const JONAS_EMPLOYEE_ID = 3762;
const PSLD_EMPLOYEE_ID  = 3761;

const TEST_VENDOR   = process.env.E2E_VENDOR  || 'ACME Industries';
const TEST_ACCOUNT  = process.env.E2E_ACCOUNT || 'Other Expenses';
const TEST_AMOUNT   = Number(process.env.E2E_AMOUNT || 600);
const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH;

// Audit-log action codes — see lib/oa_constants.js LOG_ACTIONS.
const ACTION_REASSIGNED = '5';
const ACTION_RESET      = '6';

test.skip(!DASHBOARD_PATH, 'Set NS_DASHBOARD_PATH to enable');

test.describe('UAT-053 manager reassign + reset', () => {
  test.beforeAll(async ({ browser }) => {
    // Pre-flight: confirm psld has manager privilege. Without it the
    // dashboard won't surface reassign/reset options and both subtests fail.
    const ctx  = await browser.newContext({ storageState: 'tests-e2e/.auth/state.json' });
    const page = await ctx.newPage();
    const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
    await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load', timeout: 30_000 });
    const r = await page.evaluate(async ([base, id]) => {
      const resp = await fetch(`${base}/services/rest/query/v1/suiteql`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
        body: JSON.stringify({ q:
          `SELECT id, custentity_oa_is_manager FROM employee WHERE id = ${id}` }),
      });
      return { status: resp.status, body: await resp.text() };
    }, [baseURL, PSLD_EMPLOYEE_ID]);
    let isManager = false;
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const flag = j.items && j.items[0] && j.items[0].custentity_oa_is_manager;
        isManager = (String(flag).toUpperCase() === 'T' || String(flag) === 'true');
      } catch (_) { /* fall through */ }
    }
    if (!isManager) {
      console.warn(
        `[UAT-053] WARNING: psld (employee ${PSLD_EMPLOYEE_ID}) does not have ` +
        'custentity_oa_is_manager = T. The dashboard will not expose Reassign / Reset ' +
        'options. Tests below will skip. Run _setup-psld-manager.spec.js to enable.',
      );
    } else {
      console.log(`[UAT-053] Pre-flight OK — psld has manager privilege.`);
    }
    await ctx.close();
    test.skip(!isManager,
      'psld lacks custentity_oa_is_manager = T. Run _setup-psld-manager.spec.js first.');
  });

  /**
   * Submit a reassign/reset action for one VB row. Returns the action that was
   * actually submitted (selectOption falls back to dropdown discovery).
   *
   * @param {import('@playwright/test').Page} page
   * @param {string} vbId
   * @param {'reassign'|'reset'} action
   */
  const submitManagerAction = async (page, vbId, action) => {
    await page.goto(DASHBOARD_PATH);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('tr[data-id]').first()).toBeVisible({ timeout: 15_000 });

    const row = page.locator(`tr[data-id="${vbId}"]`).first();
    await expect(row).toBeAttached({ timeout: 10_000 });
    await row.scrollIntoViewIfNeeded();

    const select = row.locator('.action-select');
    const optionVals = await select.locator('option').evaluateAll(opts =>
      opts.map(o => /** @type {HTMLOptionElement} */ (o).value));
    expect(
      optionVals,
      `[UAT-053] Dashboard row missing "${action}" option. Available: ${optionVals.join(',')}. ` +
      'psld may not have manager privilege on this dashboard load.',
    ).toContain(action);

    await select.selectOption(action);

    // Pick Jonas in the reassign-input. The control is either a <select> populated
    // from loadActiveApprovers() or a fallback <input type="text">.
    const reassignInput = row.locator('.reassign-input');
    await expect(reassignInput).toBeVisible({ timeout: 5_000 });
    const tagName = await reassignInput.evaluate(el => el.tagName.toLowerCase());
    if (tagName === 'select') {
      // The select has approver name labels; selectOption by value (employee id).
      await reassignInput.selectOption(String(JONAS_EMPLOYEE_ID));
    } else {
      await reassignInput.fill(String(JONAS_EMPLOYEE_ID));
    }

    await page.getByRole('button', { name: 'Submit approvals' }).first().click();
    await expect(page.locator('#toast')).toContainText(/Done: 1 processed/, { timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
  };

  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} vbId
   */
  const readNextApprover = async (page, vbId) => {
    const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
    const r = await page.evaluate(async ([base, id]) => {
      const resp = await fetch(`${base}/services/rest/query/v1/suiteql`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
        body: JSON.stringify({ q:
          `SELECT custbody_oa_next_approver AS na, approvalstatus AS st
           FROM transaction WHERE id = ${id}` }),
      });
      return { status: resp.status, body: await resp.text() };
    }, [baseURL, vbId]);
    if (r.status !== 200) return { nextApprover: null, status: null };
    try {
      const row = (JSON.parse(r.body).items || [])[0] || {};
      return { nextApprover: row.na || null, status: row.st || null };
    } catch (_) { return { nextApprover: null, status: null }; }
  };

  /**
   * @param {import('@playwright/test').Page} page
   * @param {string} vbId
   * @param {string} actionCode  '5' for REASSIGNED, '6' for RESET
   */
  const findAuditLog = async (page, vbId, actionCode) => {
    const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
    const r = await page.evaluate(async ([base, id, action]) => {
      const resp = await fetch(`${base}/services/rest/query/v1/suiteql`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
        body: JSON.stringify({ q:
          `SELECT id, custrecord_oal_action, custrecord_oal_actor, custrecord_oal_target,
                  custrecord_oal_timestamp
           FROM customrecord_oa_log
           WHERE custrecord_oal_transaction = ${id}
             AND custrecord_oal_action = '${action}'
           ORDER BY id DESC FETCH FIRST 5 ROWS ONLY` }),
      });
      return { status: resp.status, body: await resp.text() };
    }, [baseURL, vbId, actionCode]);
    if (r.status !== 200) return [];
    try { return JSON.parse(r.body).items || []; } catch (_) { return []; }
  };

  test('Reassign sets next_approver to Jonas and writes REASSIGNED audit log', async ({ page }) => {
    test.setTimeout(180_000);

    const result = await createVendorBill(page, {
      vendor:   TEST_VENDOR,
      account:  TEST_ACCOUNT,
      amount:   TEST_AMOUNT,
      scenario: 'UAT-053-reassign',
    });
    expect(result.id).toMatch(/^\d+$/);
    expect(result.status).toBe('Pending Approval');
    const vbId = result.id;
    console.log(`[UAT-053] Created VB ${vbId} for reassign test (initial approver "${result.nextApprover}")`);

    await submitManagerAction(page, vbId, 'reassign');

    // Assert next_approver is Jonas. SuiteQL value is the raw id.
    /** @type {{nextApprover:string|null, status:string|null}} */
    let state = { nextApprover: null, status: null };
    for (let i = 0; i < 10; i++) {
      state = await readNextApprover(page, vbId);
      if (String(state.nextApprover) === String(JONAS_EMPLOYEE_ID)) break;
      await page.waitForTimeout(1500);
    }
    expect(
      String(state.nextApprover),
      `[UAT-053] After reassign, custbody_oa_next_approver must be ${JONAS_EMPLOYEE_ID} but got '${state.nextApprover}'`,
    ).toBe(String(JONAS_EMPLOYEE_ID));
    expect(state.status, '[UAT-053] Reassign must keep VB Pending').toBe('1');

    // Assert audit-log entry exists.
    const logs = await findAuditLog(page, vbId, ACTION_REASSIGNED);
    expect(
      logs.length,
      `[UAT-053] Expected at least one REASSIGNED log row for VB ${vbId}. customrecord_oa_log query returned ${logs.length}.`,
    ).toBeGreaterThan(0);
    console.log(`[UAT-053] PASS reassign — VB ${vbId} → approver=${state.nextApprover}, REASSIGNED logs=${logs.length}`);
  });

  test('Reset & Re-route sets next_approver to Jonas and writes RESET audit log', async ({ page }) => {
    test.setTimeout(180_000);

    // Fresh VB so the row's audit-log history is unambiguous.
    const result = await createVendorBill(page, {
      vendor:   TEST_VENDOR,
      account:  TEST_ACCOUNT,
      amount:   TEST_AMOUNT,
      scenario: 'UAT-053-reset',
    });
    expect(result.id).toMatch(/^\d+$/);
    expect(result.status).toBe('Pending Approval');
    const vbId = result.id;
    console.log(`[UAT-053] Created VB ${vbId} for reset test (initial approver "${result.nextApprover}")`);

    // The reset option only appears when psld is NOT the assigned approver
    // (and not super_approver) — i.e. the manager-only branch in oa_sl_dashboard.js.
    // psld is super_approver in this sandbox, so the dropdown shows
    // super_approve / super_decline / reassign — but NOT reset.
    // Probe the dropdown options first; if reset isn't present, skip with a clear message.
    await page.goto(DASHBOARD_PATH);
    await page.waitForLoadState('domcontentloaded');
    const row = page.locator(`tr[data-id="${vbId}"]`).first();
    await expect(row).toBeAttached({ timeout: 15_000 });
    const optionVals = await row.locator('.action-select option').evaluateAll(opts =>
      opts.map(o => /** @type {HTMLOptionElement} */ (o).value));
    test.skip(
      !optionVals.includes('reset'),
      `[UAT-053] Dashboard does not expose "reset" for psld on this row (options: ${optionVals.join(',')}). ` +
      'The reset option is shown only to managers who are NOT super-approvers and NOT the assigned approver — ' +
      'see oa_sl_dashboard.js:399-404. To exercise this path, run as a non-super-approver manager session.',
    );

    await submitManagerAction(page, vbId, 'reset');

    /** @type {{nextApprover:string|null, status:string|null}} */
    let state = { nextApprover: null, status: null };
    for (let i = 0; i < 10; i++) {
      state = await readNextApprover(page, vbId);
      if (String(state.nextApprover) === String(JONAS_EMPLOYEE_ID)) break;
      await page.waitForTimeout(1500);
    }
    expect(
      String(state.nextApprover),
      `[UAT-053] After reset, custbody_oa_next_approver must be ${JONAS_EMPLOYEE_ID} but got '${state.nextApprover}'`,
    ).toBe(String(JONAS_EMPLOYEE_ID));
    expect(state.status, '[UAT-053] Reset re-pends the VB (status=1)').toBe('1');

    const logs = await findAuditLog(page, vbId, ACTION_RESET);
    expect(
      logs.length,
      `[UAT-053] Expected at least one RESET log row for VB ${vbId}. customrecord_oa_log query returned ${logs.length}.`,
    ).toBeGreaterThan(0);
    console.log(`[UAT-053] PASS reset — VB ${vbId} → approver=${state.nextApprover}, RESET logs=${logs.length}`);
  });
});
