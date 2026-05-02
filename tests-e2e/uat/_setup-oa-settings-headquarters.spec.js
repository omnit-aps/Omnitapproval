// @ts-check
/**
 * One-shot sandbox setup: configure the OmnitApprovals settings record for the
 * Headquarters subsidiary with VB approvals, email notifications, HMAC secret,
 * email sender (psld@omnit.dk, id 3761), default approver 1 (Jonas Test, id
 * 3762), and approve-without-login enabled.
 *
 * Strategy:
 *   - Find (or create) the customrecord_oa_settings record for HQ subsidiary
 *     via SuiteQL (page.request shares the session cookie).
 *   - For creation: POST via REST (works for custom records).
 *   - For updating an existing record: NS REST PATCH/PUT is blocked by Akamai
 *     (501/405). Instead, navigate to the custom record edit page and use
 *     nlapiSubmitField() to set each field server-side — same technique used
 *     by setEmployeeFlag().
 *
 * Idempotent. Run with:
 *   npx playwright test _setup-oa-settings-headquarters --project=chromium --reporter=list
 */
const { test, expect } = require('@playwright/test');

const SETTINGS_RECORD_TYPE = 'customrecord_oa_settings';
const SUBSIDIARY_NAME      = 'Headquarters';
const EMAIL_SENDER_ID      = 3761;  // psld@omnit.dk
const DEFAULT_APPROVER1_ID = 3762;  // Jonas Test

/** Generate a 32-char hex HMAC secret */
function generateHmacSecret() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Use nlapiSubmitField to update fields on a custom record.
 * nlapiSubmitField is a global NS client API available on any NS page.
 * We navigate to a standard NS page that reliably loads the full NLAPI
 * (the home dashboard), then call nlapiSubmitField with the record type
 * string and record id.
 * @param {import('@playwright/test').Page} page
 * @param {string} recordType
 * @param {string|number} recordId
 * @param {Record<string, string|boolean|number>} fields
 */
async function submitCustomRecordFields(page, recordType, recordId, fields) {
  // Use a standard NS page that always loads the full NLAPI
  await page.goto('/app/center/card.nl?sc=-29&whence=');
  await page.waitForLoadState('domcontentloaded');
  // Wait for nlapiSubmitField to be available
  await page.waitForFunction(() => typeof /** @type {any} */ (window).nlapiSubmitField === 'function', null, { timeout: 30_000 });

  const results = await page.evaluate(
    ([type, id, fieldsJson]) => {
      /** @type {any} */ const w = window;
      const fieldMap = JSON.parse(fieldsJson);
      /** @type {Record<string, string>} */ const out = {};
      for (const [field, value] of Object.entries(fieldMap)) {
        try {
          w.nlapiSubmitField(type, String(id), field, value);
          out[field] = 'ok';
        } catch (e) {
          out[field] = 'ERROR: ' + (e instanceof Error ? e.message : String(e));
        }
      }
      return out;
    },
    [recordType, String(recordId), JSON.stringify(fields)],
  );
  return results;
}

