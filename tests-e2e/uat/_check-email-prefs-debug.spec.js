// @ts-check
/**
 * _check-email-prefs-debug.spec.js
 *
 * Probes the OmnitApprovals debug Suitelet (oa_sl_debug) which returns
 * a JSON dump of NetSuite COMPANY_PREFERENCES email-routing flags plus
 * runtime metadata and the most recent inbound notification messages.
 *
 * The Suitelet must be deployed before this spec can run:
 *   /app/site/hosting/scriptlet.nl
 *     ?script=customscript_oa_sl_debug
 *     &deploy=customdeploy_oa_sl_debug
 *
 * This is a REPORTING spec (not an assertion gate). It always passes
 * as long as the Suitelet responds with parseable JSON; problems are
 * surfaced in the console output and in test-results/email-prefs-debug.json.
 *
 * Run:
 *   npx playwright test _check-email-prefs-debug --project=chromium --reporter=list
 */
const { test, expect } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');

test.setTimeout(120_000);

const SUITELET_PATH =
  '/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug&deploy=customdeploy_oa_sl_debug';

const OUTPUT_DIR  = path.resolve(__dirname, '..', '..', 'test-results');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'email-prefs-debug.json');

/**
 * Render a small ASCII box around the given title + lines so the
 * boxed summary is immediately recognizable in the test output, in
 * keeping with the other audit specs in this repo.
 *
 * @param {string} title
 * @param {string[]} lines
 */
function boxed(title, lines) {
  const all = [title, '', ...lines];
  const width = Math.max(...all.map((l) => l.length)) + 2;
  const top    = '+' + '-'.repeat(width) + '+';
  const middle = all.map((l) => '| ' + l.padEnd(width - 2, ' ') + ' |').join('\n');
  return `${top}\n${middle}\n${top}`;
}

