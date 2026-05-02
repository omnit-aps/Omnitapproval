# OmnitApprovals Build Status

> Live status. Updated whenever I make progress. Keep open in a tab — VS Code Markdown Preview (`Cmd+Shift+V`).
> Last update: 2026-05-02 10:10

## 🎯 ACTION FOR YOU NOW

✅ **Recipient audit clean** — confirmed every approval email has only `jonasbm@gmail.com` on the To: line. Zero cc/bcc/leaks. So the script is doing the right thing on that front.

❌ **Emails still not arriving at Gmail** — NS reports `emailed=T` (handed to mail relay) for 14 messages today, but Gmail inbox is empty.

### Steps so far (automated)

- ✅ Subject-line bug fixed in [oa_mr_notifications.js:114](OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_mr_notifications.js#L114)
- ✅ Deployed via SuiteCloud (you ran `suitecloud file:upload`)
- ✅ MR re-triggered for VB 94300 + 94301 via "touch save" (saving the VB without changes fires the after-submit which schedules the MR)

### Still needs you (Full Access role required)

**Open `/app/setup/companyemailprefs.nl` while logged in as the actual account owner / Full Access role** — psld@omnit.dk can't read it even with the Administrator role label. Verify:

| Setting | Should be |
|---|---|
| Hold All Notification Emails | unchecked |
| Send All Outgoing Emails to | empty |
| Approved Email Domains | empty or includes gmail.com |
| Email Sender Approval | not blocking unknown senders |

If any are wrong, flip them and Save. Then I'll re-trigger the MR and you'll get the emails.

**Or** — the simpler fallback: NS sandboxes are commonly configured at the Oracle infrastructure level to suppress external email entirely (regardless of these settings). If your sandbox has that lock, the fix is to either:
- Have NS support enable "external email" on td3075893
- Test on production with throwaway transactions
- Or test the email approval link by reading the email body from NS's own message log (we can do that via Playwright; the link still works as long as NS dispatched it)

## 🤖 Agents

- **Currently in flight:** 3
  1. Full e2e regression suite
  2. NS message log query — checking VB 94300 + 94301 specifically for `emailed=T` records
  3. Manual MR trigger — scheduling `customscript_oa_mr_notifications` for VB 94300 + 94301
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
