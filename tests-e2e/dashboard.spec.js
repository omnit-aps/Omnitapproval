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
  await expect(page.locator('.topbar-title')).toHaveText('Omnit Approvals — Bulk Approval');
  await page.screenshot({ path: 'test-results/dashboard-loaded.png', fullPage: true });
});

test('topbar has Settings link', async ({ page }) => {
  await page.goto(DASHBOARD_PATH);
  const settingsLink = page.locator('.topbar-settings');
  await expect(settingsLink).toBeVisible();
  await expect(settingsLink).toHaveText('Settings');
  await expect(settingsLink).toHaveAttribute('href', /script=.*&deploy=/);
});

test('filter row exposes date / vendor / amount / subsidiary inputs', async ({ page }) => {
  await page.goto(DASHBOARD_PATH);
  const form = page.locator('#adv-filter-form');
  await expect(form).toBeVisible();
  await expect(form.locator('input[name="oa_filter_date_from"]')).toBeVisible();
  await expect(form.locator('input[name="oa_filter_date_to"]')).toBeVisible();
  await expect(form.locator('select[name="oa_filter_vendor"]')).toBeVisible();
  await expect(form.locator('input[name="oa_filter_amount_min"]')).toBeVisible();
  await expect(form.locator('input[name="oa_filter_amount_max"]')).toBeVisible();
  await expect(form.locator('select[name="oa_filter_subsidiary"]')).toBeVisible();
});
