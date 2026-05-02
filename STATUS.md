# OmnitApprovals Build Status

> Live status. Updated whenever I make progress. Keep open in a tab — VS Code Markdown Preview (`Cmd+Shift+V`).
> Last update: 2026-05-02 16:30

## 🎯 ACTION FOR YOU NOW

**Single fastest test:** open https://mail.google.com/mail/u/0/#spam in jonasbm's account and search for `from:netsuite.com`. ~50% chance the 14 dispatched emails are sitting in spam. If they are: whitelist the sender and the email path works. If not: it's a sandbox-level external-email block (see "Root cause" below).

## 🧾 Today's diagnostic run (all evidence)

| What we tested | Result |
|---|---|
| OA `customscript_oa_mr_notifications` dispatch | ✅ 14 emails dispatched today, all `emailed=T` |
| Recipients on each email | ✅ Only `jonasbm@gmail.com` — no cc/bcc/leaks |
| Subject line | 🐛 `"Approval required — "` (empty after dash). Fix is in code at [oa_mr_notifications.js:116](OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_mr_notifications.js#L116) but the deployed file may be stale OR `tranid` is non-empty-but-empty |
| Message → VB link | 🐛 Every dispatched message has `transaction=null` — `email.send()` was missing `relatedRecords`. **Just fixed** in [oa_mr_notifications.js:233](OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_mr_notifications.js#L233). Needs redeploy. |
| Gmail inbox | ❌ Empty (per your check earlier) |
| Email Preferences setup page | ❌ All 10 candidate URLs return 500 / "Page not found" for psld role — the page genuinely doesn't exist for this role, not just access-denied |
| Message record view (`/app/crm/common/message.nl?id=…`) | ❌ Returns "Page not found" for psld — can't inspect body, links, sender |
| VB record view (94300, 94301) | ❌ Returns nulls for `tranid`/`approvalstatus` — psld can't read these records |

## 🧠 Root cause hypothesis (in order of likelihood)

1. **Gmail spam folder** (50%) — sandbox emails from `netsuite.com` get aggressive spam filtering. Check there first.
2. **NS sandbox external-email lock** (35%) — Oracle infrastructure-level suppression. `emailed=T` flips when NS hands the message to its internal queue, but if the sandbox is configured to drop external mail at the relay, no SMTP ever leaves. Diagnostic: NS Support ticket asking "is external email enabled on td3075893?" — typical answer is no, and they'll either enable it or instruct you to test on production.
3. **psld role lacks Setup access** (15%) — even if external email IS enabled, we can't tweak Hold/Send-All/Whitelist settings without Administrator (real one, not the role-label). This blocks debugging but is unlikely to be the root cause since `emailed=T` happens regardless.

## 🔧 Code fixes from this session

| Fix | File | Status |
|---|---|---|
| Subject-line fallback to `#recordId` when `tranid` empty | [oa_mr_notifications.js:116](OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_mr_notifications.js#L116) | Committed (commit `3ffc524`), deployed earlier today, but **subjects still empty** — needs redeploy verification |
| `email.send()` missing `relatedRecords: { transactionId }` | [oa_mr_notifications.js:233](OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/oa_mr_notifications.js#L233) | **Just edited, not yet committed/deployed** |

## 📋 Test specs run today

| Spec | What it verifies | Pass? |
|---|---|---|
| `_audit-email-recipients.spec.js` | Recipients are clean across all 14 emails today | ✅ |
| `_check-email-prefs.spec.js` | Reads Company Email Preferences | ❌ access denied |
| `_diagnose-email-delivery.spec.js` (new) | Probes alt prefs URLs + extracts email body | ✅ ran, both blocked by role |

Output files:
- [test-results/email-diagnosis.json](test-results/email-diagnosis.json) — structured findings
- [test-results/email-716452-body.html](test-results/email-716452-body.html) — empty (psld can't read)
- [playwright-report/index.html](playwright-report/index.html) — full HTML report

## 🚦 Next moves (ranked by reversibility / cost)

1. **You (30s):** check Gmail spam folder for jonasbm@gmail.com searching `from:netsuite.com`.
2. **You (2min):** if spam is also empty, file an NS Support ticket on td3075893 asking "is external email enabled? if not, enable for our test addresses."
3. **Me (5min):** commit the `relatedRecords` fix + redeploy via SuiteCloud, then re-trigger the MR for one VB. Verify message now links to VB.
4. **Me (10min):** investigate why subject is empty even with the deployed fix — likely `tranid` is being read before NS auto-assigns it. Check whether `search.lookupFields('tranid')` returns `""` vs `false` vs an empty array.
5. **Optional:** deploy a Suitelet that exposes Email Preferences read for the psld role, so we can verify settings without owner login. Higher effort, lower value than (1)-(4).

## 🔢 Active test VBs

| VB   | NetSuite id | Scenario      | Amount | Status          | nextApprover    |
|------|-------------|---------------|--------|-----------------|-----------------|
| VB-A | 94300       | EMAIL-APPROVE | 750    | Pending Approval | Jonas Test (3762) |
| VB-B | 94301       | EMAIL-REJECT  | 1500   | Pending Approval | Jonas Test (3762) |

Created: 2026-05-02 by `_seed-2-vbs-for-jonas.spec.js`. NOTE: psld role can't view these — needs Jonas's role or owner.

## 📞 Email approval — what codex confirmed earlier

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
- Email-recipients audit: confirmed clean
- Email-delivery diagnosis: identified `relatedRecords` bug + role-permission blocker

## 🧠 Model + effort

Currently: Opus 4.7 (1M context), `effortLevel: max`.
Subagents: Sonnet (faster, parallel-friendly).
This split is good for the current load — debugging in main thread, routine work in subagents.
