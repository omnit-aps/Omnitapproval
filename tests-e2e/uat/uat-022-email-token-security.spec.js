// @ts-check
/**
 * UAT-022 — Negative tests on the email-link HMAC token.
 *
 * Reuses the link-extraction strategy from _email-link-flow.spec.js. For each
 * valid approve link found, performs three tampering attacks and asserts the
 * email_action Suitelet rejects every one AND the VB does NOT transition.
 *
 *   (a) Signature tamper:    flip the last char of `oa_token`.
 *   (b) Expiry tamper:       decode the token body, set exp = 0 (epoch), re-encode
 *                            WITHOUT re-signing → MAC mismatch → reject.
 *   (c) Record-id tamper:    decode body, swap rid for a different transaction id,
 *                            re-encode without re-signing → MAC mismatch → reject.
 *
 * Token format: base64url(payloadJSON) + "." + sha256Hex(SECRET|base64url(payloadJSON)).
 * See OmnitApprovals/src/FileCabinet/SuiteScripts/OmnitApprovals/lib/oa_utils.js.
 *
 * Pass criteria for each variant:
 *   - Landing page text contains /invalid|tampered|expired/i (or NS shows a
 *     generic error banner).
 *   - The targeted VB's approvalstatus does NOT change from '1' (Pending).
 *
 * Run:
 *   npx playwright test tests-e2e/uat/uat-022-email-token-security.spec.js --project=chromium --reporter=list
 */
const { test, expect } = require('@playwright/test');

const JONAS_EMAIL = 'jonasbm@gmail.com';

