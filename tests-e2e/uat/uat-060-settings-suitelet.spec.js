// @ts-check
/**
 * UAT-060 — Settings Suitelet end-to-end.
 * Loads the settings page and asserts manager-level access + a working
 * topbar link back to the bulk approval dashboard.
 */
const { test, expect } = require('@playwright/test');

test.setTimeout(60_000);

test.describe('UAT-060 settings Suitelet', () => {
  test('manager (psld) loads the Settings page without access denied', async ({ page }) => {
    const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
    const url = `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_settings&deploy=customdeploy_oa_sl_settings`;
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    expect(resp?.status(), `HTTP status from settings Suitelet`).toBeLessThan(500);

    const body = await page.evaluate(() => document.body.innerText.slice(0, 500));
    expect(body).not.toMatch(/You do not have privileges/i);
    expect(body).not.toMatch(/Page not found/i);
    expect(body).toMatch(/settings|approval|subsidiary/i);
  });

  test('Settings page topbar contains Bulk Approval link', async ({ page }) => {
    const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
    await page.goto(`${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_settings&deploy=customdeploy_oa_sl_settings`,
      { waitUntil: 'load', timeout: 30_000 });
    const link = page.locator('.topbar-link, a').filter({ hasText: /Bulk Approval/i }).first();
    const linkVisible = await link.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    if (!linkVisible) {
      // Fallback diagnostic: dump topbar HTML so we know what's there.
      const topbarHtml = await page.evaluate(() => {
        const tb = document.querySelector('.topbar');
        return tb ? tb.outerHTML.slice(0, 800) : '(no .topbar element)';
      });
      console.log('Settings topbar HTML:', topbarHtml);
    }
    expect(linkVisible, 'Settings topbar should expose a "Bulk Approval" link').toBe(true);
    const href = await link.getAttribute('href');
    expect(href, 'Bulk Approval link must point at the dashboard Suitelet').toMatch(/script=.*&deploy=/);
  });

  test('POST without default approver returns an error message inline', async ({ page }) => {
    // Drive the POST via fetch so we exercise the server-side validator without
    // navigating away from the page (so we don't accidentally save invalid data).
    const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
    await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
    const url = `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_settings&deploy=customdeploy_oa_sl_settings`;
    const resp = await page.evaluate(async ([u, body]) => {
      const r = await fetch(u, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      return { status: r.status, body: await r.text() };
    }, [url, 'oa_enable_vb=T&oa_default_approver1=&oa_use_amount=F&oa_subsidiary=2&oa_settings_id=new&oa_approver_count=1']);
    expect(resp.status).toBe(200);
    expect(resp.body, 'server must reject POST when default approver is missing').toMatch(/Default Approver 1 is required/i);
  });
});
