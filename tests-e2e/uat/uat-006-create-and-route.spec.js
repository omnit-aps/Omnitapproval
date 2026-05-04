// @ts-check
// UAT-006 — PO/VB created routes to correct approver
const { test, expect } = require('@playwright/test');
const { createVendorBill } = require('./helpers');

const TEST_VENDOR  = process.env.E2E_VENDOR  || 'ACME Industries';
const TEST_ACCOUNT = process.env.E2E_ACCOUNT || 'Office Supplies';
const TEST_AMOUNT  = Number(process.env.E2E_AMOUNT || 1000);

test('UAT-006 vendor bill creation triggers approval routing', async ({ page }) => {
  test.setTimeout(120_000);

  const result = await createVendorBill(page, {
    vendor:   TEST_VENDOR,
    account:  TEST_ACCOUNT,
    amount:   TEST_AMOUNT,
    scenario: 'UAT-006',
  });
  console.log('Created VB:', result);

  expect(result.id).toMatch(/^\d+$/);
  // Approval routing fired — saved record should be Pending Approval.
  // (If this becomes "Approved", routing was bypassed and OA settings need a check.)
  expect(result.status).toBe('Pending Approval');
});
