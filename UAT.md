# OmnitApprovals — UAT Test Plan

> **How to read coverage:**
> ✅ Fully covered by the current build
> ⚠️ Partial — works but has a noted limitation or manual step
> ❌ Gap — not handled, needs work or a workaround

---

## 1. Setup & Configuration

### UAT-001 — Create settings for a new subsidiary
**Steps:** Open Omnit Approvals menu → Approval Settings → New configuration → select subsidiary → save.
**Expected:** Settings record created. Subsidiary appears in the list.
**Coverage:** ✅

---

### UAT-002 — Enable PO approval only
**Steps:** In settings, toggle Enable PO approval ON, Enable VB approval OFF → save.
**Expected:** POs route through the approval flow. VBs are unaffected.
**Coverage:** ✅

---

### UAT-003 — Base currency badge shown in matrix
**Steps:** Open a settings record for a subsidiary with a known base currency (e.g. DKK).
**Expected:** Amount columns in the approval matrix show a "DKK" badge next to each input.
**Coverage:** ✅

---

### UAT-004 — Matrix save retains row order / priority
**Steps:** Add three threshold rows, use ▲▼ buttons to reorder → save → reopen.
**Expected:** Rows reopen in the saved order. Row order = priority (top row = priority 1).
**Coverage:** ✅

---

### UAT-005 — Expired hierarchy visible in settings history
**Steps:** Manually set a hierarchy record's status to "Expired" in NetSuite. Reopen the settings page.
**Expected:** A read-only "Matrix history" section appears below the active matrix showing the expired rule set with name, status pill and date range.
**Coverage:** ✅
**Note:** OmnitApprovals does not yet automatically expire old hierarchies when a new one is saved — the status must be set manually or via a future archive feature.

---

## 2. Routing — Single-Step Approval

### UAT-006 — PO created routes to correct approver
**Steps:** Create a PO for a subsidiary with single-step PO approval enabled. Save.
**Expected:** `approvalstatus` = Pending. `custbody_oa_approver1` = correct approver. `custbody_oa_current_step` = 1. Approver receives notification email.
**Coverage:** ✅

---

### UAT-007 — PO approved → status becomes Approved
**Steps:** Approver opens PO → clicks Approve button.
**Expected:** `approvalstatus` = Approved. Audit log entry created. No further action required.
**Coverage:** ✅

---

### UAT-008 — PO rejected with mandatory reason
**Steps:** Approver clicks Reject → prompted for reason → submits.
**Expected:** `approvalstatus` = Rejected. Audit log entry contains the reason. Submitter can see status on record.
**Coverage:** ✅

---

### UAT-009 — Reject without entering reason is blocked
**Steps:** Approver clicks Reject → leaves reason blank → tries to submit.
**Expected:** Dialog shows "A reason is required." Rejection does not proceed.
**Coverage:** ✅

---

## 3. Routing — Two-Step Approval

### UAT-010 — Step 1 approval advances to step 2
**Steps:** Two-step approval configured. Approver 1 approves.
**Expected:** `custbody_oa_current_step` = 2. `approvalstatus` remains Pending. New notification sent to Approver 2.
**Coverage:** ✅

---

### UAT-011 — Step 2 approval completes the flow
**Steps:** Approver 2 approves (after step 1 is done).
**Expected:** `approvalstatus` = Approved. Audit log has two Approved entries (step 1, step 2).
**Coverage:** ✅

---

### UAT-012 — Step 2 rejection rejects the transaction
**Steps:** Approver 2 rejects.
**Expected:** `approvalstatus` = Rejected. Audit log shows rejection at step 2.
**Coverage:** ✅

---

### UAT-013 — Approver 2 cannot approve while still on step 1
**Steps:** Open a two-step pending PO as Approver 2 while step is still 1.
**Expected:** Approve/Reject buttons do NOT appear. Approver 2 is not the current step's approver.
**Coverage:** ✅
**Note:** The portlet and bulk dashboard will still show the transaction (the user is on the record as approver2) but they cannot act until step 1 clears.

---

## 4. Amount Threshold Routing

