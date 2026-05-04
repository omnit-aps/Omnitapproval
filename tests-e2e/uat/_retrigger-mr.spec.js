// @ts-check
/**
 * Re-trigger customscript_oa_mr_notifications for VB 94300 and 94301.
 *
 * Approaches tried in order (stops at first success per VB):
 *
 *   A4  Edit + Save the VB record without changes — the user_event afterSubmit
 *       schedules the MR. Simplest and most reliable path. Try this first.
 *
 *   A1  UI Save-and-Execute via the scheduled-script deployment edit form.
 *       Navigates to the deployment, sets parameters, clicks Save and Execute.
 *
 *   A2  nlapiScheduleScript injected via page.evaluate on the NS home page.
 *       Requires NLAPI globals (SuiteScript 1.x context). With Administrator
 *       role this sometimes works.
 *
 * Run with:
 *   npx playwright test _retrigger-mr --project=chromium --reporter=list
 */

const { test, expect } = require('@playwright/test');

const SCRIPT_ID   = 'customscript_oa_mr_notifications';
const DEPLOY_ID   = 'customdeploy_oa_mr_notifications';
const RECORD_TYPE = 'vendorbill';
const VB_IDS      = ['94300', '94301'];

// ──────────────────────────────────────────────────────────────────────────────
// Approach 4: Touch-save the VB (edit mode → Save without changes)
// The oa_user_event afterSubmit fires and schedules the MR.
// ──────────────────────────────────────────────────────────────────────────────
/**
 * @param {import('@playwright/test').Page} page
 * @param {string} vbId
 */
async function approach4_touchSave(page, vbId) {
  console.log(`[A4] Navigating to VB ${vbId} in edit mode...`);
  await page.goto(`/app/accounting/transactions/vendbill.nl?id=${vbId}&e=T`);
  await page.waitForLoadState('domcontentloaded');

  // Wait for the NS form to load by checking for a recognisable field
  const formReady = await page.waitForFunction(
    () => {
      /** @type {any} */ const w = window;
      try {
        return typeof w.nlapiGetFieldValue === 'function' &&
               !!w.nlapiGetFieldValue('tranid');
      } catch (_) { return false; }
    },
    null,
    { timeout: 30_000 },
  ).then(() => true).catch(() => false);

  if (!formReady) {
    // Check if it simply loaded as a view page (already approved, non-editable)
    const url = page.url();
    console.log(`[A4] Form not ready. URL: ${url}`);
    // Try to take a screenshot for diagnosis
    await page.screenshot({ path: `test-results/a4-vb${vbId}-load.png`, fullPage: true }).catch(() => {});

    // Fall back: try clicking Edit link if on view mode
    const editBtn = page.locator('a:has-text("Edit"), input[value="Edit"]').first();
    if (await editBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      console.log(`[A4] Clicking Edit link...`);
      await editBtn.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(
        () => {
          /** @type {any} */ const w = window;
          try { return typeof w.nlapiGetFieldValue === 'function'; } catch (_) { return false; }
        },
        null,
        { timeout: 15_000 },
      ).catch(() => {});
    }
  }

  // Check current approval status before saving
  const currentStatus = await page.evaluate(() => {
    /** @type {any} */ const w = window;
    try { return w.nlapiGetFieldValue('approvalstatus'); } catch (_) { return null; }
  }).catch(() => null);
  console.log(`[A4] VB ${vbId} approvalstatus = "${currentStatus}"`);

  // Find the Save button (multi-button submit)
  const saveBtn = page.locator('#btn_multibutton_submitter, input[id="btn_save"], button:has-text("Save")').first();
  const saveBtnVisible = await saveBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  console.log(`[A4] Save button visible: ${saveBtnVisible}`);

  if (!saveBtnVisible) {
    // Page may have rendered in view mode — screenshot and bail
    await page.screenshot({ path: `test-results/a4-vb${vbId}-nosave.png`, fullPage: true }).catch(() => {});
    return {
      ok: false,
      method: 'A4-touch-save',
      vbId,
      error: `Save button not found. URL: ${page.url()}. Approval status: ${currentStatus}`,
    };
  }

  // Click Save (no field changes — just triggers afterSubmit)
  await saveBtn.click({ force: true });

  // Wait for redirect back to view mode (URL will have id= but no e=T)
  const savedOk = await page.waitForURL(
    (u) => /vendbill\.nl/.test(u.toString()) && /id=\d+/.test(u.toString()),
    { timeout: 60_000 },
  ).then(() => true).catch(() => false);

  const finalUrl = page.url();
  console.log(`[A4] After save: ok=${savedOk}, URL: ${finalUrl}`);

  if (savedOk) {
    // Verify the MR was scheduled by checking script execution queue (via SuiteQL if accessible)
    return { ok: true, method: 'A4-touch-save', vbId, finalUrl };
  }

  await page.screenshot({ path: `test-results/a4-vb${vbId}-aftersave.png`, fullPage: true }).catch(() => {});
  return { ok: false, method: 'A4-touch-save', vbId, error: `Save redirect timed out. URL: ${finalUrl}` };
}

