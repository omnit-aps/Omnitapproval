// @ts-check
// UAT-046 — Dashboard shows pending queue. As a manager, psld sees ALL
// pending transactions across all approvers and subsidiaries.
const { test, expect } = require('@playwright/test');
const { createVendorBill } = require('./helpers');

const TEST_VENDOR  = process.env.E2E_VENDOR  || 'ACME Industries';
const TEST_ACCOUNT = process.env.E2E_ACCOUNT || 'Other Expenses';
const TEST_AMOUNT  = Number(process.env.E2E_AMOUNT || 1000);
const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH;

test.skip(!DASHBOARD_PATH, 'Set NS_DASHBOARD_PATH to enable');

test('UAT-046 newly created VB appears in manager dashboard', async ({ page }) => {
  test.setTimeout(180_000);

  // Seed a fresh VB so we have a known pending record to find
  const result = await createVendorBill(page, {
    vendor:   TEST_VENDOR,
    account:  TEST_ACCOUNT,
    amount:   TEST_AMOUNT,
    scenario: 'UAT-046',
  });
  expect(result.id).toMatch(/^\d+$/);
  expect(result.status).toBe('Pending Approval');

  // Open the bulk approval dashboard
  await page.goto(DASHBOARD_PATH);
  await page.waitForLoadState('domcontentloaded');

  // Manager view: dashboard should now contain at least 1 row.
  const rows = page.locator('tr[data-id]');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);

  // The seeded VB's id should appear in the table. Some NetSuite list views render
  // duplicate <tr data-id> nodes (frozen-column pane + scroll pane) so we use
  // .first() to get one match and scroll it into the viewport before asserting.
  const seededRow = page.locator(`tr[data-id="${result.id}"]`).first();
  // Wait for the row to exist in the DOM (doesn't require viewport visibility)
  await expect(seededRow).toBeAttached({ timeout: 10_000 });
  await seededRow.scrollIntoViewIfNeeded();
  await expect(seededRow).toBeVisible({ timeout: 5_000 });
  // Confirm it's the right row by checking the vendor name or UAT-046 memo marker
  const rowText = await seededRow.textContent();
  const hasVendor = rowText && rowText.includes(TEST_VENDOR);
  const hasMemo   = rowText && rowText.includes('UAT-046');
  expect(hasVendor || hasMemo).toBeTruthy();
});
