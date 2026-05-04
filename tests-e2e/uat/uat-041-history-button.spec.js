// @ts-check
// UAT-041 — Approval history button appears on submitted VB
const { test, expect } = require('@playwright/test');
const { createVendorBill } = require('./helpers');

const TEST_VENDOR  = process.env.E2E_VENDOR  || 'ACME Industries';
const TEST_ACCOUNT = process.env.E2E_ACCOUNT || 'Other Expenses';
const TEST_AMOUNT  = Number(process.env.E2E_AMOUNT || 1000);

test('UAT-041 approval history button appears on submitted VB', async ({ page }) => {
  test.setTimeout(120_000);

  const result = await createVendorBill(page, {
    vendor:   TEST_VENDOR,
    account:  TEST_ACCOUNT,
    amount:   TEST_AMOUNT,
    scenario: 'UAT-041',
  });
  expect(result.id).toMatch(/^\d+$/);

  // Navigate to the view URL (read-only) where the OA user_event adds buttons
  await page.goto(`/app/accounting/transactions/vendbill.nl?id=${result.id}`);
  await page.waitForLoadState('domcontentloaded');

  // Button is added with id custpage_oa_history; NS renders form buttons with
  // an id prefix like #tdbody_custpage_oa_history.
  const historyBtn = page.locator('#tdbody_custpage_oa_history, #custpage_oa_history, [id$=custpage_oa_history]').first();
  await expect(historyBtn).toBeVisible({ timeout: 15_000 });
});
