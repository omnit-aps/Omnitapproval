// @ts-check
/**
 * One-shot sandbox setup: flip custentity_oa_is_manager = T and
 * custentity_oa_is_super_approver = T on psld@omnit.dk (employee internal id
 * 3761) so the bulk approval dashboard returns the "show ALL pending records"
 * view and renders super_approve/super_decline action buttons on rows.
 *
 * Idempotent: skips each flag if already set to T. Run with:
 *   npx playwright test _setup-psld-manager --project=chromium
 */
const { test, expect } = require('@playwright/test');
const { setEmployeeFlag } = require('./helpers');

const PSLD_EMPLOYEE_ID = 3761;

test('flip custentity_oa_is_manager = T on psld', async ({ page }) => {
  test.setTimeout(120_000);
  const result = await setEmployeeFlag(page, PSLD_EMPLOYEE_ID, 'custentity_oa_is_manager', 'T');
  console.log('is_manager result:', JSON.stringify(result));
  expect(result.after ?? result.before).toBe('T');
});

test('flip custentity_oa_is_super_approver = T on psld', async ({ page }) => {
  test.setTimeout(120_000);
  const result = await setEmployeeFlag(page, PSLD_EMPLOYEE_ID, 'custentity_oa_is_super_approver', 'T');
  console.log('is_super_approver result:', JSON.stringify(result));
  expect(result.after ?? result.before).toBe('T');
});
