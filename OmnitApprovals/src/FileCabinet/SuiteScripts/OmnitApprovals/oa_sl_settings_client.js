/**
 * Client-side JS for OA Settings Suitelet.
 * Loaded as an external script — no inline script blocks needed.
 * Reads server-rendered data from #oa-data and #emp-options-template in the DOM.
 */
(function () {
  'use strict';

  var _c   = { po: 0, vb: 0 };
  var _ua  = false;
  var _cur = '';

  // ─── Initialise (runs after DOM ready) ───────────────────────────────────────

  function init() {
    var d = document.getElementById('oa-data');
    if (d) {
      _c.po = +(d.getAttribute('data-po-count') || 0);
      _c.vb = +(d.getAttribute('data-vb-count') || 0);
      _ua   = d.getAttribute('data-use-amount') === 'true';
      _cur  = d.getAttribute('data-currency') || '';
    }

    updatePriorityButtons('po');
    updatePriorityButtons('vb');

    var sub = document.querySelector('[name="oa_subsidiary"]');
    if (sub) {
      sub.addEventListener('change', function () {
        var opt = this.options[this.selectedIndex];
        var el  = document.getElementById('oa_subsidiary_name');
        if (el) el.value = opt ? opt.text : '';
      });
    }
  }

  // ─── Row management ──────────────────────────────────────────────────────────

  function reindex(p) {
    var rows = document.querySelectorAll('#' + p + '-matrix-body tr');
    rows.forEach(function (tr, i) {
      tr.setAttribute('data-row', i);
      tr.querySelectorAll('input[name], select[name]').forEach(function (el) {
        el.name = el.name.replace(new RegExp('^' + p + '_row_\\d+_'), p + '_row_' + i + '_');
      });
    });
    var cnt = document.getElementById(p + '_row_count');
    if (cnt) cnt.value = rows.length;
    updatePriorityButtons(p);
  }

  function updatePriorityButtons(p) {
    var rows = document.querySelectorAll('#' + p + '-matrix-body tr');
    rows.forEach(function (tr, i) {
      var btns = tr.querySelectorAll('.btn-prio');
      if (btns[0]) btns[0].disabled = i === 0;
      if (btns[1]) btns[1].disabled = i === rows.length - 1;
    });
  }

  window.moveRowUp = function (btn, p) {
    var tr   = btn.closest('tr');
    var prev = tr.previousElementSibling;
    if (prev) tr.parentNode.insertBefore(tr, prev);
    reindex(p);
  };

  window.moveRowDown = function (btn, p) {
    var tr   = btn.closest('tr');
    var next = tr.nextElementSibling;
    if (next) tr.parentNode.insertBefore(next, tr);
    reindex(p);
  };

  window.addRow = function (p) {
    var i    = _c[p]++;
    var em   = document.getElementById(p + '-empty-msg');
    if (em) em.style.display = 'none';

    var tmpl = document.getElementById('emp-options-template');
    var opts = tmpl ? tmpl.innerHTML : '';

    var tr = document.createElement('tr');
    tr.setAttribute('data-row', i);

    // Priority cell (▲ ▼ buttons)
    var td0    = document.createElement('td');
    td0.className = 'prio-col';
    var btnUp  = document.createElement('button');
    btnUp.type = 'button'; btnUp.className = 'btn-prio'; btnUp.textContent = '▲';
    btnUp.addEventListener('click', (function (pfx) { return function () { window.moveRowUp(this, pfx); }; })(p));
    var btnDn  = document.createElement('button');
    btnDn.type = 'button'; btnDn.className = 'btn-prio'; btnDn.textContent = '▼';
    btnDn.addEventListener('click', (function (pfx) { return function () { window.moveRowDown(this, pfx); }; })(p));
    td0.appendChild(btnUp); td0.appendChild(btnDn);

    // Amount cell
    var td1 = document.createElement('td');
    td1.className = 'amount-col';
    if (!_ua) td1.style.display = 'none';
    var wrap = document.createElement('span');
    wrap.className = 'amount-wrap';
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.name = p + '_row_' + i + '_min';
    inp.value = '0'; inp.min = '0'; inp.step = '0.01'; inp.className = 'matrix-num';
    wrap.appendChild(inp);
    if (_cur) {
      var tag = document.createElement('span');
      tag.className = 'currency-tag'; tag.textContent = _cur;
      wrap.appendChild(tag);
    }
    td1.appendChild(wrap);

    // Approver 1 — required
    var td2  = document.createElement('td');
    var sel1 = document.createElement('select');
    sel1.name = p + '_row_' + i + '_approver1'; sel1.required = true; sel1.innerHTML = opts;
    td2.appendChild(sel1);

    // Approver 2 — optional
    var td3  = document.createElement('td');
    var sel2 = document.createElement('select');
    sel2.name = p + '_row_' + i + '_approver2'; sel2.innerHTML = opts;
    td3.appendChild(sel2);

    // Delete cell
    var td4 = document.createElement('td');
    var hid = document.createElement('input');
    hid.type = 'hidden'; hid.name = p + '_row_' + i + '_id'; hid.value = 'new';
    var btnDel = document.createElement('button');
    btnDel.type = 'button'; btnDel.className = 'btn-link-danger'; btnDel.textContent = 'Delete';
    btnDel.addEventListener('click', (function (prefix) {
      return function () { window.deleteRow(this, prefix); };
    })(p));
    td4.appendChild(hid); td4.appendChild(btnDel);

    tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
    document.getElementById(p + '-matrix-body').appendChild(tr);
    updatePriorityButtons(p);
  };

  window.deleteRow = function (btn, p) {
    btn.closest('tr').remove();
    reindex(p);
  };

  // Validate before save: block submit if any matrix row is missing Approver 1.
  // Also reindex so server-side row indices line up with the visible order.
  window.syncRowCount = function () {
    var errors = [];
    ['po', 'vb'].forEach(function (p) {
      var enabledInput = document.querySelector('[name="oa_enable_' + p + '"]');
      if (!enabledInput || enabledInput.value !== 'T') return;
      var rows = document.querySelectorAll('#' + p + '-matrix-body tr');
      rows.forEach(function (tr, i) {
        var apr1 = tr.querySelector('select[name$="_approver1"]');
        if (!apr1 || !apr1.value) {
          errors.push((p === 'po' ? 'Purchase Order' : 'Vendor Bill') + ' matrix row ' + (i + 1) + ': Approver 1 is required');
        }
      });
    });
    if (errors.length) {
      alert('Cannot save:\n\n' + errors.join('\n') + '\n\nSelect Approver 1 or delete the row.');
      return false;
    }
    reindex('po');
    reindex('vb');
    return true;
  };

  window.setAmountCols = function (show) {
    document.querySelectorAll('.amount-col').forEach(function (el) {
      el.style.display = show ? '' : 'none';
    });
    _ua = show;
  };

  window.syncHidden = function (cb, name) {
    document.querySelector('[name="' + name + '"]').value = cb.checked ? 'T' : 'F';
    if (name === 'oa_enable_vb' || name === 'oa_enable_po') {
      var pfx     = name === 'oa_enable_vb' ? 'vb' : 'po';
      var wrapper = document.querySelector('.matrix-wrapper[data-type="' + pfx + '"]');
      if (wrapper) wrapper.style.display = cb.checked ? '' : 'none';
    } else if (name === 'oa_use_amount') {
      window.setAmountCols(cb.checked);
    }
  };

  document.addEventListener('DOMContentLoaded', init);
})();
