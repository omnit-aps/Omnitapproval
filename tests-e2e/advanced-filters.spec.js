// @ts-check
const { test, expect } = require('@playwright/test');

const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH;
test.skip(!DASHBOARD_PATH, 'Set NS_DASHBOARD_PATH to enable');

// Helper: skip a test gracefully when the advanced-filter form is absent,
// which means the updated Suitelet has not yet been deployed to this sandbox.
async function requireAdvFilterForm(page) {
  const form = page.locator('#adv-filter-form');
  const count = await form.count();
  if (count === 0) {
    test.skip(true, 'Advanced filter form (#adv-filter-form) not found — deploy the updated Suitelet first');
  }
}

test.describe('advanced filters (date / vendor / amount / subsidiary)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
  });

  test('Vendor filter dropdown is present and has at least 2 options', async ({ page }) => {
    await requireAdvFilterForm(page);
    const vendorSelect = page.locator('#adv-filter-form select[name="oa_filter_vendor"]');
    await expect(vendorSelect).toBeVisible();
    const optionCount = await vendorSelect.locator('option').count();
    expect(optionCount).toBeGreaterThanOrEqual(2); // "All vendors" + at least one vendor
  });

  test('Subsidiary filter dropdown is present', async ({ page }) => {
    await requireAdvFilterForm(page);
    const subsidiarySelect = page.locator('#adv-filter-form select[name="oa_filter_subsidiary"]');
    await expect(subsidiarySelect).toBeVisible();
  });

  test('Amount min/max inputs render with type=number', async ({ page }) => {
    await requireAdvFilterForm(page);
    const amountMin = page.locator('#adv-filter-form input[name="oa_filter_amount_min"]');
    const amountMax = page.locator('#adv-filter-form input[name="oa_filter_amount_max"]');
    await expect(amountMin).toBeVisible();
    await expect(amountMax).toBeVisible();
    await expect(amountMin).toHaveAttribute('type', 'number');
    await expect(amountMax).toHaveAttribute('type', 'number');
  });

  test('Date from/to inputs render with type=date', async ({ page }) => {
    await requireAdvFilterForm(page);
    const dateFrom = page.locator('#adv-filter-form input[name="oa_filter_date_from"]');
    const dateTo   = page.locator('#adv-filter-form input[name="oa_filter_date_to"]');
    await expect(dateFrom).toBeVisible();
    await expect(dateTo).toBeVisible();
    await expect(dateFrom).toHaveAttribute('type', 'date');
    await expect(dateTo).toHaveAttribute('type', 'date');
  });

  test('Apply button submits the form and the URL contains the filter params', async ({ page }) => {
    await requireAdvFilterForm(page);
    // Fill amount min only — safe, non-destructive; won't zero out the queue.
    const amountMin = page.locator('#adv-filter-form input[name="oa_filter_amount_min"]');
    await amountMin.fill('1');

    const applyBtn = page.locator('#adv-filter-form button.btn-apply-filters');
    await expect(applyBtn).toBeVisible();
    await applyBtn.click();

    await page.waitForURL(/oa_filter_amount_min=1/);
    expect(page.url()).toMatch(/oa_filter_amount_min=1/);
    // Hidden inputs should carry status/type through the form submission.
    expect(page.url()).toMatch(/oa_filter_status=/);
    expect(page.url()).toMatch(/oa_filter_type=/);
  });

  test('Clear filters resets advanced URL params', async ({ page }) => {
    // Start from a URL that has an amount_min param so there is something to clear.
    await page.goto(`${DASHBOARD_PATH}&oa_filter_amount_min=999`);
    await requireAdvFilterForm(page);

    const clearLink = page.locator('#adv-filter-form a.btn-clear-filters');
    await expect(clearLink).toBeVisible();
    await clearLink.click();

    // After clearing, amount_min should be absent from the URL.
    await page.waitForURL((url) => !url.toString().includes('oa_filter_amount_min'));
    expect(page.url()).not.toMatch(/oa_filter_amount_min/);
    // Status and type chip params should survive the clear.
    expect(page.url()).toMatch(/oa_filter_status=/);
    expect(page.url()).toMatch(/oa_filter_type=/);
  });
});
