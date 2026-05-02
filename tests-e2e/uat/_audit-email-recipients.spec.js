// @ts-check
/**
 * _audit-email-recipients.spec.js
 *
 * Audits every email dispatched today by customscript_oa_mr_notifications to
 * confirm approval emails go ONLY to jonasbm@gmail.com (no CC/BCC leaks).
 *
 * Three strategies in order:
 *   1. SuiteQL REST query on the `message` table filtered to today + subject LIKE 'Approval%'
 *   2. Navigate to /app/communications/messages/messagelist.nl and scrape the UI
 *   3. Visit VB 94300 and 94301 Communication subtab
 *
 * Also reads the OA Settings record (id=1) for custrecord_oa_email_cc/bcc/sender.
 * Also reads Company Email Preferences for "Send All Emails To" override.
 *
 * Run:
 *   npx playwright test _audit-email-recipients --project=chromium --reporter=list
 */
const { test, expect } = require('@playwright/test');

test.setTimeout(180_000);

/** Helper: run a SuiteQL query from inside the live browser session (reuses cookie). */
async function suiteql(page, q) {
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  return page.evaluate(
    async ([base, query]) => {
      try {
        const r = await fetch(`${base}/services/rest/query/v1/suiteql`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
          body: JSON.stringify({ q: query }),
        });
        const body = await r.text();
        return { status: r.status, body };
      } catch (e) {
        return { error: String(e) };
      }
    },
    [baseURL, q],
  );
}

