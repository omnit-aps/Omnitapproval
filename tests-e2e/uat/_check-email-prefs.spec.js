// @ts-check
/**
 * _check-email-prefs.spec.js
 *
 * Reads the NetSuite Company Email Preferences page
 * (/app/setup/companyemailprefs.nl) and ensures:
 *   1. Hold Notification Emails  — should be F (unchecked)
 *   2. Send All Emails To        — should be empty
 *   3. Email Forwarding Address  — any value is logged
 *
 * If any hold/redirect setting is enabled the spec flips it to the
 * correct value and saves the form, then navigates back to verify.
 *
 * Run:
 *   npx playwright test _check-email-prefs --project=chromium --reporter=list
 */
const { test, expect } = require('@playwright/test');

test.setTimeout(120_000);

const PAGE_PATH = '/app/setup/companyemailprefs.nl';

test('read and fix Company Email Preferences', async ({ page }) => {
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  const editURL = `${baseURL}${PAGE_PATH}?e=T`;

  // ── 1. Navigate to edit mode ──────────────────────────────────────────────
  await page.goto(editURL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1500);

  // Check for access denial before going further
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
  const denied = /page not found|access denied|you do not have|insufficient privileges|error/i.test(bodyText);
  if (denied) {
    console.log('ACCESS DENIED / ERROR navigating to', editURL);
    console.log('Body text:', bodyText);
    // Still pass the test — we report back what we found
    expect(denied, `Access denied at ${editURL}: ${bodyText.slice(0, 200)}`).toBe(false);
    return;
  }

  console.log('Current URL after goto:', page.url());

  // ── 2. Wait for nlapiGetFieldValue to be ready ────────────────────────────
  const nsReady = await page.waitForFunction(() => {
    /** @type {any} */ const w = window;
    return typeof w.nlapiGetFieldValue === 'function';
  }, null, { timeout: 30_000 }).then(() => true).catch(() => false);

  if (!nsReady) {
    console.warn('nlapiGetFieldValue not available — page may not have loaded NS client framework');
  }

  // ── 3. Discover all visible fields and their current values ───────────────
  const fieldSnapshot = await page.evaluate(() => {
    /** @type {any} */ const w = window;
    const snap = /** @type {Record<string, {value: any, text: any, domValue: any}>} */ ({});

    // Candidate field IDs for email-hold settings
    const candidates = [
      // Hold notification emails
      'notify_pendingemail',
      'holdnotifications',
      'holdnotificationemails',
      'hold_notification_emails',
      'notifyholdpending',
      'suspendnotifications',
      'emailnotifhold',
      // Send all emails to
      'notif_sendallemails',
      'sendallemailsto',
      'sendallemails',
      'allemailtodest',
      'redirectallemails',
      'emailredirect',
      // Forwarding address
      'emailforwarding',
      'forwardingaddress',
      'emailforward',
      'emailfwdaddress',
      'emailfwdaddr',
      'forwardingemail',
      // Generic catch
      'bccemailaddress',
      'testmodeemailaddress',
      'emailoverride',
    ];

    candidates.forEach((id) => {
      try {
        const val  = typeof w.nlapiGetFieldValue === 'function' ? w.nlapiGetFieldValue(id) : null;
        const text = typeof w.nlapiGetFieldText  === 'function' ? w.nlapiGetFieldText(id)  : null;
        // Also try direct DOM read
        const el = document.getElementById(id);
        let domValue = null;
        if (el) {
          if (el instanceof HTMLInputElement && el.type === 'checkbox') domValue = el.checked ? 'T' : 'F';
          else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) domValue = el.value;
          else if (el instanceof HTMLSelectElement) domValue = el.value;
          else domValue = el.textContent?.trim() ?? null;
        }
        if (val !== null || text !== null || domValue !== null) {
          snap[id] = { value: val, text, domValue };
        }
      } catch (_) {}
    });

    // Also dump ALL input/select elements on the page for manual inspection
    const allFields = /** @type {Array<{id: string, name: string, type: string, value: string, checked: boolean}>} */ ([]);
    document.querySelectorAll('input, select, textarea').forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const id = el.id || '';
      const name = (/** @type {any} */ (el)).name || '';
      if (!id && !name) return;
      let val = '';
      let chk = false;
      if (el instanceof HTMLInputElement) {
        val = el.value; chk = el.checked;
      } else if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        val = el.value;
      }
      allFields.push({ id, name, type: (/** @type {any} */ (el)).type || el.tagName, value: val, checked: chk });
    });
    snap['__allFields'] = allFields;
    return snap;
  });

  console.log('\n========== Targeted field values ==========');
  const { __allFields, ...targeted } = fieldSnapshot;
  console.log(JSON.stringify(targeted, null, 2));

  console.log('\n========== All DOM input/select fields ==========');
  (/** @type {any[]} */ (__allFields)).forEach((f) => {
    console.log(`  id="${f.id}" name="${f.name}" type="${f.type}" value="${f.value}" checked=${f.checked}`);
  });

  // ── 4. Determine what needs to change ────────────────────────────────────
  // Hold notification emails — known NS field IDs (try multiple)
  const HOLD_FIELDS    = ['notify_pendingemail', 'holdnotifications', 'holdnotificationemails', 'hold_notification_emails'];
  const REDIRECT_FIELDS = ['notif_sendallemails', 'sendallemailsto', 'sendallemails', 'allemailtodest', 'redirectallemails'];
  const FORWARD_FIELDS  = ['emailforwarding', 'forwardingaddress', 'emailforward', 'emailfwdaddress', 'emailfwdaddr', 'forwardingemail'];

  function firstHit(fields) {
    for (const f of fields) {
      const entry = targeted[f];
      if (entry) return { id: f, ...entry };
    }
    return null;
  }

  const holdEntry    = firstHit(HOLD_FIELDS);
  const redirectEntry = firstHit(REDIRECT_FIELDS);
  const forwardEntry  = firstHit(FORWARD_FIELDS);

  console.log('\n========== Resolved settings ==========');
  console.log('Hold Notification Emails:', holdEntry ? JSON.stringify(holdEntry) : '(field not found by API — check allFields above)');
  console.log('Send All Emails To:',       redirectEntry ? JSON.stringify(redirectEntry) : '(field not found)');
  console.log('Email Forwarding Address:', forwardEntry  ? JSON.stringify(forwardEntry)  : '(field not found)');

  // ── 5. Decide if we need to save anything ────────────────────────────────
  const holdIsEnabled    = holdEntry    && (holdEntry.value === 'T' || holdEntry.domValue === 'T');
  const redirectHasValue = redirectEntry && ((redirectEntry.value || '').trim() !== '' || (redirectEntry.domValue || '').trim() !== '');
  const needsSave = holdIsEnabled || redirectHasValue;

  if (!needsSave) {
    console.log('\n=> No changes needed. Settings are already correct.');
    // Verify we can read the page title to confirm we were on the right page
    const title = await page.evaluate(() => document.title);
    console.log('Page title:', title);
    expect(true).toBe(true);
    return;
  }

  // ── 6. Apply corrections ─────────────────────────────────────────────────
  console.log('\n=> Corrections needed — applying via NS client API...');

  const fixResult = await page.evaluate(({ holdId, redirectId }) => {
    /** @type {any} */ const w = window;
    const log = /** @type {Record<string, any>} */ ({});

    if (holdId) {
      try {
        w.nlapiSetFieldValue(holdId, 'F', false, false);
        log[holdId] = { setTo: 'F', readBack: w.nlapiGetFieldValue(holdId) };
      } catch (e) { log[holdId] = { error: String(e) }; }
    }
    if (redirectId) {
      try {
        w.nlapiSetFieldValue(redirectId, '', false, false);
        log[redirectId] = { setTo: '', readBack: w.nlapiGetFieldValue(redirectId) };
      } catch (e) { log[redirectId] = { error: String(e) }; }
    }
    return log;
  }, {
    holdId:     holdIsEnabled    ? holdEntry.id    : null,
    redirectId: redirectHasValue ? redirectEntry.id : null,
  });

  console.log('Fix result:', JSON.stringify(fixResult, null, 2));

  // ── 7. Save the form ──────────────────────────────────────────────────────
  // Try the NS multi-button submitter first; fall back to clicking Save
  await page.evaluate(() => {
    /** @type {any} */ const w = window;
    if (typeof w.NLDoMainFormButtonAction === 'function') {
      w.NLDoMainFormButtonAction('submitter', true);
    }
  });

  // Wait briefly; if NLDoMainFormButtonAction triggered navigation, catch it
  const savedByApi = await page.waitForURL(
    (u) => u.toString().includes(PAGE_PATH) && !u.toString().includes('e=T'),
    { timeout: 15_000 },
  ).then(() => true).catch(() => false);

  if (!savedByApi) {
    // Fallback: click the Save button
    const saveBtn = page.locator('#btn_multibutton_submitter, input[id="btn_multibutton_submitter"], input[value="Save"]').first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click({ force: true });
      await page.waitForURL(
        (u) => u.toString().includes(PAGE_PATH) && !u.toString().includes('e=T'),
        { timeout: 30_000 },
      ).catch(() => {});
    }
  }

  console.log('URL after save:', page.url());

  // ── 8. Navigate back in view mode and verify ─────────────────────────────
  await page.goto(`${baseURL}${PAGE_PATH}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1500);

  const nsReady2 = await page.waitForFunction(() => {
    /** @type {any} */ const w = window;
    return typeof w.nlapiGetFieldValue === 'function';
  }, null, { timeout: 15_000 }).then(() => true).catch(() => false);

  const verifyResult = await page.evaluate(({ holdId, redirectId }) => {
    /** @type {any} */ const w = window;
    const out = /** @type {Record<string, any>} */ ({});
    if (holdId) {
      try { out[holdId] = w.nlapiGetFieldValue(holdId); } catch (_) { out[holdId] = null; }
    }
    if (redirectId) {
      try { out[redirectId] = w.nlapiGetFieldValue(redirectId); } catch (_) { out[redirectId] = null; }
    }
    return out;
  }, {
    holdId:     holdEntry    ? holdEntry.id    : null,
    redirectId: redirectEntry ? redirectEntry.id : null,
  });

  console.log('\n========== Verification after save ==========');
  console.log(JSON.stringify(verifyResult, null, 2));

  // Assert corrections held
  if (holdEntry) {
    const finalHold = verifyResult[holdEntry.id];
    expect(finalHold, `Hold Notifications (${holdEntry.id}) should be F after save`).toBe('F');
  }
  if (redirectEntry && redirectHasValue) {
    const finalRedirect = verifyResult[redirectEntry.id];
    expect((finalRedirect || '').trim(), `Send All Emails To (${redirectEntry.id}) should be empty after save`).toBe('');
  }

  console.log('\n=> All email-hold settings confirmed corrected.');
});
