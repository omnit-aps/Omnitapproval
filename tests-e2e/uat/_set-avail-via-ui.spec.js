// @ts-check
const { test, expect } = require('@playwright/test');
test('set Available Without Login via NS UI', async ({ page }) => {
  test.setTimeout(120_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  // Deployment record edit URL (id 35899)
  await page.goto(`${baseURL}/app/common/scripting/scriptdeployment.nl?id=35899&e=T`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2000);
  // Dump page title + first 400 body chars to confirm we landed
  const info = await page.evaluate(() => ({
    title: document.title,
    snippet: document.body.innerText.slice(0, 400).replace(/\n+/g, ' | '),
    inputs: Array.from(document.querySelectorAll('input, select')).slice(0, 200).map(el => ({
      id: el.id, name: el.getAttribute('name'), type: el.type, tag: el.tagName, value: el.type === 'checkbox' ? (el.checked ? 'T' : 'F') : (el.value || '').slice(0, 50)
    })).filter(i => i.id && /avail|login|onl|extern|public|guest|anon/i.test(i.id + ' ' + (i.name || '')))
  }));
  console.log('Page title:', info.title);
  console.log('Body snippet:', info.snippet.slice(0, 200));
  console.log('Login/avail inputs:', JSON.stringify(info.inputs, null, 2));
  await page.screenshot({ path: 'test-results/deployment-edit.png', fullPage: true });
  expect(true).toBe(true);
});