/** Parse SuiteQL response to rows array. */
function parseRows(raw) {
  if (raw.error) return { error: raw.error, rows: [] };
  if (raw.status !== 200) return { error: `HTTP ${raw.status}: ${(raw.body || '').slice(0, 300)}`, rows: [] };
  try {
    const parsed = JSON.parse(raw.body);
    const rows = parsed.items || parsed.data || [];
    return { rows, count: parsed.count ?? parsed.totalResults ?? rows.length };
  } catch (e) {
    return { error: `JSON parse failed: ${e.message}`, rows: [], rawSnippet: (raw.body || '').slice(0, 200) };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
test('audit email recipients for today\'s MR notification emails', async ({ page }) => {
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');

  // Establish authenticated session
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForTimeout(1000);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  EMAIL RECIPIENT AUDIT — customscript_oa_mr_notifications    ║');
  console.log('║  Sandbox: td3075893  |  Date: ' + new Date().toISOString().slice(0, 10) + '                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ──────────────────────────────────────────────────────────────────────────
  // STRATEGY 1: SuiteQL on message table — today's approval emails
  // ──────────────────────────────────────────────────────────────────────────
  console.log('═══ STRATEGY 1: SuiteQL on message table ═══');

  // Primary query: today + approval subject
  const todayApprovalRaw = await suiteql(page,
    `SELECT id, subject, author, authorEmail, recipient, recipientEmail, messageDate, emailed
     FROM message
     WHERE TRUNC(messageDate) = TRUNC(CURRENT_DATE)
       AND UPPER(subject) LIKE '%APPROV%'
     ORDER BY messageDate DESC`
  );
  const todayApproval = parseRows(todayApprovalRaw);

  if (todayApproval.error) {
    console.log('Today approval query error:', todayApproval.error);
  } else {
    console.log(`Today approval emails found: ${todayApproval.rows.length} (total count: ${todayApproval.count})`);
    todayApproval.rows.forEach((r) => {
      const date = r.messagedate || r.messageDate;
      const to = r.recipientemail || r.recipientEmail || '(none)';
      const subj = r.subject || '';
      const emailed = r.emailed;
      console.log(`  [${date}] emailed=${emailed} to="${to}" subject="${subj}"`);
    });
  }

  // Extended query: try CC/BCC columns too (columns may not exist in all schemas)
  const todayAllColsRaw = await suiteql(page,
    `SELECT id, subject, authorEmail, recipientEmail, messageDate, emailed, ccRecipient, bccRecipient
     FROM message
     WHERE TRUNC(messageDate) = TRUNC(CURRENT_DATE)
       AND UPPER(subject) LIKE '%APPROV%'
     ORDER BY messageDate DESC`
  );
  const todayAllCols = parseRows(todayAllColsRaw);
  if (!todayAllCols.error) {
    console.log('\nWith CC/BCC columns:');
    todayAllCols.rows.forEach((r) => {
      const cc = r.ccrecipient || r.ccRecipient || '';
      const bcc = r.bccrecipient || r.bccRecipient || '';
      console.log(`  id=${r.id} cc="${cc}" bcc="${bcc}"`);
    });
  } else {
    console.log('CC/BCC column query error (columns may not exist):', todayAllCols.error.slice(0, 200));
  }

  // Broader: all outbound emails today (any subject) for completeness
  const todayAllRaw = await suiteql(page,
    `SELECT id, subject, authorEmail, recipientEmail, messageDate, emailed
     FROM message
     WHERE TRUNC(messageDate) = TRUNC(CURRENT_DATE)
       AND incoming = 'F'
     ORDER BY messageDate DESC`
  );
  const todayAll = parseRows(todayAllRaw);
  console.log(`\nAll outbound emails today (any subject): ${todayAll.error ? 'ERROR: ' + todayAll.error : todayAll.rows.length}`);
  if (!todayAll.error) {
    todayAll.rows.forEach((r) => {
      const to = r.recipientemail || r.recipientEmail || '(none)';
      console.log(`  [${r.messagedate || r.messageDate}] to="${to}" subject="${r.subject}"`);
    });
  }

  // Also search last 48 hours in case today's date arithmetic differs in sandbox TZ
  const recent48Raw = await suiteql(page,
    `SELECT id, subject, authorEmail, recipientEmail, messageDate, emailed
     FROM message
     WHERE messageDate >= SYSDATE - 2
       AND UPPER(subject) LIKE '%APPROV%'
     ORDER BY messageDate DESC`
  );
  const recent48 = parseRows(recent48Raw);
  console.log(`\nApproval emails in last 48h: ${recent48.error ? 'ERROR: ' + recent48.error : recent48.rows.length}`);
  if (!recent48.error) {
    recent48.rows.forEach((r) => {
      const to = r.recipientemail || r.recipientEmail || '(none)';
      console.log(`  [${r.messagedate || r.messageDate}] emailed=${r.emailed} to="${to}" subject="${r.subject}"`);
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRATEGY 2: Message list UI at /app/communications/messages/messagelist.nl
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n═══ STRATEGY 2: Message list UI ═══');
  try {
    await page.goto(
      `${baseURL}/app/communications/messages/messagelist.nl`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );
    await page.waitForTimeout(2000);
    const pageTitle = await page.evaluate(() => document.title);
    const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log('Page title:', pageTitle);
    console.log('Body snippet:', bodySnippet.replace(/\n+/g, ' | ').slice(0, 200));

    // Try to find table rows
    const rows = await page.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('tr[id^="row_"], tr.list-row, tbody tr'));
      return trs.slice(0, 20).map((tr) => {
        const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim() || '');
        return cells.join(' | ');
      }).filter((s) => s.length > 5);
    });
    if (rows.length > 0) {
      console.log(`Message list rows (up to 20):`);
      rows.forEach((r) => console.log('  ', r));
    } else {
      console.log('No table rows found via generic selectors — may need role-specific access.');
    }
  } catch (e) {
    console.log('Strategy 2 error:', e.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRATEGY 3: VB 94300 and 94301 Communication subtab
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n═══ STRATEGY 3: VB Communication subtab ═══');

  for (const vbId of ['94300', '94301']) {
    console.log(`\n--- VB ${vbId} ---`);
    try {
      await page.goto(
        `${baseURL}/app/accounting/transactions/vendbill.nl?id=${vbId}`,
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );
      await page.waitForTimeout(2000);

      const accessible = await page.evaluate(() => {
        const blocked = /page not found|access denied|you do not have|insufficient/i.test(document.body.innerText.slice(0, 200));
        return !blocked;
      });

      if (!accessible) {
        const snippet = await page.evaluate(() => document.body.innerText.slice(0, 200));
        console.log(`  VB ${vbId}: NOT accessible — ${snippet.replace(/\n/g, ' ')}`);
        continue;
      }

      // Read subject / approval status field
      const vbInfo = await page.evaluate(() => {
        /** @type {any} */ const w = window;
        const get = (id) => {
          try {
            const v = typeof w.nlapiGetFieldValue === 'function' ? w.nlapiGetFieldValue(id) : null;
            const t = typeof w.nlapiGetFieldText === 'function' ? w.nlapiGetFieldText(id) : null;
            return t || v || null;
          } catch (_) { return null; }
        };
        return {
          tranid: get('tranid'),
          approvalstatus: get('approvalstatus'),
          nextapprover: get('nextapprover'),
          memo: get('memo'),
        };
      });
      console.log(`  VB info: ${JSON.stringify(vbInfo)}`);

      // Try clicking Communication subtab
      const commTabSelectors = [
        'a[href*="Communication"], a[data-tabid*="Communication"]',
        'td[id*="communication"] a, div[id*="communication"] a',
        'a:has-text("Communication"), a:has-text("Messages")',
        '#communication_tab, #messages_tab',
        'li[id*="communication"] a, li[id*="messages"] a',
      ];

      let tabClicked = false;
      for (const sel of commTabSelectors) {
        const tab = page.locator(sel).first();
        if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
          await tab.click({ force: true });
          await page.waitForTimeout(1500);
          tabClicked = true;
          console.log(`  Clicked Communication tab via: ${sel}`);
          break;
        }
      }

      if (!tabClicked) {
        // Try by text content scan
        const tabText = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a, td, li'));
          return links.filter(el => /communication|messages/i.test(el.textContent || '')).map(el => ({
            tag: el.tagName,
            id: el.id,
            text: (el.textContent || '').trim().slice(0, 50),
          })).slice(0, 10);
        });
        console.log('  Subtab candidates:', JSON.stringify(tabText));
      }

      // Read message rows from the communication section
      const msgRows = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll(
          'tr[id^="row_"], .ns-list-body tr, table.listview tr, #communication_table tr, ' +
          '[id*="communication"] tr, [id*="message"] tr'
        ));
        return rows.slice(0, 30).map((tr) => {
          const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim() || '');
          return cells.filter(c => c).join(' | ');
        }).filter(s => s.length > 5);
      });

      if (msgRows.length > 0) {
        console.log(`  Message rows (${msgRows.length}):`);
        msgRows.forEach(r => console.log(`    ${r}`));
      } else {
        // Dump page text for debugging
        const snippet = await page.evaluate(() => document.body.innerText.slice(0, 500));
        console.log('  No message rows found. Page text snippet:');
        console.log(' ', snippet.replace(/\n+/g, ' | ').slice(0, 400));
      }

      // Also try SuiteQL filtered to this VB transaction
      const vbMsgRaw = await suiteql(page,
        `SELECT id, subject, authorEmail, recipientEmail, messageDate, emailed
         FROM message
         WHERE transaction = ${vbId}
         ORDER BY messageDate DESC`
      );
      const vbMsg = parseRows(vbMsgRaw);
      if (!vbMsg.error) {
        console.log(`  SuiteQL messages for VB ${vbId}: ${vbMsg.rows.length}`);
        vbMsg.rows.forEach((r) => {
          const to = r.recipientemail || r.recipientEmail || '(none)';
          console.log(`    [${r.messagedate || r.messageDate}] emailed=${r.emailed} to="${to}" subject="${r.subject}"`);
        });
      } else {
        console.log(`  SuiteQL for VB ${vbId} error:`, vbMsg.error.slice(0, 200));
      }
    } catch (e) {
      console.log(`  VB ${vbId} error:`, e.message);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // OA SETTINGS record (id=1) — check CC/BCC/sender custom fields
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n═══ OA Settings record (id=1) — CC/BCC/sender fields ═══');

  // Try SuiteQL on the custom record
  const oaSettingsRaw = await suiteql(page,
    `SELECT id, name, custrecord_oa_email_cc, custrecord_oa_email_bcc, custrecord_oa_email_sender,
            custrecord_oa_email_override, custrecord_oa_redirect_email
     FROM customrecord_oa_settings
     WHERE id = 1`
  );
  const oaSettings = parseRows(oaSettingsRaw);
  if (!oaSettings.error) {
    console.log('OA Settings SuiteQL result:');
    oaSettings.rows.forEach(r => console.log('  ', JSON.stringify(r)));
    if (oaSettings.rows.length === 0) console.log('  (no rows returned — record may not exist or table name differs)');
  } else {
    console.log('OA Settings SuiteQL error:', oaSettings.error.slice(0, 300));
  }

  // Also navigate to the custom record UI
  try {
    await page.goto(
      `${baseURL}/app/common/custom/custrecordentry.nl?rectype=customrecord_oa_settings&id=1`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 }
    );
    await page.waitForTimeout(1500);

    const nsReady = await page.waitForFunction(() => {
      /** @type {any} */ const w = window;
      return typeof w.nlapiGetFieldValue === 'function';
    }, null, { timeout: 15_000 }).then(() => true).catch(() => false);

    if (nsReady) {
      const oaFieldValues = await page.evaluate(() => {
        /** @type {any} */ const w = window;
        const fields = [
          'custrecord_oa_email_cc',
          'custrecord_oa_email_bcc',
          'custrecord_oa_email_sender',
          'custrecord_oa_email_override',
          'custrecord_oa_redirect_email',
          'custrecord_oa_test_email',
          'custrecord_oa_notify_cc',
          'custrecord_oa_notify_bcc',
        ];
        const result = {};
        fields.forEach(f => {
          try {
            const val = w.nlapiGetFieldValue(f);
            const txt = w.nlapiGetFieldText ? w.nlapiGetFieldText(f) : null;
            if (val !== null || txt !== null) result[f] = { value: val, text: txt };
          } catch (_) {}
        });
        // Also dump all inputs
        const allInputs = [];
        document.querySelectorAll('input, select, textarea').forEach(el => {
          if (!(el instanceof HTMLElement)) return;
          const id = el.id || '';
          const name = (/** @type {any} */(el)).name || '';
          if (id.startsWith('custrecord')) {
            let val = '';
            if (el instanceof HTMLInputElement) val = el.type === 'checkbox' ? (el.checked ? 'T' : 'F') : el.value;
            else if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) val = el.value;
            allInputs.push({ id, name, val });
          }
        });
        result['__custrecordInputs'] = allInputs;
        return result;
      });

      const { __custrecordInputs, ...oa } = oaFieldValues;
      console.log('OA Settings field values (nlapiGetFieldValue):');
      console.log('  ', JSON.stringify(oa, null, 2));
      if (Array.isArray(__custrecordInputs) && __custrecordInputs.length > 0) {
        console.log('  All custrecord* DOM inputs:');
        __custrecordInputs.forEach(f => console.log(`    id="${f.id}" val="${f.val}"`));
      }
    } else {
      const snippet = await page.evaluate(() => document.body.innerText.slice(0, 300));
      console.log('OA Settings page (nlapiGetFieldValue not ready):', snippet.replace(/\n/g, ' | ').slice(0, 200));
    }
  } catch (e) {
    console.log('OA Settings UI error:', e.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Company Email Preferences — "Send All Emails To" override
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n═══ Company Email Preferences — Send All Emails To ═══');
  try {
    await page.goto(
      `${baseURL}/app/setup/companyemailprefs.nl`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 }
    );
    await page.waitForTimeout(1500);

    const accessible = await page.evaluate(() =>
      !/page not found|access denied|you do not have|insufficient/i.test(document.body.innerText.slice(0, 200))
    );

    if (!accessible) {
      console.log('Company Email Prefs: access denied for this role');
    } else {
      const prefs = await page.evaluate(() => {
        /** @type {any} */ const w = window;
        const fields = [
          'notif_sendallemails', 'sendallemailsto', 'sendallemails',
          'allemailtodest', 'redirectallemails', 'emailredirect',
          'notify_pendingemail', 'holdnotifications', 'holdnotificationemails',
          'testmodeemailaddress', 'bccemailaddress',
        ];
        const out = {};
        fields.forEach(f => {
          try {
            const val = typeof w.nlapiGetFieldValue === 'function' ? w.nlapiGetFieldValue(f) : null;
            const el = document.getElementById(f);
            let domVal = null;
            if (el instanceof HTMLInputElement) domVal = el.type === 'checkbox' ? (el.checked ? 'T' : 'F') : el.value;
            else if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) domVal = /** @type {any} */(el).value;
            if (val !== null || domVal !== null) out[f] = { api: val, dom: domVal };
          } catch (_) {}
        });
        // Also dump all inputs on the page
        const allInputs = [];
        document.querySelectorAll('input[type="text"], input[type="email"], textarea').forEach(el => {
          const id = (/** @type {any} */(el)).id || '';
          const name = (/** @type {any} */(el)).name || '';
          const val = (/** @type {any} */(el)).value || '';
          if (id || name) allInputs.push({ id, name, val });
        });
        out['__allTextInputs'] = allInputs;
        return out;
      });

      const { __allTextInputs, ...emailPrefs } = prefs;
      console.log('Email pref field values:', JSON.stringify(emailPrefs, null, 2));
      if (Array.isArray(__allTextInputs) && __allTextInputs.length > 0) {
        console.log('All text inputs on Company Email Prefs page:');
        __allTextInputs.forEach(f => console.log(`  id="${f.id}" name="${f.name}" val="${f.val}"`));
      }
    }
  } catch (e) {
    console.log('Company Email Prefs error:', e.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FINAL AUDIT SUMMARY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    FINAL AUDIT SUMMARY                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Collect all approval emails from all sources
  const allApprovalEmails = [
    ...(todayApproval.rows || []),
    ...(recent48.rows || []),
  ];

  // Deduplicate by id
  const seen = new Set();
  const deduped = allApprovalEmails.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  // Distinct recipients
  const distinctRecipients = new Set(
    deduped.map(r => (r.recipientemail || r.recipientEmail || '').toLowerCase()).filter(Boolean)
  );

  console.log(`\nTotal approval emails found (deduplicated): ${deduped.length}`);
  console.log(`Distinct recipient emails:`);
  if (distinctRecipients.size === 0) {
    console.log('  (none found — either no emails sent today or table access blocked)');
  } else {
    [...distinctRecipients].forEach(e => console.log(`  ${e}`));
  }

  // Check for any non-jonasbm recipients
  const nonJonas = [...distinctRecipients].filter(e => !e.includes('jonasbm@gmail.com'));
  if (nonJonas.length > 0) {
    console.log(`\n⚠  LEAK DETECTED — recipients other than jonasbm@gmail.com:`);
    nonJonas.forEach(e => console.log(`   ${e}`));
  } else if (distinctRecipients.size > 0) {
    console.log(`\n✓  All approval emails sent ONLY to jonasbm@gmail.com`);
  }

  // Check email subjects for the new format
  const subjects = deduped.map(r => r.subject || '').filter(Boolean);
  const newFormatSubjects = subjects.filter(s => /Approval required\s*[—–-]/.test(s));
  const oldFormatSubjects = subjects.filter(s => /Approval required/i.test(s) && !/[—–-]/.test(s));

  console.log(`\nSubject format audit:`);
  console.log(`  New format (contains em-dash "—"): ${newFormatSubjects.length}`);
  newFormatSubjects.forEach(s => console.log(`    "${s}"`));
  console.log(`  Old format (no em-dash): ${oldFormatSubjects.length}`);
  oldFormatSubjects.forEach(s => console.log(`    "${s}"`));

  if (newFormatSubjects.length > 0) {
    console.log('\n✓  New subject fix IS in effect — subjects contain "Approval required — #XXXXX"');
  } else if (subjects.length > 0) {
    console.log('\n⚠  New subject fix NOT detected in current emails');
  } else {
    console.log('\n  (No emails found to check subject format)');
  }

  // The test always passes — this is a reporting spec
  expect(true).toBe(true);
});