// ── b64url helpers (browser-side base64 + URL-safe variant) ───────────────────
/** @param {string} s */
function b64urlEncode(s) {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** @param {string} s */
function b64urlDecode(s) {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/**
 * @param {string} link
 */
function extractToken(link) {
  const u = new URL(link);
  const tok = u.searchParams.get('oa_token');
  if (!tok) throw new Error(`No oa_token in link: ${link.slice(0, 80)}…`);
  return tok;
}

/**
 * Replace oa_token in the link with a new value, keeping all other params.
 * @param {string} link
 * @param {string} newToken
 */
function withToken(link, newToken) {
  const u = new URL(link);
  u.searchParams.set('oa_token', newToken);
  return u.toString();
}

test.describe('UAT-022 email link HMAC tamper resistance', () => {
  test('Tampered token variants are rejected; VB stays pending', async ({ page }) => {
    test.setTimeout(180_000);

    const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
    await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load', timeout: 30_000 });

    // ── Step 1: find a recent approval message addressed to Jonas ────────────
    const recent = await page.evaluate(async ([base, email]) => {
      const r = await fetch(`${base}/services/rest/query/v1/suiteql`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
        body: JSON.stringify({ q:
          `SELECT id, transaction FROM message
           WHERE messageDate >= SYSDATE - 2
             AND incoming = 'F'
             AND UPPER(subject) LIKE '%APPROV%'
             AND LOWER(recipientEmail) = LOWER('${email}')
           ORDER BY messageDate DESC FETCH FIRST 10 ROWS ONLY` }),
      });
      return { status: r.status, body: await r.text() };
    }, [baseURL, JONAS_EMAIL]);
    test.skip(
      recent.status !== 200,
      `[UAT-022] SuiteQL message lookup failed (HTTP ${recent.status}). Cannot proceed.`,
    );
    const items = (() => { try { return JSON.parse(recent.body).items || []; } catch (_) { return []; } })();
    test.skip(
      items.length === 0,
      `[UAT-022] No approval emails found for ${JONAS_EMAIL} in last 48h. ` +
      'Run UAT-020 or UAT-021 first to seed an approval email.',
    );

    const ids = items.map(i => Number(i.id)).filter(Boolean);
    console.log(`[UAT-022] Examining recent message ids: ${ids.join(',')}`);

    // ── Step 2: pull bodies via debug Suitelet ───────────────────────────────
    const dbgUrl =
      `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug` +
      `&deploy=customdeploy_oa_sl_debug&msgids=${ids.join(',')}`;
    const dbgResp = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return { status: r.status, body: await r.text() };
    }, dbgUrl);
    expect(dbgResp.status).toBe(200);
    const dbg = JSON.parse(dbgResp.body);
    const target = (dbg.messageBodies || []).find(m =>
      Array.isArray(m.approveLinks) && m.approveLinks.length > 0);
    test.skip(!target, '[UAT-022] No approve link found in any recent approval email.');

    const approveLink = target.approveLinks[0];
    const txnIdFromMsg = String(target.transaction || '').trim();
    console.log(`[UAT-022] Source msg id=${target.id}, txn=${txnIdFromMsg || '(none)'}`);
    console.log(`[UAT-022] Approve link: ${approveLink.slice(0, 110)}…`);

    // The HMAC body has the canonical record id even if message.transaction is blank.
    const validToken = extractToken(approveLink);
    /** @type {{ rt: string, rid: string, s: number, aid: string, exp: number }} */
    const bodyJson = (() => {
      const dot = validToken.lastIndexOf('.');
      return JSON.parse(b64urlDecode(validToken.slice(0, dot)));
    })();
    const targetRid = String(bodyJson.rid);
    console.log(`[UAT-022] Token payload: rt=${bodyJson.rt} rid=${targetRid} step=${bodyJson.s} aid=${bodyJson.aid} exp=${new Date(bodyJson.exp).toISOString()}`);

    // Capture starting approvalstatus so we can re-check after each tamper.
    /** @returns {Promise<string|null>} */
    const readApprovalStatus = async () => {
      const r = await page.evaluate(async ([base, id]) => {
        const resp = await fetch(`${base}/services/rest/query/v1/suiteql`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
          body: JSON.stringify({ q: `SELECT approvalstatus FROM transaction WHERE id = ${id}` }),
        });
        return { status: resp.status, body: await resp.text() };
      }, [baseURL, targetRid]);
      if (r.status !== 200) return null;
      try {
        const j = JSON.parse(r.body);
        return (j.items && j.items[0] && j.items[0].approvalstatus) || null;
      } catch (_) { return null; }
    };

    const startStatus = await readApprovalStatus();
    console.log(`[UAT-022] VB ${targetRid} starting approvalstatus = '${startStatus}'`);
    test.skip(
      startStatus !== '1',
      `[UAT-022] VB ${targetRid} is not pending (status='${startStatus}') — cannot validate tamper paths. ` +
      'Need a pending VB with a fresh approve token. Re-run UAT-020 to seed one and retry.',
    );

    /**
     * Hit a tampered link and assert it is rejected.
     * @param {string} label
     * @param {string} tamperedToken
     */
    const assertRejected = async (label, tamperedToken) => {
      const link = withToken(approveLink, tamperedToken)
        .replace('https://td3075893.extforms.netsuite.com/', 'https://td3075893.app.netsuite.com/');
      console.log(`\n[UAT-022] [${label}] Hitting tampered link: ${link.slice(0, 130)}…`);
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1200);
      const txt = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      const title = await page.evaluate(() => document.title);
      console.log(`[UAT-022] [${label}] Landing title="${title}", body preview:\n  ${txt.split('\n').slice(0, 12).join('\n  ')}`);

      // Reject text — Suitelet returns "expired or is invalid" per oa_sl_email_action.js.
      expect(
        txt,
        `[${label}] Landing page should signal invalid/tampered/expired token but got: ${txt.slice(0, 200)}`,
      ).toMatch(/invalid|tampered|expired/i);

      // Belt-and-braces: VB must not have transitioned.
      const after = await readApprovalStatus();
      expect(
        after,
        `[${label}] VB ${targetRid} approvalstatus must remain '1' (Pending) after tamper, got '${after}'`,
      ).toBe('1');
      console.log(`[UAT-022] [${label}] PASS — link rejected, VB still pending.`);
    };

    // ── (a) Signature tamper: flip last char of token (after the dot) ────────
    const sigTampered = (() => {
      const lastChar = validToken.slice(-1);
      // Swap last char to something different (hex sig — flip 'a'<->'b' or 0<->1)
      const next = lastChar === 'a' ? 'b' : (lastChar === '0' ? '1' : 'a');
      return validToken.slice(0, -1) + next;
    })();
    expect(sigTampered).not.toBe(validToken);
    await assertRejected('signature-tamper', sigTampered);

    // ── (b) Expiry tamper: set exp into the past, re-encode body, keep old sig ─
    const expiredBody = { ...bodyJson, exp: 1 }; // 1970-01-01
    const expiredToken = (() => {
      const newBodyB64 = b64urlEncode(JSON.stringify(expiredBody));
      const oldSig = validToken.slice(validToken.lastIndexOf('.') + 1);
      return newBodyB64 + '.' + oldSig;
    })();
    await assertRejected('expiry-tamper', expiredToken);

    // ── (c) Record-id tamper: swap rid to a different VB id, keep old sig ────
    // Pick a known different id by incrementing — the engine rejects on signature
    // mismatch first, so the chosen id doesn't even need to exist.
    const otherRid = String(Number(targetRid) + 1);
    const ridTamperedBody = { ...bodyJson, rid: otherRid };
    const ridTamperedToken = (() => {
      const newBodyB64 = b64urlEncode(JSON.stringify(ridTamperedBody));
      const oldSig = validToken.slice(validToken.lastIndexOf('.') + 1);
      return newBodyB64 + '.' + oldSig;
    })();
    await assertRejected('rid-tamper', ridTamperedToken);

    console.log(`\n[UAT-022] All three tamper variants rejected. VB ${targetRid} still pending.`);
  });
});
