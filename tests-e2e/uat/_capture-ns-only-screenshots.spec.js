// @ts-check
/**
 * Pure NetSuite (no Omnit Approval) HD screenshots for the demo deck.
 * Captures NS native dashboards, analytics, KPIs, and reports at 2x retina.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.setTimeout(360_000);
const OUT = '/Users/work/Omnitapproval/demo-screenshots-ns';

test('capture HD NS-native screenshots', async ({ browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');

  // Fresh context with retina-quality (2x device-scale, 1920x1200 viewport).
  const ctx = await browser.newContext({
    storageState: 'tests-e2e/.auth/state.json',
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // Sanity: confirm session is alive.
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load', timeout: 30_000 });
  const sanityTitle = await page.evaluate(() => document.title);
  if (/login/i.test(sanityTitle)) throw new Error('Auth expired');

  const targets = [
    // Home / dashboards (these usually render with portlets, KPIs, charts)
    { name: '01-ns-home-dashboard',         url: '/app/center/card.nl' },
    { name: '02-ns-home-classic',           url: '/app/center/card.nl?sc=-29' },
    // The Manufacturing center has its own dashboard
    { name: '03-ns-mfg-dashboard',          url: '/app/center/card.nl?sc=-71' },
    { name: '04-ns-accountant-dashboard',   url: '/app/center/card.nl?sc=-120' },
    // Transaction lists with status badges (look pretty in screenshots)
    { name: '05-ns-vendor-bills',           url: '/app/accounting/transactions/vendbill.nl' },
    { name: '06-ns-purchase-orders',        url: '/app/accounting/transactions/purchord.nl' },
    { name: '07-ns-sales-orders',           url: '/app/accounting/transactions/salesord.nl' },
    { name: '08-ns-invoices',               url: '/app/accounting/transactions/custinvc.nl' },
    // Vendor / customer record views (have summary tabs with charts on some forms)
    { name: '09-ns-vendor-acme',            url: '/app/common/entity/vendor.nl?id=11' },
    // SuiteAnalytics workbench (newer NS analytics — colorful charts when available)
    { name: '10-ns-analytics-workbench',    url: '/app/translations/analytics/saved-searches/' },
    { name: '11-ns-analytics-portlet',      url: '/app/center/embedded.nl?ovurl=%2Fapp%2Ftranslations%2Fanalytics%2Fworkbook%2F' },
    // Item record (Manufacturing demo has rich items)
    { name: '12-ns-item-list',              url: '/app/common/item/itemlist.nl' },
    // Setup → Center types — colorful menu page if accessible
    { name: '13-ns-employee-list',          url: '/app/common/entity/employeelist.nl' },
  ];

  const results = [];
  for (const t of targets) {
    const out = path.join(OUT, t.name + '.png');
    try {
      const resp = await page.goto(`${baseURL}${t.url}`, { waitUntil: 'load', timeout: 45_000 });
      await page.waitForTimeout(4000);
      const status = resp ? resp.status() : '?';
      const pageTitle = await page.evaluate(() => document.title || '');
      if (/login/i.test(pageTitle) && !t.url.includes('login')) {
        results.push({ name: t.name, ok: false, status, title: pageTitle, skipped: 'auth lost' });
        console.log(`[SKIP-LOGIN] ${t.name}`);
        continue;
      }
      // Dismiss "What's New" / dashboard nag overlays.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: out, fullPage: true, type: 'png' });
      const okPage = status < 400 && !/Page not found|do not have privileges/i.test(pageTitle);
      results.push({ name: t.name, ok: okPage, status, title: pageTitle, file: out });
      console.log(`[${status}] ${t.name} title="${pageTitle.slice(0, 70)}" -> ${out}`);
    } catch (e) {
      results.push({ name: t.name, ok: false, error: e.message });
      console.log(`[ERR] ${t.name}: ${e.message}`);
    }
  }

  await ctx.close();
  const summary = results.map(r => `${r.ok ? '✅' : '❌'} ${r.name} -- ${r.title || r.error || r.status} ${r.skipped ? '(' + r.skipped + ')' : ''}`).join('\n');
  console.log('\n=== HD NS Screenshot summary ===\n' + summary);
  fs.writeFileSync(path.join(OUT, 'manifest.txt'), summary + '\n');
  expect(true).toBe(true);
});
