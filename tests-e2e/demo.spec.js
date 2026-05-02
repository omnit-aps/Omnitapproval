// @ts-check
// 40-second demo walkthrough of the OmnitApprovals bulk approval dashboard.
// Recorded to video. Run:
//   npx playwright test demo --project=chromium --headed
// Output: test-results/demo-OmnitApprovals-bulk-approval-demo-chromium/video.webm
const { test, expect } = require('@playwright/test');

const DASHBOARD_PATH = process.env.NS_DASHBOARD_PATH;
test.skip(!DASHBOARD_PATH, 'Set NS_DASHBOARD_PATH to enable');

test.use({
  video: { mode: 'on', size: { width: 1280, height: 720 } },
  viewport: { width: 1280, height: 720 },
});

test('OmnitApprovals bulk approval demo', async ({ page }) => {
  test.setTimeout(120_000);

  // 0–5s: Land on the bulk approval dashboard
  await page.goto(DASHBOARD_PATH);
  await expect(page.getByRole('heading', { name: 'Bulk Approval' })).toBeVisible();
  await page.waitForTimeout(3_500);

  // 5–10s: Show the summary cards
  await page.locator('.summary-cards').scrollIntoViewIfNeeded();
  await page.waitForTimeout(3_000);

  // 10–18s: Click through status filters (linger on each)
  await page.locator('.filter-btn', { hasText: /^Approved$/ }).click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2_500);

  await page.locator('.filter-btn', { hasText: /^All$/ }).first().click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2_500);

  await page.locator('.filter-btn', { hasText: /^Pending$/ }).click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2_500);

  // 18–22s: Highlight a row and hover the new Document # link
  const firstRow = page.locator('tr[data-id]').first();
  await firstRow.scrollIntoViewIfNeeded();
  await firstRow.hover();
  await page.waitForTimeout(1_500);
  const docLink = firstRow.locator('a').first();
  if (await docLink.count() > 0) {
    await docLink.hover();
    await page.waitForTimeout(2_000);
  }

  // 22–30s: Open the action dropdown to show available super-approve actions,
  // pick "Reassign" so the new per-row approver dropdown appears.
  const actionSelect = firstRow.locator('.action-select');
  await actionSelect.click();
  await page.waitForTimeout(2_000);
  const hasReassign = (await actionSelect.locator('option[value="reassign"]').count()) > 0;
  if (hasReassign) {
    await actionSelect.selectOption('reassign');
  } else {
    await actionSelect.selectOption({ index: 1 });
  }
  await page.waitForTimeout(2_500);
  const approverPicker = firstRow.locator('select.reassign-input');
  if (await approverPicker.count() > 0) {
    await approverPicker.click();
    await page.waitForTimeout(3_000);
  }

  // 30–37s: Cross-navigate to Settings via the new topbar link, linger
  const settingsLink = page.locator('.topbar-settings, a.topbar-settings').first();
  if (await settingsLink.count() > 0) {
    await settingsLink.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5_000);
    await page.goBack();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1_500);
  }

  // 37–42s: Slow tour through the pending queue — manager view of all 80+ records
  await page.locator('.table-card').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_000);
  // Scroll the table area to show more rows over time
  await page.evaluate(() => window.scrollBy({ top: 200, left: 0, behavior: 'smooth' }));
  await page.waitForTimeout(2_500);
  await page.evaluate(() => window.scrollBy({ top: 300, left: 0, behavior: 'smooth' }));
  await page.waitForTimeout(2_500);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(2_500);
});
