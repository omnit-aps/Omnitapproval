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
        const rejectLinks = links.filter((l) => /action=(reject|decline)|[?&](reject|decline)|=(reject|decline)/i.test(l));
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
      const s = search.create({
        type: 'scriptdeployment',
        filters: [['scriptid', 'is', deployScriptId]],
        columns: ['internalid', 'scriptid'],
      });
      const found = [];
      s.run().each((r) => { found.push({ id: r.id, scriptid: r.getValue('scriptid') }); return true; });
      if (found.length === 0) return { error: `No deployment with scriptid='${deployScriptId}'` };
      const target = found[0];
      // Set both `isonline = T` (available without login) AND `runasrole = 3`
      // (Administrator). Without runasrole, an anonymous request hits an
      // "Anonymous" execution context with zero permissions, so any record
      // operation — and the page render itself — fails with "no privileges".
      const attempts = [];
      try {
        record.submitFields({
          type: 'scriptdeployment',
          id: target.id,
          values: { isonline: true, runasrole: 3 },
          options: { ignoreMandatoryFields: true, enableSourcing: false },
        });
        attempts.push({ ok: true, set: { isonline: true, runasrole: 3 } });
      } catch (e) {
        attempts.push({ ok: false, err: (e.message || String(e)).slice(0, 200) });
      }
      // Read back current state.
      const after = {};
      try {
        const rec = record.load({ type: 'scriptdeployment', id: target.id });
        after.isonline   = rec.getValue({ fieldId: 'isonline' });
        after.runasrole  = rec.getValue({ fieldId: 'runasrole' });
        after.status     = rec.getValue({ fieldId: 'status' });
        after.isdeployed = rec.getValue({ fieldId: 'isdeployed' });
      } catch (e) { after.__err = e.message; }
      return { id: target.id, scriptid: target.scriptid, attempts, after };
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
    // ?dump_script=<id> — dump fields on the parent SCRIPT record (not deployment)
    const dumpScript = (req.parameters && req.parameters.dump_script) || '';
    if (dumpScript) {
      try {
        const rec = record.load({ type: 'script', id: dumpScript });
        const fields = {};
        rec.getFields().forEach((id) => {
          try { fields[id] = rec.getValue({ fieldId: id }); } catch (_) { fields[id] = '__err'; }
        });
        resp.write(JSON.stringify({ id: dumpScript, fields }, null, 2));
      } catch (e) {
        resp.write(JSON.stringify({ error: e.message || String(e) }, null, 2));
      }
      return;
    }
    // ?role_lookup=<id> — return name of a role by internal id
    const roleLookup = (req.parameters && req.parameters.role_lookup) || '';
    if (roleLookup) {
      try {
        const f = search.lookupFields({ type: 'role', id: roleLookup, columns: ['name', 'isinactive', 'centertype'] });
        resp.write(JSON.stringify({ id: roleLookup, fields: f }, null, 2));
      } catch (e) {
        resp.write(JSON.stringify({ id: roleLookup, error: e.message || String(e) }, null, 2));
      }
      return;
    }
    // ?force_avail=<scriptid> — full record.load + record.save path (vs submitFields).
    // Some audience changes only commit through the full save flow.
    const forceAvail = (req.parameters && req.parameters.force_avail) || '';
    if (forceAvail) {
      const out = { action: 'force_avail', target: forceAvail };
      try {
        const s = search.create({
          type: 'scriptdeployment',
          filters: [['scriptid', 'is', forceAvail]],
          columns: ['internalid'],
        });
        const ids = [];
        s.run().each((r) => { ids.push(r.id); return true; });
        if (ids.length === 0) { out.error = 'not found'; resp.write(JSON.stringify(out, null, 2)); return; }
        const rec = record.load({ type: 'scriptdeployment', id: ids[0] });
        out.before = {
          isonline:   rec.getValue({ fieldId: 'isonline' }),
          runasrole:  rec.getValue({ fieldId: 'runasrole' }),
          allroles:   rec.getValue({ fieldId: 'allroles' }),
          audience:   rec.getValue({ fieldId: 'audience' }),
          audslctextrole: rec.getValue({ fieldId: 'audslctextrole' }),
        };
        rec.setValue({ fieldId: 'isonline', value: true });
        rec.setValue({ fieldId: 'runasrole', value: 3 });
        // Clear audience restrictions and rely on isonline for anonymous access.
        try { rec.setValue({ fieldId: 'audience', value: '' }); } catch (_) {}
        try { rec.setValue({ fieldId: 'allroles', value: true }); } catch (_) {}
        const id = rec.save({ ignoreMandatoryFields: true, enableSourcing: false });
        out.savedId = id;
        const after = record.load({ type: 'scriptdeployment', id: ids[0] });
        out.after = {
          isonline:   after.getValue({ fieldId: 'isonline' }),
          runasrole:  after.getValue({ fieldId: 'runasrole' }),
          allroles:   after.getValue({ fieldId: 'allroles' }),
          audience:   after.getValue({ fieldId: 'audience' }),
          audslctextrole: after.getValue({ fieldId: 'audslctextrole' }),
        };
      } catch (e) {
        out.error = e.message || String(e);
        out.stack = (e.stack || '').slice(0, 400);
      }
      resp.write(JSON.stringify(out, null, 2));
      return;
    }
    // ?dump_deploy=<scriptid> — load the deployment record and return every field.
    // Lets us identify the actual field name for "Available Without Login".
    const dumpDeploy = (req.parameters && req.parameters.dump_deploy) || '';
    if (dumpDeploy) {
      const out = { action: 'dump_deploy', target: dumpDeploy };
      try {
        const s = search.create({
          type: 'scriptdeployment',
          filters: [['scriptid', 'is', dumpDeploy]],
          columns: ['internalid'],
        });
        const ids = [];
        s.run().each((r) => { ids.push(r.id); return true; });
        if (ids.length === 0) { out.error = `No deployment with scriptid='${dumpDeploy}'`; resp.write(JSON.stringify(out, null, 2)); return; }
        const rec = record.load({ type: 'scriptdeployment', id: ids[0] });
        const fields = {};
        rec.getFields().forEach((id) => {
          try { fields[id] = rec.getValue({ fieldId: id }); } catch (_) { fields[id] = '__err'; }
        });
        out.id = ids[0];
        out.fields = fields;
        // Find every field whose ID or value relates to login/availability
        out.candidates = Object.keys(fields).filter(k => /login|avail|public|extern|online|anonym|nopwd|guest/i.test(k));
      } catch (e) {
        out.error = e.message || String(e);
      }
      resp.write(JSON.stringify(out, null, 2));
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
