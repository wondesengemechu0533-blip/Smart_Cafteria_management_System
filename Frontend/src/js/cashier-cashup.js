function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * Cashier Cash Up
 * - Loads GET /api/v1/cashier/cashup?date=YYYY-MM-DD
 * - Renders day summary stat cards and the reconciliation table
 */
(function () {
  'use strict';

  var CASHUP_ROWS = [
    { key: 'transactionCount', label: 'Transaction Count', money: false },
    { key: 'subtotal', label: 'Subtotal', money: true },
    { key: 'serviceFeesCollected', label: 'Service Fees Collected', money: true },
    { key: 'deliveryFeesCollected', label: 'Delivery Fees Collected', money: true },
    { key: 'vatCollected', label: 'VAT Collected', money: true },
    { key: 'platformShare', label: 'Platform Share', money: true },
    { key: 'cafeteriaShare', label: 'Cafeteria Share', money: true },
    { key: 'refundsToday', label: 'Refunds Today', money: true },
    { key: 'cash', label: 'Cash', money: true },
    { key: 'electronic', label: 'Electronic', money: true },
    { key: 'netCashAtHand', label: 'Net Cash at Hand', money: true },
    { key: 'totalCollected', label: 'Total Collected', money: true }
  ];

  function todayStr() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function showError(message) {
    var banner = document.getElementById('errorBanner');
    if (banner) {
      banner.style.display = 'block';
      banner.textContent = message;
    }
  }

  function hideError() {
    var banner = document.getElementById('errorBanner');
    if (banner) banner.style.display = 'none';
  }

  function renderCashup(cashup) {
    var box = document.getElementById('cashupResults');
    if (box) box.style.display = 'block';

    var set = function (id, v) {
      var el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    set('cashStatTotalCollected', window.CashierAPI.formatCurrency(cashup.totalCollected));
    set('cashStatCash', window.CashierAPI.formatCurrency(cashup.cash));
    set('cashStatElectronic', window.CashierAPI.formatCurrency(cashup.electronic));
    set('cashStatNetCash', window.CashierAPI.formatCurrency(cashup.netCashAtHand));

    var body = document.getElementById('cashupTableBody');
    if (!body) return;
    var html = '';
    CASHUP_ROWS.forEach(function (row) {
      var value = cashup[row.key];
      var display = row.money ? window.CashierAPI.formatCurrency(value) : window.esc(value === null || value === undefined ? 0 : value);
      if (row.key === 'netCashAtHand' || row.key === 'totalCollected') {
        html += '<tr style="background:#f8fafc;font-weight:700;">';
      } else {
        html += '<tr>';
      }
      html += '<td>' + row.label + '</td>';
      html += '<td style="text-align:right;"><strong>' + display + '</strong></td>';
      html += '</tr>';
    });
    body.innerHTML = html;
  }

  async function loadCashup(date) {
    try {
      var res = await window.CashierAPI.get('/cashier/cashup', { date: date });
      renderCashup(res.cashup || {});
      hideError();
    } catch (e) {
      showError(tr('error_load_report', 'Failed to load cash up data: ') + e.message);
    }
  }

  function bindEvents() {
    var dateInput = document.getElementById('cashupDate');
    var isAmharic = function () {
      return typeof window.getCurrentLanguage === 'function' && window.getCurrentLanguage() === 'am';
    };

    var loadBtn = document.getElementById('loadCashupBtn');
    if (loadBtn) {
      loadBtn.addEventListener('click', function () {
        var date = dateInput.value;
        if (!date) {
          window.CashierToast.error(tr('select_date', 'Please select a date.'));
          return;
        }
        loadCashup(date);
      });
    }

    dateInput.addEventListener('change', function () {
      if (dateInput.value) loadCashup(dateInput.value);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var dateInput = document.getElementById('cashupDate');
    if (dateInput) {
      dateInput.value = todayStr();
      dateInput.max = todayStr();
    }
    bindEvents();
    loadCashup(todayStr());
  });
})();