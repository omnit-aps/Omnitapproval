// @ts-check
// UAT-051 — Super Decline without justification is rejected client-side.
// Choosing super_decline while leaving .super-reason-input empty must show
// the validation toast and must NOT process the record: the VB stays in the
// pending queue and its approvalstatus remains 'Pending Approval'.
const { test, expect } = require('@playwright/test');
const { createVendorBill, readField } = require('./helpers');

const TEST_VENDOR   = process.env.E2E_VENDOR  || 'ACME Industries';
const TEST_ACCOUNT  = process.env.E2E_ACCOUNT || 'Other Expenses';
const TEST_AMOUNT   = Number(process.env.E2E_AMOUNT || 500);
const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH;

test.skip(!DASHBOARD_PATH, 'Set NS_DASHBOARD_PATH to enable');

test('UAT-051 super_decline without reason shows validation toast and leaves record pending', async ({ page }) => {
  test.setTimeout(180_000);

  // ── 1. Seed a fresh Vendor Bill ──────────────────────────────────────────
  const result = await createVendorBill(page, {
    vendor:   TEST_VENDOR,
    account:  TEST_ACCOUNT,
    amount:   TEST_AMOUNT,
    scenario: 'UAT-051',
  });
  expect(result.id).toMatch(/^\d+$/);
  expect(result.status).toBe('Pending Approval');

  // ── 2. Open the bulk-approval dashboard ─────────────────────────────────
  await page.goto(DASHBOARD_PATH);
  await page.waitForLoadState('domcontentloaded');

  // Wait until at least one data row is visible
  const rows = page.locator('tr[data-id]');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });

  // ── 3. Locate the seeded VB row ─────────────────────────────────────────
  // NetSuite renders duplicate <tr data-id> nodes (frozen-column pane + scroll
  // pane) so we use .first() to avoid "locator resolved to 2 elements" errors.
  const row = page.locator(`tr[data-id="${result.id}"]`).first();
  await expect(row).toBeAttached({ timeout: 10_000 });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible({ timeout: 5_000 });

  // ── 4. Choose Super Decline — intentionally leave .super-reason-input empty
  await row.locator('.action-select').selectOption('super_decline');
  // Confirm the reason field is blank (default state; no fill call here)
  const reasonValue = await row.locator('.super-reason-input').inputValue();
  expect(reasonValue.trim()).toBe('');

  // ── 5. Submit without filling in the justification ───────────────────────
  await page.getByRole('button', { name: 'Submit approvals' }).first().click();

  // ── 6. Expect client-side validation toast (no server call should be made)
  await expect(page.locator('#toast')).toContainText(/Override justification is required/, { timeout: 10_000 });

  // ── 7. The row must still be present (no reload should have happened) ─────
  // Use .first() + toBeAttached because duplicate pane TRs may give count > 1.
  await expect(page.locator(`tr[data-id="${result.id}"]`).first()).toBeAttached({ timeout: 5_000 });

  // ── 8. Verify approvalstatus on the record is still Pending Approval ──────
  await page.goto(`/app/accounting/transactions/vendbill.nl?id=${result.id}&e=T`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => {
    /** @type {any} */ const w = window;
    try { return Boolean(w.nlapiGetFieldValue && w.nlapiGetFieldValue('approvalstatus')); } catch (_) { return false; }
  }, null, { timeout: 30_000 });
  const approvalStatus = await readField(page, 'approvalstatus');
  expect(approvalStatus).toBe('Pending Approval');
});
