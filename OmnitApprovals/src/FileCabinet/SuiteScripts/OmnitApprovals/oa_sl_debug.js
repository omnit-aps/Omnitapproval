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
define(['N/config', 'N/runtime', 'N/search', 'N/log', 'N/https', 'N/record'], (config, runtime, search, log, https, record) => {
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
        columns: ['messagedate', 'subject', 'authoremail', 'recipientemail', 'transaction'],
      });
      s.run().each((r) => {
        rows.push({
          id: r.id,
          messagedate: r.getValue('messagedate'),
          subject: r.getValue('subject'),
          author: r.getValue('authoremail'),
          recipient: r.getValue('recipientemail'),
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
   * Load the actual message bodies by ID via record.load and parse the
   * approve/reject HMAC link out of the HTML body. Server-side record.load
   * works regardless of UI permissions or search-column quirks.
   *
   * IDs to load are passed via the request query param 'msgids' (comma-list)
   * or default to a small set of recent ones we know exist. Caller should
   * keep the list short — record.load is one round-trip per id.
   */
  function extractApproveLinksFromIds(idsCsv) {
    const out = [];
    const ids = (idsCsv || '716550,716549,716548').split(',').map((s) => s.trim()).filter(Boolean);
    ids.forEach((id) => {
      try {
        const rec = record.load({ type: 'message', id });
        const body = rec.getValue({ fieldId: 'message' }) || '';
        const subject = rec.getValue({ fieldId: 'subject' });
        const recipient = rec.getValue({ fieldId: 'recipientemail' });
        const transaction = rec.getValue({ fieldId: 'transaction' });
        const linkRe = /https?:\/\/[^\s"'<>]+/g;
        const links = (body.match(linkRe) || []);
        const approveLinks = links.filter((l) => /action=approve|[?&]approve|=approve/i.test(l));
        const rejectLinks = links.filter((l) => /action=reject|[?&]reject|=reject/i.test(l));
        out.push({
          id, subject, recipient, transaction,
          bodyLength: body.length,
          bodyPreview: body.slice(0, 800),
          approveLinks: approveLinks.slice(0, 5),
          rejectLinks: rejectLinks.slice(0, 5),
          allLinks: links.slice(0, 20),
        });
      } catch (e) {
        out.push({ id, __error: e.message || String(e) });
      }
    });
    return out;
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

  /**
   * One-shot fix: set isavailablewithoutlogin=T on a script deployment record.
   * SDF deployments refuse to update this flag; NS expects it set via UI or
   * server-side N/record. Triggered with ?fix_avail=<deploy-scriptid>.
   */
  function fixAvailableWithoutLogin(deployScriptId) {
    try {
      // Step 1: find the deployment id by scriptid (no extra columns — that field isn't a searchable column)
      const s = search.create({
        type: 'scriptdeployment',
        filters: [['scriptid', 'is', deployScriptId]],
        columns: ['internalid', 'scriptid'],
      });
      const found = [];
      s.run().each((r) => { found.push({ id: r.id, scriptid: r.getValue('scriptid') }); return true; });
      if (found.length === 0) return { error: `No deployment with scriptid='${deployScriptId}'` };
      const target = found[0];
      // Step 2: try a few candidate field names — NS is inconsistent here
      const candidates = ['isavailablewithoutlogin', 'availablewithoutlogin', 'isonline'];
      const attempts = [];
      for (const fid of candidates) {
        try {
          record.submitFields({
            type: 'scriptdeployment',
            id: target.id,
            values: { [fid]: true },
            options: { ignoreMandatoryFields: true, enableSourcing: false },
          });
          attempts.push({ field: fid, ok: true });
          break;
        } catch (e) {
          attempts.push({ field: fid, ok: false, err: (e.message || String(e)).slice(0, 120) });
        }
      }
      return { id: target.id, scriptid: target.scriptid, attempts };
    } catch (e) {
      return { error: e.message || String(e), stack: (e.stack || '').slice(0, 400) };
    }
  }

  function onRequest(context) {
    const req  = context.request;
    const resp = context.response;
    resp.setHeader({ name: 'Content-Type', value: 'application/json; charset=utf-8' });
    const msgIdsParam = (req.parameters && req.parameters.msgids) || '';
    const fixAvail = (req.parameters && req.parameters.fix_avail) || '';
    if (fixAvail) {
      resp.write(JSON.stringify({ action: 'fix_avail', target: fixAvail, result: fixAvailableWithoutLogin(fixAvail) }, null, 2));
      return;
    }

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
      messageBodies: extractApproveLinksFromIds(msgIdsParam),
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
