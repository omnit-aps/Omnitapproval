// @ts-check
// UAT-055 — Same skip rationale as UAT-054. The PO never reaches a Pending
// state in this account because NS native auto-approves it on save.
const { test, expect } = require('@playwright/test');
const { createPurchaseOrder } = require('./helpers');

const TEST_VENDOR   = process.env.E2E_VENDOR    || 'ACME Industries';
const TEST_ITEM     = process.env.E2E_ITEM      || 'Generic Service';
const TEST_QUANTITY = Number(process.env.E2E_QUANTITY || 1);

test.skip('UAT-055 super_decline-needs-reason on PO (skipped: NS account auto-approves PO)', async ({ page }) => {
  test.setTimeout(180_000);
  const result = await createPurchaseOrder(page, { vendor: TEST_VENDOR, item: TEST_ITEM, quantity: TEST_QUANTITY, scenario: 'UAT-055' });
  expect(result.id).toMatch(/^\d+$/);
});
