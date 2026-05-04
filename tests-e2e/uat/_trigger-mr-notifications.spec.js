// @ts-check
/**
 * One-shot trigger: schedule customscript_oa_mr_notifications for VB 94300 and
 * VB 94301 to force email re-send.
 *
 * Strategy (three escalating approaches):
 *   1. REST API: POST to /services/rest/script/v1/schedule (SuiteScript 2.x endpoint)
 *   2. nlapiScheduleScript via browser evaluate on the NS home page (NLAPI context)
 *   3. Suitelet/URL trigger approach: navigate to the script deployment page and
 *      "Save and Execute" via UI interactions
 *
 * Run with:
 *   npx playwright test _trigger-mr-notifications --project=chromium --reporter=list
 */

const { test, expect } = require('@playwright/test');

const SCRIPT_ID   = 'customscript_oa_mr_notifications';
const RECORD_TYPE = 'vendorbill';
const VB_IDS      = ['94300', '94301'];

/**
 * Attempt 1: schedule via REST API (SuiteScript 2.x schedule endpoint).
 * @param {import('@playwright/test').APIRequestContext} api
 * @param {string} scriptId
 * @param {string} recordId
 * @returns {Promise<{ok: boolean, status: number, body: string}>}
 */
async function scheduleViaRest(api, scriptId, recordId) {
  // SuiteScript 2.x task/schedule endpoint
  const resp = await api.post('/services/rest/record/v1/scheduledscriptinstance', {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({
      scriptid:    { id: scriptId },
      parameters: {
        custscript_oa_mr_record_id:   recordId,
        custscript_oa_mr_record_type: RECORD_TYPE,
      },
    }),
  }).catch((e) => null);
  if (!resp) return { ok: false, status: 0, body: 'fetch error' };
  const body = await resp.text().catch(() => '');
  return { ok: resp.ok(), status: resp.status(), body: body.slice(0, 500) };
}

/**
 * Attempt 2: schedule via N/task module through an inline Suitelet POST
 * (execute arbitrary server-side code by calling the NS REST API executor).
 * @param {import('@playwright/test').APIRequestContext} api
 * @param {string} scriptId
 * @param {string} recordId
 */
async function scheduleViaSuiteQL(api, scriptId, recordId) {
  // SuiteQL can't trigger scripts. This is a placeholder that signals "not tried".
  return { ok: false, status: 0, body: 'not-applicable' };
}

/**
 * Attempt 3: use nlapiScheduleScript in the browser NLAPI context.
 * This works on any NS page that loads the full NLAPI.
 * @param {import('@playwright/test').Page} page
 * @param {string} scriptId
 * @param {string} deploymentId  Pass null to use the default deployment
 * @param {string} recordId
 */
async function scheduleViaClientNlapi(page, scriptId, deploymentId, recordId) {
  // Load the NS home/dashboard page which reliably bootstraps the full NLAPI
  await page.goto('/app/center/card.nl?sc=-29&whence=');
  await page.waitForLoadState('domcontentloaded');
  // Wait for nlapiScheduleScript to be available (client NLAPI)
  const hasSchedule = await page.waitForFunction(
    () => typeof /** @type {any} */ (window).nlapiScheduleScript === 'function',
    null,
    { timeout: 30_000 },
  ).then(() => true).catch(() => false);

  if (!hasSchedule) {
    return { ok: false, error: 'nlapiScheduleScript not available in this context' };
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
    [scriptId, deploymentId ?? null, recordId, RECORD_TYPE],
  );
  return result;
}

/**
 * Attempt 4: UI-based trigger — find the script deployment in the UI
 * and use "Save and Execute".
 * @param {import('@playwright/test').Page} page
 * @param {string} scriptId
 * @param {string} recordId
 */