test('debug Suitelet — dump email/notification CompanyPreferences + recent messages', async ({ page }) => {
  const baseURL = (process.env.NS_BASE_URL || 'https://td3075893.app.netsuite.com').replace(/\/$/, '');
  const debugURL = `${baseURL}${SUITELET_PATH}`;

  console.log('\n========== Debug Suitelet probe ==========');
  console.log('URL:', debugURL);

  // ── 1. Prime the page session by hitting any authenticated NS page ───────
  // We need a live NetSuite session cookie before we can fetch the Suitelet
  // JSON in the page context. Hit the dashboard first if we are not already
  // on a NS page.
  if (!page.url().includes('netsuite.com')) {
    await page.goto(`${baseURL}/app/center/card.nl`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    }).catch(() => {});
  }

  // ── 2. Fetch the Suitelet JSON using the live page session ───────────────
  /** @type {{ status: number, ok: boolean, contentType: string, body: string, error?: string }} */
  let fetchResult;
  try {
    fetchResult = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const body = await resp.text();
        return {
          status: resp.status,
          ok: resp.ok,
          contentType: resp.headers.get('content-type') || '',
          body,
        };
      } catch (e) {
        return {
          status: 0,
          ok: false,
          contentType: '',
          body: '',
          error: String(e),
        };
      }
    }, debugURL);
  } catch (e) {
    fetchResult = { status: 0, ok: false, contentType: '', body: '', error: String(e) };
  }

  console.log('HTTP status:', fetchResult.status);
  console.log('Content-Type:', fetchResult.contentType);
  if (fetchResult.error) {
    console.log('Fetch error:', fetchResult.error);
  }

  // ── 3. Parse JSON (gracefully handle non-JSON responses) ─────────────────
  /** @type {any} */
  let payload = null;
  /** @type {string|null} */
  let parseError = null;
  try {
    payload = JSON.parse(fetchResult.body);
  } catch (e) {
    parseError = String(e);
  }

  if (parseError) {
    console.log('\nFailed to parse JSON. First 800 chars of body:');
    console.log(fetchResult.body.slice(0, 800));
    // Persist what we got so the redeploy attempt can be diagnosed
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      url: debugURL,
      status: fetchResult.status,
      contentType: fetchResult.contentType,
      parseError,
      bodyPreview: fetchResult.body.slice(0, 4000),
    }, null, 2));
    console.log('\n' + boxed('EMAIL PREFS DEBUG — NO JSON', [
      `URL:           ${debugURL}`,
      `Status:        ${fetchResult.status}`,
      `Content-Type:  ${fetchResult.contentType || '(none)'}`,
      `Parse error:   ${parseError}`,
      `Output file:   ${OUTPUT_FILE}`,
      '',
      'Suitelet may not be deployed yet — redeploy customscript_oa_sl_debug.',
    ]));
    expect(true).toBe(true);
    return;
  }

  // ── 4. Persist full JSON to disk ─────────────────────────────────────────
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2));
  console.log('Full payload written to:', OUTPUT_FILE);

  // ── 5. Log runtime info ──────────────────────────────────────────────────
  console.log('\n---------- runtime ----------');
  if (payload.runtime && typeof payload.runtime === 'object') {
    Object.entries(payload.runtime).forEach(([k, v]) => {
      console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    });
  } else {
    console.log('  (runtime missing from payload)');
  }

  // ── 6. Log every companyPrefs key/value pair ─────────────────────────────
  /** @type {Record<string, any>} */
  const prefs = (payload.companyPrefs && typeof payload.companyPrefs === 'object')
    ? payload.companyPrefs
    : {};
  const prefKeys = Object.keys(prefs).sort();

  console.log('\n---------- companyPrefs ----------');
  if (prefKeys.length === 0) {
    console.log('  (no companyPrefs returned)');
  } else {
    prefKeys.forEach((k) => {
      const v = prefs[k];
      const display = (v === null || v === undefined)
        ? '(null)'
        : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      console.log(`  ${k} = ${display}`);
    });
  }

  // ── 7. Hold-flag detection ───────────────────────────────────────────────
  // Any pref whose key contains "hold" AND whose value is a truthy boolean
  // (true, 'T', 'true', 1, '1') is treated as a hold flag that is currently
  // enabled. We log every match prominently.
  /** @param {any} v */
  function isTruthyFlag(v) {
    if (v === true) return true;
    if (typeof v === 'number' && v !== 0) return true;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      return s === 't' || s === 'true' || s === '1' || s === 'y' || s === 'yes';
    }
    return false;
  }

  const holdKeys = prefKeys.filter((k) => /hold/i.test(k));
  /** @type {string[]} */
  const heldEnabled = [];
  console.log('\n---------- HOLD flags ----------');
  if (holdKeys.length === 0) {
    console.log('  (no keys matching /hold/i found)');
  } else {
    holdKeys.forEach((k) => {
      const v = prefs[k];
      const enabled = isTruthyFlag(v);
      console.log(`  ${enabled ? '!! ENABLED !!' : 'ok          '}  ${k} = ${v}`);
      if (enabled) heldEnabled.push(`${k}=${v}`);
    });
  }
  const holdNotificationsValue = prefs.holdnotifications;
  console.log(`  Explicit holdnotifications value: ${holdNotificationsValue === undefined ? '(not present)' : holdNotificationsValue}`);

  // ── 8. Send-all-email / override / test-mode flag logging ────────────────
  console.log('\n---------- Redirect / Override / Test-mode flags ----------');
  const REDIRECT_PATTERN = /^(sendallemail|emailoverride|testmode|notif_sendallemail)/i;
  const redirectKeys = prefKeys.filter((k) => REDIRECT_PATTERN.test(k));
  if (redirectKeys.length === 0) {
    console.log('  (no sendallemail* / emailoverride / testmode* / notif_sendallemails keys found)');
  } else {
    redirectKeys.forEach((k) => {
      const v = prefs[k];
      const display = (v === null || v === undefined || v === '')
        ? '(empty)'
        : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      console.log(`  ${k} = ${display}`);
    });
  }
  // Also call out the four canonical keys explicitly even when absent so
  // their presence/absence is unambiguous in the log.
  const CANONICAL = ['sendallemailsto', 'sendallemails', 'emailoverride', 'testmodeemailaddress', 'testmode', 'notif_sendallemails'];
  CANONICAL.forEach((k) => {
    const present = Object.prototype.hasOwnProperty.call(prefs, k);
    console.log(`  [canonical] ${k}: ${present ? JSON.stringify(prefs[k]) : '(not in payload)'}`);
  });

  // ── 9. Recent messages summary ───────────────────────────────────────────
  console.log('\n---------- recentMessages ----------');
  const recent = Array.isArray(payload.recentMessages) ? payload.recentMessages : [];
  console.log(`  count: ${recent.length}`);
  recent.slice(0, 25).forEach((m, i) => {
    const subj  = m && (m.subject || m.title) || '(no subject)';
    const from  = m && (m.author  || m.from || m.sender) || '(no sender)';
    const to    = m && (m.recipient || m.to) || '(no recipient)';
    const dt    = m && (m.date || m.datecreated || m.messagedate) || '(no date)';
    const stat  = m && (m.status || m.emailstatus || m.sentstatus) || '';
    console.log(`  [${String(i + 1).padStart(2, '0')}] ${dt} | ${from} -> ${to} | ${subj}${stat ? ' | ' + stat : ''}`);
  });
  if (recent.length > 25) {
    console.log(`  … and ${recent.length - 25} more (see ${OUTPUT_FILE})`);
  }

  // ── 10. Boxed final summary ──────────────────────────────────────────────
  const summaryLines = [
    `URL:                  ${debugURL}`,
    `HTTP status:          ${fetchResult.status}  ok=${payload.ok === undefined ? '(missing)' : payload.ok}`,
    `companyPrefs keys:    ${prefKeys.length}`,
    `hold-matching keys:   ${holdKeys.length}  (enabled: ${heldEnabled.length})`,
    `holdnotifications:    ${holdNotificationsValue === undefined ? '(not present)' : holdNotificationsValue}`,
    `redirect/override:    ${redirectKeys.length} key(s) matched`,
    `recentMessages:       ${recent.length}`,
    `JSON written to:      ${OUTPUT_FILE}`,
  ];
  if (heldEnabled.length > 0) {
    summaryLines.push('');
    summaryLines.push('!! HOLD-LIKE FLAGS ARE ENABLED:');
    heldEnabled.forEach((s) => summaryLines.push('   - ' + s));
  }
  console.log('\n' + boxed('EMAIL PREFS DEBUG — SUMMARY', summaryLines));

  // Reporting spec — always passes as long as we got here.
  expect(true).toBe(true);
});
