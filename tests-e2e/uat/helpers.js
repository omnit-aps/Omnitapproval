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
 * Detects the NetSuite "You have been logged out" session-expiry modal and
 * throws a descriptive error so the test fails fast with a clear message
 * rather than timing out 45 s later inside waitForFunction.
 * @param {import('@playwright/test').Page} page
 */
async function assertNotLoggedOut(page) {
  const logoutModal = page.locator('text=You have been logged out').first();
  const visible = await logoutModal.isVisible().catch(() => false);
  if (visible) {
    throw new Error(
      'NetSuite session expired mid-test ("You have been logged out" modal detected). ' +
      'Re-run `npx playwright test --project=setup` to refresh the auth cookie, then retry.',
    );
  }
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
  // Type the vendor name slowly so the NS type-ahead dropdown appears, then
  // pick the first matching suggestion. Falling back to Tab-blur if no popup
  // shows (e.g. exact-match single result that resolves immediately).
  const entityInput = page.locator('#entity_display');
  await entityInput.clear();
  await entityInput.pressSequentially(vendor, { delay: 80 });
  // Wait up to 5 s for the suggestion list; if it appears, click first item.
  const suggestionList = page.locator('div.ns-suggest-list .ns-sug-item, div[id^="_suggestions"] li, div.suggestions li').first();
  const listVisible = await suggestionList.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
  if (listVisible) {
    await suggestionList.click();
  } else {
    await page.keyboard.press('Tab');
  }
  await dismissBlockingModals(page);
  // Wait for the read-only display span to reflect the resolved vendor name,
  // which confirms NS has fully loaded the vendor record and auto-filled fields.
  await page.locator('#entity_displayonly').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  await assertNotLoggedOut(page);
  await page.waitForFunction(() => {
    /** @type {any} */ const w = window;
    try { return Boolean(w.nlapiGetFieldValue && w.nlapiGetFieldValue('account')); } catch (_) { return false; }
  }, null, { timeout: 45_000 });
  await page.locator('#popuptimeoutblocker').waitFor({ state: 'hidden' }).catch(() => {});

  // Body memo — sublist also has #memo on some form variants; scope by aria-label.
  await page.locator('input[aria-labelledby="memo_fs_lbl"]').fill(memoTag(scenario));

  // Add a committed expense line via NS client-record APIs. A VB with no
  // expense/item line silently aborts save (no POST). The body Amount field
  // is just a control total — not the accounting distribution. The line
  // account must differ from the body Account (NS rejects duplicate accounts).
  //
  // Account resolution strategy:
  //   1. Use nlapiSearchRecord (in a separate evaluate) to enumerate real Expense accounts.
  //      Retry up to 3 times — nlapiSearchRecord makes synchronous XHR calls that
  //      intermittently return HTML error pages in the sandbox.
  //   2. Try to match the requested name (and a list of fallbacks) against actual names.
  //   3. If no name matches, pick the first non-AP leaf account from the search results.
  //   4. Set the line via nlapiSetCurrentLineItemValue(id) — avoids the unreliable
  //      nlapiSetCurrentLineItemText typeahead which intermittently fails to resolve.

  // Step A: resolve account ID (with retries, separate from line-item mutation)
  const HARDCODED_EXPENSE_IDS = ['59', '60', '63', '146', '149', '160', '161', '162', '163', '164', '362'];
  const fallbackNames = [
    'Other Expenses', 'Office Supplies', 'Office Expenses', 'Travel',
    'Telephone', 'Postage and Delivery', 'Bank Charges',
    'Miscellaneous Expense', 'Other Expense', 'Operating Expense', 'General Expense',
  ];

  /** @type {{id:string, name:string}|null} */
  let resolvedAccount = null;
  let resolveLog = '';
  for (let attempt = 0; attempt < 3 && !resolvedAccount; attempt++) {
    if (attempt > 0) await page.waitForTimeout(1500);
    resolvedAccount = await page.evaluate(({ account: acct, fallbacks, bodyExclusions }) => {
      /** @type {any} */ const w = window;
      const bodyAccountId = String(w.nlapiGetFieldValue('account') || '');
      try {
        if (typeof w.nlapiSearchRecord !== 'function') return null;
        const filters = [
          new w.nlobjSearchFilter('type', null, 'anyof', ['Expense']),
          new w.nlobjSearchFilter('isinactive', null, 'is', 'F'),
        ];
        const cols = [
          new w.nlobjSearchColumn('internalid'),
          new w.nlobjSearchColumn('name'),
        ];
        const rs = w.nlapiSearchRecord('account', null, filters, cols);
        if (!rs || rs.length === 0) return null;
        const accounts = rs.map((/** @type {any} */ r) => ({
          id: r.getValue('internalid'),
          name: r.getValue('name') || '',
        })).filter((/** @type {{id:string,name:string}} */ a) => !bodyExclusions.includes(a.id));
        const candidates = [acct, ...fallbacks.filter((n) => n !== acct)];
        for (const name of candidates) {
          const lower = name.toLowerCase();
          const match = accounts.find(
            (a) => a.name.toLowerCase() === lower ||
                   a.name.toLowerCase().includes(lower) ||
                   lower.includes(a.name.toLowerCase()),
          );
          if (match) return match;
        }
        return accounts[0] || null;
      } catch (_) { return null; }
    }, { account, fallbacks: fallbackNames, bodyExclusions: [await page.evaluate(() => String((/** @type {any} */ (window)).nlapiGetFieldValue('account') || ''))] });
  }
  // If all retries failed, use hard-coded IDs from this sandbox as last resort
  if (!resolvedAccount) {
    const bodyId = await page.evaluate(() => String((/** @type {any} */ (window)).nlapiGetFieldValue('account') || ''));
    const fallbackId = HARDCODED_EXPENSE_IDS.find((id) => id !== bodyId) || HARDCODED_EXPENSE_IDS[0];
    resolvedAccount = { id: fallbackId, name: `[hardcoded id=${fallbackId}]` };
    resolveLog = 'nlapiSearchRecord failed 3x; using hardcoded account id';
  }
  console.log(`[createVendorBill] account resolved: "${resolvedAccount.name}" (id=${resolvedAccount.id}, requested="${account}") ${resolveLog}`);

  // Step B: add the expense line using the pre-resolved account ID (no XHR in evaluate)
  const lineResult = await page.evaluate(({ accountId, accountName, amount }) => {
    /** @type {any} */ const w = window;
    /** @type {Record<string, any>} */ const log = { accountUsed: accountName, accountId };
    try {
      w.nlapiSelectNewLineItem('expense');
      w.nlapiSetCurrentLineItemValue('expense', 'account', accountId, false, false);
      w.nlapiSetCurrentLineItemValue('expense', 'amount', String(amount), false, false);
      w.nlapiCommitLineItem('expense');
      log.lineCount = w.nlapiGetLineItemCount('expense');
    } catch (e) {
      log.fatal = e instanceof Error ? e.message : String(e);
    }
    return log;
  }, { accountId: resolvedAccount.id, accountName: resolvedAccount.name, amount });
  if (!lineResult.lineCount || lineResult.lineCount < 1) {
    throw new Error(`Could not add expense line: ${JSON.stringify(lineResult)}`);
  }

  // Save: blur active element, then click NS's actual multi-button.
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur());
  await page.locator('#popuptimeoutblocker').waitFor({ state: 'hidden' }).catch(() => {});
  await assertNotLoggedOut(page);
  await page.locator('#btn_multibutton_submitter').click({ force: true });
  try {
    await page.waitForURL((u) => /vendbill\.nl/.test(u.toString()) && /id=\d+/.test(u.toString()), { timeout: 60_000 });
    await assertNotLoggedOut(page);
  } catch (e) {
    await assertNotLoggedOut(page).catch((logoutErr) => { throw logoutErr; });
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
  return { id, status, nextApprover, accountUsed: lineResult.accountUsed, accountId: lineResult.accountId };
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

/**
 * Idempotently set an OA flag on an employee record (e.g. is_manager=T on psld
 * so the dashboard shows all pending records). Uses NetSuite's nlapiSubmitField
 * which is a server-side update — no form save cycle needed.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string|number} employeeId  Internal id of the employee record
 * @param {string} fieldId            e.g. 'custentity_oa_is_manager'
 * @param {string} value              'T' or 'F'
 */
async function setEmployeeFlag(page, employeeId, fieldId, value) {
  await page.goto(`/app/common/entity/employee.nl?id=${employeeId}&e=T`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    (id) => {
      /** @type {any} */ const w = window;
      try { return typeof w.nlapiGetFieldValue === 'function' && w.nlapiGetFieldValue('id') === String(id); } catch (_) { return false; }
    },
    String(employeeId),
    { timeout: 30_000 },
  );
  const before = await page.evaluate(
    (f) => /** @type {any} */ (window).nlapiGetFieldValue(f),
    fieldId,
  );
  if (before === value) return { changed: false, before, after: before };
  const after = await page.evaluate(
    ([type, id, f, v]) => {
      /** @type {any} */ const w = window;
      w.nlapiSubmitField(type, id, f, v);
      return w.nlapiLookupField ? w.nlapiLookupField(type, id, f) : v;
    },
    /** @type {[string, string, string, string]} */ (['employee', String(employeeId), fieldId, value]),
  );
  return { changed: true, before, after };
}

module.exports = { createVendorBill, readField, deleteTestRecord, setEmployeeFlag, assertNotLoggedOut, TEST_TAG, memoTag };