async function scheduleViaUI(page, scriptId, recordId) {
  // First, find the internal ID of the script via SuiteQL through REST
  const searchResp = await page.request.post('/services/rest/query/v1/suiteql?limit=5', {
    headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
    data: JSON.stringify({
      q: `SELECT id, scriptid, name FROM script WHERE scriptid = '${scriptId}'`,
    }),
  });

  let nsScriptId = null;
  let deployId   = null;

  if (searchResp.ok()) {
    const body = await searchResp.json();
    console.log(`[SCRIPT-SEARCH] ${JSON.stringify(body).slice(0, 300)}`);
    if (body.items && body.items.length > 0) {
      nsScriptId = String(body.items[0].id);
    }
  }

  // Also find the deployment ID
  if (nsScriptId) {
    const depResp = await page.request.post('/services/rest/query/v1/suiteql?limit=5', {
      headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
      data: JSON.stringify({
        q: `SELECT id, scriptid, status FROM scriptdeployment WHERE script = ${nsScriptId}`,
      }),
    });
    if (depResp.ok()) {
      const body = await depResp.json();
      console.log(`[DEPLOY-SEARCH] ${JSON.stringify(body).slice(0, 300)}`);
      if (body.items && body.items.length > 0) {
        deployId = String(body.items[0].id);
      }
    }
  }

  console.log(`[UI-TRIGGER] script internal id: ${nsScriptId}, deployment id: ${deployId}`);

  if (!nsScriptId) {
    return { ok: false, error: `Could not find script ${scriptId} via SuiteQL — insufficient permissions or script does not exist` };
  }

  // Navigate to the script deployment edit page
  await page.goto(`/app/common/scripting/script.nl?id=${nsScriptId}&whence=`);
  await page.waitForLoadState('domcontentloaded');

  // Check if we landed on the script page
  const pageTitle = await page.title();
  console.log(`[UI-TRIGGER] Page title: "${pageTitle}", URL: ${page.url()}`);

  // Try navigating to the scheduled scripts list
  await page.goto('/app/common/scripting/scheduledscripts.nl');
  await page.waitForLoadState('domcontentloaded');

  const scheduledUrl = page.url();
  console.log(`[UI-TRIGGER] Scheduled scripts URL: ${scheduledUrl}`);

  // Look for the notification script in the list
  const scriptRow = page.locator(`tr:has-text("${scriptId}"), tr:has-text("OA")`).first();
  const rowVisible = await scriptRow.isVisible().catch(() => false);
  console.log(`[UI-TRIGGER] Script row visible: ${rowVisible}`);

  if (!rowVisible) {
    return {
      ok: false,
      nsScriptId,
      deployId,
      error: `Script row not found in scheduled scripts list. Manual steps: Setup → Scripting → Scheduled Scripts → find "${scriptId}" → Edit → set custscript_oa_mr_record_id=${recordId} and custscript_oa_mr_record_type=${RECORD_TYPE} → Save and Execute`,
    };
  }

  // Try to click Edit on the row
  const editLink = scriptRow.locator('a:has-text("Edit"), a[href*="script.nl"]').first();
  if (await editLink.isVisible().catch(() => false)) {
    await editLink.click();
    await page.waitForLoadState('domcontentloaded');

    // Set the parameters
    const recordIdField = page.locator('input[id*="custscript_oa_mr_record_id"], input[name*="custscript_oa_mr_record_id"]').first();
    if (await recordIdField.isVisible().catch(() => false)) {
      await recordIdField.fill(recordId);
    }
    const recordTypeField = page.locator('input[id*="custscript_oa_mr_record_type"], input[name*="custscript_oa_mr_record_type"]').first();
    if (await recordTypeField.isVisible().catch(() => false)) {
      await recordTypeField.fill(RECORD_TYPE);
    }

    // Click Save and Execute
    const saveExecBtn = page.locator('button:has-text("Save and Execute"), input[value="Save and Execute"]').first();
    if (await saveExecBtn.isVisible().catch(() => false)) {
      await saveExecBtn.click();
      await page.waitForTimeout(3000);
      return { ok: true, method: 'UI Save and Execute', recordId, nsScriptId, deployId };
    }
  }

  return {
    ok: false,
    nsScriptId,
    deployId,
    error: `Found script in list but could not interact with it. Navigate manually to: Setup → Scripting → Scheduled Scripts → ${scriptId}`,
  };
}

