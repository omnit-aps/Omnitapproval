// @ts-check
// UAT-007 — Purchase Order created routes to correct approver
const { test, expect } = require('@playwright/test');
const { createPurchaseOrder } = require('./helpers');

const TEST_VENDOR   = process.env.E2E_VENDOR    || 'ACME Industries';
const TEST_ITEM     = process.env.E2E_ITEM      || 'Generic Service';
const TEST_QUANTITY = Number(process.env.E2E_QUANTITY || 1);

test('UAT-007 purchase order creation triggers approval routing', async ({ page }) => {
  test.setTimeout(120_000);

  const result = await createPurchaseOrder(page, {
    vendor:   TEST_VENDOR,
    item:     TEST_ITEM,
    quantity: TEST_QUANTITY,
    scenario: 'UAT-007',
  });
  console.log('Created PO:', result);

  expect(result.id).toMatch(/^\d+$/);
  // Verify OA routed the PO via SuiteQL — the canonical signal that engine.
  // routeForApproval fired is `custbody_oa_next_approver` being non-empty.
  // Reading approvalstatus from the form is unreliable on POs because NS
  // mixes `orderstatus` (native: Pending Bill / Approved / etc.) with
  // OA's `approvalstatus` (Pending=1 / Approved=2 / Rejected=3).
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  const sqlResp = await page.evaluate(async ([base, id]) => {
    const r = await fetch(`${base}/services/rest/query/v1/suiteql`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
      body: JSON.stringify({ q: `SELECT id, custbody_oa_next_approver, custbody_oa_route_source, approvalstatus FROM transaction WHERE id = ${id}` }),
    });
    return JSON.parse(await r.text());
  }, [baseURL, result.id]);
  const row = sqlResp.items && sqlResp.items[0];
  console.log('PO SuiteQL row:', JSON.stringify(row));
  expect(row, 'PO row should be queryable via SuiteQL').toBeTruthy();
  expect(row.custbody_oa_next_approver, 'OA must set a next_approver on a routed PO').toMatch(/^\d+$/);
});
