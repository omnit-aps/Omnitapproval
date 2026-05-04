// @ts-check
/**
 * Open the email-action deployment edit page and turn on
 * "Available Without Login" via the NS UI itself. Submit the form so NS goes
 * through its full audience-reconciliation path (which submitFields skips).
 */
const { test, expect } = require('@playwright/test');
test('toggle Available Without Login via NS UI', async ({ page }) => {
  test.setTimeout(120_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/common/scripting/scriptdeployment.nl?id=35899&e=T`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(6000);
  // Diagnostic dump
  const pageInfo = await page.evaluate(() => ({
    title: document.title,
    bodyLen: document.body.innerText.length,
    bodySnippet: document.body.innerText.slice(0, 500).replace(/\n+/g, ' | '),
    iframeCount: document.querySelectorAll('iframe').length,
    inputCount: document.querySelectorAll('input').length,
    checkboxCount: document.querySelectorAll('input[type="checkbox"]').length,
    selectCount: document.querySelectorAll('select').length,
  }));
  console.log('Page diagnostic:', JSON.stringify(pageInfo, null, 2));

  // Locate the "Available Without Login" checkbox. NS uses a few possible ids.
  const candidateIds = [
    'isonline', 'isonlineform', 'available_without_login', 'availablewithoutlogin',
    'iswithoutlogin', 'isnologin'
  ];
  let toggled = false;
  let toggledId = '';
  for (const id of candidateIds) {
    const cb = page.locator(`#${id}`).first();
    if (await cb.count() === 0) continue;
    const isChecked = await cb.isChecked().catch(() => null);
    console.log(`Found checkbox #${id} — currently ${isChecked === true ? 'CHECKED' : isChecked === false ? 'unchecked' : 'unknown'}`);
    if (isChecked === false) {
      await cb.check({ force: true });
      toggled = true;
    } else if (isChecked === true) {
      // already on; nothing to flip but we still need to save to refresh audience
      toggled = true;
    }
    toggledId = id;
    break;
  }

  if (!toggledId) {
    // No id matched — list all checkboxes for diagnostic
    const all = await page.evaluate(() => Array.from(document.querySelectorAll('input[type="checkbox"]')).map(cb => ({
      id: cb.id, name: cb.getAttribute('name'), checked: cb.checked,
      labelText: (() => {
        const lbl = document.querySelector(`label[for="${cb.id}"]`);
        return lbl ? lbl.textContent.trim() : '';
      })(),
    })));
    console.log('No matching id; all checkboxes on page:');
    all.forEach(cb => console.log(`  id="${cb.id}" name="${cb.name}" labelText="${cb.labelText}" checked=${cb.checked}`));
  }

  // Save the form via the NS multibutton or any submit input.
  const saveSelectors = ['#btn_multibutton_submitter', 'input[value="Save"]', 'button:has-text("Save")'];
  let saved = false;
  for (const s of saveSelectors) {
    const btn = page.locator(s).first();
    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true });
      saved = true;
      break;
    }
  }
  await page.waitForTimeout(3000);
  console.log(`Toggle: ${toggledId || '(none)'}, Saved via UI: ${saved}, Final URL: ${page.url()}`);
  await page.screenshot({ path: 'test-results/avail-toggle-after-save.png', fullPage: true });
  expect(saved).toBe(true);
});
