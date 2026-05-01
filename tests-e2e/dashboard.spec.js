// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Starter test for the OmnitApprovals dashboard Suitelet (oa_sl_dashboard.js).
 *
 * Fill in DASHBOARD_PATH with the deployed Suitelet URL path from your sandbox
 * (Setup > Customization > Scripts > Script Deployments — copy the External URL,
 * keep just the path, e.g. /app/site/hosting/scriptlet.nl?script=123&deploy=1).
 */
const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH ?? '';

test.skip(!DASHBOARD_PATH, 'Set NS_DASHBOARD_PATH to enable');

test('dashboard loads', async ({ page }) => {
  await page.goto(DASHBOARD_PATH);
  await expect(page).toHaveTitle(/Bulk Approval/);
  await expect(page.locator('.topbar-title')).toContainText('Omnit Approvals');
  await expect(page.getByRole('heading', { name: 'Bulk Approval' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-loaded.png', fullPage: true });
});
