/**
 * Client-side JS for OA Settings Suitelet.
 * Loaded as an external script — no inline script blocks needed.
 * Reads server-rendered data from #oa-data and #emp-options-template in the DOM.
 */
(function () {
  'use strict';

  var _c  = { po: 0, vb: 0 };
  var _ua = false;

  // ─── Initialise (runs after DOM ready) ───────────────────────────────────────

  function init() {
    var d = document.getElementById('oa-data');
    if (d) {
      _c.po = +(d.getAttribute('data-po-count') || 0);
      _c.vb = +(d.getAttribute('data-vb-count') || 0);
      _ua   = d.getAttribute('data-use-amount') === 'true';
    }

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
  }

  window.addRow = function (p) {
    var i    = _c[p]++;
    var em   = document.getElementById(p + '-empty-msg');
    if (em) em.style.display = 'none';

    var tmpl = document.getElementById('emp-options-template');
    var opts = tmpl ? tmpl.innerHTML : '';

    var tr = document.createElement('tr');
    tr.setAttribute('data-row', i);

    // Amount cell
    var td1 = document.createElement('td');
    td1.className = 'amount-col';
    if (!_ua) td1.style.display = 'none';
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.name = p + '_row_' + i + '_min';
    inp.value = '0'; inp.min = '0'; inp.step = '0.01'; inp.className = 'matrix-num';
    td1.appendChild(inp);

    // Approver 1
    var td2  = document.createElement('td');
    var sel1 = document.createElement('select');
    sel1.name = p + '_row_' + i + '_approver1'; sel1.innerHTML = opts;
    td2.appendChild(sel1);

    // Approver 2
    var td3  = document.createElement('td');
    var sel2 = document.createElement('select');
    sel2.name = p + '_row_' + i + '_approver2'; sel2.innerHTML = opts;
    td3.appendChild(sel2);

    // Delete cell
    var td4 = document.createElement('td');
    var hid = document.createElement('input');
    hid.type = 'hidden'; hid.name = p + '_row_' + i + '_id'; hid.value = 'new';
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-link-danger'; btn.textContent = 'Delete';
    btn.addEventListener('click', (function (prefix) {
      return function () { window.deleteRow(this, prefix); };
    })(p));
    td4.appendChild(hid); td4.appendChild(btn);

    tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
    document.getElementById(p + '-matrix-body').appendChild(tr);
  };

  window.deleteRow = function (btn, p) {
    btn.closest('tr').remove();
    reindex(p);
  };

  window.syncRowCount = function () { reindex('po'); reindex('vb'); };

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
