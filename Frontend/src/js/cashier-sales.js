function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * Cashier Sales
 * - GET /api/v1/cashier/sales?date=YYYY-MM-DD
 *   (same payload as cash-up: totals + reconciliation rows)
 */
(function () {
  'use strict';

  var SALES_ROWS = [
    { key: 'transactionCount', label: 'Transaction Count', money: false },
    { key: 'subtotal', label: 'Subtotal', money: true },
    { key: 'serviceFeesCollected', label: 'Service Fees', money: true },
    { key: 'deliveryFeesCollected', label: 'Delivery Fees', money: true },
    { key: 'vatCollected', label: 'VAT Collected', money: true },
    { key: 'platformShare', label: 'Platform Share', money: true },
    { key: 'cafeteriaShare', label: 'Cafeteria Share', money: true },
    { key: 'refundsToday', label: 'Refunds', money: true },
    { key: 'cash', label: 'Cash', money: true },
    { key: 'electronic', label: 'Electronic', money: true },
    { key: 'netCashAtHand', label: 'Net Cash at Hand', money: true },
    { key: 'totalCollected', label: 'Total Collected', money: true },
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

  function renderSales(cashup) {
    var box = document.getElementById('salesResults');
    if (box) box.style.display = 'block';

    var set = function (id, v) {
      var el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    set('salesStatTotal', window.CashierAPI.formatCurrency(cashup.totalCollected));
    set('salesStatCash', window.CashierAPI.formatCurrency(cashup.cash));
    set('salesStatElectronic', window.CashierAPI.formatCurrency(cashup.electronic));
    set('salesStatNet', window.CashierAPI.formatCurrency(cashup.netCashAtHand));
    set('salesStatVat', window.CashierAPI.formatCurrency(cashup.vatCollected));
    set('salesStatTxns', cashup.transactionCount || 0);

    var body = document.getElementById('salesTableBody');
    if (!body) return;
    var html = '';
    SALES_ROWS.forEach(function (row) {
      var value = cashup[row.key];
      var display = row.money
        ? window.CashierAPI.formatCurrency(value)
        : window.esc(value === null || value === undefined ? 0 : value);
      var style = row.key === 'netCashAtHand' || row.key === 'totalCollected' ? ' style="background:#f8fafc;font-weight:700;"' : '';
      html += '<tr' + style + '><td>' + row.label + '</td><td style="text-align:right;"><strong>' + display + '</strong></td></tr>';
    });
    body.innerHTML = html;
  }

  async function loadSales(date) {
    try {
      var res = await window.CashierAPI.get('/cashier/sales', { date: date });
      renderSales(res.cashup || {});
      hideError();
    } catch (e) {
      showError(tr('failed_load_sales', 'Failed to load sales data: {error}', { error: e.message }));
    }
  }

  function bindEvents() {
    var dateInput = document.getElementById('salesDate');
    var loadBtn = document.getElementById('loadSalesBtn');
    var refreshBtn = document.getElementById('refreshSalesBtn');

    function loadSelected() {
      var date = dateInput && dateInput.value;
      if (!date) {
        window.CashierToast.error(tr('select_date', 'Please select a date.'));
        return;
      }
      loadSales(date);
    }

    if (loadBtn) loadBtn.addEventListener('click', loadSelected);
    if (dateInput) dateInput.addEventListener('change', function () { if (dateInput.value) loadSales(dateInput.value); });
    if (refreshBtn) refreshBtn.addEventListener('click', loadSelected);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var dateInput = document.getElementById('salesDate');
    if (dateInput) {
      dateInput.value = todayStr();
      dateInput.max = todayStr();
    }
    bindEvents();
    loadSales(todayStr());
  });
})();
