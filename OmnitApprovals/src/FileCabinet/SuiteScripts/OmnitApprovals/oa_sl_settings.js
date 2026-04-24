/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define([
  'N/record',
  'N/search',
  'N/url',
  'N/file',
  './lib/oa_constants',
  './oa_engine'
], (record, search, url, nsFile, C, engine) => {
  'use strict';

  function onRequest(context) {
    const req  = context.request;
    const resp = context.response;
    resp.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });

    if (req.method === 'POST') {
      handlePost(req, resp);
      return;
    }

    const view       = req.parameters.oa_view || 'list';
    const settingsId = req.parameters.oa_settings_id;
    const selfUrl    = url.resolveScript({ scriptId: 'customscript_oa_sl_settings', deploymentId: 'customdeploy_oa_sl_settings', returnExternalUrl: false });

    let jsUrl = '';
    try {
      jsUrl = nsFile.load({ id: 'SuiteScripts/OmnitApprovals/oa_sl_settings_client.js' }).url;
    } catch (e) { /* file not deployed yet — graceful degradation */ }

    if (view === 'edit' && settingsId) {
      resp.write(renderEditPage(settingsId, selfUrl, jsUrl));
    } else {
      resp.write(renderListPage(selfUrl));
    }
  }

  // ─── POST ────────────────────────────────────────────────────────────────────

  function handlePost(req, resp) {
    const p       = req.parameters;
    const selfUrl = url.resolveScript({ scriptId: 'customscript_oa_sl_settings', deploymentId: 'customdeploy_oa_sl_settings', returnExternalUrl: false });

    // Save settings
    const settingsId = p.oa_settings_id;
    try {
      // Validate: default approver required when any approval type is enabled
      if ((p.oa_enable_po === 'T' || p.oa_enable_vb === 'T') && !parseInt(p.oa_default_approver1, 10)) {
        resp.write(renderError('A Default Approver 1 is required when approval is enabled for any transaction type.', selfUrl));
        return;
      }

      // Validate: only one active settings record per subsidiary
      const subsidiaryId = parseInt(p.oa_subsidiary, 10);
      if (subsidiaryId) {
        let dupFound = false;
        search.create({
          type:    C.RECORDS.SETTINGS,
          filters: [
            [C.FIELDS.SETTINGS.SUBSIDIARY, 'anyof', subsidiaryId],
            'AND',
            ['isinactive', 'is', 'F']
          ],
          columns: ['internalid']
        }).run().each(r => {
          if (String(r.id) !== String(settingsId)) { dupFound = true; }
          return !dupFound;
        });
        if (dupFound) {
          resp.write(renderError('A configuration already exists for this subsidiary. Each subsidiary can only have one configuration.', selfUrl));
          return;
        }
      }

      let rec;
      if (settingsId && settingsId !== 'new') {
        rec = record.load({ type: C.RECORDS.SETTINGS, id: settingsId, isDynamic: false });
      } else {
        rec = record.create({ type: C.RECORDS.SETTINGS, isDynamic: false });
      }

      rec.setValue({ fieldId: 'name',                               value: 'OA Settings - ' + (p.oa_subsidiary_name || p.oa_subsidiary) });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.SUBSIDIARY,        value: parseInt(p.oa_subsidiary, 10) || '' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.ENABLE_PO,         value: p.oa_enable_po === 'T' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.ENABLE_VB,         value: p.oa_enable_vb === 'T' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.APPROVER_COUNT,    value: parseInt(p.oa_approver_count, 10) || 1 });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.USE_AMOUNT,        value: p.oa_use_amount === 'T' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.DEFAULT_APPROVER1, value: parseInt(p.oa_default_approver1, 10) || '' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.DEFAULT_APPROVER2, value: parseInt(p.oa_default_approver2, 10) || '' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.APPROVE_STRING,    value: p.oa_approve_string || 'Approve' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.REJECT_STRING,     value: p.oa_reject_string  || 'Reject' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.EMAIL_ENABLED,     value: p.oa_email_enabled === 'T' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.TOKEN_EXPIRY_DAYS, value: parseInt(p.oa_token_expiry_days, 10) || 7 });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.EMAIL_SENDER,      value: parseInt(p.oa_email_sender, 10) || '' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.EMAIL_SUBJECT,          value: p.oa_email_subject || '' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.EMAIL_INTRO,            value: p.oa_email_intro   || '' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.APPROVE_WITHOUT_LOGIN,  value: p.oa_approve_without_login === 'T' });
      const savedId = rec.save();

      saveMatrixRows(savedId, p);

      // Deactivate any duplicate active settings for the same subsidiary (keep only savedId)
      if (subsidiaryId) {
        search.create({
          type:    C.RECORDS.SETTINGS,
          filters: [
            [C.FIELDS.SETTINGS.SUBSIDIARY, 'anyof', subsidiaryId],
            'AND',
            ['isinactive', 'is', 'F']
          ],
          columns: ['internalid']
        }).run().each(r => {
          if (String(r.id) !== String(savedId)) {
            try {
              record.submitFields({ type: C.RECORDS.SETTINGS, id: r.id, values: { isinactive: true }, ignoreMandatoryFields: true });
            } catch (de) { log.error('OA: dedup deactivate failed', `id=${r.id}: ${de.message}`); }
          }
          return true;
        });
      }

      resp.write(`<script>window.location='${selfUrl}&oa_view=edit&oa_settings_id=${savedId}&oa_saved=1'</script>`);
    } catch (e) {
      resp.write(renderError(e.message, selfUrl));
    }
  }

  // ─── List View ────────────────────────────────────────────────────────────────

  function renderListPage(selfUrl) {
    const rows = [];
    search.create({
      type:    C.RECORDS.SETTINGS,
      columns: Object.values(C.FIELDS.SETTINGS).concat(['internalid'])
    }).run().each(r => {
      rows.push({
        id:         r.id,
        subsidiary: r.getText(C.FIELDS.SETTINGS.SUBSIDIARY) || '—',
        approver1:  r.getText(C.FIELDS.SETTINGS.DEFAULT_APPROVER1) || '—',
        emailOn:    r.getValue(C.FIELDS.SETTINGS.EMAIL_ENABLED) ? 'Yes' : 'No',
        enablePO:   r.getValue(C.FIELDS.SETTINGS.ENABLE_PO) ? 'Yes' : 'No',
        enableVB:   r.getValue(C.FIELDS.SETTINGS.ENABLE_VB) ? 'Yes' : 'No'
      });
      return true;
    });

    const tableRows = rows.map(r => `
      <tr>
        <td>${r.subsidiary}</td>
        <td>${r.approver1}</td>
        <td><span class="badge ${r.emailOn === 'Yes' ? 'badge-green' : 'badge-grey'}">${r.emailOn}</span></td>
        <td><span class="badge ${r.enablePO === 'Yes' ? 'badge-green' : 'badge-grey'}">${r.enablePO}</span></td>
        <td><span class="badge ${r.enableVB === 'Yes' ? 'badge-green' : 'badge-grey'}">${r.enableVB}</span></td>
        <td><a href="${selfUrl}&oa_view=edit&oa_settings_id=${r.id}" class="link">Edit</a></td>
      </tr>`).join('');

    return _shell('Omnit Approvals — Configuration', `
      <div class="page-header">
        <div>
          <h1>Configuration</h1>
          <p class="subtitle">Manage approval settings per subsidiary</p>
        </div>
        <a href="${selfUrl}&oa_view=edit&oa_settings_id=new" class="btn-primary">+ New configuration</a>
      </div>
      <div class="card">
        <table class="data-table">
          <thead><tr>
            <th>Subsidiary</th><th>Default approver</th><th>Email</th><th>PO</th><th>VB</th><th></th>
          </tr></thead>
          <tbody>${tableRows || '<tr><td colspan="6" class="empty">No configurations yet.</td></tr>'}</tbody>
        </table>
      </div>`, selfUrl);
  }

  // ─── Edit View ────────────────────────────────────────────────────────────────

  function renderEditPage(settingsId, selfUrl, jsUrl) {
    let s = {};
    let poRows = [];
    let vbRows = [];

    if (settingsId !== 'new') {
      try {
        const rec = record.load({ type: C.RECORDS.SETTINGS, id: settingsId, isDynamic: false });
        Object.entries(C.FIELDS.SETTINGS).forEach(([k, fid]) => { s[k.toLowerCase()] = rec.getValue(fid); });
        s.subsidiary_text = rec.getText(C.FIELDS.SETTINGS.SUBSIDIARY);

        const loadRowsForType = (recordType) => {
          const rows = [];
          search.create({
            type:    C.RECORDS.HIERARCHY,
            filters: [
              [C.FIELDS.HIERARCHY.SETTINGS,    'equalto', settingsId],
              'AND',
              [C.FIELDS.HIERARCHY.RECORD_TYPE, 'is',    recordType]
            ],
            columns: ['internalid']
          }).run().each(hr => {
            const tIds = [];
            search.create({
              type:    C.RECORDS.THRESHOLD,
              filters: [[C.FIELDS.THRESHOLD.HIERARCHY, 'equalto', hr.id]],
              columns: ['internalid', C.FIELDS.THRESHOLD.SORT_ORDER]
            }).run().each(t => {
              tIds.push({ id: parseInt(t.id, 10), sortOrder: parseInt(t.getValue(C.FIELDS.THRESHOLD.SORT_ORDER), 10) || 0 });
              return true;
            });
            tIds.sort((a, b) => a.sortOrder - b.sortOrder);
            tIds.forEach(({ id }) => {
              try {
                const t = record.load({ type: C.RECORDS.THRESHOLD, id, isDynamic: false });
                rows.push({
                  id:        String(id),
                  minAmount: String(t.getValue(C.FIELDS.THRESHOLD.MIN_AMOUNT) || 0),
                  approver1: String(t.getValue(C.FIELDS.THRESHOLD.APPROVER)  || ''),
                  approver2: String(t.getValue(C.FIELDS.THRESHOLD.APPROVER2) || '')
                });
              } catch (e) { /* threshold deleted since search ran — skip */ }
            });
            return false;
          });
          return rows;
        };

        poRows = loadRowsForType(C.HIERARCHY_RECORD_TYPES.PO);
        vbRows = loadRowsForType(C.HIERARCHY_RECORD_TYPES.VB);
      } catch (e) {
        return renderError(`Configuration with ID ${settingsId} not found.`, selfUrl);
      }
    }

    // Load expired/draft hierarchies for the Matrix history section (single list, all types)
    let historyItems = [];
    if (settingsId !== 'new') {
      try {
        search.create({
          type:    C.RECORDS.HIERARCHY,
          filters: [
            [C.FIELDS.HIERARCHY.SETTINGS, 'equalto', settingsId],
            'AND',
            [C.FIELDS.HIERARCHY.STATUS, 'anyof', [C.HIERARCHY_STATUS.DRAFT, C.HIERARCHY_STATUS.EXPIRED]]
          ],
          columns: [
            'internalid',
            C.FIELDS.HIERARCHY.NAME,
            C.FIELDS.HIERARCHY.STATUS,
            C.FIELDS.HIERARCHY.RECORD_TYPE,
            C.FIELDS.HIERARCHY.START_DATE,
            C.FIELDS.HIERARCHY.END_DATE
          ]
        }).run().each(hr => {
          const statusVal = hr.getValue(C.FIELDS.HIERARCHY.STATUS);
          const rtVal     = hr.getValue(C.FIELDS.HIERARCHY.RECORD_TYPE);
          let rtLabel = '—';
          if      (rtVal === C.HIERARCHY_RECORD_TYPES.PO)   rtLabel = 'PO';
          else if (rtVal === C.HIERARCHY_RECORD_TYPES.VB)   rtLabel = 'VB';
          else if (rtVal === C.HIERARCHY_RECORD_TYPES.BOTH) rtLabel = 'PO + VB';
          historyItems.push({
            name:      hr.getValue(C.FIELDS.HIERARCHY.NAME) || `Hierarchy ${hr.id}`,
            status:    statusVal === C.HIERARCHY_STATUS.DRAFT ? 'Draft' : 'Expired',
            recordType: rtLabel,
            startDate: hr.getValue(C.FIELDS.HIERARCHY.START_DATE) || '',
            endDate:   hr.getValue(C.FIELDS.HIERARCHY.END_DATE)   || ''
          });
          return true;
        });
      } catch (e) { log.error('OA: matrix history load failed', e.message); }
    }

    // Look up the subsidiary's base currency symbol for display in the matrix
    let baseCurrency = '';
    if (s.subsidiary) {
      try {
        const subCur = search.lookupFields({ type: 'subsidiary', id: s.subsidiary, columns: ['currency'] });
        const curArr = subCur.currency;
        if (curArr && curArr[0]) {
          // Try 'isocode' (ISO 4217 code like DKK/USD); fall back to the currency's display name
          const curFields = search.lookupFields({ type: 'currency', id: curArr[0].value, columns: ['isocode', 'symbol'] });
          baseCurrency = curFields.isocode || curFields.symbol || curArr[0].text || '';
        }
      } catch (e) { /* OneWorld not available — graceful fallback */ }
    }

    // Pre-build employee options HTML for client-side new rows
    const empOpts = ['<option value="">— Select employee —</option>'];
    search.create({
      type:    'employee',
      filters: [['isinactive', 'is', 'F']],
      columns: ['internalid', 'entityid']
    }).run().each(r => {
      empOpts.push(`<option value="${r.id}">${r.getValue('entityid').replace(/"/g, '&quot;')}</option>`);
      return true;
    });
    const empOptsHtml = empOpts.join('');

    // Pre-build approver-only options HTML for matrix row dropdowns (filtered by is_approver=T)
    const apprOpts = ['<option value="">— Select approver —</option>'];
    search.create({
      type:    'employee',
      filters: [['isinactive', 'is', 'F'], 'AND', [C.FIELDS.EMPLOYEE.IS_APPROVER, 'is', 'T']],
      columns: ['internalid', 'entityid']
    }).run().each(r => {
      apprOpts.push(`<option value="${r.id}">${r.getValue('entityid').replace(/"/g, '&quot;')}</option>`);
      return true;
    });
    const apprOptsHtml = apprOpts.join('');

    const useAmount   = !!s.use_amount;
    const enablePo    = !!s.enable_po;
    const enableVb    = !!s.enable_vb;

    return _shell(`${settingsId === 'new' ? 'New' : 'Edit'} configuration`, `
      <div class="page-header">
        <div>
          <a href="${selfUrl}" class="back-link">← Back to list</a>
          <h1>${settingsId === 'new' ? 'New configuration' : s.subsidiary_text || 'Edit configuration'}</h1>
        </div>
      </div>

      <form method="POST" action="${selfUrl}" onsubmit="syncRowCount()">
        <input type="hidden" name="oa_settings_id" value="${settingsId}">
        <input type="hidden" name="oa_subsidiary_name" id="oa_subsidiary_name" value="${s.subsidiary_text || ''}">

        <div class="card section">
          <h2>General settings</h2>
          <div class="form-grid">
            <div class="form-group">
              <label>Subsidiary *</label>
              <span class="field-help">The subsidiary these approval settings apply to. Each subsidiary must have its own configuration.</span>
              ${subsidiarySelect('oa_subsidiary', s.subsidiary)}
            </div>
            <div class="form-group">
              <label>Number of approvers</label>
              <span class="field-help">Single step: one approver signs off. Two step: the transaction must be approved by two people in sequence.</span>
              <select name="oa_approver_count">
                <option value="1" ${s.approver_count == 1 ? 'selected' : ''}>1 — Single step</option>
                <option value="2" ${s.approver_count == 2 ? 'selected' : ''}>2 — Two step</option>
              </select>
            </div>
            <div class="form-group toggle-row">
              <div>
                <label style="margin-bottom:2px">Enable PO approval</label>
                <span class="field-help">When on, Purchase Orders will be routed for approval when saved.</span>
              </div>
              <label class="toggle"><input type="checkbox" name="oa_enable_po_cb" onchange="syncHidden(this,'oa_enable_po')" ${s.enable_po ? 'checked' : ''}><span class="slider"></span></label>
              <input type="hidden" name="oa_enable_po" value="${s.enable_po ? 'T' : 'F'}">
            </div>
            <div class="form-group toggle-row">
              <div>
                <label style="margin-bottom:2px">Enable Vendor Bill approval</label>
                <span class="field-help">When on, Vendor Bills will be routed for approval when saved.</span>
              </div>
              <label class="toggle"><input type="checkbox" name="oa_enable_vb_cb" onchange="syncHidden(this,'oa_enable_vb')" ${s.enable_vb ? 'checked' : ''}><span class="slider"></span></label>
              <input type="hidden" name="oa_enable_vb" value="${s.enable_vb ? 'T' : 'F'}">
            </div>
            <div class="form-group toggle-row">
              <div>
                <label style="margin-bottom:2px">Use amount thresholds</label>
                <span class="field-help">When on, the approval matrix below is used to select the approver based on the transaction amount. When off, the default approvers above are always used.</span>
              </div>
              <label class="toggle"><input type="checkbox" name="oa_use_amount_cb" onchange="syncHidden(this,'oa_use_amount')" ${s.use_amount ? 'checked' : ''}><span class="slider"></span></label>
              <input type="hidden" name="oa_use_amount" value="${s.use_amount ? 'T' : 'F'}">
            </div>
          </div>
        </div>

        <div class="card section">
          <h2>Approvers</h2>
          <div class="form-grid">
            <div class="form-group">
              <label>Default approver 1 *</label>
              <span class="field-help">The primary approver used when amount thresholds are off, or when the transaction amount falls in a gap between threshold rules.</span>
              ${employeeSelect('oa_default_approver1', s.default_approver1)}
            </div>
            <div class="form-group">
              <label>Default approver 2 <span class="muted">(2-step only)</span></label>
              <span class="field-help">The second approver used as fallback in a two-step flow when no threshold rule matches. Only relevant when "Number of approvers" is 2.</span>
              ${employeeSelect('oa_default_approver2', s.default_approver2)}
            </div>
          </div>
        </div>

        <div class="card section">
          <h2>Email & buttons</h2>
          <div class="form-grid">
            <div class="form-group toggle-row">
              <div>
                <label style="margin-bottom:2px">Enable email approval</label>
                <span class="field-help">When on, approvers receive an email with Approve and Reject buttons so they can act without logging in to NetSuite.</span>
              </div>
              <label class="toggle"><input type="checkbox" name="oa_email_enabled_cb" onchange="syncHidden(this,'oa_email_enabled')" ${s.email_enabled ? 'checked' : ''}><span class="slider"></span></label>
              <input type="hidden" name="oa_email_enabled" value="${s.email_enabled ? 'T' : 'F'}">
            </div>
            <div class="form-group toggle-row">
              <div>
                <label style="margin-bottom:2px">Approve without login</label>
                <span class="field-help">When on, approvers can click the email link and approve or reject without having a NetSuite login. The token in the link is the only authentication. Requires the email action suitelet deployment to have "Available Without Login" enabled in NetSuite.</span>
              </div>
              <label class="toggle"><input type="checkbox" name="oa_approve_without_login_cb" onchange="syncHidden(this,'oa_approve_without_login')" ${s.approve_without_login ? 'checked' : ''}><span class="slider"></span></label>
              <input type="hidden" name="oa_approve_without_login" value="${s.approve_without_login ? 'T' : 'F'}">
            </div>
            <div class="form-group">
              <label>Email sender (From)</label>
              <span class="field-help">The NetSuite employee whose email address appears as the sender. If left blank, the email is sent from whoever submitted the transaction.</span>
              ${employeeSelect('oa_email_sender', s.email_sender)}
            </div>
            <div class="form-group">
              <label>Email subject</label>
              <span class="field-help">Subject line of the approval email. Use {docNumber} to insert the document number automatically.</span>
              <input type="text" name="oa_email_subject" value="${s.email_subject || 'Approval required — {docNumber}'}">
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label>Email intro text</label>
              <span class="field-help">The introductory paragraph in the approval email. Use {recordType}, {subsidiary}, {docNumber} and {requester} as placeholders.</span>
              <textarea name="oa_email_intro" rows="4" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical">${s.email_intro || 'A new {recordType} from {subsidiary} has been entered in NetSuite and requires your approval. Please see the attached document for full details.'}</textarea>
            </div>
            <div class="form-group">
              <label>Token expires (days)</label>
              <span class="field-help">How many days the email approval link stays valid. After expiry the approver must log in to NetSuite to act.</span>
              <input type="number" name="oa_token_expiry_days" value="${(s.token_expiry_days || typeof s.token_expiry_days === 'number') ? s.token_expiry_days : 7}" min="1" max="30">
            </div>
            <div class="form-group">
              <label>Approve button text</label>
              <span class="field-help">Label shown on the green approve button in the email and on the transaction form.</span>
              <input type="text" name="oa_approve_string" value="${s.approve_string || 'Approve'}">
            </div>
            <div class="form-group">
              <label>Reject button text</label>
              <span class="field-help">Label shown on the red reject button in the email and on the transaction form.</span>
              <input type="text" name="oa_reject_string" value="${s.reject_string || 'Reject'}">
            </div>
          </div>
        </div>

        <div class="form-actions">
          <a href="${selfUrl}" class="btn-secondary">Cancel</a>
          <button type="submit" class="btn-primary">Save settings</button>
        </div>

        ${renderMatrix('vb', 'Approval Matrix — Vendor Bills', vbRows, useAmount, enableVb, baseCurrency)}
        ${renderMatrix('po', 'Approval Matrix — Purchase Orders', poRows, useAmount, enablePo, baseCurrency)}
      </form>

      ${renderMatrixHistory(historyItems)}

      <div id="oa-data" data-po-count="${poRows.length}" data-vb-count="${vbRows.length}" data-use-amount="${useAmount}" data-currency="${baseCurrency}" style="display:none"></div>
      <select id="emp-options-template" style="display:none" aria-hidden="true">${empOptsHtml}</select>
      <select id="approver-options-template" style="display:none" aria-hidden="true">${apprOptsHtml}</select>`, selfUrl, jsUrl);
  }

  // ─── Employee dropdown helper ─────────────────────────────────────────────────

  function employeeSelect(fieldName, selectedId) {
    const opts = ['<option value="">— Select employee —</option>'];
    search.create({
      type:    'employee',
      filters: [['isinactive', 'is', 'F']],
      columns: ['internalid', 'entityid']
    }).run().each(r => {
      const sel = String(r.id) === String(selectedId) ? ' selected' : '';
      opts.push(`<option value="${r.id}"${sel}>${r.getValue('entityid')}</option>`);
      return true;
    });
    return `<select name="${fieldName}">${opts.join('')}</select>`;
  }

  // ─── Approver dropdown (matrix rows) — filtered to is_approver=T employees ────

  function approverSelect(fieldName, selectedId) {
    const opts = ['<option value="">— Select approver —</option>'];
    search.create({
      type:    'employee',
      filters: [
        ['isinactive', 'is', 'F'],
        'AND',
        [C.FIELDS.EMPLOYEE.IS_APPROVER, 'is', 'T']
      ],
      columns: ['internalid', 'entityid']
    }).run().each(r => {
      const sel = String(r.id) === String(selectedId) ? ' selected' : '';
      opts.push(`<option value="${r.id}"${sel}>${r.getValue('entityid')}</option>`);
      return true;
    });
    return `<select name="${fieldName}">${opts.join('')}</select>`;
  }

  // ─── Subsidiary dropdown helper ───────────────────────────────────────────────

  function subsidiarySelect(fieldName, selectedId) {
    const opts = ['<option value="">— Select subsidiary —</option>'];
    try {
      search.create({
        type:    'subsidiary',
        columns: ['internalid', 'name', 'currency']
      }).run().each(r => {
        const curId = r.getValue('currency');
        let isoCode = '';
        if (curId) {
          try {
            const cf = search.lookupFields({ type: 'currency', id: curId, columns: ['isocode', 'symbol', 'name'] });
            isoCode = cf.isocode || cf.symbol || cf.name || r.getText('currency') || '';
          } catch (ce) {
            isoCode = r.getText('currency') || '';
          }
        }
        const sel     = String(r.id) === String(selectedId) ? ' selected' : '';
        const curAttr = isoCode.replace(/"/g, '&quot;');
        opts.push(`<option value="${r.id}"${sel} data-currency="${curAttr}">${r.getValue('name')}</option>`);
        return true;
      });
    } catch (e) {
      if (selectedId) opts.push(`<option value="${selectedId}" selected>${selectedId}</option>`);
    }
    return `<select name="${fieldName}" id="oa-subsidiary-select" required onchange="OA_updateCurrency(this)">${opts.join('')}</select>`;
  }

  // ─── Matrix HTML helper ───────────────────────────────────────────────────────

  function renderMatrix(prefix, title, rows, useAmount, isEnabled, currency) {
    const colStyle   = useAmount ? '' : ' style="display:none"';
    const curTag     = currency ? ` <span class="currency-tag">${currency}</span>` : '';
    const amountHdr  = `Amount from${currency ? ' (' + currency + ')' : ''}`;
    const total      = rows.length;
    const rowsHtml   = rows.map((row, i) => {
      const upDis   = i === 0         ? ' disabled' : '';
      const downDis = i === total - 1 ? ' disabled' : '';
      return `<tr data-row="${i}">
          <td class="prio-col"><button type="button" class="btn-prio" onclick="OA_moveRow('${prefix}',${i},-1)"${upDis}>▲</button><button type="button" class="btn-prio" onclick="OA_moveRow('${prefix}',${i},1)"${downDis}>▼</button></td>
          <td class="amount-col"${colStyle}><span class="amount-wrap"><input type="number" name="${prefix}_row_${i}_min" value="${row.minAmount}" min="0" step="0.01" class="matrix-num">${curTag}</span></td>
          <td>${approverSelect(prefix + '_row_' + i + '_approver1', row.approver1)}</td>
          <td>${approverSelect(prefix + '_row_' + i + '_approver2', row.approver2)}</td>
          <td><input type="hidden" name="${prefix}_row_${i}_id" value="${row.id}"><button type="button" class="btn-link-danger" onclick="OA_deleteRow(this,'${prefix}')">Delete</button></td>
        </tr>`;
    }).join('');
    return `<div class="matrix-wrapper" data-type="${prefix}"${isEnabled ? '' : ' style="display:none"'}>
      <div class="card section">
        <div class="section-header">
          <div>
            <h2 style="margin-bottom:4px">${title}</h2>
            <p class="muted" style="margin-top:2px;font-size:12px">Row order = priority. Top row wins if two rules overlap. If no rule matches, the default approver above is used.</p>
            <p class="amount-col muted" style="margin-top:2px;font-size:12px${useAmount ? '' : ';display:none'}">Amounts compared against the transaction's value in the subsidiary's base currency${currency ? ' (' + currency + ')' : ''}. Next row's "Amount from" acts as this row's upper limit.</p>
          </div>
          <button type="button" class="btn-primary" onclick="addRow('${prefix}')">+ Add rule</button>
        </div>
        <input type="hidden" name="${prefix}_row_count" id="${prefix}_row_count" value="${rows.length}">
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>
              <th class="prio-col" style="width:72px">Priority</th>
              <th class="amount-col matrix-amount-hdr"${colStyle} style="width:180px">${amountHdr}</th>
              <th>Approver 1</th>
              <th>Approver 2 <span style="font-weight:normal;color:#aaa">(optional)</span></th>
              <th style="width:60px"></th>
            </tr></thead>
            <tbody id="${prefix}-matrix-body">${rowsHtml}</tbody>
          </table>
        </div>
        ${rows.length === 0 ? `<p id="${prefix}-empty-msg" class="muted" style="text-align:center;padding:20px 0">No rules. Click &quot;+ Add rule&quot;.</p>` : ''}
      </div>
    </div>`;
  }

  // ─── History section (read-only expired/draft hierarchies) ───────────────────

  function renderHistorySection(typeLabel, historyItems, useAmount, currency) {
    if (!historyItems || historyItems.length === 0) return '';
    const amountHdr = `Amount from${currency ? ' (' + currency + ')' : ''}`;
    const colStyle  = useAmount ? '' : ' style="display:none"';
    const items = historyItems.map(h => {
      const dateRange = [h.startDate, h.endDate].filter(Boolean).join(' – ') || '—';
      const pill = h.status === 'Expired'
        ? `<span style="background:#c7463418;color:#c74634;border:1px solid #c7463430;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600">${h.status}</span>`
        : `<span style="background:#d9770618;color:#d97706;border:1px solid #d9770630;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600">${h.status}</span>`;
      const rows = h.thresholds.length ? h.thresholds.map(t =>
        `<tr>
          <td${colStyle}>${Number(t.minAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
          <td>${t.approver1}</td>
          <td>${t.approver2 || '<span style="color:#bbb">—</span>'}</td>
        </tr>`
      ).join('') : `<tr><td colspan="3" style="color:#bbb;text-align:center;padding:16px;font-style:italic">No threshold rules.</td></tr>`;
      return `<div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span style="font-size:14px;font-weight:600;color:#312d2a">${h.name}</span>
          ${pill}
          <span style="font-size:12px;color:#888">${dateRange}</span>
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:#f9f9f9">
              <th${colStyle} style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f0efee">${amountHdr}</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f0efee">Approver 1</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f0efee">Approver 2</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
    }).join('');
    return `<div class="card section" style="margin-top:24px">
      <h2 style="margin-bottom:4px">Matrix history — ${typeLabel}</h2>
      <p class="muted" style="margin-bottom:20px;font-size:12px">Past approval matrices that are no longer active. Read-only reference.</p>
      ${items}
    </div>`;
  }

  // ─── Matrix history (single unified section, all record types) ───────────────

  function renderMatrixHistory(items) {
    if (!items || items.length === 0) return '';
    const fmtDate = (d) => d ? String(d) : '—';
    const pill = (status) => {
      const color = status === 'Draft' ? '#d97706' : '#c74634';
      return `<span style="display:inline-block;padding:3px 10px;background:${color}18;color:${color};border:1px solid ${color}30;border-radius:20px;font-size:12px;font-weight:600">${status}</span>`;
    };
    const rows = items.map(h => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f5f5f5;font-weight:500">${h.name}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f5f5f5">${h.recordType}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f5f5f5">${pill(h.status)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f5f5f5;color:#666">${fmtDate(h.startDate)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f5f5f5;color:#666">${fmtDate(h.endDate)}</td>
      </tr>`).join('');
    return `<div class="card section" style="margin-top:24px">
      <h2 style="margin-bottom:4px">Matrix history</h2>
      <p class="muted" style="margin-bottom:20px;font-size:12px">Past approval matrices that are no longer active. Read-only reference.</p>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#fafafa">
            <th style="text-align:left;padding:9px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f0efee">Name</th>
            <th style="text-align:left;padding:9px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f0efee">Type</th>
            <th style="text-align:left;padding:9px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f0efee">Status</th>
            <th style="text-align:left;padding:9px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f0efee">Start date</th>
            <th style="text-align:left;padding:9px 12px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f0efee">End date</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  // ─── Matrix save helper ───────────────────────────────────────────────────────

  function saveMatrixRows(settingsId, p) {
    if (p.oa_enable_po === 'T') saveMatrixRowsForType(settingsId, p, 'po', C.HIERARCHY_RECORD_TYPES.PO);
    if (p.oa_enable_vb === 'T') saveMatrixRowsForType(settingsId, p, 'vb', C.HIERARCHY_RECORD_TYPES.VB);
  }

  function saveMatrixRowsForType(settingsId, p, prefix, recordType) {
    const rowCount = parseInt(p[prefix + '_row_count'], 10) || 0;

    let hierarchyId = null;
    search.create({
      type:    C.RECORDS.HIERARCHY,
      filters: [
        [C.FIELDS.HIERARCHY.SETTINGS,    'equalto', settingsId],
        'AND',
        [C.FIELDS.HIERARCHY.RECORD_TYPE, 'is',    recordType]
      ],
      columns: ['internalid']
    }).run().each(r => { hierarchyId = parseInt(r.id, 10); return false; });

    if (rowCount === 0) {
      if (hierarchyId) {
        search.create({
          type:    C.RECORDS.THRESHOLD,
          filters: [[C.FIELDS.THRESHOLD.HIERARCHY, 'equalto', hierarchyId]],
          columns: ['internalid']
        }).run().each(t => {
          try { record.delete({ type: C.RECORDS.THRESHOLD, id: parseInt(t.id, 10) }); } catch (e) {}
          return true;
        });
      }
      return;
    }

    if (!hierarchyId) {
      const h = record.create({ type: C.RECORDS.HIERARCHY, isDynamic: false });
      const autoName = 'Auto - ' + settingsId + ' - ' + prefix.toUpperCase();
      h.setValue({ fieldId: 'name',                          value: autoName });
      h.setValue({ fieldId: C.FIELDS.HIERARCHY.NAME,         value: autoName });
      h.setValue({ fieldId: C.FIELDS.HIERARCHY.SETTINGS,     value: settingsId });
      h.setValue({ fieldId: C.FIELDS.HIERARCHY.STATUS,       value: C.HIERARCHY_STATUS.ACTIVE });
      h.setValue({ fieldId: C.FIELDS.HIERARCHY.RECORD_TYPE,  value: recordType });
      h.setValue({ fieldId: C.FIELDS.HIERARCHY.HIGHEST_ONLY, value: false });
      h.setValue({ fieldId: C.FIELDS.HIERARCHY.START_DATE,   value: new Date() });
      hierarchyId = h.save();
    }

    const existingIds = [];
    search.create({
      type:    C.RECORDS.THRESHOLD,
      filters: [[C.FIELDS.THRESHOLD.HIERARCHY, 'equalto', hierarchyId]],
      columns: ['internalid']
    }).run().each(r => { existingIds.push(parseInt(r.id, 10)); return true; });

    const submittedIds = [];
    for (let i = 0; i < rowCount; i++) {
      const rowId        = p[prefix + '_row_' + i + '_id'];
      const rowMin       = parseFloat(p[prefix + '_row_' + i + '_min']) || 0;
      const rowApprover1 = parseInt(p[prefix + '_row_' + i + '_approver1'], 10) || null;
      const rowApprover2 = parseInt(p[prefix + '_row_' + i + '_approver2'], 10) || null;

      if (!rowApprover1) continue;

      let rowMax = null;
      for (let j = i + 1; j < rowCount; j++) {
        const nextA1  = parseInt(p[prefix + '_row_' + j + '_approver1'], 10);
        const nextMin = parseFloat(p[prefix + '_row_' + j + '_min']);
        if (nextA1 && !isNaN(nextMin)) { rowMax = nextMin - 0.01; break; }
      }

      let t;
      if (rowId && rowId !== 'new') {
        const parsedId = parseInt(rowId, 10);
        try {
          t = record.load({ type: C.RECORDS.THRESHOLD, id: parsedId, isDynamic: false });
          submittedIds.push(parsedId);
        } catch (e) {
          t = record.create({ type: C.RECORDS.THRESHOLD, isDynamic: false });
          t.setValue({ fieldId: 'name', value: 'Threshold ' + (i + 1) });
        }
      } else {
        t = record.create({ type: C.RECORDS.THRESHOLD, isDynamic: false });
        t.setValue({ fieldId: 'name', value: 'Threshold ' + (i + 1) });
      }

      t.setValue({ fieldId: C.FIELDS.THRESHOLD.HIERARCHY,  value: hierarchyId });
      t.setValue({ fieldId: C.FIELDS.THRESHOLD.MIN_AMOUNT, value: rowMin });
      t.setValue({ fieldId: C.FIELDS.THRESHOLD.MAX_AMOUNT, value: rowMax !== null ? rowMax : '' });
      t.setValue({ fieldId: C.FIELDS.THRESHOLD.APPROVER,   value: rowApprover1 });
      t.setValue({ fieldId: C.FIELDS.THRESHOLD.APPROVER2,  value: rowApprover2 || '' });
      t.setValue({ fieldId: C.FIELDS.THRESHOLD.SORT_ORDER, value: (i + 1) * 10 });
      const tSavedId = t.save();
      if (!rowId || rowId === 'new') submittedIds.push(tSavedId);
    }

    existingIds.forEach(id => {
      if (!submittedIds.includes(id)) {
        try { record.delete({ type: C.RECORDS.THRESHOLD, id }); } catch (e) {}
      }
    });
  }

  // ─── Shell / CSS ─────────────────────────────────────────────────────────────

  function _shell(title, body, selfUrl, jsUrl) {
    const listUrl = selfUrl || '';
    const breadcrumb = listUrl
      ? `<a href="${listUrl}" class="topbar-link">Omnit Approvals</a><span class="topbar-sep">›</span><span class="topbar-title">Settings</span>`
      : `<span class="topbar-title">Omnit Approvals › Settings</span>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
${jsUrl ? `<script src="${jsUrl}"><\/script>` : ''}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#f0efee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#312d2a;font-size:14px}
  .topbar{background:#312d2a;padding:0 32px;height:52px;display:flex;align-items:center;gap:16px}
  .topbar-logo{color:#c74634;font-weight:700;font-size:16px;letter-spacing:.5px}
  .topbar-sep{color:#666;font-size:18px}
  .topbar-title{color:#ccc;font-size:14px}
  .topbar-link{color:#ccc;font-size:14px;text-decoration:none}.topbar-link:hover{color:#fff;text-decoration:underline}
  .main{max-width:1100px;margin:0 auto;padding:32px 24px}
  .page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px}
  h1{font-size:24px;font-weight:700;color:#312d2a}
  h2{font-size:16px;font-weight:600;color:#312d2a;margin-bottom:20px}
  h3{font-size:14px;font-weight:600;color:#888;margin-bottom:12px}
  .subtitle{color:#888;font-size:14px;margin-top:4px}
  .card{background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:20px}
  .section{margin-bottom:20px}
  .back-link{color:#888;font-size:13px;text-decoration:none;display:block;margin-bottom:6px}
  .back-link:hover{color:#c74634}
  .data-table{width:100%;border-collapse:collapse}
  .data-table th{text-align:left;padding:10px 14px;font-size:12px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #f0efee}
  .data-table td{padding:12px 14px;border-bottom:1px solid #f5f5f5;font-size:14px;vertical-align:middle}
  .data-table tr:last-child td{border-bottom:none}
  .data-table tr:hover td{background:#fafafa}
  .empty{color:#bbb;text-align:center;padding:32px!important}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
  .badge-green{background:#e8f5e9;color:#2e7d32}
  .badge-grey{background:#f5f5f5;color:#999}
  .badge-blue{background:#e3f2fd;color:#1565c0}
  .link{color:#c74634;text-decoration:none;font-weight:500}
  .link:hover{text-decoration:underline}
  .btn-link-danger{background:none;border:none;padding:0;cursor:pointer;color:#c74634;font-weight:500;font-size:14px;font-family:inherit}
  .btn-link-danger:hover{text-decoration:underline}
  .btn-primary{background:#c74634;color:#fff;padding:10px 22px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;border:none;cursor:pointer;display:inline-block}
  .btn-primary:hover{background:#b03d2e}
  .btn-secondary{background:#f5f5f5;color:#555;padding:10px 22px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;border:none;cursor:pointer;display:inline-block}
  .form-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px}
  .form-group label{display:block;font-size:13px;font-weight:600;color:#555;margin-bottom:6px}
  .form-group input,.form-group select{width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;outline:none;transition:border .15s}
  .form-group input:focus,.form-group select:focus{border-color:#c74634}
  .toggle-row{display:flex;align-items:center;gap:12px}
  .toggle-row label:first-child{flex:1;margin:0}
  .toggle{position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0}
  .toggle input{opacity:0;width:0;height:0}
  .slider{position:absolute;cursor:pointer;inset:0;background:#ddd;border-radius:12px;transition:.2s}
  .slider:before{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
  input:checked+.slider{background:#c74634}
  input:checked+.slider:before{transform:translateX(20px)}
  .form-actions{display:flex;justify-content:flex-end;gap:12px;margin-bottom:24px}
  .section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
  .muted{color:#aaa;font-size:13px}
  .table-scroll{overflow-x:auto}
  .data-table tbody select{width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:inherit}
  .data-table tbody select:focus{border-color:#c74634;outline:none}
  .matrix-num{width:120px!important;padding:6px 10px!important;border:1px solid #ddd!important;border-radius:6px!important;font-size:13px!important}
  .field-help{display:block;font-size:12px;color:#aaa;font-weight:400;margin-bottom:6px;line-height:1.5}
  .prio-col{white-space:nowrap;text-align:center}
  .btn-prio{background:none;border:1px solid #ddd;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px;color:#666;line-height:1.4;margin:0 1px}
  .btn-prio:hover:not(:disabled){background:#f5f5f5;border-color:#aaa}
  .btn-prio:disabled{color:#ddd;cursor:default;border-color:#eee}
  .amount-wrap{display:inline-flex;align-items:center;gap:6px}
  .currency-tag{display:inline-block;padding:3px 8px;background:#e8f0fe;color:#1a56db;border-radius:5px;font-size:12px;font-weight:600;letter-spacing:.3px;white-space:nowrap}
</style>
</head>
<body>
<div class="topbar">
  <span class="topbar-logo">OMNI:T</span>
  <span class="topbar-sep">›</span>
  ${breadcrumb}
</div>
<div class="main">${body}</div>
<script>
// ─── Row reorder (inline — works even if external client JS fails to load) ───
function OA_reindex(p) {
  var rows = document.querySelectorAll('#' + p + '-matrix-body tr');
  rows.forEach(function(tr, i) {
    tr.setAttribute('data-row', i);
    tr.querySelectorAll('input[name],select[name]').forEach(function(el) {
      el.name = el.name.replace(new RegExp('^' + p + '_row_\\\\d+_'), p + '_row_' + i + '_');
    });
    var btns = tr.querySelectorAll('.btn-prio');
    if (btns[0]) { btns[0].disabled = i === 0;              btns[0].setAttribute('onclick', "OA_moveRow('" + p + "'," + i + ",-1)"); }
    if (btns[1]) { btns[1].disabled = i === rows.length - 1; btns[1].setAttribute('onclick', "OA_moveRow('" + p + "'," + i + ",1)"); }
  });
  var cnt = document.getElementById(p + '_row_count');
  if (cnt) cnt.value = rows.length;
}
function OA_moveRow(p, idx, delta) {
  var tbody = document.getElementById(p + '-matrix-body');
  var rows  = Array.from(tbody.querySelectorAll('tr'));
  var nIdx  = idx + delta;
  if (nIdx < 0 || nIdx >= rows.length) return;
  if (delta > 0) { rows[nIdx].insertAdjacentElement('afterend', rows[idx]); }
  else           { tbody.insertBefore(rows[idx], rows[nIdx]); }
  OA_reindex(p);
}
function OA_deleteRow(btn, p) { btn.closest('tr').remove(); OA_reindex(p); }
// Aliases so external client JS still works if cached
window.moveRowUp   = function(btn, p) { var tr = btn.closest('tr'); var prev = tr.previousElementSibling; if (prev) tr.parentNode.insertBefore(tr, prev); OA_reindex(p); };
window.moveRowDown = function(btn, p) { var tr = btn.closest('tr'); var next = tr.nextElementSibling;     if (next) tr.parentNode.insertBefore(next, tr); OA_reindex(p); };
window.deleteRow   = OA_deleteRow;
// Patch addRow to use approver template for row dropdowns
var _origAddRow = window.addRow;
window.addRow = function(p) {
  if (_origAddRow) _origAddRow(p);
  // Replace the last-added row's approver dropdowns with approver-only options
  var tbody = document.getElementById(p + '-matrix-body');
  if (!tbody) return;
  var lastRow = tbody.querySelector('tr:last-child');
  if (!lastRow) return;
  var apprTmpl = document.getElementById('approver-options-template');
  if (!apprTmpl) return;
  lastRow.querySelectorAll('select[name$="_approver1"],select[name$="_approver2"]').forEach(function(sel) {
    sel.innerHTML = apprTmpl.innerHTML;
  });
};

function OA_updateCurrency(sel) {
  var opt = sel.options[sel.selectedIndex];
  var cur = opt ? (opt.getAttribute('data-currency') || '') : '';
  // Update all currency badge spans in the matrix
  document.querySelectorAll('.currency-tag').forEach(function(el) {
    el.textContent = cur;
    el.style.display = cur ? '' : 'none';
  });
  // Update amount column headers
  document.querySelectorAll('.matrix-amount-hdr').forEach(function(el) {
    el.textContent = 'Amount from' + (cur ? ' (' + cur + ')' : '');
  });
  // Keep oa_subsidiary_name hidden field in sync
  var nm = document.getElementById('oa_subsidiary_name');
  if (nm && opt) nm.value = opt.text || '';
  // Update data-currency attribute for client-side new rows
  var d = document.getElementById('oa-data');
  if (d) d.setAttribute('data-currency', cur);
}
</script>
</body></html>`;
  }

  function renderError(msg, selfUrl) {
    return _shell('Error', `<div class="card"><h2>Error</h2><p style="color:#c74634">${msg}</p><br><a href="${selfUrl}" class="link">← Back</a></div>`, selfUrl);
  }

  return { onRequest };
});
