// @ts-check
const { test, expect } = require('@playwright/test');

// Resolve dashboard URL via the live NS session — no env var needed.
// Falls back to NS_DASHBOARD_PATH if explicitly set.
const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH ||
  '/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_dashboard&deploy=customdeploy_oa_sl_dashboard';

test.describe('dashboard filters', () => {
  test('Pending is the default active status filter', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    const pending = page.locator('.filter-btn', { hasText: /^Pending$/ });
    await expect(pending).toHaveClass(/active/);
  });

  test('clicking Approved updates URL and active class', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    await page.locator('.filter-btn', { hasText: /^Approved$/ }).click();
    await page.waitForURL(/oa_filter_status=approved/);
    await expect(page.locator('.filter-btn', { hasText: /^Approved$/ })).toHaveClass(/active/);
    await expect(page.locator('.filter-btn', { hasText: /^Pending$/ })).not.toHaveClass(/active/);
  });

  test('clicking Rejected updates URL and active class', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    await page.locator('.filter-btn', { hasText: /^Rejected$/ }).click();
    await page.waitForURL(/oa_filter_status=rejected/);
    await expect(page.locator('.filter-btn', { hasText: /^Rejected$/ })).toHaveClass(/active/);
  });

  test('clicking All status updates URL and active class', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    await page.locator('.filter-btn[onclick*="status\',\'all"]').click();
    await page.waitForURL(/oa_filter_status=all/);
  });

  test('clicking Purchase Order type filter updates URL', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    await page.locator('.filter-btn', { hasText: 'Purchase Order' }).click();
    await page.waitForURL(/oa_filter_type=po/);
    await expect(page.locator('.filter-btn', { hasText: 'Purchase Order' })).toHaveClass(/active/);
  });

  test('clicking Vendor Bill type filter updates URL', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    await page.locator('.filter-btn', { hasText: 'Vendor Bill' }).click();
    await page.waitForURL(/oa_filter_type=vb/);
    await expect(page.locator('.filter-btn', { hasText: 'Vendor Bill' })).toHaveClass(/active/);
  });

  test('status and type filters compose in URL', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    await page.locator('.filter-btn', { hasText: /^Approved$/ }).click();
    await page.waitForURL(/oa_filter_status=approved/);
    await page.locator('.filter-btn', { hasText: 'Vendor Bill' }).click();
    await page.waitForURL(/oa_filter_type=vb/);
    expect(page.url()).toMatch(/oa_filter_status=approved/);
    expect(page.url()).toMatch(/oa_filter_type=vb/);
  });
});
