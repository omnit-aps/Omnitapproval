// @ts-check
// UAT-050 — Super Approve: admin override approval sets record to Approved.
// A VB with no matching matrix rule (nextapprover=null) exposes only the
// super_approve / super_decline / reassign / skip actions.  This test
// verifies that choosing super_approve with a justification processes the
// record and transitions it to 'Approved'.
const { test, expect } = require('@playwright/test');
const { createVendorBill, readField } = require('./helpers');

const TEST_VENDOR   = process.env.E2E_VENDOR  || 'ACME Industries';
const TEST_ACCOUNT  = process.env.E2E_ACCOUNT || 'Other Expenses';
const TEST_AMOUNT   = Number(process.env.E2E_AMOUNT || 500);
const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH;

test.skip(!DASHBOARD_PATH, 'Set NS_DASHBOARD_PATH to enable');

test('UAT-050 super_approve transitions VB to Approved and removes it from pending queue', async ({ page }) => {
  test.setTimeout(180_000);

  // ── 1. Seed a fresh Vendor Bill ──────────────────────────────────────────
  const result = await createVendorBill(page, {
    vendor:   TEST_VENDOR,
    account:  TEST_ACCOUNT,
    amount:   TEST_AMOUNT,
    scenario: 'UAT-050',
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

  // ── 4. Choose Super Approve and fill the mandatory justification ─────────
  await row.locator('.action-select').selectOption('super_approve');
  await row.locator('.super-reason-input').fill('[E2E-TEST] auto super approve');

  // ── 5. Submit ────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Submit approvals' }).first().click();

  // ── 6. Expect success toast ──────────────────────────────────────────────
  await expect(page.locator('#toast')).toContainText(/Done: 1 processed/, { timeout: 30_000 });

  // ── 7. Wait for the automatic reload (1.8 s) then give it extra time ─────
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
  // After reload the dashboard defaults to pending filter — the processed
  // row must no longer appear in the table.
  await expect(page.locator(`tr[data-id="${result.id}"]`)).toHaveCount(0, { timeout: 15_000 });

  // ── 8. Verify approvalstatus on the record itself ────────────────────────
  await page.goto(`/app/accounting/transactions/vendbill.nl?id=${result.id}&e=T`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => {
    /** @type {any} */ const w = window;
    try { return Boolean(w.nlapiGetFieldValue && w.nlapiGetFieldValue('approvalstatus')); } catch (_) { return false; }
  }, null, { timeout: 30_000 });
  const approvalStatus = await readField(page, 'approvalstatus');
  expect(approvalStatus).toBe('Approved');
});
