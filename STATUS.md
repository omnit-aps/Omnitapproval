# OmnitApprovals Build Status

> Live status. Updated whenever I make progress. Keep open in a tab — VS Code Markdown Preview (`Cmd+Shift+V`).
> Last update: 2026-05-02 10:10

## 🎯 ACTION FOR YOU NOW

🔍 **Diagnosis complete.** NS dispatched 14 emails today with `emailed=T`, but **none reached your Gmail**. Two distinct issues:

### Issue 1 — Code bug in MR script ✅ FIXED

The 14 emails today all had subject `"Approval required — "` (no VB number). Reason: `documentNumber = fields.tranid` is `undefined` on freshly-saved VBs, so the subject ended in just a trailing space.

**Fix applied** to [oa_mr_notifications.js:114](OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_mr_notifications.js#L114) — falls back to `#<recordId>` when `tranid` isn't assigned yet. Subjects will now be like `"Approval required — #94300"`.

### Issue 2 — Likely sandbox email hold (needs your admin)

`emailed=T` means NS handed the message to its mail relay — but external delivery is being suppressed somewhere. `psld@omnit.dk` doesn't have admin rights to verify, so **you (or whoever has Administrator) need to do this:**

**Step A: Check Email Preferences as Administrator**

Open `https://td3075893.app.netsuite.com/app/setup/companyemailprefs.nl` while logged in as Administrator. Look for:
- ❑ **"Hold All Notification Emails"** — should be unchecked
- ❑ **"Send All Outgoing Emails to:"** — should be empty (if filled, all emails are redirected to that address regardless of the actual recipient)
- ❑ **"Approve Email Domains"** — confirm `gmail.com` is allowed (or no domain restriction)

**Step B: Deploy the fixed MR script**

The subject-line fix is committed but not deployed to sandbox. Run from `/Users/work/Omnitapproval/OmnitApprovals`:
```sh
suitecloud file:upload --paths "/SuiteScripts/OmnitApprovals/oa_mr_notifications.js"
```
(needs SuiteCloud CLI + auth — see [Suitelet deploy](#suitelet-deploy) below)

**Step C: Re-trigger MR for VB 94300 + 94301**

Either re-save them so the user-event fires automatically, or:
1. Setup → Scripting → Scheduled Scripts → `customscript_oa_mr_notifications`
2. Edit deployment → set `custscript_oa_mr_record_id = 94300`, `custscript_oa_mr_record_type = vendorbill`
3. Save and Execute. Repeat for 94301.

**Step D: Check both inbox AND spam at jonasbm@gmail.com.** If still nothing, Issue 2 is real and we need step A's preferences flipped.

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
