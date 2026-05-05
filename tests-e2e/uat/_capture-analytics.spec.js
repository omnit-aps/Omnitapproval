// @ts-check
/**
 * Discover and capture NS analytics pages psld DOES have access to.
 * Captures the Analytics list page, drills into the first few entries,
 * and grabs the Planning Workbench. 2x retina output.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.setTimeout(420_000);
const OUT = '/Users/work/Omnitapproval/demo-screenshots-ns';

test('drill into accessible NS analytics', async ({ browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  const ctx = await browser.newContext({
    storageState: 'tests-e2e/.auth/state.json',
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load', timeout: 30_000 });

  // 1. The Analytics list — psld's accessible entry point
  await page.goto(`${baseURL}/app/common/report/list.nl?sc=-160`, { waitUntil: 'load', timeout: 45_000 });
  await page.waitForTimeout(4000);
  await page.keyboard.press('Escape').catch(() => {});
  await page.screenshot({ path: path.join(OUT, '20-ns-analytics-list.png'), fullPage: true });

  // Pull individual analytic links from the list
  const analyticLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/app/common/report"]'));
    return links
      .map(a => ({ text: a.textContent.trim().slice(0, 60), href: a.href }))
      .filter(l => l.href.includes('report.nl') && !l.href.includes('list.nl'))
      .slice(0, 6);
  });
  console.log('Analytics drill-down links:', JSON.stringify(analyticLinks, null, 2));

  for (let i = 0; i < analyticLinks.length; i++) {
    const l = analyticLinks[i];
    const safe = l.text.replace(/[^a-z0-9]/gi, '-').slice(0, 30);
    try {
      await page.goto(l.href, { waitUntil: 'load', timeout: 45_000 });
      await page.waitForTimeout(5000);
      const title = await page.evaluate(() => document.title);
      if (/login|page not found/i.test(title)) { console.log(`Skip ${l.text}: ${title}`); continue; }
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `21-${String(i + 1).padStart(2, '0')}-analytics-${safe}.png`), fullPage: true });
      console.log(`Captured analytics: ${l.text}`);
    } catch (e) { console.log(`Err ${l.text}: ${e.message}`); }
  }

  // 2. Planning Workbench (Manufacturing demo)
  for (const target of [
    { name: '30-ns-planning-workbench-views', url: '/app/planning/workbench/planningviews.nl' },
    { name: '31-ns-planning-workbench-new',   url: '/app/planning/workbench/planningview.nl' },
    // Reports landing — try variants psld can hit
    { name: '32-ns-reports-snapshot',         url: '/app/reporting/snapshots.nl' },
    { name: '33-ns-supply-chain-search',      url: '/app/common/report/report.nl?recordType=supplyChainSnapshotSimulation' },
  ]) {
    try {
      await page.goto(`${baseURL}${target.url}`, { waitUntil: 'load', timeout: 45_000 });
      await page.waitForTimeout(5000);
      const title = await page.evaluate(() => document.title);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, target.name + '.png'), fullPage: true });
      console.log(`[${title.slice(0, 50)}] ${target.name}`);
    } catch (e) { console.log(`Err ${target.name}: ${e.message}`); }
  }

  await ctx.close();
  expect(true).toBe(true);
});