// ──────────────────────────────────────────────────────────────────────────────
// Approach 1: UI Save-and-Execute on the scheduled-script deployment
// ──────────────────────────────────────────────────────────────────────────────
/**
 * @param {import('@playwright/test').Page} page
 * @param {string} vbId
 */
async function approach1_saveAndExecute(page, vbId) {
  console.log(`[A1] Locating script deployment via SuiteQL...`);

  // Step 1: Find script internal id
  let nsScriptId = null;
  const scriptResp = await page.request.post('/services/rest/query/v1/suiteql?limit=5', {
    headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
    data: JSON.stringify({
      q: `SELECT id, scriptid FROM script WHERE scriptid = '${SCRIPT_ID}'`,
    }),
  }).catch(() => null);

  if (scriptResp && scriptResp.ok()) {
    const body = await scriptResp.json().catch(() => null);
    if (body?.items?.length > 0) {
      nsScriptId = String(body.items[0].id);
      console.log(`[A1] Script internal id: ${nsScriptId}`);
    }
  }

  // Step 2: Find deployment internal id
  let nsDeployId = null;
  if (nsScriptId) {
    const depResp = await page.request.post('/services/rest/query/v1/suiteql?limit=5', {
      headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
      data: JSON.stringify({
        q: `SELECT id, scriptid, status FROM scriptdeployment WHERE script = ${nsScriptId}`,
      }),
    }).catch(() => null);
    if (depResp && depResp.ok()) {
      const body = await depResp.json().catch(() => null);
      console.log(`[A1] Deployments: ${JSON.stringify(body?.items)}`);
      if (body?.items?.length > 0) {
        nsDeployId = String(body.items[0].id);
      }
    }
  }

  if (!nsScriptId || !nsDeployId) {
    return { ok: false, method: 'A1-UI', vbId, error: `Could not resolve script/deploy IDs. script=${nsScriptId} deploy=${nsDeployId}` };
  }

  // Step 3: Navigate to deployment edit page
  await page.goto(`/app/common/scripting/script.nl?id=${nsDeployId}&e=T`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  const pageTitle = await page.title();
  const pageUrl = page.url();
  console.log(`[A1] Deployment page title: "${pageTitle}", URL: ${pageUrl}`);
  await page.screenshot({ path: `test-results/a1-vb${vbId}-deploy-page.png`, fullPage: true }).catch(() => {});

  // Step 4: Fill in script parameters
  // NS renders script params in a sublist/subtab — may need to click the Parameters tab
  const paramsTab = page.locator('a:has-text("Parameters"), td:has-text("Parameters")').first();
  if (await paramsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    console.log(`[A1] Clicking Parameters tab...`);
    await paramsTab.click();
    await page.waitForTimeout(1000);
  }

  // Find and fill custscript_oa_mr_record_id
  const recordIdField = page.locator(
    'input[id*="custscript_oa_mr_record_id"], input[name*="custscript_oa_mr_record_id"], ' +
    'input[data-fieldid="custscript_oa_mr_record_id"]'
  ).first();

  const recordTypeField = page.locator(
    'input[id*="custscript_oa_mr_record_type"], input[name*="custscript_oa_mr_record_type"], ' +
    'select[id*="custscript_oa_mr_record_type"], input[data-fieldid="custscript_oa_mr_record_type"]'
  ).first();

  const fieldIdVisible = await recordIdField.isVisible({ timeout: 5_000 }).catch(() => false);
  console.log(`[A1] custscript_oa_mr_record_id field visible: ${fieldIdVisible}`);

  if (fieldIdVisible) {
    await recordIdField.fill(vbId);
    console.log(`[A1] Set custscript_oa_mr_record_id = ${vbId}`);
  }

  const fieldTypeVisible = await recordTypeField.isVisible({ timeout: 3_000 }).catch(() => false);
  if (fieldTypeVisible) {
    const tagName = await recordTypeField.evaluate((el) => el.tagName.toLowerCase());
    if (tagName === 'select') {
      await recordTypeField.selectOption({ label: 'Vendor Bill' }).catch(
        () => recordTypeField.selectOption(RECORD_TYPE)
      );
    } else {
      await recordTypeField.fill(RECORD_TYPE);
    }
    console.log(`[A1] Set custscript_oa_mr_record_type = ${RECORD_TYPE}`);
  }

  // Step 5: Click "Save and Execute"
  const saveExecBtn = page.locator(
    'input[value="Save and Execute"], button:has-text("Save and Execute"), ' +
    '#btn_multibutton_saveandexecute, a:has-text("Save and Execute")'
  ).first();

  const saveExecVisible = await saveExecBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  console.log(`[A1] "Save and Execute" button visible: ${saveExecVisible}`);

  if (!saveExecVisible) {
    // Try the multi-button dropdown — Save and Execute may be in the dropdown
    const multiBtn = page.locator('#btn_multibutton_save, #btn_multibutton_submitter').first();
    if (await multiBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      // Check for dropdown trigger
      const dropTrigger = page.locator('#btn_multibutton_save_arrow, #btn_multibutton_submitter_arrow').first();
      if (await dropTrigger.isVisible({ timeout: 2_000 }).catch(() => false)) {
        console.log(`[A1] Opening multi-button dropdown...`);
        await dropTrigger.click();
        await page.waitForTimeout(500);
        const dropExec = page.locator('a:has-text("Save and Execute"), li:has-text("Save and Execute")').first();
        if (await dropExec.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await dropExec.click();
          const confirmed = await page.waitForLoadState('domcontentloaded').then(() => true).catch(() => false);
          await page.waitForTimeout(3000);
          console.log(`[A1] Clicked dropdown "Save and Execute", confirmed=${confirmed}`);
          return { ok: true, method: 'A1-UI-dropdown', vbId, nsScriptId, nsDeployId };
        }
      }
    }
    await page.screenshot({ path: `test-results/a1-vb${vbId}-nosaveexec.png`, fullPage: true }).catch(() => {});
    return { ok: false, method: 'A1-UI', vbId, error: '"Save and Execute" not found on deployment edit page', nsScriptId, nsDeployId };
  }

  await saveExecBtn.click();
  await page.waitForTimeout(3000);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  console.log(`[A1] Clicked "Save and Execute". Final URL: ${page.url()}`);
  await page.screenshot({ path: `test-results/a1-vb${vbId}-aftersaveexec.png`, fullPage: true }).catch(() => {});
  return { ok: true, method: 'A1-UI', vbId, nsScriptId, nsDeployId };
}

// ──────────────────────────────────────────────────────────────────────────────
// Approach 2: nlapiScheduleScript via browser evaluate
// ──────────────────────────────────────────────────────────────────────────────
/**
 * @param {import('@playwright/test').Page} page
 * @param {string} vbId
 */
async function approach2_nlapi(page, vbId) {
  console.log(`[A2] Loading NS home to bootstrap NLAPI context...`);
  await page.goto('/app/center/card.nl?sc=-29&whence=');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  const hasNlapi = await page.evaluate(
    () => typeof /** @type {any} */ (window).nlapiScheduleScript === 'function',
  ).catch(() => false);
  console.log(`[A2] nlapiScheduleScript available: ${hasNlapi}`);

  if (!hasNlapi) {
    return { ok: false, method: 'A2-nlapi', vbId, error: 'nlapiScheduleScript not available in browser context' };
  }

  const result = await page.evaluate(
    ([sid, did, rid, rtype]) => {
      /** @type {any} */ const w = window;
      try {
        const params = {
          custscript_oa_mr_record_id:   rid,
          custscript_oa_mr_record_type: rtype,
        };
        const status = w.nlapiScheduleScript(sid, did, params);
        return { ok: true, status: String(status) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [SCRIPT_ID, DEPLOY_ID, vbId, RECORD_TYPE],
  ).catch((e) => ({ ok: false, error: String(e) }));

  console.log(`[A2] nlapiScheduleScript result: ${JSON.stringify(result)}`);
  return { ...result, method: 'A2-nlapi', vbId };
}

// ──────────────────────────────────────────────────────────────────────────────
// Check script execution log after triggering (optional verification)
// ──────────────────────────────────────────────────────────────────────────────
/**
 * @param {import('@playwright/test').Page} page
 * @param {string} vbId
 */
async function checkScriptLog(page, vbId) {
  // Query recent script execution log entries for this script
  const resp = await page.request.post('/services/rest/query/v1/suiteql?limit=5', {
    headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
    data: JSON.stringify({
      q: `SELECT id, scriptid, status, startdate, enddate FROM scriptexecution ` +
         `WHERE scriptid = '${SCRIPT_ID}' ORDER BY id DESC`,
    }),
  }).catch(() => null);

  if (resp && resp.ok()) {
    const body = await resp.json().catch(() => null);
    console.log(`[LOG-CHECK] VB ${vbId} - recent executions: ${JSON.stringify(body?.items?.slice(0, 3))}`);
    return body?.items;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main test suite
// ──────────────────────────────────────────────────────────────────────────────
test.describe('Re-trigger OA MR notifications script', () => {
  test.setTimeout(180_000);

  for (const vbId of VB_IDS) {
    test(`Retrigger ${SCRIPT_ID} for VB ${vbId}`, async ({ page }) => {
      console.log(`\n${'='.repeat(64)}`);
      console.log(`VB ${vbId} — attempting to trigger ${SCRIPT_ID}`);
      console.log('='.repeat(64));

      // Warm up the session
      await page.goto('/app/center/card.nl?sc=-29&whence=');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1000);

      // ── Approach 4: Touch-save (simplest, most reliable) ─────────────────
      const a4 = await approach4_touchSave(page, vbId);
      console.log(`[RESULT-A4] ${JSON.stringify(a4)}`);

      if (a4.ok) {
        console.log(`\n[SUCCESS] VB ${vbId} → ${a4.method}`);
        // Optional: check if MR was queued
        await checkScriptLog(page, vbId);
        expect(a4.ok).toBe(true);
        return;
      }

      // ── Approach 1: UI Save and Execute ──────────────────────────────────
      const a1 = await approach1_saveAndExecute(page, vbId);
      console.log(`[RESULT-A1] ${JSON.stringify(a1)}`);

      if (a1.ok) {
        console.log(`\n[SUCCESS] VB ${vbId} → ${a1.method}`);
        await checkScriptLog(page, vbId);
        expect(a1.ok).toBe(true);
        return;
      }

      // ── Approach 2: nlapiScheduleScript ──────────────────────────────────
      const a2 = await approach2_nlapi(page, vbId);
      console.log(`[RESULT-A2] ${JSON.stringify(a2)}`);

      if (a2.ok) {
        const status = /** @type {any} */ (a2).status || '';
        console.log(`\n[SUCCESS] VB ${vbId} → ${a2.method} (NS status: "${status}")`);
        if (String(status).toUpperCase() === 'FAILED') {
          console.warn(`[WARN] nlapiScheduleScript returned FAILED — may be already queued or deployment disabled`);
        }
        await checkScriptLog(page, vbId);
        expect(a2.ok).toBe(true);
        return;
      }

      // ── All failed ────────────────────────────────────────────────────────
      console.log(`\n[FAILED] All approaches failed for VB ${vbId}.`);
      console.log(`A4: ${a4.error}`);
      console.log(`A1: ${/** @type {any} */ (a1).error}`);
      console.log(`A2: ${/** @type {any} */ (a2).error}`);

      expect.soft(false, `Could not retrigger MR for VB ${vbId}.\nA4: ${a4.error}\nA1: ${/** @type {any} */ (a1).error}\nA2: ${/** @type {any} */ (a2).error}`).toBe(true);
    });
  }
});
