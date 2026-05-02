// @ts-check
const { test, expect } = require('@playwright/test');

const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH;
test.skip(!DASHBOARD_PATH, 'Set NS_DASHBOARD_PATH to enable');

test.describe('dashboard structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
  });

  test('header and topbar render', async ({ page }) => {
    await expect(page).toHaveTitle(/Bulk Approval/);
    await expect(page.locator('.topbar-logo')).toHaveText('OMNI:T');
    await expect(page.locator('.topbar-title')).toContainText('Omnit Approvals');
    await expect(page.getByRole('heading', { name: 'Bulk Approval' })).toBeVisible();
    await expect(page.getByText('Process multiple transactions at once')).toBeVisible();
  });

  test('all status filter buttons are present', async ({ page }) => {
    for (const label of ['Pending', 'Approved', 'Rejected']) {
      await expect(page.locator('.filter-btn', { hasText: new RegExp(`^${label}$`) })).toBeVisible();
    }
    // "All" appears twice (status + type); status one is the first .filter-btn matching.
    await expect(page.locator('.filter-btn[onclick*="status\',\'all"]')).toBeVisible();
  });

  test('all type filter buttons are present', async ({ page }) => {
    await expect(page.locator('.filter-btn', { hasText: 'Purchase Order' })).toBeVisible();
    await expect(page.locator('.filter-btn', { hasText: 'Vendor Bill' })).toBeVisible();
  });

  test('three summary cards render with labels', async ({ page }) => {
    const cards = page.locator('.summary-cards .card');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0).locator('.card-label')).toHaveText(/Total approved/i);
    await expect(cards.nth(1).locator('.card-label')).toHaveText(/Total rejected/i);
    await expect(cards.nth(2).locator('.card-label')).toHaveText(/Progress/i);
  });

  test('table headers match expected approval columns', async ({ page }) => {
    const expected = [
      'Action', 'Reason', 'Type', 'Vendor',
      'Document #', 'Currency', 'Subsidiary',
      'Amount', 'Submitted by', 'Next approver', 'Date', 'Status',
    ];
    const headers = await page.locator('thead th').allTextContents();
    expect(headers).toEqual(expected);
  });

  test('Submit and Reset buttons are present', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Submit approvals' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset' }).first()).toBeVisible();
  });

  test('shows empty-state row when no transactions match', async ({ page }) => {
    // Navigate with a PO+Rejected filter combination unlikely to have rows.
    await page.goto(`${DASHBOARD_PATH}&oa_filter_type=po&oa_filter_status=rejected`);
    // Wait for the table body to finish rendering (either rows or the empty-state cell).
    await page.waitForSelector('#txn-table td', { timeout: 15000 });
    const rowCount = await page.locator('tr[data-id]').count();
    if (rowCount > 0) {
      // Rows exist — the empty-state can't be shown; skip rather than false-fail.
      test.skip(true, `PO+Rejected filter returned ${rowCount} row(s); empty-state not reachable`);
      return;
    }
    const emptyCell = page.locator('td.empty');
    await expect(emptyCell).toBeVisible();
    await expect(emptyCell).toHaveText(/No transactions match the filter/i);
  });
});
