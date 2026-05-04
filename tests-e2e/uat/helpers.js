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

/**
 * Creates a basic Purchase Order via the standard NetSuite UI.
 * Mirrors {@link createVendorBill} but uses the PO 'item' sublist instead
 * of the VB 'expense' sublist. Returns the saved record's internal id and
 * approval status.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} opts
 * @param {string} opts.vendor    Vendor display name
 * @param {string} [opts.item]    Optional item name to prefer; falls through
 *                                a list of common candidates if not found.
 * @param {number} [opts.quantity] Line quantity (defaults to 1)
 * @param {string} opts.scenario  Short label embedded in memo
 */
async function createPurchaseOrder(page, { vendor, item, quantity, scenario }) {
  const qty = Number(quantity || 1);
  await page.goto('/app/accounting/transactions/purchord.nl?whence=');
  await page.waitForLoadState('domcontentloaded');
  await dismissBlockingModals(page);

  // Vendor selection — same type-ahead pattern as VB.
  const entityInput = page.locator('#entity_display');
  await entityInput.clear();
  await entityInput.pressSequentially(vendor, { delay: 80 });
  const suggestionList = page.locator('div.ns-suggest-list .ns-sug-item, div[id^="_suggestions"] li, div.suggestions li').first();
  const listVisible = await suggestionList.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
  if (listVisible) {
    await suggestionList.click();
  } else {
    await page.keyboard.press('Tab');
  }
  await dismissBlockingModals(page);
  await page.locator('#entity_displayonly').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  await assertNotLoggedOut(page);
  // PO doesn't auto-fill an account field, so wait for the item sublist API to be ready.
  await page.waitForFunction(() => {
    /** @type {any} */ const w = window;
    try { return typeof w.nlapiSelectNewLineItem === 'function' && Boolean(w.nlapiGetFieldValue && w.nlapiGetFieldValue('entity')); } catch (_) { return false; }
  }, null, { timeout: 45_000 });
  await page.locator('#popuptimeoutblocker').waitFor({ state: 'hidden' }).catch(() => {});

  // Body memo.
  await page.locator('input[aria-labelledby="memo_fs_lbl"]').fill(memoTag(scenario));

  // LOCATION (required on PO in Manufacturing-edition NS accounts). NS
  // scopes Location by Subsidiary — picking a Location outside the active
  // Subsidiary silently rejects. Iterate the existing <select id="location">
  // options (which NS already filtered to valid subsidiary-scoped values)
  // and pick the first non-empty one. Falls back to nlapiSetFieldValue with
  // a searched id when the DOM picker isn't available.
  const resolvedLocation = await page.evaluate(() => {
    /** @type {any} */ const w = window;
    try {
      const existing = w.nlapiGetFieldValue && w.nlapiGetFieldValue('location');
      if (existing) return { id: existing, source: 'preset' };
      // Try the rendered <select> first — it shows only subsidiary-scoped locations
      const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('location'));
      if (sel && sel.options) {
        for (let i = 0; i < sel.options.length; i++) {
          const opt = sel.options[i];
          if (opt.value && opt.value !== '0' && opt.value !== '') {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            try { w.nlapiSetFieldValue('location', opt.value, true, true); } catch (_) {}
            return { id: opt.value, name: opt.text, source: 'dom-select' };
          }
        }
      }
      // Fallback: search filtered by current subsidiary so we don't pick a
      // cross-subsidiary location that NS will silently reject.
      const subId = w.nlapiGetFieldValue && w.nlapiGetFieldValue('subsidiary');
      const filters = [new w.nlobjSearchFilter('isinactive', null, 'is', 'F')];
      if (subId) filters.push(new w.nlobjSearchFilter('subsidiary', null, 'anyof', subId));
      const rs = w.nlapiSearchRecord('location', null, filters,
        [new w.nlobjSearchColumn('internalid'), new w.nlobjSearchColumn('name')]);
      if (rs && rs.length) {
        const first = rs[0];
        const id = first.getValue('internalid');
        try { w.nlapiSetFieldValue('location', id, true, true); } catch (_) {}
        return { id, name: first.getValue('name'), source: 'searched-by-sub' };
      }
    } catch (e) { return { __error: e.message || String(e) }; }
    return null;
  });
  console.log(`[createPurchaseOrder] location: ${JSON.stringify(resolvedLocation)}`);

  // Item resolution strategy:
  //   1. nlapiSearchRecord on type=item filtering isinactive=F. Item supertype
  //      covers serviceitem, noninventoryitem, otherchargeitem, etc.
  //   2. Prefer requested name, then a fallback list of common test item names.
  //   3. Otherwise pick the first non-inactive item the search returns
  //      (preferring service / non-inventory types since they don't need stock).
  //   4. If search yields nothing, fall back to a list of hard-coded NS standard
  //      item ids; if those also fail, fail loudly with a clear message.

  const HARDCODED_ITEM_IDS = ['1', '2', '3', '4', '5', '10', '20', '50', '100'];
  const fallbackItemNames = [
    'Generic Service', 'Test Item', 'Service', 'Consulting', 'Consulting Services',
    'Professional Services', 'Labor', 'Misc Service', 'Miscellaneous',
    'Office Supplies', 'Generic Item',
  ];
  const PREFERRED_TYPES = ['Service', 'NonInvtPart', 'OthCharge', 'InvtPart', 'Group'];

  /** @type {{id:string, name:string, type?:string}|null} */
  let resolvedItem = null;
  let resolveLog = '';
  for (let attempt = 0; attempt < 3 && !resolvedItem; attempt++) {
    if (attempt > 0) await page.waitForTimeout(1500);
    resolvedItem = await page.evaluate(({ requested, fallbacks, preferredTypes }) => {
      /** @type {any} */ const w = window;
      try {
        if (typeof w.nlapiSearchRecord !== 'function') return null;
        const filters = [new w.nlobjSearchFilter('isinactive', null, 'is', 'F')];
        const cols = [
          new w.nlobjSearchColumn('internalid'),
          new w.nlobjSearchColumn('itemid'),
          new w.nlobjSearchColumn('type'),
        ];
        const rs = w.nlapiSearchRecord('item', null, filters, cols);
        if (!rs || rs.length === 0) return null;
        const items = rs.map((/** @type {any} */ r) => ({
          id: r.getValue('internalid'),
          name: r.getValue('itemid') || '',
          type: r.getValue('type') || '',
        }));
        const candidates = requested ? [requested, ...fallbacks.filter((n) => n !== requested)] : fallbacks;
        for (const name of candidates) {
          const lower = String(name).toLowerCase();
          const match = items.find(
            (it) => it.name.toLowerCase() === lower ||
                    it.name.toLowerCase().includes(lower) ||
                    lower.includes(it.name.toLowerCase()),
          );
          if (match) return match;
        }
        // No name match — pick first item of a preferred type, else first item overall.
        for (const t of preferredTypes) {
          const byType = items.find((it) => it.type === t);
          if (byType) return byType;
        }
        return items[0] || null;
      } catch (_) { return null; }
    }, { requested: item || null, fallbacks: fallbackItemNames, preferredTypes: PREFERRED_TYPES });
  }

  if (!resolvedItem) {
    // Last resort: try hard-coded ids by attempting to set them on a line.
    for (const id of HARDCODED_ITEM_IDS) {
      const ok = await page.evaluate((tryId) => {
        /** @type {any} */ const w = window;
        try {
          w.nlapiSelectNewLineItem('item');
          w.nlapiSetCurrentLineItemValue('item', 'item', tryId, false, false);
          const set = w.nlapiGetCurrentLineItemValue('item', 'item');
          w.nlapiCancelLineItem('item');
          return set === tryId;
        } catch (_) { return false; }
      }, id).catch(() => false);
      if (ok) {
        resolvedItem = { id, name: `[hardcoded id=${id}]` };
        resolveLog = 'nlapiSearchRecord failed; resolved via hardcoded id probe';
        break;
      }
    }
  }
  if (!resolvedItem) {
    throw new Error('no items in sandbox; create one and re-run');
  }
  console.log(`[createPurchaseOrder] item resolved: "${resolvedItem.name}" (id=${resolvedItem.id}, type=${resolvedItem.type || '?'}, requested="${item || ''}") ${resolveLog}`);

  // Add the item line. PO item-sourcing fires async sublist field updates
  // (rate, units, taxcode); fire fire-fields=true on the item set so NS
  // sources defaults, then poll briefly for the rate/description to show up
  // before committing. Trigger field-change handlers via the 4th/5th args.
  const lineResult = await page.evaluate(async ({ itemId, itemName, qty }) => {
    /** @type {any} */ const w = window;
    /** @type {Record<string, any>} */ const log = { itemUsed: itemName, itemId, steps: [] };
    const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    try {
      w.nlapiSelectNewLineItem('item');
      log.steps.push('selectNewLine');
      // 4th arg = fireSlavingSync (synchronously source dependent fields).
      w.nlapiSetCurrentLineItemValue('item', 'item', itemId, true, true);
      log.steps.push('setItem');
      // Wait up to 5s for NS to source rate / description.
      let sourced = false;
      for (let i = 0; i < 20 && !sourced; i++) {
        const desc = w.nlapiGetCurrentLineItemValue('item', 'description');
        const rate = w.nlapiGetCurrentLineItemValue('item', 'rate');
        if (desc || rate) { sourced = true; break; }
        await sleep(250);
      }
      log.sourced = sourced;
      w.nlapiSetCurrentLineItemValue('item', 'quantity', String(qty), true, true);
      log.steps.push('setQty');
      const rate = w.nlapiGetCurrentLineItemValue('item', 'rate');
      if (!rate || Number(rate) === 0) {
        w.nlapiSetCurrentLineItemValue('item', 'rate', '100', true, true);
        log.steps.push('forceRate');
      }
      log.preCommit = {
        item: w.nlapiGetCurrentLineItemValue('item', 'item'),
        quantity: w.nlapiGetCurrentLineItemValue('item', 'quantity'),
        rate: w.nlapiGetCurrentLineItemValue('item', 'rate'),
        amount: w.nlapiGetCurrentLineItemValue('item', 'amount'),
      };
      w.nlapiCommitLineItem('item');
      log.steps.push('commit');
      log.lineCount = w.nlapiGetLineItemCount('item');
    } catch (e) {
      log.fatal = e instanceof Error ? `${e.message}\n${e.stack || ''}` : String(e);
    }
    return log;
  }, { itemId: resolvedItem.id, itemName: resolvedItem.name, qty });
  console.log(`[createPurchaseOrder] line result: ${JSON.stringify(lineResult)}`);
  if (!lineResult.lineCount || lineResult.lineCount < 1) {
    throw new Error(`Could not add PO item line: ${JSON.stringify(lineResult)}`);
  }

  // Save.
  await page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement)?.blur());
  await page.locator('#popuptimeoutblocker').waitFor({ state: 'hidden' }).catch(() => {});
  await assertNotLoggedOut(page);
  await page.locator('#btn_multibutton_submitter').click({ force: true });
  try {
    // NS lands at either purchord.nl?id=N (older form variants) OR
    // transaction.nl?id=N (newer / Manufacturing-edition forms). Accept both.
    await page.waitForURL((u) => /(?:purchord|transaction)\.nl/.test(u.toString()) && /id=\d+/.test(u.toString()), { timeout: 60_000 });
    await assertNotLoggedOut(page);
  } catch (e) {
    await assertNotLoggedOut(page).catch((logoutErr) => { throw logoutErr; });
    await page.screenshot({ path: 'test-results/po-save-stuck.png', fullPage: true });
    throw e;
  }

  const id = new URL(page.url()).searchParams.get('id');
  await page.goto(`/app/accounting/transactions/purchord.nl?id=${id}&e=T`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => {
    /** @type {any} */ const w = window;
    try {
      return Boolean(
        w.nlapiGetFieldValue &&
        (w.nlapiGetFieldValue('approvalstatus') || w.nlapiGetFieldValue('orderstatus')),
      );
    } catch (_) { return false; }
  }, null, { timeout: 30_000 });
  // POs surface approval state via 'approvalstatus' (same field as VB on most accounts);
  // some forms expose it as 'orderstatus' instead — read both and prefer the non-empty.
  const status = (await readField(page, 'approvalstatus')) || (await readField(page, 'orderstatus'));
  const nextApprover = await readField(page, 'nextapprover');
  return { id, status, nextApprover, itemUsed: lineResult.itemUsed, itemId: lineResult.itemId };
}

module.exports = { createVendorBill, createPurchaseOrder, readField, deleteTestRecord, setEmployeeFlag, assertNotLoggedOut, TEST_TAG, memoTag };