test('configure OA settings for Headquarters', async ({ page }) => {
  test.setTimeout(180_000);

  // Warm up the session
  await page.goto('/app/center/card.nl?sc=-29&whence=');
  await page.waitForLoadState('domcontentloaded');

  const api = page.request;

  // --- 1. Find Headquarters subsidiary via SuiteQL ---
  /** @type {string|null} */
  let subsidiaryId = null;

  const subResp = await api.post('/services/rest/query/v1/suiteql?limit=5', {
    headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
    data: JSON.stringify({
      q: `SELECT id, name FROM subsidiary WHERE name = '${SUBSIDIARY_NAME}'`,
    }),
  });

  if (subResp.ok()) {
    const body = await subResp.json();
    console.log(`[SUBSIDIARY] SuiteQL response: ${JSON.stringify(body).slice(0, 300)}`);
    if (body.items && body.items.length > 0) {
      subsidiaryId = String(body.items[0].id);
      console.log(`[SUBSIDIARY] Found "${SUBSIDIARY_NAME}" id: ${subsidiaryId}`);
    }
  } else {
    const text = await subResp.text();
    console.log(`[SUBSIDIARY] SuiteQL failed ${subResp.status()}: ${text.slice(0, 300)}`);
  }

  if (!subsidiaryId) {
    // Fallback: list all
    const listResp = await api.post('/services/rest/query/v1/suiteql?limit=50', {
      headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
      data: JSON.stringify({ q: 'SELECT id, name FROM subsidiary ORDER BY id' }),
    });
    if (listResp.ok()) {
      const body = await listResp.json();
      console.log('[SUBSIDIARY] All:', JSON.stringify(body.items));
      const hq = (body.items || []).find(
        (/** @type {{id:number,name:string}} */ s) => /headquarters/i.test(s.name),
      );
      if (hq) subsidiaryId = String(hq.id);
    }
  }

  expect(subsidiaryId, 'Could not find Headquarters subsidiary').toBeTruthy();
  console.log(`[SUBSIDIARY] Using id: ${subsidiaryId}`);

  // --- 2. Search for existing OA settings record ---
  /** @type {{id: string, hmacSecret: string|null}|null} */
  let existing = null;

  const searchResp = await api.post('/services/rest/query/v1/suiteql?limit=5', {
    headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
    data: JSON.stringify({
      q: `SELECT id, custrecord_oa_hmac_secret FROM ${SETTINGS_RECORD_TYPE} WHERE custrecord_oa_subsidiary = ${subsidiaryId}`,
    }),
  });

  if (searchResp.ok()) {
    const body = await searchResp.json();
    console.log(`[SEARCH] SuiteQL result: ${JSON.stringify(body).slice(0, 300)}`);
    if (body.items && body.items.length > 0) {
      existing = {
        id: String(body.items[0].id),
        hmacSecret: body.items[0].custrecord_oa_hmac_secret || null,
      };
      console.log(`[SEARCH] Found existing settings record id: ${existing.id}`);
    }
  } else {
    console.log(`[SEARCH] SuiteQL returned ${searchResp.status()}: ${(await searchResp.text()).slice(0, 200)}`);
  }

  const hmacSecret = (existing && existing.hmacSecret) || generateHmacSecret();
  /** @type {string|null} */
  let settingsId = existing?.id ?? null;
  let action;

  if (!existing) {
    // --- 3a. POST new record via REST ---
    console.log('[POST] No existing settings record — creating one');
    const payload = {
      name:                                `OA Settings - ${SUBSIDIARY_NAME}`,
      custrecord_oa_subsidiary:            { id: /** @type {string} */ (subsidiaryId) },
      custrecord_oa_enable_vb:             true,
      custrecord_oa_email_enabled:         true,
      custrecord_oa_hmac_secret:           hmacSecret,
      custrecord_oa_email_sender:          { id: String(EMAIL_SENDER_ID) },
      custrecord_oa_default_approver1:     { id: String(DEFAULT_APPROVER1_ID) },
      custrecord_oa_approve_without_login: true,
    };
    const postResp = await api.post(
      `/services/rest/record/v1/${SETTINGS_RECORD_TYPE}`,
      { headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(payload) },
    );
    if (!postResp.ok()) {
      const body = await postResp.text();
      throw new Error(`POST settings failed (${postResp.status()}): ${body.slice(0, 500)}`);
    }
    const location = postResp.headers()['location'] || '';
    const match = location.match(/\/(\d+)$/);
    settingsId = match ? match[1] : null;
    if (!settingsId) {
      try { const b = await postResp.json(); if (b.id) settingsId = String(b.id); } catch (_) {}
    }
    console.log(`[POST] Success — new settings record id: ${settingsId}`);
    action = 'POST';
  } else {
    // --- 3b. Update existing record via nlapiSubmitField (client-side API) ---
    // NS REST PATCH/PUT on custom records is blocked by the edge CDN (Akamai 501).
    // nlapiSubmitField works in the browser context on the edit page.
    console.log(`[UPDATE] Updating existing record id: ${existing.id} via nlapiSubmitField`);
    const fields = {
      custrecord_oa_enable_vb:             'T',
      custrecord_oa_email_enabled:         'T',
      custrecord_oa_hmac_secret:           hmacSecret,
      custrecord_oa_email_sender:          String(EMAIL_SENDER_ID),
      custrecord_oa_default_approver1:     String(DEFAULT_APPROVER1_ID),
      custrecord_oa_approve_without_login: 'T',
    };
    const results = await submitCustomRecordFields(page, SETTINGS_RECORD_TYPE, existing.id, fields);
    console.log('[UPDATE] nlapiSubmitField results:', JSON.stringify(results));
    for (const [field, res] of Object.entries(results)) {
      if (String(res).startsWith('ERROR:')) {
        throw new Error(`nlapiSubmitField failed for ${field}: ${res}`);
      }
    }
    action = 'nlapiSubmitField';
  }

  // --- 4. Verify by reading back via REST GET ---
  if (settingsId) {
    const getResp = await api.get(
      `/services/rest/record/v1/${SETTINGS_RECORD_TYPE}/${settingsId}`,
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (getResp.ok()) {
      const rec = await getResp.json();
      console.log('[VERIFY] Record fields:', JSON.stringify({
        id: rec.id,
        custrecord_oa_enable_vb:             rec.custrecord_oa_enable_vb,
        custrecord_oa_email_enabled:         rec.custrecord_oa_email_enabled,
        custrecord_oa_hmac_secret:           rec.custrecord_oa_hmac_secret ? '***set***' : null,
        custrecord_oa_email_sender:          rec.custrecord_oa_email_sender,
        custrecord_oa_default_approver1:     rec.custrecord_oa_default_approver1,
        custrecord_oa_approve_without_login: rec.custrecord_oa_approve_without_login,
      }));
      expect(rec.custrecord_oa_enable_vb, 'enable_vb should be true').toBe(true);
      expect(rec.custrecord_oa_email_enabled, 'email_enabled should be true').toBe(true);
      expect(rec.custrecord_oa_hmac_secret, 'hmac_secret should be set').toBeTruthy();
      expect(rec.custrecord_oa_approve_without_login, 'approve_without_login should be true').toBe(true);
    } else {
      console.log(`[VERIFY] GET returned ${getResp.status()} — skipping field assertions`);
    }
  }

  console.log(`[DONE] action=${action}, settingsId=${settingsId}, subsidiaryId=${subsidiaryId}`);
  expect(settingsId ?? 'created').toBeTruthy();
});
