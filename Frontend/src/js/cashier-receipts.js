function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  if (typeof window.getText === 'function') { var r = window.getText(key); if (r && r !== key) return r; }
  return fallback;
}
/**
 * Cashier Receipts
 * - GET /api/v1/cashier/receipts
 * - GET /api/v1/cashier/receipts/:id
 */
(function () {
  'use strict';

  var state = { page: 1, limit: 10, search: '', date: '', total: 0, pages: 1, currentHtml: '' };

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

  function openModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('open');
  }
  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }

  function renderReceipts(receipts) {
    var body = document.getElementById('receiptsTableBody');
    if (!body) return;
    if (!receipts.length) {
      body.innerHTML = '<tr><td colspan="8" class="table-empty">No receipts found.</td></tr>';
      return;
    }
    body.innerHTML = receipts
      .map(function (r) {
        var paid = String(r.paymentStatus || '').toUpperCase() === 'PAID';
        var status = paid
          ? '<span class="badge badge-success">Paid</span>'
          : '<span class="badge badge-warning">' + window.esc(r.paymentStatus || '—') + '</span>';
        return (
          '<tr>' +
          '<td><strong>#' + window.esc(r.orderId) + '</strong></td>' +
          '<td>' + window.esc(r.customerName || '—') + '</td>' +
          '<td>' + Number(r.itemCount || 0) + '</td>' +
          '<td><strong>' + window.CashierAPI.formatCurrency(r.totalAmount) + '</strong></td>' +
          '<td>' + window.esc(r.paymentMethod || '—') + '</td>' +
          '<td>' + status + '</td>' +
          '<td>' + window.CashierAPI.formatDateTime(r.createdAt) + '</td>' +
          '<td><button type="button" class="btn btn-sm btn-primary view-receipt-btn" data-id="' +
          window.esc(r.id) +
          '"><i class="fa-solid fa-eye"></i> View</button></td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderPagination() {
    var info = document.getElementById('receiptsPaginationInfo');
    var prev = document.getElementById('prevReceiptsPageBtn');
    var next = document.getElementById('nextReceiptsPageBtn');
    if (info) info.textContent = tr('page_of_receipts', 'Page {page} of {pages} ({total} receipts)').replace('{page}', state.page).replace('{pages}', Math.max(state.pages, 1)).replace('{total}', state.total);
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= state.pages;
  }

  async function loadReceipts() {
    var body = document.getElementById('receiptsTableBody');
    if (!body || !window.CashierAPI) return;
    body.innerHTML = '<tr><td colspan="8" class="table-empty">Loading receipts...</td></tr>';
    try {
      var res = await window.CashierAPI.get('/cashier/receipts', {
        page: state.page,
        limit: state.limit,
        search: state.search,
        date: state.date,
      });
      state.total = res.total || 0;
      state.pages = res.pages || Math.max(Math.ceil(state.total / state.limit), 1);
      renderReceipts(res.receipts || []);
      renderPagination();
      hideError();
    } catch (e) {
      body.innerHTML = tr('failed_load_receipts', 'Failed to load receipts: {error}', { error: e.message || '' });
      showError(e.message);
    }
  }

  async function showReceipt(id) {
    try {
      var res = await window.CashierAPI.get('/cashier/receipts/' + encodeURIComponent(id));
      var r = res.receipt || {};
      var items = (r.items || [])
        .map(function (i) {
          return (
            '<tr><td>' +
            window.esc(i.name) +
            '</td><td style="text-align:center;">' +
            Number(i.qty || 0) +
            '</td><td style="text-align:right;">' +
            window.CashierAPI.formatCurrency(i.unitPrice) +
            '</td><td style="text-align:right;">' +
            window.CashierAPI.formatCurrency(i.subtotal) +
            '</td></tr>'
          );
        })
        .join('');

      var html =
        '<div style="text-align:center;margin-bottom:12px;">' +
        '<strong style="font-size:16px;">Smart Cafeteria</strong><br>' +
        '<span>Receipt #' + window.esc(r.orderNumber) + '</span><br>' +
        '<small>' + window.CashierAPI.formatDateTime(r.createdAt) + '</small>' +
        '</div>' +
        '<div style="margin-bottom:8px;">' +
        '<div>Customer: ' + window.esc(r.customerName || '—') + '</div>' +
        (r.customerPhone ? '<div>Phone: ' + window.esc(r.customerPhone) + '</div>' : '') +
        '<div>Payment: ' + window.esc(r.paymentMethod || '—') + ' (' + window.esc(r.paymentStatus || '—') + ')</div>' +
        '</div>' +
        '<table class="admin-table" style="width:100%;"><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Subtotal</th></tr></thead><tbody>' +
        (items || '<tr><td colspan="4">No items</td></tr>') +
        '</tbody></table>' +
        '<div style="margin-top:12px;text-align:right;">' +
        '<div>Subtotal: <strong>' + window.CashierAPI.formatCurrency(r.subtotal) + '</strong></div>' +
        (r.serviceFee ? '<div>Service Fee: <strong>' + window.CashierAPI.formatCurrency(r.serviceFee) + '</strong></div>' : '') +
        (r.vatAmount ? '<div>VAT: <strong>' + window.CashierAPI.formatCurrency(r.vatAmount) + '</strong></div>' : '') +
        '<div style="font-size:16px;">Total: <strong>' + window.CashierAPI.formatCurrency(r.total) + '</strong></div>' +
        '</div>';

      state.currentHtml = html;
      var box = document.getElementById('receiptDetail');
      if (box) box.innerHTML = html;
      openModal('receiptModal');
    } catch (e) {
      window.CashierToast.error(e.message || tr('failed_load_receipt', 'Failed to load receipt'));
    }
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  function applyFilters() {
    var search = document.getElementById('receiptSearchInput');
    var date = document.getElementById('receiptDateFilter');
    state.search = search ? search.value.trim() : '';
    state.date = date ? date.value : '';
    state.page = 1;
    loadReceipts();
  }

  function bindEvents() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.view-receipt-btn');
      if (btn) showReceipt(btn.getAttribute('data-id'));
      var closeBtn = e.target.closest('[data-close-modal]');
      if (closeBtn) closeModal(closeBtn.getAttribute('data-close-modal'));
    });

    var search = document.getElementById('receiptSearchInput');
    if (search) {
      search.addEventListener('input', debounce(function () {
        state.search = search.value.trim();
        state.page = 1;
        loadReceipts();
      }, 400));
    }

    var applyBtn = document.getElementById('applyReceiptFiltersBtn');
    if (applyBtn) applyBtn.addEventListener('click', applyFilters);
    var date = document.getElementById('receiptDateFilter');
    if (date) date.addEventListener('change', applyFilters);

    var refresh = document.getElementById('refreshReceiptsBtn');
    if (refresh) refresh.addEventListener('click', loadReceipts);

    var printBtn = document.getElementById('printReceiptBtn');
    if (printBtn) {
      printBtn.addEventListener('click', function () {
        if (!state.currentHtml) return;
        var win = window.open('', '_blank', 'width=420,height=640');
        if (!win) return;
        win.document.write(
          '<html><head><title>Receipt</title><style>body{font-family:Arial,sans-serif;padding:16px;}table{width:100%;border-collapse:collapse;}td,th{padding:6px;border-bottom:1px solid #ddd;font-size:13px;}</style></head><body>' +
          state.currentHtml +
          '</body></html>'
        );
        win.document.close();
        win.focus();
        win.print();
      });
    }

    var prev = document.getElementById('prevReceiptsPageBtn');
    var next = document.getElementById('nextReceiptsPageBtn');
    if (prev) prev.addEventListener('click', function () { if (state.page > 1) { state.page--; loadReceipts(); } });
    if (next) next.addEventListener('click', function () { if (state.page < state.pages) { state.page++; loadReceipts(); } });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    loadReceipts();
  });
})();
