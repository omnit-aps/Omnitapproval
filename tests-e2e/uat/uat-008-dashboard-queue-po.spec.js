// @ts-check
// UAT-008 — PO equivalent of UAT-046. Manager (psld) sees a freshly-created
// PO in the bulk approval dashboard.
const { test, expect } = require('@playwright/test');
const { createPurchaseOrder } = require('./helpers');

const TEST_VENDOR   = process.env.E2E_VENDOR    || 'ACME Industries';
const TEST_ITEM     = process.env.E2E_ITEM      || 'Generic Service';
const TEST_QUANTITY = Number(process.env.E2E_QUANTITY || 1);
const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH ||
  '/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_dashboard&deploy=customdeploy_oa_sl_dashboard';

test('UAT-008 newly created PO appears in manager dashboard', async ({ page }) => {
  test.setTimeout(180_000);

  const result = await createPurchaseOrder(page, {
    vendor:   TEST_VENDOR,
    item:     TEST_ITEM,
    quantity: TEST_QUANTITY,
    scenario: 'UAT-008',
  });
  expect(result.id).toMatch(/^\d+$/);

  // Open the dashboard, optionally filtered to PO so the seeded row lands on page 1
  // (newest VBs/POs sort DESC by datecreated; on a busy account the PO might still
  // be off page 1 if VBs were created later, but the explicit type filter keeps
  // the search scoped to PurchOrd only).
  const dashUrl = `${DASHBOARD_PATH}&oa_filter_status=all&oa_filter_type=po`;
  await page.goto(dashUrl);
  await page.waitForLoadState('domcontentloaded');

  const rows = page.locator('tr[data-id]');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });

  const seededRow = page.locator(`tr[data-id="${result.id}"]`).first();
  await expect(seededRow).toBeAttached({ timeout: 10_000 });
  await seededRow.scrollIntoViewIfNeeded();
  await expect(seededRow).toBeVisible({ timeout: 5_000 });

  const rowText = await seededRow.textContent();
  const hasVendor = rowText && rowText.includes(TEST_VENDOR);
  const hasMemo   = rowText && rowText.includes('UAT-008');
  expect(hasVendor || hasMemo).toBeTruthy();
});