### UAT-014 — Amount matches a threshold row → correct approver assigned
**Steps:** Matrix has row: min 0, Approver = Alice. Create PO for amount 5,000 (base currency).
**Expected:** `custbody_oa_approver1` = Alice.
**Coverage:** ✅

---

### UAT-015 — Amount falls in a gap between rows → default approver used
**Steps:** Matrix has rows for 0–1,000 (Alice) and 5,000+ (Bob). Create PO for 2,500.
**Expected:** No threshold matches. `custbody_oa_approver1` = settings default approver. Audit log shows routing.
**Coverage:** ✅

---

### UAT-016 — Amount below all thresholds → default approver used
**Steps:** Only threshold is min 10,000 (Alice). Create PO for 500.
**Expected:** `custbody_oa_approver1` = default approver (not Alice).
**Coverage:** ✅

---

### UAT-017 — Two overlapping threshold rows → top row (priority 1) wins
**Steps:** Row 1 (priority 1): 0–50,000 → Alice. Row 2 (priority 2): 0–50,000 → Bob. Create PO for 10,000.
**Expected:** `custbody_oa_approver1` = Alice (row 1 takes precedence).
**Coverage:** ✅

---

### UAT-018 — No matrix configured → default approver used
**Steps:** Settings has "Use amount thresholds" OFF. Default approver = Carol.
**Expected:** All POs/VBs route to Carol regardless of amount.
**Coverage:** ✅

---

### UAT-019 — No settings for subsidiary → transaction not routed
**Steps:** Create a PO under a subsidiary with no OA settings record.
**Expected:** Transaction saves normally. No approval routing occurs. `approvalstatus` unchanged.
**Coverage:** ✅

---

## 5. Email Approval

### UAT-020 — Approver receives email on submission
**Steps:** Email approval enabled in settings. Create a PO.
**Expected:** Approver receives email with transaction summary, Approve and Reject buttons/links.
**Coverage:** ✅

---

### UAT-021 — Approve via email link (logged in)
**Steps:** Approver clicks Approve link in email while logged in to NetSuite.
**Expected:** Transaction approved. Confirmation page shown. Audit log entry with source = "Email link".
**Coverage:** ✅

---

### UAT-022 — Approve via email link (not logged in, without-login enabled)
**Steps:** "Approve without login" = ON for subsidiary. Approver clicks email link without a NetSuite session.
**Expected:** Suitelet processes token, approves transaction, shows confirmation. No login prompt.
**Coverage:** ✅
**Prerequisite:** `customdeploy_oa_sl_email_action` must have "Available Without Login" checked in NetSuite Setup > Scripting > Script Deployments.

---

### UAT-023 — Email link blocked when without-login is disabled
**Steps:** "Approve without login" = OFF. Unauthenticated user clicks email link.
**Expected:** Error page: "Approval without login is not enabled for this subsidiary. Please log in."
**Coverage:** ✅

---

### UAT-024 — Expired token is rejected
**Steps:** Token expiry = 1 day. Wait 2 days. Click approve link.
**Expected:** Error page: "This link has expired. Please log in to NetSuite."
**Coverage:** ✅

---

### UAT-025 — Already-used token is rejected
**Steps:** Approve via email link. Copy the same link and open it again.
**Expected:** Error page: "Invalid or already used token." (Token was replaced on approval.)
**Coverage:** ✅

---

### UAT-026 — Reject via email link shows comment form
**Steps:** Approver clicks Reject link in email.
**Expected:** A rejection comment page is shown. Submitting the form with a reason processes the rejection.
**Coverage:** ✅

---

### UAT-027 — Reject via email without entering reason is blocked
**Steps:** Open email reject form. Leave reason blank. Submit.
**Expected:** Error page: "A reason for rejection is required."
**Coverage:** ✅

---

## 6. Delegate

### UAT-028 — Approver delegates to a flagged approver
**Prerequisites:** Actor has `custentity_oa_can_delegate = T`. Target has `custentity_oa_is_approver = T`.
**Steps:** Current approver clicks Delegate button → selects target employee → confirms.
**Expected:** `custbody_oa_approver1` (or 2) updated to target. New token generated. Target receives notification email. Audit log shows Delegated action with actor → target.
**Coverage:** ✅

