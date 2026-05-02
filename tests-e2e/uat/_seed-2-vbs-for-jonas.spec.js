// @ts-check
/**
 * Seed spec: create exactly 2 Vendor Bills routed to Jonas Test (id 3762)
 * for email approval testing.
 *
 *   VB-A  scenario=EMAIL-APPROVE  vendor=ACME Industries  amount=750
 *   VB-B  scenario=EMAIL-REJECT   vendor=ACME Industries  amount=1500
 *
 * After each save, asserts:
 *   - approvalstatus == "Pending Approval"
 *   - nextapprover (custbody_oa_next_approver) is populated AND equals Jonas (3762)
 *
 * Both VBs are created inside a single test to avoid session expiry between tests.
 * The 2 created VB ids are printed with the "Created VB:" prefix.
 */

const { test, expect } = require('@playwright/test');
const { createVendorBill, readField } = require('./helpers');

const JONAS_EMPLOYEE_ID = 3762;
const JONAS_NAME_RE = /jonas/i;

const VENDOR  = 'ACME Industries';
const ACCOUNT = 'Other Expenses';

test('Seed 2 VBs for Jonas email-approval: VB-A (EMAIL-APPROVE) + VB-B (EMAIL-REJECT)', async ({ page }) => {
  test.setTimeout(360_000);

  // ── VB-A: EMAIL-APPROVE ────────────────────────────────────────────────────
  const resultA = await createVendorBill(page, {
    vendor:   VENDOR,
    account:  ACCOUNT,
    amount:   750,
    scenario: 'EMAIL-APPROVE',
  });

  console.log(`Created VB: id=${resultA.id} scenario=EMAIL-APPROVE amount=750 status="${resultA.status}" nextApprover="${resultA.nextApprover}"`);

  expect(resultA.id, 'VB-A should have a numeric id').toMatch(/^\d+$/);

  expect(
    resultA.status,
    `VB-A (id=${resultA.id}) approvalstatus should be Pending Approval, got: "${resultA.status}"`,
  ).toMatch(/pending/i);

  const nextApproverA = resultA.nextApprover ?? await readField(page, 'custbody_oa_next_approver');
  console.log(`[VB-A] id=${resultA.id}  nextapprover="${nextApproverA}"`);

  const matchesJonasA =
    nextApproverA != null && (
      JONAS_NAME_RE.test(String(nextApproverA)) ||
      String(nextApproverA).trim() === String(JONAS_EMPLOYEE_ID)
    );

  expect(
    nextApproverA,
    `VB-A (id=${resultA.id}) nextapprover should be populated`,
  ).toBeTruthy();

  expect(
    matchesJonasA,
    `VB-A (id=${resultA.id}) nextapprover should be Jonas (id ${JONAS_EMPLOYEE_ID}), got: "${nextApproverA}"`,
  ).toBeTruthy();

  console.log(`Created VB: VB-A id=${resultA.id} PASSED — nextApprover=${nextApproverA} (Jonas ${JONAS_EMPLOYEE_ID})`);

  // ── VB-B: EMAIL-REJECT ─────────────────────────────────────────────────────
  const resultB = await createVendorBill(page, {
    vendor:   VENDOR,
    account:  ACCOUNT,
    amount:   1500,
    scenario: 'EMAIL-REJECT',
  });

  console.log(`Created VB: id=${resultB.id} scenario=EMAIL-REJECT amount=1500 status="${resultB.status}" nextApprover="${resultB.nextApprover}"`);

  expect(resultB.id, 'VB-B should have a numeric id').toMatch(/^\d+$/);

  expect(
    resultB.status,
    `VB-B (id=${resultB.id}) approvalstatus should be Pending Approval, got: "${resultB.status}"`,
  ).toMatch(/pending/i);

  const nextApproverB = resultB.nextApprover ?? await readField(page, 'custbody_oa_next_approver');
  console.log(`[VB-B] id=${resultB.id}  nextapprover="${nextApproverB}"`);

  const matchesJonasB =
    nextApproverB != null && (
      JONAS_NAME_RE.test(String(nextApproverB)) ||
      String(nextApproverB).trim() === String(JONAS_EMPLOYEE_ID)
    );

  expect(
    nextApproverB,
    `VB-B (id=${resultB.id}) nextapprover should be populated`,
  ).toBeTruthy();

  expect(
    matchesJonasB,
    `VB-B (id=${resultB.id}) nextapprover should be Jonas (id ${JONAS_EMPLOYEE_ID}), got: "${nextApproverB}"`,
  ).toBeTruthy();

  console.log(`Created VB: VB-B id=${resultB.id} PASSED — nextApprover=${nextApproverB} (Jonas ${JONAS_EMPLOYEE_ID})`);

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n=== Seed VBs Summary ===');
  console.log(`  EMAIL-APPROVE: id=${resultA.id}  status="${resultA.status}"  nextApprover="${nextApproverA}"`);
  console.log(`  EMAIL-REJECT:  id=${resultB.id}  status="${resultB.status}"  nextApprover="${nextApproverB}"`);
  console.log(`\nCreated VB: VB-A=${resultA.id} (EMAIL-APPROVE)  VB-B=${resultB.id} (EMAIL-REJECT)`);
});
