# OmnitApprovals Build Status

> Live status. Updated whenever I make progress (auto-loop fires every 15 min). Keep open in a tab — VS Code Markdown Preview (`Cmd+Shift+V`).
> Last update: 2026-05-04 — full coverage push in flight

## 🎯 ACTION FOR YOU NOW

Nothing pressing. Test coverage push is in flight (2 background agents writing more tests). I'll ping you with a sound only if I hit a real blocker.

## ✅ Just shipped (2026-05-04)

**Production bug fix** (commit `eac4ea1`):
`oa_user_event.js` `beforeSubmit` was overriding `engine.processDecline`'s status transition — every decline-save triggered a re-route that reset status to PENDING. Audit log captured REJECTED but the transaction itself stuck on Pending. Fix: skip re-routing when `approvalstatus` changed in the current save (only the engine writes that field, so a transition is engine-initiated, not user-edit). UAT-021 verified VB 94338 → Rejected end-to-end.

**Test coverage from codex review (17 gaps identified):**

| Test | Type | Status |
|---|---|---|
| H-7 two-step approval lifecycle | unit | ✅ 3/3 |
| H-8 HMAC token validation matrix | unit | ✅ 7/7 |
| SB-7 dashboard POST per-action privilege | unit | ✅ 8/8 |
| **M-2 delegation** | unit | ✅ 5/5 |
| **M-3 hierarchy tie-breaks** | unit | ✅ 6/6 |
| **M-4 subsidiary settings lookup** | unit | ✅ 6/6 |
| **H-9 approved-edit resubmit thresholds** | unit | ✅ 5/5 |
| uat-007 PO create-and-route | e2e | ✅ |
| uat-021 email decline | e2e | ✅ |
| uat-022 token tamper rejection | e2e | ✅ 3/3 variants |
| uat-052 two-step VB approval | e2e | ✅ |
| uat-053 manager reassign/reset | e2e | ✅ reassign / ⏭️ reset |

**All UATs passing. Unit suite: 89/89.**

## 🚀 In-flight now

- Agent: Settings Suitelet POST validation, Portlet rendering, Approval History permissions, MR notifications integration test
- Agent: uat-060 Settings Suitelet UAT, uat-070 Portlet quick-actions

## 🔧 Earlier session fixes (deployed + pushed)

- Dashboard `mainline=T` filter (was 1.7M rows, now 8.7K)
- `datecreated DESC` sort so newest VBs land on page 1
- Pagination 50/page with page nav
- Vendor / subsidiary / approver filter dropdowns query records directly
- Reassign input renders for any role combo
- Tranid link fallback when tranid empty
- Form action fix (script + deploy hidden inputs)
- Clear filters URL fix
- POST handler per-action privilege (HIGH security)
- GET handler access guard for non-approvers
- Settings page: link back to bulk approval

## 📋 Open / blocked

- **Anonymous extforms.netsuite.com access** — link works only via internal app.netsuite.com URL with cookies. The `Available Without Login` audience config requires NS UI access at `/app/common/scripting/scriptdeployment.nl?id=35899&e=T` which psld can't reach. Workaround: real account-owner toggles the checkbox once. Not blocking UAT (internal URL flow is verified end-to-end).

## 🔢 Branch state

- Branch: `claude/playwright-e2e-setup`
- Latest commit: `eac4ea1` fix(engine): user_event resets engine-initiated status transitions
- Pushed to origin

## 🧠 Test patterns established

- Unit: `tests/unit/<H|M|L|SB>-<n>_<desc>.test.js` — node:test + AMD loader + per-test mocks
- Integration: `tests/integration/<SB|MR>-<n>_<desc>.test.js`
- E2E UAT: `tests-e2e/uat/uat-<NNN>-<desc>.spec.js` — Playwright + live NS sandbox
- Diagnostic specs: `tests-e2e/uat/_<purpose>.spec.js` — utility probes (debug Suitelet)

## 🤖 Notifications

Sound configured for **Notification events only** (permission prompts, attention requests). Stop events are silent per your earlier ask.
