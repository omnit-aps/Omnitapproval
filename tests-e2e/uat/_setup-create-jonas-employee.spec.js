// @ts-check
/**
 * One-shot sandbox setup: create employee "Jonas Test" (jonasbm@gmail.com)
 * and set the four OmnitApprovals flags to their required values.
 *
 * Strategy: use the NetSuite REST Record API (v1) to create and look up the
 * employee. This avoids the NS UI form's session-timeout issues and broken
 * onChange handlers. The REST endpoint uses the same session cookies that
 * Playwright's storageState provides.
 *
 * Idempotent: if an employee with that email already exists the creation step
 * is skipped; only the OA flags are verified / updated.
 *
 * Run with:
 *   npx playwright test _setup-create-jonas-employee --project=chromium --reporter=list
 */
const { test, expect } = require('@playwright/test');
const { setEmployeeFlag } = require('./helpers');

const TARGET_EMAIL = 'jonasbm@gmail.com';
const FIRST_NAME   = 'Jonas';
const LAST_NAME    = 'Test';

/** @type {string|null} */
let employeeId = null;

/**
 * Use NS SuiteQL (via the REST meta API) to search for an employee by email.
 * Falls back to nlapiSearchRecord client-side if the REST endpoint is not usable.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {string} email
 * @returns {Promise<string|null>}
 */
async function findEmployeeByEmailREST(page, request, email) {
  // Try REST SuiteQL endpoint first
  try {
    const resp = await request.post('/services/rest/query/v1/suiteql?limit=5', {
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'transient',
      },
      data: JSON.stringify({
        q: `SELECT id FROM employee WHERE email = '${email.replace(/'/g, "''")}'`,
      }),
    });
    if (resp.ok()) {
      const body = await resp.json();
      const items = body.items || [];
      if (items.length > 0) return String(items[0].id);
      return null; // Not found but query worked
    }
    console.log(`[SEARCH REST] SuiteQL returned ${resp.status()} — falling back to NLAPI`);
  } catch (e) {
    console.log(`[SEARCH REST] Error: ${e} — falling back to NLAPI`);
  }

  // Fallback: use client-side nlapiSearchRecord on an NS page
  return page.evaluate((e) => {
    /** @type {any} */ const w = window;
    try {
      const filter = new w.nlobjSearchFilter('email', null, 'is', e);
      const col    = new w.nlobjSearchColumn('internalid');
      const results = w.nlapiSearchRecord('employee', null, [filter], [col]);
      if (results && results.length > 0) return String(results[0].getId());
    } catch (_) {}
    return null;
  }, email);
}

/**
 * Create employee via NS REST Record API.
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {object} data
 * @returns {Promise<string>} internal id of the created record
 */
async function createEmployeeREST(request, data) {
  const resp = await request.post('/services/rest/record/v1/employee', {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify(data),
  });

  if (!resp.ok()) {
    const body = await resp.text();
    throw new Error(`REST create employee failed (${resp.status()}): ${body.slice(0, 500)}`);
  }

  // NS REST returns 204 No Content with a Location header containing the new id
  const location = resp.headers()['location'] || '';
  const match = location.match(/\/(\d+)$/);
  if (match) return match[1];

  // Some NS versions return 200 with body
  try {
    const body = await resp.json();
    if (body.id) return String(body.id);
  } catch (_) {}

  throw new Error(`Could not extract employee id from REST response. Location: ${location}`);
}

