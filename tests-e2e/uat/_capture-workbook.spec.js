// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.setTimeout(420_000);
const OUT = '/Users/work/Omnitapproval/demo-screenshots-ns';

test('capture analytics workbook variations', async ({ browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  const ctx = await browser.newContext({
    storageState: 'tests-e2e/.auth/state.json',
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // Find Workbook record types we can open
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });

  // Try various workbook record types
  const targets = [
    { name: '40-workbook-supply-chain',     url: '/app/common/report/report.nl?recordType=supplyChainSnapshotSimulation' },
    { name: '41-workbook-transaction',      url: '/app/common/report/report.nl?recordType=transaction' },
    { name: '42-workbook-vendorbill',       url: '/app/common/report/report.nl?recordType=vendorbill' },
    { name: '43-workbook-purchaseorder',    url: '/app/common/report/report.nl?recordType=purchaseorder' },
    { name: '44-workbook-employee',         url: '/app/common/report/report.nl?recordType=employee' },
    { name: '45-workbook-item',             url: '/app/common/report/report.nl?recordType=item' },
    // Saved searches with charts
    { name: '46-saved-search-list',         url: '/app/common/search/savedsearchlist.nl' },
    { name: '47-search-list',               url: '/app/common/report/searchlist.nl' },
    // Reports
    { name: '48-financial-report',          url: '/app/reporting/financialreport.nl' },
    // KPI portlet preview pages
    { name: '49-portlet-kpi',               url: '/app/center/dashboard.nl' },
  ];

  for (const t of targets) {
    try {
      await page.goto(`${baseURL}${t.url}`, { waitUntil: 'load', timeout: 45_000 });
      await page.waitForTimeout(6000);
      const title = await page.evaluate(() => document.title);
      const isErr = /login|page not found|do not have priv/i.test(title);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, t.name + '.png'), fullPage: true });
      console.log(`${isErr ? '❌' : '✅'} ${t.name} -- ${title.slice(0, 70)}`);
    } catch (e) { console.log(`ERR ${t.name}: ${e.message}`); }
  }

  await ctx.close();
  expect(true).toBe(true);
});
