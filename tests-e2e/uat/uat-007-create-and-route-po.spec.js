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
  // Approval routing fired — saved record should be Pending Approval.
  // (If this becomes "Approved", routing was bypassed and OA settings need a check.)
  expect(result.status).toBe('Pending Approval');
});