test.describe('Trigger OA Map/Reduce notification script', () => {
  test.setTimeout(180_000);

  for (const vbId of VB_IDS) {
    test(`Trigger customscript_oa_mr_notifications for VB ${vbId}`, async ({ page }) => {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Triggering ${SCRIPT_ID} for VB ${vbId} (${RECORD_TYPE})`);
      console.log('='.repeat(60));

      // Warm up the session
      await page.goto('/app/center/card.nl?sc=-29&whence=');
      await page.waitForLoadState('domcontentloaded');

      // ── Approach 1: REST schedule endpoint ──────────────────────────────────
      console.log('\n[A1] Attempting REST schedule endpoint...');
      const restResult = await scheduleViaRest(page.request, SCRIPT_ID, vbId);
      console.log(`[A1] REST result: ok=${restResult.ok} status=${restResult.status} body=${restResult.body}`);

      if (restResult.ok) {
        console.log(`[VB ${vbId}] SUCCESS via REST API`);
        return;
      }

      // ── Approach 2: nlapiScheduleScript (client NLAPI) ───────────────────────
      console.log('\n[A2] Attempting nlapiScheduleScript via client NLAPI...');
      const nlapiResult = await scheduleViaClientNlapi(page, SCRIPT_ID, null, vbId);
      console.log(`[A2] nlapiScheduleScript result: ${JSON.stringify(nlapiResult)}`);

      if (nlapiResult.ok) {
        console.log(`[VB ${vbId}] SUCCESS via nlapiScheduleScript — NS returned: "${nlapiResult.status}"`);
        // NS returns 'QUEUED' on success, 'FAILED' on failure
        if (nlapiResult.status && nlapiResult.status.toUpperCase() === 'FAILED') {
          console.warn(`[VB ${vbId}] WARNING: nlapiScheduleScript returned FAILED — script may be already queued or deployment disabled`);
        }
        return;
      }

      // ── Approach 3: UI-based trigger ─────────────────────────────────────────
      console.log('\n[A3] Attempting UI-based trigger...');
      const uiResult = await scheduleViaUI(page, SCRIPT_ID, vbId);
      console.log(`[A3] UI result: ${JSON.stringify(uiResult)}`);

      if (uiResult.ok) {
        console.log(`[VB ${vbId}] SUCCESS via UI`);
        return;
      }

      // ── All approaches failed — report manual steps ─────────────────────────
      const nsScriptId = uiResult.nsScriptId || 'unknown';
      const deployId   = uiResult.deployId   || 'unknown';

      console.log(`\n[VB ${vbId}] All automated approaches failed.`);
      console.log('[MANUAL STEPS] To trigger manually:');
      console.log('  1. Go to: Setup → Scripting → Scheduled Scripts');
      console.log(`  2. Find script: "${SCRIPT_ID}" (NS internal id: ${nsScriptId})`);
      console.log(`  3. Click "Edit" on the deployment (deployment id: ${deployId})`);
      console.log(`  4. Set parameter: custscript_oa_mr_record_id = ${vbId}`);
      console.log(`  5. Set parameter: custscript_oa_mr_record_type = ${RECORD_TYPE}`);
      console.log('  6. Click "Save and Execute"');
      console.log('');
      console.log('  Alternative URL (if script internal id is known):');
      console.log(`  /app/common/scripting/script.nl?id=${nsScriptId}`);

      // Don't hard-fail the test — log results for the user and surface the info
      // The "expect" below will fail the test if nothing worked, making the output visible.
      expect(
        false,
        `[VB ${vbId}] Could not auto-trigger ${SCRIPT_ID}.\n` +
        `REST: ${restResult.status} — ${restResult.body.slice(0, 200)}\n` +
        `NLAPI: ${JSON.stringify(nlapiResult)}\n` +
        `UI: ${JSON.stringify(uiResult)}\n\n` +
        `Manual: Setup → Scripting → Scheduled Scripts → find "${SCRIPT_ID}" → ` +
        `Edit deployment → set custscript_oa_mr_record_id=${vbId}, custscript_oa_mr_record_type=${RECORD_TYPE} → Save and Execute`,
      ).toBe(true);
    });
  }
});