// ---------------------------------------------------------------------------
// Step 1: find or create the employee
// ---------------------------------------------------------------------------
test('find or create employee Jonas Test', async ({ page, request }) => {
  test.setTimeout(180_000);

  // Load the NS home page to warm up the session (ensures cookies are active)
  await page.goto('/app/center/card.nl?sc=-29&whence=');
  await page.waitForLoadState('domcontentloaded');

  // Search for existing employee
  const existing = await findEmployeeByEmailREST(page, request, TARGET_EMAIL);
  if (existing) {
    employeeId = existing;
    console.log(`[FOUND] Employee already exists — internal id: ${employeeId}`);
    return;
  }

  // --- Create via REST API ---
  console.log('[CREATE] No existing employee found — creating Jonas Test via REST ...');

  // Also search by name as a secondary check (email may not be set from a previous
  // partial run that failed before setting the email field)
  try {
    const nameResp = await request.post('/services/rest/query/v1/suiteql?limit=5', {
      headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
      data: JSON.stringify({
        q: `SELECT id FROM employee WHERE firstname = '${FIRST_NAME}' AND lastname = '${LAST_NAME}'`,
      }),
    });
    if (nameResp.ok()) {
      const body = await nameResp.json();
      if (body.items && body.items.length > 0) {
        employeeId = String(body.items[0].id);
        console.log(`[FOUND by name] Employee "${FIRST_NAME} ${LAST_NAME}" id: ${employeeId}`);
        return;
      }
    }
  } catch (_) {}

  // Build the minimal create payload. NS requires at minimum: firstname or name,
  // and in a multi-subsidiary account, the subsidiary field.
  // We'll get the first available subsidiary id via REST.
  let subsidiaryId = null;
  try {
    const subResp = await request.post('/services/rest/query/v1/suiteql?limit=1', {
      headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
      data: JSON.stringify({ q: `SELECT id, name FROM subsidiary ORDER BY id` }),
    });
    if (subResp.ok()) {
      const body = await subResp.json();
      if (body.items && body.items.length > 0) {
        subsidiaryId = body.items[0].id;
        console.log(`[SUBSIDIARY] Using id ${subsidiaryId}: ${body.items[0].name}`);
      }
    }
  } catch (_) {}

  /** @type {Record<string, any>} */
  const payload = {
    firstname: FIRST_NAME,
    lastname:  LAST_NAME,
    email:     TARGET_EMAIL,
  };
  if (subsidiaryId) {
    payload.subsidiary = { id: String(subsidiaryId) };
  }

  const newId = await createEmployeeREST(request, payload);
  employeeId = newId;
  console.log(`[CREATED] New employee internal id: ${employeeId}`);
});

// ---------------------------------------------------------------------------
// Step 2: set OA flags (and email if not set)
// ---------------------------------------------------------------------------
test('set OA flags on Jonas Test', async ({ page, request }) => {
  test.setTimeout(180_000);

  // Resolve employeeId if running in isolation
  if (!employeeId) {
    await page.goto('/app/center/card.nl?sc=-29&whence=');
    await page.waitForLoadState('domcontentloaded');
    let found = await findEmployeeByEmailREST(page, request, TARGET_EMAIL);
    if (!found) {
      // Try by name
      try {
        const resp = await request.post('/services/rest/query/v1/suiteql?limit=5', {
          headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
          data: JSON.stringify({
            q: `SELECT id FROM employee WHERE firstname = '${FIRST_NAME}' AND lastname = '${LAST_NAME}'`,
          }),
        });
        if (resp.ok()) {
          const body = await resp.json();
          if (body.items && body.items.length > 0) found = String(body.items[0].id);
        }
      } catch (_) {}
    }
    if (!found) throw new Error('Could not resolve employee id for Jonas Test — run step 1 first.');
    employeeId = found;
    console.log(`[RESOLVED] Employee id: ${employeeId}`);
  }

  // Ensure email is set (may have been skipped in a prior partial run)
  try {
    const patchResp = await request.patch(`/services/rest/record/v1/employee/${employeeId}`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ email: TARGET_EMAIL }),
    });
    if (patchResp.ok()) {
      console.log(`email patched to ${TARGET_EMAIL}`);
    } else {
      console.log(`[WARN] email PATCH returned ${patchResp.status()}`);
    }
  } catch (e) {
    console.log(`[WARN] email PATCH error: ${e}`);
  }

  // OA flags via the existing setEmployeeFlag helper (uses nlapiSubmitField client-side)
  const flags = /** @type {[string, string][]} */ ([
    ['custentity_oa_is_approver',       'T'],
    ['custentity_oa_use_email',         'T'],
    ['custentity_oa_is_manager',        'F'],
    ['custentity_oa_is_super_approver', 'F'],
  ]);

  for (const [field, value] of flags) {
    const result = await setEmployeeFlag(page, /** @type {string} */ (employeeId), field, value);
    console.log(`${field} = ${value} →`, JSON.stringify(result));
    expect(result.after ?? result.before).toBe(value);
  }

  // Read back the internal id as final confirmation
  const finalId = await page.evaluate(() => {
    /** @type {any} */ const w = window;
    try { return w.nlapiGetFieldValue('id'); } catch (_) { return null; }
  });
  console.log(`[DONE] Jonas Test employee internal id: ${finalId ?? employeeId}`);
});