---

### UAT-029 — Delegate to employee who is NOT flagged as approver is blocked
**Prerequisites:** Target employee has `custentity_oa_is_approver = F` (or unset).
**Steps:** Approver tries to delegate to that employee.
**Expected:** Error message: "Target is not an approver." Delegation does not proceed.
**Coverage:** ✅
**Note:** This is the answer to the question "what if delegated to an employee not part of any flow?" — the engine actively blocks it.

---

### UAT-030 — Delegate button only appears for can_delegate employees
**Steps:** Log in as employee with `custentity_oa_can_delegate = F`. Open a pending PO where you are the approver.
**Expected:** Approve and Reject buttons appear. Delegate button does NOT appear.
**Coverage:** ✅

---

### UAT-031 — Original approver cannot approve after delegation
**Steps:** Approver 1 delegates to Approver X. Approver 1 opens the same PO.
**Expected:** Approve/Reject buttons no longer appear for Approver 1 (they are no longer the current approver on the record).
**Coverage:** ✅

---

### UAT-032 — Approver has delegate_to set → auto-routes on submission
**Prerequisites:** Approver Alice has `custentity_oa_delegate_to` = Bob.
**Steps:** Create a PO that would route to Alice.
**Expected:** `custbody_oa_approver1` is set to Bob (auto-delegation at routing time). Alice is bypassed.
**Coverage:** ✅

---

## 7. Reset & Reassign

### UAT-033 — Manager resets approval flow
**Prerequisites:** User has `custentity_oa_is_manager = T`.
**Steps:** Manager opens a pending PO → clicks Reset flow → selects new approver.
**Expected:** `custbody_oa_current_step` = 1. `custbody_oa_approver1` = new approver. New token generated. New approver receives notification. Audit log shows Reset action.
**Coverage:** ✅

---

### UAT-034 — Reset invalidates previous email links
**Steps:** Manager resets flow. Previous approver tries to click the original email approve link.
**Expected:** Error page: "Invalid or already used token." Previous link is dead.
**Coverage:** ✅

---

### UAT-035 — Reset / Reassign buttons only appear for managers
**Steps:** Log in as employee with `custentity_oa_is_manager = F`. Open any pending PO.
**Expected:** Reset flow and Reassign buttons do NOT appear.
**Coverage:** ✅

---

### UAT-036 — Non-manager cannot call reset via POST
**Steps:** POST directly to email action suitelet with action=reset as a non-manager user.
**Expected:** Engine returns `{ success: false, message: 'Actor is not a manager.' }`. No changes made.
**Coverage:** ✅

---

## 8. Rejected Transaction Re-routing

### UAT-037 — Editing a rejected PO re-routes it
**Steps:** PO is in Rejected status. Edit any field and save.
**Expected:** `approvalstatus` = Pending. Approval flow restarts from step 1. Approver receives new notification. Audit log shows Submitted entry.
**Coverage:** ✅

---

### UAT-038 — Editing a pending PO does NOT re-route
**Steps:** PO is in Pending status (waiting for approval). Edit a non-approval field and save.
**Expected:** `approvalstatus` remains Pending. Current step unchanged. No duplicate notification.
**Coverage:** ✅
**Note:** This prevents an infinite loop where the engine's own `txn.save()` inside afterSubmit would re-trigger the user event.

---

### UAT-039 — Editing an approved PO does NOT re-route
**Steps:** PO is in Approved status. Edit a field and save.
**Expected:** `approvalstatus` remains Approved. No re-routing.
**Coverage:** ✅

---

### UAT-040 — PO created via CSV import is not routed
**Steps:** Import POs via CSV/SuiteScript in a non-UI execution context.
**Expected:** No approval routing occurs. `approvalstatus` unchanged. (User event only fires for USER_INTERFACE, WEBSERVICES, RESTLETS contexts.)
**Coverage:** ✅

---

## 9. Approval History

### UAT-041 — Approval history button appears on submitted PO
**Steps:** Open a PO that has been submitted for approval (`custbody_oa_submitted_by` is set).
**Expected:** "Approval history" button visible in the toolbar, regardless of current approval status.
**Coverage:** ✅

