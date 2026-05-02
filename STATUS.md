# OmnitApprovals Build Status

> Live status. Updated whenever I make progress. Keep open in a tab — VS Code Markdown Preview (`Cmd+Shift+V`).
> Last update: 2026-05-02 09:55

## 🎯 ACTION FOR YOU NOW

📧 **Open jonasbm@gmail.com inbox + spam folder.** Two emails should be there from the NetSuite sandbox:

| Subject contains | Action | NS internal id |
|---|---|---|
| "Approval required" — $750 ACME | Click **Approve** link | **94300** |
| "Approval required" — $1500 ACME | Click **Reject** → enter a reason | **94301** |

After each click, the transaction status flips (Approved / Rejected). I'll see it in the dashboard.

**Sandbox email is confirmed live** — 8 messages dispatched to jonasbm@gmail.com today (`emailed=T` per NS message log). If you don't see them, definitely check spam.

## 🤖 Agents

- **Currently in flight:** 1 (full e2e regression suite)
- **Just finished:** 9 agents (see Done section)

## ✅ Done this session (overall)

- Tier 1 e2e suite: 19 tests
- Tier 2 UAT-006/041/046/050/051: VB creation + dashboard approve/reject flows
- Setup specs: psld manager+super_approver, Jonas approver, OA Headquarters settings
- Dashboard features:
  - Approver dropdown (employees with `is_approver=T`)
  - Document # clickable link
  - Amount column with base-currency sub-line
  - Settings link in topbar
  - Filter row: date / vendor / amount / subsidiary
- Portlet features:
  - Inline ✓/✗ quick-action deep-links → dashboard auto-prefills action
  - Client-side filters: vendor / amount / date / subsidiary
- Test infra: auth setup with security-question fallback, robust VB helper with account fallback list
- Demo video: 32s (preserved at [demo-omnit-approvals.webm](demo-omnit-approvals.webm))

## 🔧 Open queue

1. Verify NS sandbox email actually sends (in flight)
2. Create 2 test VBs for Jonas (approve + reject) (in flight)
3. Trigger MR notifications for both VBs (in flight)
4. Deploy updated Suitelets to sandbox — needs your help (SuiteCloud CLI auth)
5. Commit + push to working branch `claude/playwright-e2e-setup`

## 📞 Email approval — what codex confirmed

**Trigger:** real-time async via `oa_user_event.afterSubmit` → schedules MR with VB id.

**Required Jonas fields (✅ all set):**
- email: jonasbm@gmail.com
- `custentity_oa_is_approver = T`
- `custentity_oa_use_email = T`

**Required OA settings on Headquarters (✅ all set):**
- `custrecord_oa_enable_vb = T`
- `custrecord_oa_email_enabled = T`
- `custrecord_oa_hmac_secret` populated
- `custrecord_oa_email_sender` = psld (id 3761)
- `custrecord_oa_default_approver1` = Jonas (id 3762)
- `custrecord_oa_approve_without_login = T`

**Manual MR trigger:** Setup → Map/Reduce → Schedule `customscript_oa_mr_notifications` with `custscript_oa_mr_record_id=<VB id>` and `custscript_oa_mr_record_type=vendorbill`.

## 🎬 What you'll do

1. Open jonasbm@gmail.com inbox
2. Find 2 emails (or 1 if the sandbox de-dupes; or 0 if sandbox email is disabled)
3. **VB-A:** click Approve link → confirm transaction status changed to Approved in NS
4. **VB-B:** click Reject link → enter a reason → confirm transaction status changed to Rejected

I'll chime 3x when both VBs are routed and email-trigger MR has fired.

## 🔢 Active test VBs

| VB   | NetSuite id | Scenario      | Amount | Status          | nextApprover    |
|------|-------------|---------------|--------|-----------------|-----------------|
| VB-A | 94300       | EMAIL-APPROVE | 750    | Pending Approval | Jonas Test (3762) |
| VB-B | 94301       | EMAIL-REJECT  | 1500   | Pending Approval | Jonas Test (3762) |

Created: 2026-05-02 by `_seed-2-vbs-for-jonas.spec.js`

## 🧠 Model + effort

Currently: Opus 4.7 (1M context), `effortLevel: max`.
Subagents: Sonnet (faster, parallel-friendly).
This split is good for the current load — debugging in main thread, routine work in subagents.
