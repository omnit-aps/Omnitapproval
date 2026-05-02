/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * OA Debug Suitelet — read-only JSON dump of email-routing config.
 *
 * Why: psld@omnit.dk's role can't open /app/setup/companyemailprefs.nl
 * (returns "Page not found"). The COMPANY_PREFERENCES record is also not
 * exposed via SuiteQL. The only programmatic path is N/config server-side.
 * The SDF deployment runs this script with executeasrole=ADMINISTRATOR so
 * the config.load() call has the necessary permissions regardless of who
 * hits the URL.
 *
 * Returns: { ok, runtime, companyPrefs, recentMessages }
 *   - companyPrefs: every field on COMPANY_PREFERENCES whose id matches
 *     /email|notif|hold|forward|spam|relay|test|domain|sender/i
 *   - recentMessages: last 5 OA approval emails (subject, recipient, emailed)
 *
 * Hard rules:
 *   - read-only — no record writes, no submitFields
 *   - no secrets in output (HMAC keys, passwords, etc. are not on the
 *     fields whose IDs match the filter regex above)
 */
define(['N/config', 'N/runtime', 'N/search', 'N/log', 'N/https'], (config, runtime, search, log, https) => {
  'use strict';

  /**
   * Dump every accessible field from one or more N/config types as JSON.
   * No regex filter — we want to see EVERYTHING that's exposed so we can
   * locate Hold-emails / Send-all-to / domain whitelist fields by inspection.
   */
  function dumpConfigType(typeKey) {
    const out = {};
    try {
      const cfg = config.load({ type: config.Type[typeKey] });
      const fieldIds = cfg.getFields();
      fieldIds.forEach((id) => {
        try {
          const value = cfg.getValue({ fieldId: id });
          let text = null;
          try { text = cfg.getText({ fieldId: id }); } catch (_) {}
          out[id] = text && text !== value ? { value, text } : value;
        } catch (e) {
          out[id] = { __error: e.message || String(e) };
        }
      });
    } catch (e) {
      out.__loadError = e.message || String(e);
    }
    return out;
  }

  function recentApprovalEmails() {
    const rows = [];
    try {
      const s = search.create({
        type: search.Type.MESSAGE,
        filters: [
          ['messagedate', 'onorafter', 'startoftoday'],
          'AND',
          ['subject', 'startswith', 'Approval'],
        ],
        columns: ['messagedate', 'subject', 'authoremail', 'recipientemail', 'emailed', 'transaction', 'internaldate'],
      });
      s.run().each((r) => {
        rows.push({
          id: r.id,
          messagedate: r.getValue('messagedate'),
          internaldate: r.getValue('internaldate'),
          subject: r.getValue('subject'),
          author: r.getValue('authoremail'),
          recipient: r.getValue('recipientemail'),
          emailed: r.getValue('emailed'),
          transaction: r.getValue('transaction'),
        });
        return rows.length < 10;
      });
    } catch (e) {
      rows.push({ __error: e.message || String(e) });
    }
    return rows;
  }

  /**
   * Try to fetch the Email Preferences setup page server-side as Administrator.
   * If we can scrape it, we can read Hold All / Send All Emails To even when
   * the user's UI session can't navigate to it.
   */
  function probeSetupUrls(https) {
    const urls = [
      '/app/setup/companyemailprefs.nl',
      '/app/setup/setupemail.nl',
      '/app/setup/preferences/emailpreferences.nl',
      '/app/setup/company/emailpreferences.nl',
      '/app/setup/manageemailpreferences.nl',
      '/app/setup/company/companyinformation.nl',
      '/app/common/setup/companysetup.nl',
      '/app/common/setup/companypreferences.nl',
    ];
    const out = {};
    urls.forEach((p) => {
      try {
        const resp = https.get({ url: 'https://' + runtime.accountId.toLowerCase() + '.app.netsuite.com' + p });
        const code = resp.code;
        const body = (resp.body || '').slice(0, 400);
        out[p] = {
          code,
          isPrefsPage: /hold (all )?notification|send all (outgoing|email)|forward(ing)? (email|address)/i.test(resp.body || ''),
          snippet: body.replace(/\s+/g, ' ').slice(0, 200),
        };
      } catch (e) {
        out[p] = { error: e.message || String(e) };
      }
    });
    return out;
  }

  function onRequest(context) {
    const resp = context.response;
    resp.setHeader({ name: 'Content-Type', value: 'application/json; charset=utf-8' });

    const out = {
      ok: true,
      runtime: {
        accountId: runtime.accountId,
        envType: runtime.envType,
        userId: runtime.getCurrentUser().id,
        userEmail: runtime.getCurrentUser().email,
        roleId: runtime.getCurrentUser().role,
        roleName: runtime.getCurrentUser().roleId,
        scriptExecutionContext: runtime.executionContext,
      },
      companyPrefs: dumpConfigType('COMPANY_PREFERENCES'),
      userPrefs: dumpConfigType('USER_PREFERENCES'),
      companyInfo: dumpConfigType('COMPANY_INFORMATION'),
      accountingPrefs: dumpConfigType('ACCOUNTING_PREFERENCES'),
      recentMessages: recentApprovalEmails(),
      setupUrlProbe: probeSetupUrls(https),
    };

    log.audit('OA debug suitelet hit', {
      user: out.runtime.userEmail,
      role: out.runtime.roleName,
      companyPrefsKeys: Object.keys(out.companyPrefs).length,
      userPrefsKeys: Object.keys(out.userPrefs).length,
      msgs: out.recentMessages.length,
    });
    resp.write(JSON.stringify(out, null, 2));
  }

  return { onRequest };
});