---

### UAT-042 — History button does NOT appear on unsubmitted PO
**Steps:** Open a newly created PO that has not yet gone through OA (`submitted_by` is empty).
**Expected:** No "Approval history" button in toolbar.
**Coverage:** ✅

---

### UAT-043 — History popup shows complete timeline
**Steps:** Click "Approval history" on a PO that has been: Submitted → Delegated → Approved.
**Expected:** Popup opens showing three rows in chronological order: Submitted, Delegated (actor → target), Approved. Each row shows date/time, action pill with colour, step number, who, and source (NetSuite or Email link).
**Coverage:** ✅

---

### UAT-044 — History shows correct source for email approvals
**Steps:** Approve a VB via email link. Open approval history.
**Expected:** The Approved row shows "Email link" in the Via column.
**Coverage:** ✅

---

### UAT-045 — History popup opens in a separate window
**Steps:** Click "Approval history".
**Expected:** Opens in a 960×700 popup window, not in the same tab.
**Coverage:** ✅

---

## 10. Bulk Approval Dashboard

### UAT-046 — Dashboard shows pending queue for current approver
**Steps:** Log in as an approver who has pending transactions. Open Omnit Approvals menu → Bulk Approval Dashboard.
**Expected:** Table shows all POs/VBs where the user is approver1 or approver2 and status = Pending.
**Coverage:** ✅

---

### UAT-047 — Manager sees ALL pending transactions (not just own)
**Steps:** Log in as employee with `custentity_oa_is_manager = T`. Open dashboard.
**Expected:** ALL pending transactions across all approvers and subsidiaries are visible.
**Coverage:** ✅
**Note:** This is the primary answer to "where do I see an overview of all VBs in approval." Any admin who needs this view should have `is_manager = T` set on their employee record.

---

### UAT-048 — Filter by type: Vendor Bills only
**Steps:** Click "Vendor Bill" filter on dashboard.
**Expected:** Only VBs shown. POs hidden.
**Coverage:** ✅

---

### UAT-049 — Filter by status: Approved
**Steps:** Click "Approved" filter.
**Expected:** Shows all approved transactions (for current user or all if manager).
**Coverage:** ✅

---

### UAT-050 — Bulk approve multiple transactions
**Steps:** Set action = Approve on three rows. Click Submit approvals.
**Expected:** All three processed. Toast notification: "Done: 3 processed". Page reloads. Those transactions now show Approved.
**Coverage:** ✅

---

### UAT-051 — Bulk reject requires a reason on all rejections
**Steps:** Set action = Reject on two rows. Leave one reason blank. Click Submit approvals.
**Expected:** Toast: "Please provide a reason for all rejections." No transactions processed.
**Coverage:** ✅

---

### UAT-052 — Skipped rows are not processed
**Steps:** Set action = Approve on row 1, action = Skip on row 2. Submit.
**Expected:** Only row 1 processed. Row 2 unchanged.
**Coverage:** ✅

---

### UAT-053 — Partial success reported correctly
**Steps:** Bulk approve two transactions. Manually set one to Approved beforehand so the engine rejects it ("already processed").
**Expected:** Toast: "Done: 1 processed, 1 failed." Page reloads.
**Coverage:** ✅

---

## 11. Dashboard Portlet

### UAT-054 — Portlet can be added to NetSuite home dashboard
**Steps:** Home dashboard → Customise → Add Portlet → find "OA - Pending Approvals" → add.
**Expected:** Portlet appears on dashboard showing the user's pending approval queue.
**Coverage:** ✅

---

### UAT-055 — Portlet shows empty state when queue is clear
**Steps:** Add portlet when you have no pending approvals.
**Expected:** Portlet shows a ✓ icon and "No pending approvals for you right now."
**Coverage:** ✅

---

### UAT-056 — Portlet caps at 10 rows with "see all" link
**Steps:** Have more than 10 pending transactions as the logged-in user.
**Expected:** Portlet shows 10 rows. Footer shows "Showing first 10 — see all" link to bulk dashboard.
**Coverage:** ✅

---

