/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define([
  'N/record',
  'N/search',
  'N/url',
  './lib/oa_constants',
  './oa_engine'
], (record, search, url, C, engine) => {
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

    if (view === 'edit' && settingsId) {
      resp.write(renderEditPage(settingsId, selfUrl));
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
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.APPROVE_STRING,    value: p.oa_approve_string || 'Godkend' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.REJECT_STRING,     value: p.oa_reject_string  || 'Afvis' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.EMAIL_ENABLED,     value: p.oa_email_enabled === 'T' });
      rec.setValue({ fieldId: C.FIELDS.SETTINGS.TOKEN_EXPIRY_DAYS, value: parseInt(p.oa_token_expiry_days, 10) || 7 });
      const savedId = rec.save();

      saveMatrixRows(savedId, p);
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
        emailOn:    r.getValue(C.FIELDS.SETTINGS.EMAIL_ENABLED) ? 'Ja' : 'Nej',
        enablePO:   r.getValue(C.FIELDS.SETTINGS.ENABLE_PO) ? 'Ja' : 'Nej',
        enableVB:   r.getValue(C.FIELDS.SETTINGS.ENABLE_VB) ? 'Ja' : 'Nej'
      });
      return true;
    });

    const tableRows = rows.map(r => `
      <tr>
        <td>${r.subsidiary}</td>
        <td>${r.approver1}</td>
        <td><span class="badge ${r.emailOn === 'Ja' ? 'badge-green' : 'badge-grey'}">${r.emailOn}</span></td>
        <td><span class="badge ${r.enablePO === 'Ja' ? 'badge-green' : 'badge-grey'}">${r.enablePO}</span></td>
        <td><span class="badge ${r.enableVB === 'Ja' ? 'badge-green' : 'badge-grey'}">${r.enableVB}</span></td>
        <td><a href="${selfUrl}&oa_view=edit&oa_settings_id=${r.id}" class="link">Rediger</a></td>
      </tr>`).join('');

    return _shell('Omnit Approvals — Konfiguration', `
      <div class="page-header">
        <div>
          <h1>Konfiguration</h1>
          <p class="subtitle">Administrer godkendelsesindstillinger per subsidiary</p>
        </div>
        <a href="${selfUrl}&oa_view=edit&oa_settings_id=new" class="btn-primary">+ Ny konfiguration</a>
      </div>
      <div class="card">
        <table class="data-table">
          <thead><tr>
            <th>Subsidiary</th><th>Standard godkender</th><th>Email</th><th>PO</th><th>VB</th><th></th>
          </tr></thead>
          <tbody>${tableRows || '<tr><td colspan="6" class="empty">Ingen konfigurationer endnu.</td></tr>'}</tbody>
        </table>
      </div>`, selfUrl);
  }

  // ─── Edit View ────────────────────────────────────────────────────────────────

  function renderEditPage(settingsId, selfUrl) {
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
              [C.FIELDS.HIERARCHY.SETTINGS,    'anyof', settingsId],
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
              const t = record.load({ type: C.RECORDS.THRESHOLD, id, isDynamic: false });
              rows.push({
                id:        String(id),
                minAmount: String(t.getValue(C.FIELDS.THRESHOLD.MIN_AMOUNT) || 0),
                approver1: String(t.getValue(C.FIELDS.THRESHOLD.APPROVER)  || ''),
                approver2: String(t.getValue(C.FIELDS.THRESHOLD.APPROVER2) || '')
              });
            });
            return false;
          });
          return rows;
        };

        poRows = loadRowsForType(C.HIERARCHY_RECORD_TYPES.PO);
        vbRows = loadRowsForType(C.HIERARCHY_RECORD_TYPES.VB);
      } catch (e) {
        return renderError(`Konfiguration med ID ${settingsId} ikke fundet.`, selfUrl);
      }
    }

    // Pre-build employee options HTML for client-side new rows
    const empOpts = ['<option value="">— Vælg medarbejder —</option>'];
    search.create({
      type:    'employee',
      filters: [['isinactive', 'is', 'F']],
      columns: ['internalid', 'entityid']
    }).run().each(r => {
      empOpts.push(`<option value="${r.id}">${r.getValue('entityid').replace(/"/g, '&quot;')}</option>`);
      return true;
    });
    const empOptsJson = JSON.stringify(empOpts.join(''));
    const useAmount   = !!s.use_amount;
    const enablePo    = !!s.enable_po;
    const enableVb    = !!s.enable_vb;

    return _shell(`${settingsId === 'new' ? 'Ny' : 'Rediger'} konfiguration`, `
      <div class="page-header">
        <div>
          <a href="${selfUrl}" class="back-link">← Tilbage til liste</a>
          <h1>${settingsId === 'new' ? 'Ny konfiguration' : s.subsidiary_text || 'Rediger konfiguration'}</h1>
        </div>
      </div>

      <form method="POST" action="${selfUrl}" onsubmit="syncRowCount()">
        <input type="hidden" name="oa_settings_id" value="${settingsId}">
        <input type="hidden" name="oa_subsidiary_name" id="oa_subsidiary_name" value="${s.subsidiary_text || ''}">

        <div class="card section">
          <h2>Generelle indstillinger</h2>
          <div class="form-grid">
            <div class="form-group">
              <label>Subsidiary *</label>
              ${subsidiarySelect('oa_subsidiary', s.subsidiary)}
            </div>
            <div class="form-group">
              <label>Antal godkendere</label>
              <select name="oa_approver_count">
                <option value="1" ${s.approver_count == 1 ? 'selected' : ''}>1 — Et trin</option>
                <option value="2" ${s.approver_count == 2 ? 'selected' : ''}>2 — To trin</option>
              </select>
            </div>
            <div class="form-group toggle-row">
              <label>Aktiver PO godkendelse</label>
              <label class="toggle"><input type="checkbox" name="oa_enable_po_cb" onchange="syncHidden(this,'oa_enable_po')" ${s.enable_po ? 'checked' : ''}><span class="slider"></span></label>
              <input type="hidden" name="oa_enable_po" value="${s.enable_po ? 'T' : 'F'}">
            </div>
            <div class="form-group toggle-row">
              <label>Aktiver Vendor Bill godkendelse</label>
              <label class="toggle"><input type="checkbox" name="oa_enable_vb_cb" onchange="syncHidden(this,'oa_enable_vb')" ${s.enable_vb ? 'checked' : ''}><span class="slider"></span></label>
              <input type="hidden" name="oa_enable_vb" value="${s.enable_vb ? 'T' : 'F'}">
            </div>
            <div class="form-group toggle-row">
              <label>Brug beløbstærskler</label>
              <label class="toggle"><input type="checkbox" name="oa_use_amount_cb" onchange="syncHidden(this,'oa_use_amount')" ${s.use_amount ? 'checked' : ''}><span class="slider"></span></label>
              <input type="hidden" name="oa_use_amount" value="${s.use_amount ? 'T' : 'F'}">
            </div>
          </div>
        </div>

        <div class="card section">
          <h2>Godkendere</h2>
          <div class="form-grid">
            <div class="form-group">
              <label>Standard godkender 1 *</label>
              ${employeeSelect('oa_default_approver1', s.default_approver1)}
            </div>
            <div class="form-group">
              <label>Standard godkender 2 <span class="muted">(kun ved 2-trins)</span></label>
              ${employeeSelect('oa_default_approver2', s.default_approver2)}
            </div>
          </div>
        </div>

        <div class="card section">
          <h2>Email & knapper</h2>
          <div class="form-grid">
            <div class="form-group toggle-row">
              <label>Aktiver email godkendelse</label>
              <label class="toggle"><input type="checkbox" name="oa_email_enabled_cb" onchange="syncHidden(this,'oa_email_enabled')" ${s.email_enabled ? 'checked' : ''}><span class="slider"></span></label>
              <input type="hidden" name="oa_email_enabled" value="${s.email_enabled ? 'T' : 'F'}">
            </div>
            <div class="form-group">
              <label>Token udløber (dage)</label>
              <input type="number" name="oa_token_expiry_days" value="${(s.token_expiry_days || typeof s.token_expiry_days === 'number') ? s.token_expiry_days : 7}" min="1" max="30">
            </div>
            <div class="form-group">
              <label>Godkend-knap tekst</label>
              <input type="text" name="oa_approve_string" value="${s.approve_string || 'Godkend'}">
            </div>
            <div class="form-group">
              <label>Afvis-knap tekst</label>
              <input type="text" name="oa_reject_string" value="${s.reject_string || 'Afvis'}">
            </div>
          </div>
        </div>

        <div class="form-actions">
          <a href="${selfUrl}" class="btn-secondary">Annuller</a>
          <button type="submit" class="btn-primary">Gem indstillinger</button>
        </div>

        ${renderMatrix('vb', 'Godkendelsesmatrix — Vendor Bills', vbRows, useAmount, enableVb)}
        ${renderMatrix('po', 'Godkendelsesmatrix — Purchase Orders', poRows, useAmount, enablePo)}
      </form>

      <script>
      var _counters = { po: ${poRows.length}, vb: ${vbRows.length} };
      var _empOptions = ${empOptsJson};
      var _useAmount = ${useAmount ? 'true' : 'false'};
      function addRow(prefix) {
        var i = _counters[prefix]++;
        var em = document.getElementById(prefix + '-empty-msg');
        if (em) em.style.display = 'none';
        var amountDisplay = _useAmount ? '' : 'display:none;';
        var tr = document.createElement('tr');
        tr.setAttribute('data-row', i);
        tr.innerHTML =
          '<td class="amount-col" style="' + amountDisplay + '"><input type="number" name="' + prefix + '_row_' + i + '_min" value="0" min="0" step="0.01" class="matrix-num"></td>' +
          '<td><select name="' + prefix + '_row_' + i + '_approver1">' + _empOptions + '</select></td>' +
          '<td><select name="' + prefix + '_row_' + i + '_approver2">' + _empOptions + '</select></td>' +
          '<td><input type="hidden" name="' + prefix + '_row_' + i + '_id" value="new">' +
              '<button type="button" class="btn-link-danger" onclick="deleteRow(this,\'' + prefix + '\')">Slet</button></td>';
        document.getElementById(prefix + '-matrix-body').appendChild(tr);
      }
      function deleteRow(btn, prefix) {
        btn.closest('tr').remove();
        reindexRows(prefix);
      }
      function reindexRows(prefix) {
        var rows = document.querySelectorAll('#' + prefix + '-matrix-body tr');
        rows.forEach(function(tr, idx) {
          tr.setAttribute('data-row', idx);
          tr.querySelectorAll('input[name], select[name]').forEach(function(el) {
            el.name = el.name.replace(new RegExp('^' + prefix + '_row_\\d+_'), prefix + '_row_' + idx + '_');
          });
        });
        var countEl = document.getElementById(prefix + '_row_count');
        if (countEl) countEl.value = rows.length;
      }
      function syncRowCount() { reindexRows('po'); reindexRows('vb'); }
      function setAmountCols(show) {
        document.querySelectorAll('.amount-col').forEach(function(el) {
          el.style.display = show ? '' : 'none';
        });
        _useAmount = show;
      }
      function syncHidden(cb, name) {
        document.querySelector('[name="' + name + '"]').value = cb.checked ? 'T' : 'F';
        if (name === 'oa_enable_vb' || name === 'oa_enable_po') {
          var prefix = name === 'oa_enable_vb' ? 'vb' : 'po';
          var wrapper = document.querySelector('.matrix-wrapper[data-type="' + prefix + '"]');
          if (wrapper) wrapper.style.display = cb.checked ? '' : 'none';
        } else if (name === 'oa_use_amount') {
          setAmountCols(cb.checked);
        }
      }
      var subSel = document.querySelector('[name="oa_subsidiary"]');
      if (subSel) subSel.addEventListener('change', function() {
        var opt = this.options[this.selectedIndex];
        document.getElementById('oa_subsidiary_name').value = opt ? opt.text : '';
      });
      </script>`, selfUrl);
  }

  // ─── Employee dropdown helper ─────────────────────────────────────────────────

  function employeeSelect(fieldName, selectedId) {
    const opts = ['<option value="">— Vælg medarbejder —</option>'];
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

  // ─── Subsidiary dropdown helper ───────────────────────────────────────────────

  function subsidiarySelect(fieldName, selectedId) {
    const opts = ['<option value="">— Vælg subsidiary —</option>'];
    try {
      search.create({
        type:    'subsidiary',
        columns: ['internalid', 'name']
      }).run().each(r => {
        const sel = String(r.id) === String(selectedId) ? ' selected' : '';
        opts.push(`<option value="${r.id}"${sel}>${r.getValue('name')}</option>`);
        return true;
      });
    } catch (e) {
      if (selectedId) opts.push(`<option value="${selectedId}" selected>${selectedId}</option>`);
    }
    return `<select name="${fieldName}" required>${opts.join('')}</select>`;
  }

  // ─── Matrix HTML helper ───────────────────────────────────────────────────────

  function renderMatrix(prefix, title, rows, useAmount, isEnabled) {
    const colStyle  = useAmount ? '' : ' style="display:none"';
    const rowsHtml = rows.map((row, i) => {
      return `<tr data-row="${i}">
          <td class="amount-col"${colStyle}><input type="number" name="${prefix}_row_${i}_min" value="${row.minAmount}" min="0" step="0.01" class="matrix-num"></td>
          <td>${employeeSelect(prefix + '_row_' + i + '_approver1', row.approver1)}</td>
          <td>${employeeSelect(prefix + '_row_' + i + '_approver2', row.approver2)}</td>
          <td><input type="hidden" name="${prefix}_row_${i}_id" value="${row.id}"><button type="button" class="btn-link-danger" onclick="deleteRow(this,'${prefix}')">Slet</button></td>
        </tr>`;
    }).join('');
    return `<div class="matrix-wrapper" data-type="${prefix}"${isEnabled ? '' : ' style="display:none"'}>
      <div class="card section">
        <div class="section-header">
          <div>
            <h2 style="margin-bottom:4px">${title}</h2>
            <p class="amount-col muted" style="margin-top:2px;font-size:12px${useAmount ? '' : ';display:none'}">Sorteres stigende — næste rækkes beløb er øvre grænse.</p>
          </div>
          <button type="button" class="btn-primary" onclick="addRow('${prefix}')">+ Tilføj regel</button>
        </div>
        <input type="hidden" name="${prefix}_row_count" id="${prefix}_row_count" value="${rows.length}">
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>
              <th class="amount-col"${colStyle} style="width:150px">Beløb fra</th>
              <th>Godkender 1</th>
              <th>Godkender 2 <span style="font-weight:normal;color:#aaa">(valgfri)</span></th>
              <th style="width:60px"></th>
            </tr></thead>
            <tbody id="${prefix}-matrix-body">${rowsHtml}</tbody>
          </table>
        </div>
        ${rows.length === 0 ? `<p id="${prefix}-empty-msg" class="muted" style="text-align:center;padding:20px 0">Ingen regler. Klik "+ Tilføj regel".</p>` : ''}
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
        [C.FIELDS.HIERARCHY.SETTINGS,    'anyof', settingsId],
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
      h.setValue({ fieldId: 'name',                          value: 'Auto-' + prefix.toUpperCase() });
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
        t = record.load({ type: C.RECORDS.THRESHOLD, id: parsedId, isDynamic: false });
        submittedIds.push(parsedId);
      } else {
        t = record.create({ type: C.RECORDS.THRESHOLD, isDynamic: false });
        t.setValue({ fieldId: 'name', value: 'Tærskel ' + (i + 1) });
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

  function _shell(title, body, selfUrl) {
    const listUrl = selfUrl || '';
    const breadcrumb = listUrl
      ? `<a href="${listUrl}" class="topbar-link">Omnit Approvals</a><span class="topbar-sep">›</span><span class="topbar-title">Indstillinger</span>`
      : `<span class="topbar-title">Omnit Approvals › Indstillinger</span>`;
    return `<!DOCTYPE html>
<html lang="da">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
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
</style>
</head>
<body>
<div class="topbar">
  <span class="topbar-logo">OMNI:T</span>
  <span class="topbar-sep">›</span>
  ${breadcrumb}
</div>
<div class="main">${body}</div>
</body></html>`;
  }

  function renderError(msg, selfUrl) {
    return _shell('Fejl', `<div class="card"><h2>Fejl</h2><p style="color:#c74634">${msg}</p><br><a href="${selfUrl}" class="link">← Tilbage</a></div>`, selfUrl);
  }

  return { onRequest };
});
