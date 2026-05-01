// @ts-check
const { test, expect } = require('@playwright/test');

const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH;
test.skip(!DASHBOARD_PATH, 'Set NS_DASHBOARD_PATH to enable');

test.describe('dashboard interactions (read-only)', () => {
  test('Refresh button reloads the page', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    await page.locator('button.btn-secondary', { hasText: 'Refresh' }).click();
    await page.waitForLoadState('load');
    await expect(page.getByRole('heading', { name: 'Bulk Approval' })).toBeVisible();
  });

  test('clicking Submit with no rows shows "No actions selected" toast', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    // With 0 transactions there are no action selects, so submit should hit the
    // "No actions selected." branch in submitAll().
    await page.getByRole('button', { name: 'Submit approvals' }).first().click();
    const toast = page.locator('#toast');
    await expect(toast).toHaveClass(/show/);
    await expect(toast).toHaveText(/No actions selected/i);
  });

  test('Reset button does not error on empty table', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    // resetAll() iterates select/inputs; with none present it should be a no-op.
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.getByRole('button', { name: 'Reset' }).first().click();
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });
});