## 12. NetSuite Menu

### UAT-057 — "Omnit Approvals" tab appears in navigation
**Steps:** Log in to NetSuite with any role after deploying the bundle.
**Expected:** "Omnit Approvals" tab visible in the top navigation bar.
**Coverage:** ✅

---

### UAT-058 — Menu links navigate to correct pages
**Steps:** Click Omnit Approvals → Approval Settings and Omnit Approvals → Bulk Approval Dashboard.
**Expected:** Each link opens the correct suitelet.
**Coverage:** ✅

---

## 13. Employee Flags

### UAT-059 — Employee flags are grouped under "Omnit Approval" tab
**Steps:** Open any Employee record → look for the "Omnit Approval" subtab.
**Expected:** Tab exists and contains: Is Approver, Is Manager, Can Delegate, Use Email Approval, Delegate To.
**Coverage:** ✅

---

### UAT-060 — Use Email = OFF suppresses notification email
**Steps:** Set `custentity_oa_use_email = F` on an approver. Create a PO routing to them.
**Expected:** No notification email sent. Approver must log in to NetSuite to find and act on the transaction.
**Coverage:** ✅

---

### UAT-061 — is_approver flag required to appear in matrix dropdowns
**Steps:** Employee A has `is_approver = F`. Open settings → approval matrix.
**Expected:** Employee A does not appear in the approver dropdowns.
**Coverage:** ⚠️
**Note:** The employee dropdown in the matrix currently filters only by `isinactive = F`. The `is_approver` flag is not used to filter matrix dropdowns — any active employee can be selected. The flag is enforced at delegation time, not at matrix setup time. Consider adding the filter to the employee search in `oa_sl_settings.js` if you want to restrict the dropdowns.

---

## 14. Overview & Reporting — Key Question Answers

### UAT-062 — Where to see ALL vendor bills currently in approval
**Answer:** Open **Omnit Approvals → Bulk Approval Dashboard**. If you have `custentity_oa_is_manager = T` on your employee record, you see every pending transaction across all approvers and subsidiaries. Filter by type = Vendor Bill.
**Coverage:** ⚠️
**Gap:** There is no separate admin-only "all pending" view. Any administrator who needs this overview must have `is_manager = T`. If you want to separate "approval manager" from "NetSuite manager" that is a future feature. A NetSuite saved search on Vendor Bills filtered by `approvalstatus = Pending` is a viable alternative for read-only visibility without needing the flag.

---

### UAT-063 — Where to see full approval history for one document
**Answer:** Open the PO or VB → click the **"Approval history"** button in the toolbar. Shows the complete timeline: who submitted, who approved/rejected/delegated, what step, via what channel, with timestamps and comments.
**Coverage:** ✅

---

### UAT-064 — Where to see all documents a specific employee has approved
**Answer:** There is no dedicated view for this. Use a **NetSuite saved search** on Transactions → add a filter on `customrecord_oa_log` joined by transaction, filtering `custrecord_oal_actor = [employee]` and `custrecord_oal_action = approved`.
**Coverage:** ❌
**Gap:** A "per-approver activity report" suitelet or saved search is not included in Phase 1. Recommended Phase 2 item.

---

### UAT-065 — Where to see transactions awaiting approval that are overdue
**Answer:** No overdue tracking exists in Phase 1. Use the bulk dashboard (manager view) and sort by the Date column manually.
**Coverage:** ❌
**Gap:** No escalation, no overdue flag, no reminder re-send for transactions that have been pending more than N days. Recommended Phase 2 item.

---

## 15. Edge Cases

### UAT-066 — Approval routing when no active hierarchy exists
**Steps:** Delete or inactivate all hierarchy records for a subsidiary. Create a PO.
**Expected:** Falls back to default approver from settings. If no default approver is set, `approver1` remains empty and the transaction pends with no assigned approver. No crash.
**Coverage:** ⚠️
**Gap:** If neither a matching threshold nor a default approver is configured, the transaction will sit pending with no approver and no notification. Consider adding a validation on settings save that requires a default approver.

---

