// @ts-check
/**
 * _diagnose-email-delivery.spec.js
 *
 * Two-part diagnostic for the "emailed=T but Gmail empty" mystery:
 *
 *   PART A: Probe candidate URLs for the Email Preferences setup page in
 *           this NS version (companyemailprefs.nl returns "Page not found"
 *           in td3075893). Reports first URL that resolves to a real page.
 *
 *   PART B: Pull the HTML body of the most recent OA approval email
 *           (subject LIKE 'Approval required%') and verify:
 *             - the approve / reject link is present and well-formed
 *             - HMAC token, record id, action params present
 *             - sender / recipient match expectations
 *
 * Output is written both to console and to test-results/email-diagnosis.json.
 *
 * Run:
 *   npx playwright test _diagnose-email-delivery --project=chromium --reporter=list
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.setTimeout(180_000);

const CANDIDATE_PREFS_URLS = [
  '/app/setup/companyemailprefs.nl',
  '/app/setup/setupemail.nl',
  '/app/setup/preferences/emailpreferences.nl',
  '/app/setup/company/emailpreferences.nl',
  '/app/setup/manageemailpreferences.nl',
  '/app/setup/email/preferences.nl',
  '/app/setup/email.nl',
  '/app/setup/preferences/companypreferences.nl',
  '/app/common/setup/email/companyemailpreferences.nl',
  '/app/common/setup/companyemailprefs.nl',
];

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

function parseRows(raw) {
  if (raw.error) return { error: raw.error, rows: [] };
  if (raw.status !== 200) return { error: `HTTP ${raw.status}: ${(raw.body || '').slice(0, 300)}`, rows: [] };
  try {
    const parsed = JSON.parse(raw.body);
    return { rows: parsed.items || parsed.data || [] };
  } catch (e) {
    return { error: `JSON parse failed: ${e.message}`, rows: [] };
  }
}

test('diagnose email delivery — probe prefs URLs + extract email body', async ({ page }) => {
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  const out = { partA: { urlsProbed: [], working: [] }, partB: {} };

  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForTimeout(800);

  // ── PART A: probe candidate URLs ───────────────────────────────────────────
  console.log('\n═══ PART A: Probing Email Preferences URL candidates ═══\n');

  for (const p of CANDIDATE_PREFS_URLS) {
    const url = `${baseURL}${p}`;
    let result = { url: p, status: '?', title: '', snippet: '', isPrefsPage: false };
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      result.status = resp ? resp.status() : 'no-response';
      await page.waitForTimeout(500);
      const info = await page.evaluate(() => ({
        title: document.title,
        snippet: document.body.innerText.slice(0, 200),
        // heuristic: "real" prefs page exposes these field labels
        hasHoldField: Boolean(document.body.innerText.match(/hold all notification|hold notification|hold pending notification/i)),
        hasSendAllField: Boolean(document.body.innerText.match(/send all (outgoing|email)/i)),
        hasFwdField: Boolean(document.body.innerText.match(/forward(ing)? (email|address)/i)),
      }));
      result.title = info.title;
      result.snippet = info.snippet.replace(/\n+/g, ' | ').slice(0, 200);
      result.isPrefsPage = info.hasHoldField || info.hasSendAllField || info.hasFwdField;
      result.flags = { hasHoldField: info.hasHoldField, hasSendAllField: info.hasSendAllField, hasFwdField: info.hasFwdField };
    } catch (e) {
      result.error = e.message;
    }
    out.partA.urlsProbed.push(result);
    const verdict = result.isPrefsPage ? '✓ PREFS PAGE' : (/page not found|access denied|insufficient/i.test(result.snippet) ? '✗' : '?');
    console.log(`  [${result.status}] ${verdict} ${p}`);
    console.log(`         title="${result.title}" snippet="${result.snippet.slice(0, 90)}"`);
    if (result.isPrefsPage) out.partA.working.push(p);
  }

  if (out.partA.working.length > 0) {
    console.log(`\n✓ Working email-prefs URL(s): ${out.partA.working.join(', ')}`);
  } else {
    console.log(`\n✗ No working email-prefs URL found for this role. Need higher-privilege role.`);
  }

  // ── PART B: extract latest approval email body ─────────────────────────────
  console.log('\n═══ PART B: Extract latest OA approval email body ═══\n');

  // Find one of today's approval emails (jonasbm@gmail.com recipient)
  const findRaw = await suiteql(
    page,
    `SELECT id, subject, recipientEmail, authorEmail, messageDate, transaction
     FROM message
     WHERE TRUNC(messageDate) = TRUNC(CURRENT_DATE)
       AND recipientEmail = 'jonasbm@gmail.com'
     ORDER BY messageDate DESC
     FETCH FIRST 5 ROWS ONLY`,
  );
  const find = parseRows(findRaw);
  if (find.error) {
    console.log('Find error:', find.error);
    out.partB.findError = find.error;
  } else {
    console.log(`Found ${find.rows.length} candidate emails:`);
    find.rows.forEach((r) => {
      console.log(`  id=${r.id} txn=${r.transaction || '(none)'} subj="${r.subject}" date=${r.messagedate || r.messageDate}`);
    });
    out.partB.candidates = find.rows;
  }

  // Pull the body of the first candidate. SuiteQL does not return the
  // `message` text column reliably (it's CLOB-ish), so navigate to the
  // message record's UI page and scrape from there.
  if (find.rows && find.rows.length > 0) {
    const msgId = find.rows[0].id;
    const msgUrl = `${baseURL}/app/crm/common/message.nl?id=${msgId}`;
    console.log(`\nNavigating to message record: ${msgUrl}`);
    try {
      await page.goto(msgUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1500);

      const msgInfo = await page.evaluate(() => {
        /** @type {any} */ const w = window;
        const get = (id) => {
          try {
            const t = typeof w.nlapiGetFieldText === 'function' ? w.nlapiGetFieldText(id) : null;
            const v = typeof w.nlapiGetFieldValue === 'function' ? w.nlapiGetFieldValue(id) : null;
            return t || v || null;
          } catch (_) { return null; }
        };
        // Try multiple field names for the body
        const bodyRaw = get('message') || get('messagetext') || get('body') || '';
        // DOM fallback: look for an iframe containing the rendered HTML
        let iframeBody = '';
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const f of iframes) {
          try {
            const doc = f.contentDocument;
            if (doc && doc.body && doc.body.innerHTML.length > 100) {
              iframeBody = doc.body.innerHTML;
              break;
            }
          } catch (_) {}
        }
        // Also try a textarea or pre that contains the message
        const textareas = Array.from(document.querySelectorAll('textarea'));
        const taBody = textareas.map(t => t.value).filter(v => v && v.length > 50).join('\n---\n');
        return {
          subject: get('subject'),
          authorEmail: get('authoremail'),
          recipientEmail: get('recipientemail'),
          fieldBody: bodyRaw,
          iframeBody,
          taBody,
          fullPageText: document.body.innerText.slice(0, 4000),
        };
      });

      console.log(`\nMessage ${msgId} field-level info:`);
      console.log(`  subject:     "${msgInfo.subject}"`);
      console.log(`  authorEmail: "${msgInfo.authorEmail}"`);
      console.log(`  recipient:   "${msgInfo.recipientEmail}"`);
      console.log(`  fieldBody length: ${(msgInfo.fieldBody || '').length}`);
      console.log(`  iframeBody length: ${(msgInfo.iframeBody || '').length}`);
      console.log(`  taBody length: ${(msgInfo.taBody || '').length}`);

      // Use whichever body is longest
      const bodySources = [
        { name: 'fieldBody', src: msgInfo.fieldBody },
        { name: 'iframeBody', src: msgInfo.iframeBody },
        { name: 'taBody', src: msgInfo.taBody },
      ].filter(b => b.src && b.src.length > 50);
      bodySources.sort((a, b) => b.src.length - a.src.length);
      const bestBody = bodySources[0]?.src || msgInfo.fullPageText;
      const bestSource = bodySources[0]?.name || 'fullPageText';

      console.log(`\nUsing body source: ${bestSource} (${bestBody.length} chars)`);

      // Scan for approve / reject / portal links
      const linkRegex = /https?:\/\/[^\s"'<>]+/g;
      const links = (bestBody.match(linkRegex) || []).slice(0, 30);
      const approveLinks = links.filter(l => /(action=approve|approve|approval)/i.test(l));
      const rejectLinks = links.filter(l => /(action=reject|reject|decline)/i.test(l));
      const ssLinks = links.filter(l => /\/c\.|\/app\/site\/hosting\/scriptlet\.nl/i.test(l));

      console.log(`\nLinks found in body: ${links.length}`);
      console.log(`  Approve-flavored: ${approveLinks.length}`);
      approveLinks.slice(0, 3).forEach(l => console.log(`    ${l}`));
      console.log(`  Reject-flavored:  ${rejectLinks.length}`);
      rejectLinks.slice(0, 3).forEach(l => console.log(`    ${l}`));
      console.log(`  Suitelet (script) links: ${ssLinks.length}`);
      ssLinks.slice(0, 3).forEach(l => console.log(`    ${l}`));

      // Token/HMAC heuristic
      const hasHmac = /[?&](sig|token|hmac)=[A-Za-z0-9_\-]{16,}/i.test(bestBody);
      const hasRecord = /[?&](rec|recordid|id)=\d+/i.test(bestBody);
      const hasAction = /[?&]action=/i.test(bestBody);
      console.log(`  Has HMAC/sig param: ${hasHmac}`);
      console.log(`  Has record id param: ${hasRecord}`);
      console.log(`  Has action param: ${hasAction}`);

      out.partB.message = {
        id: msgId,
        subject: msgInfo.subject,
        authorEmail: msgInfo.authorEmail,
        recipientEmail: msgInfo.recipientEmail,
        bodySource: bestSource,
        bodyLength: bestBody.length,
        bodyPreview: bestBody.slice(0, 1500),
        approveLinks,
        rejectLinks,
        ssLinks,
        hasHmac,
        hasRecord,
        hasAction,
      };

      // Save full body to file for inspection
      const bodyFile = path.join('test-results', `email-${msgId}-body.html`);
      try {
        fs.mkdirSync('test-results', { recursive: true });
        fs.writeFileSync(bodyFile, bestBody);
        console.log(`\nFull body written to ${bodyFile}`);
      } catch (e) {
        console.log(`Could not write body file: ${e.message}`);
      }
    } catch (e) {
      console.log(`Body extraction error: ${e.message}`);
      out.partB.bodyError = e.message;
    }
  }

  // Save structured JSON
  try {
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync('test-results/email-diagnosis.json', JSON.stringify(out, null, 2));
    console.log('\nDiagnosis JSON written to test-results/email-diagnosis.json');
  } catch (e) {
    console.log(`Could not write JSON: ${e.message}`);
  }

  // Spec passes regardless — purpose is reporting, not assertion
  expect(true).toBe(true);
});
