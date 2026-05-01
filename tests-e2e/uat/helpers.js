// @ts-check
/**
 * UAT helpers for OmnitApprovals e2e tests.
 *
 * Test records are tagged with [E2E-TEST] in memo so they can be filtered/cleaned.
 */

const TEST_TAG = '[E2E-TEST]';

/** @param {string} scenario */
function memoTag(scenario) {
  return `${TEST_TAG} ${scenario} ${new Date().toISOString()}`;
}

/**
 * Dismisses one-off NetSuite popups that may appear over forms (security
 * questions setup, "what's new" announcements, etc.). No-op if none present.
 * NS renders these buttons inconsistently (sometimes <button>, sometimes <input>,
 * sometimes <a>), so try multiple strategies.
 * @param {import('@playwright/test').Page} page
 */
async function dismissBlockingModals(page) {
  // Try Escape first — NetSuite modals often close on it
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);

  const labels = ['Remind Me Later', 'Close', 'Dismiss', 'No Thanks', 'Not Now'];
  // Search all frames (NS modals are sometimes in iframes)
  for (const frame of page.frames()) {
    for (const label of labels) {
      const btn = frame.locator(`button:has-text("${label}"), input[value="${label}"], a:has-text("${label}")`).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  }
  // Final sweep: nuke any large fixed/absolute overlay that's still there
  await page.evaluate(() => {
    document.querySelectorAll('div, section').forEach((el) => {
      const cs = getComputedStyle(el);
      if ((cs.position === 'fixed' || cs.position === 'absolute') && Number(cs.zIndex) > 100) {
        const r = el.getBoundingClientRect();
        if (r.width > 300 && r.height > 200 && r.top < 200) el.remove();
      }
    });
  }).catch(() => {});
}

/**
 * Creates a basic Vendor Bill via the standard NetSuite UI.
 * Returns the saved record's internal id and approval status.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} opts
 * @param {string} opts.vendor   Vendor display name (e.g. "ACME Industries")
 * @param {string} opts.account  Expense account name to use on the line
 * @param {number} opts.amount   Line amount
 * @param {string} opts.scenario Short label that will be embedded in memo
 */
async function createVendorBill(page, { vendor, account, amount, scenario }) {
  await page.goto('/app/accounting/transactions/vendbill.nl?whence=');
  await page.waitForLoadState('domcontentloaded');
  await dismissBlockingModals(page);

  // Vendor selection auto-fills Account / Subsidiary / Posting Period.
  await page.locator('#entity_display').fill(vendor);
  await page.keyboard.press('Tab');
  await dismissBlockingModals(page);
  await page.waitForFunction(() => {
    /** @type {any} */ const w = window;
    try { return Boolean(w.nlapiGetFieldValue && w.nlapiGetFieldValue('account')); } catch (_) { return false; }
  }, null, { timeout: 30_000 });
  await page.locator('#popuptimeoutblocker').waitFor({ state: 'hidden' }).catch(() => {});

  // Body memo — sublist also has #memo on some form variants; scope by aria-label.
  await page.locator('input[aria-labelledby="memo_fs_lbl"]').fill(memoTag(scenario));

  // Add a committed expense line via NS client-record APIs. A VB with no
  // expense/item line silently aborts save (no POST). The body Amount field
  // is just a control total — not the accounting distribution. The line
  // account must differ from the body Account (NS rejects duplicate accounts).
  const lineResult = await page.evaluate(({ account, amount }) => {
    /** @type {any} */ const w = window;
    /** @type {Record<string, any>} */ const log = {};
    try {
      w.nlapiSelectNewLineItem('expense');
      w.nlapiSetCurrentLineItemText('expense', 'account', account, true, true);
      const resolved = w.nlapiGetCurrentLineItemText('expense', 'account');
      log.accountAfter = resolved;
      if (!resolved) { log.fatal = `Account "${account}" did not resolve`; return log; }
      w.nlapiSetCurrentLineItemValue('expense', 'amount', String(amount), true, true);
      w.nlapiCommitLineItem('expense');
      log.lineCount = w.nlapiGetLineItemCount('expense');
    } catch (e) {
      log.fatal = e instanceof Error ? e.message : String(e);
    }
    return log;
  }, { account, amount });
  if (!lineResult.lineCount || lineResult.lineCount < 1) {
    throw new Error(`Could not add expense line: ${JSON.stringify(lineResult)}`);
  }

  // Save: blur active element, then click NS's actual multi-button.
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur());
  await page.locator('#popuptimeoutblocker').waitFor({ state: 'hidden' }).catch(() => {});
  await page.locator('#btn_multibutton_submitter').click({ force: true });
  try {
    await page.waitForURL((u) => /vendbill\.nl/.test(u.toString()) && /id=\d+/.test(u.toString()), { timeout: 60_000 });
  } catch (e) {
    await page.screenshot({ path: 'test-results/save-stuck.png', fullPage: true });
    throw e;
  }

  const id = new URL(page.url()).searchParams.get('id');
  // Navigate to edit-mode URL — nlapiGetField* APIs work there but not on view-only.
  await page.goto(`/app/accounting/transactions/vendbill.nl?id=${id}&e=T`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => {
    /** @type {any} */ const w = window;
    try { return Boolean(w.nlapiGetFieldValue && w.nlapiGetFieldValue('approvalstatus')); } catch (_) { return false; }
  }, null, { timeout: 30_000 });
  const status = await readField(page, 'approvalstatus');
  const nextApprover = await readField(page, 'nextapprover');
  return { id, status, nextApprover };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} fieldId
 */
async function readField(page, fieldId) {
  // First try the runtime API which works in view mode regardless of DOM markup
  const apiVal = await page.evaluate((id) => {
    /** @type {any} */
    const w = window;
    try {
      const text = typeof w.nlapiGetFieldText === 'function' ? w.nlapiGetFieldText(id) : null;
      if (text && String(text).trim()) return String(text).trim();
      const val = typeof w.nlapiGetFieldValue === 'function' ? w.nlapiGetFieldValue(id) : null;
      if (val && String(val).trim()) return String(val).trim();
    } catch (_) {}
    return null;
  }, fieldId).catch(() => null);
  if (apiVal) return apiVal;

  // DOM fallbacks (view-mode formatted text)
  const candidates = [`#${fieldId}_fs_inlinetext`, `#${fieldId}_val`, `#${fieldId}_fs`, `#${fieldId}_display`, `#${fieldId}`];
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      const txt = (await el.textContent().catch(() => null)) || (await el.inputValue().catch(() => null));
      if (txt && txt.trim()) return txt.trim();
    }
  }
  return null;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} type   NetSuite transaction type segment, e.g. "vendbill" or "purchord"
 * @param {string} id     Internal record id
 */
async function deleteTestRecord(page, type, id) {
  await page.goto(`/app/accounting/transactions/${type}.nl?id=${id}&e=T`);
  // Actions menu → Delete (NetSuite-specific; bail silently if not allowed)
  await page.locator('a:has-text("Actions"), a:has-text("More Actions")').first().click().catch(() => {});
  await page.locator('a:has-text("Delete")').first().click().catch(() => {});
  await page.locator('input[value="OK"]').first().click().catch(() => {});
}

module.exports = { createVendorBill, readField, deleteTestRecord, TEST_TAG, memoTag };