### UAT-067 — Approver deactivated mid-flow
**Steps:** Transaction is pending with Approver A. Approver A's employee record is set to inactive.
**Expected:** The token-based email link still works (lookupFields by ID is not filtered by active status). The NetSuite UI buttons still appear (isCurrentApprover is ID-based). The approver simply cannot log in if their user account is also deactivated.
**Coverage:** ⚠️
**Note:** An inactive employee will disappear from the matrix dropdowns on the settings page but will not be automatically replaced on in-flight transactions. A manager reset is required to move those transactions to a new approver.

---

### UAT-068 — Settings record subsidiary changed after transactions are in flight
**Steps:** Change the subsidiary on an OA settings record while transactions for that subsidiary are pending.
**Expected:** In-flight transactions are unaffected (they already have approver fields set). Future transactions for the old subsidiary will no longer match settings.
**Coverage:** ⚠️
**Note:** Changing a subsidiary on a settings record is a destructive configuration action. No guard exists. Recommend treating settings records as immutable once in use.

---

### UAT-069 — Two settings records for the same subsidiary
**Steps:** Create two settings records both pointing to the same subsidiary.
**Expected:** The engine uses `run().each()` and takes the first result. Whichever record has the lower internal ID will be used. The second record is silently ignored.
**Coverage:** ⚠️
**Gap:** No uniqueness validation on subsidiary in settings. The settings suitelet should warn or block duplicate subsidiaries on save.

---

### UAT-070 — Transaction amount in foreign currency
**Steps:** Create a PO in USD for a subsidiary whose base currency is DKK. Amount threshold matrix is configured in DKK.
**Expected:** The engine uses the `amount` field (NetSuite base currency total, already converted to DKK). Threshold matching is always against base currency regardless of transaction currency. The matrix column header shows "(DKK)".
**Coverage:** ✅

---

### UAT-071 — Single-step configured but approver 2 is set in matrix
**Steps:** Settings: approver count = 1. Matrix row has approver2 set.
**Expected:** Only approver1 is used. Approver2 field on the transaction is not set. One approval completes the flow.
**Coverage:** ✅

---

### UAT-072 — Two-step configured but no approver 2 in matrix or default
**Steps:** Settings: approver count = 2. Matrix row has no approver2. No default approver2 set.
**Expected:** `custbody_oa_approver2` is empty. Step 1 approval completes the flow (engine finds approver2 is null and finalises).
**Coverage:** ✅

---

### UAT-073 — Suitelet actions blocked for wrong user via POST
**Steps:** Employee B POSTs to email action suitelet with action=approve for a transaction where Employee A is the approver.
**Expected:** Engine's `processApproval` uses the posting user's ID (Employee B). The approval is recorded as Employee B's action. There is no "are you the assigned approver?" check in the engine — only the UI hides buttons from non-approvers.
**Coverage:** ⚠️
**Gap:** A user who constructs a manual POST can approve a transaction they are not assigned to. Consider adding an `actorId === currentApprover` guard inside `processApproval` for Phase 2.

---

## 16. Phase 2 Gaps Summary

The following are not in scope for Phase 1 but should be considered before going live with high-volume or regulated environments:

| # | Gap | Risk if not addressed |
|---|-----|-----------------------|
| 1 | No uniqueness check on subsidiary in settings | Silent misconfiguration if two records exist for same subsidiary |
| 2 | Matrix dropdowns not filtered by `is_approver` flag | Any active employee can be set as approver in matrix |
| 3 | No server-side "are you the assigned approver?" check in engine | Determined user can approve via manual POST |
| 4 | No per-approver activity report | Audit trail exists in logs but requires a custom saved search to query |
| 5 | No overdue/escalation tracking | Transactions can sit pending indefinitely with no alert |
| 6 | No default approver validation on settings save | Misconfigured subsidiary silently routes nowhere |
| 7 | Hierarchy date ranges stored but not enforced by engine | Date-scoped rules have no effect at runtime |
| 8 | No automatic hierarchy expiry when saving new matrix | Old hierarchies must be manually marked Expired |
| 9 | No bulk action from email (magic keywords) | Email-only approvers must click a link, not reply |
| 10 | No line-level threshold routing | Header amount only; line-item variance not supported |
