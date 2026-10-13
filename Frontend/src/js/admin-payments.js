function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}

/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN PAYMENT MANAGEMENT
 * ================================================================
 * Read-only payment monitoring driven by the backend API:
 *   GET /admin/payments        (list / search / filter / paginate)
 *   GET /admin/payments/stats  (metric cards)
 *   GET /admin/payments/:id    (payment detail)
 *   GET /admin/payments/:id/history (audit trail)
 *   POST /admin/payments/:id/refund (process refund)
 *
 * Supports full refund management with audit trail.
 *
 * Requires window.AdminAPI (admin-api.js) loaded first.
 * ================================================================
 */
(function () {
  "use strict";

  var state = {
    page: 1,
    limit: 10,
    search: "",
    method: "",
    status: "",
    dateRange: "",
    dateFrom: "",
    dateTo: "",
    sort: "newest",
    currentPaymentId: null
  };

  function money(value) {
    if (value === null || value === undefined) return "0.00";
    return Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function paymentBadge(paymentStatus) {
    var cls = "order-badge";
    var ps = String(paymentStatus || "PENDING").toUpperCase();
    switch (ps) {
      case "PAID": cls += " cmp"; break;
      case "REFUNDED": cls += " cmp"; break;
      case "FAILED": cls += " cxl"; break;
      case "CANCELLED": cls += " cxl"; break;
      default: cls += " pend"; break;
    }
    var label = window.translateStatus ? window.translateStatus(ps) : ps;
    return '<span class="' + cls + '">' + label + "</span>";
  }

  function methodLabel(method) {
    var m = String(method || "").toUpperCase();
    return '<span class="pay-method">' + window.esc(m || "—") + "</span>";
  }

  function refText(value) {
    var v = value || "—";
    // Long transaction references are truncated with CSS ellipsis; the full value
    // is exposed on hover via the native title tooltip.
    return '<span class="mono-ref" title="' + window.esc(v) + '">' + window.esc(v) + "</span>";
  }

  function getDateRange() {
    var today = new Date();
    var from = null, to = null;

    switch (state.dateRange) {
      case "today":
        from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        to = new Date(from);
        to.setDate(to.getDate() + 1);
        break;
      case "yesterday":
        from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
        to = new Date(from);
        to.setDate(to.getDate() + 1);
        break;
      case "last7":
        from = new Date(today);
        from.setDate(from.getDate() - 7);
        to = new Date(today);
        to.setDate(to.getDate() + 1);
        break;
      case "last30":
        from = new Date(today);
        from.setDate(from.getDate() - 30);
        to = new Date(today);
        to.setDate(to.getDate() + 1);
        break;
      case "custom":
        if (state.dateFrom) from = new Date(state.dateFrom);
        if (state.dateTo) to = new Date(state.dateTo);
        break;
    }

    return { from: from ? from.toISOString().split("T")[0] : null, to: to ? to.toISOString().split("T")[0] : null };
  }

  /* ============================================================
   * MODALS
   * ============================================================ */
  function openModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add("open");
  }

  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove("open");
  }

  /* ============================================================
   * DATA LOADING
   * ============================================================ */
  async function loadStats() {
    try {
      var data = await window.AdminAPI.get("/admin/payments/stats");
      var stats = data.stats || {};

      document.getElementById("metricTotalPayments").textContent = stats.totalPayments || 0;
      document.getElementById("metricSuccessfulPayments").textContent = stats.successfulPayments || 0;
      document.getElementById("metricFailedPayments").textContent = stats.failedPayments || 0;
      document.getElementById("metricPendingPayments").textContent = stats.pendingPayments || 0;
      document.getElementById("metricRefundedPayments").textContent = stats.cancelledPayments || 0;
      document.getElementById("metricNetRevenue").textContent = "ETB " + money(stats.totalRevenue || 0);
    } catch (e) {
      console.error("Error loading stats:", e);
    }
  }

  async function loadPayments() {
    var tbody = document.getElementById("paymentsTableBody");
    if (!tbody || !window.AdminAPI) return;

    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">'+tr('loading_payments','Loading payments...')+'</td></tr>';

    try {
      var dateRange = getDateRange();
      var params = {
        page: state.page,
        limit: state.limit,
        sort: state.sort
      };

      if (state.search) params.search = state.search;
      if (state.method) params.method = state.method;
      if (state.status) params.status = state.status;
      if (dateRange.from) params.dateFrom = dateRange.from;
      if (dateRange.to) params.dateTo = dateRange.to;

      var data = await window.AdminAPI.get("/admin/payments", params);

      window.__paymentsCache = data.payments || [];
      renderPayments(window.__paymentsCache);

      var total = data.total || 0;
      var pages = Math.max(data.pages || 1, 1);
      var info = document.getElementById("paymentPaginationInfo");
      if (info) info.textContent = tr('page_of_payments', 'Page {page} of {pages} ({total} payments)').replace('{page}', data.page || state.page).replace('{pages}', pages).replace('{total}', total);
      var prevBtn = document.getElementById("paymentPrevPageBtn");
      var nextBtn = document.getElementById("paymentNextPageBtn");
      if (prevBtn) prevBtn.disabled = (data.page || 1) <= 1;
      if (nextBtn) nextBtn.disabled = (data.page || 1) >= pages;
      state.page = data.page || 1;
    } catch (error) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">' + window.esc(tr('failed_load_payments', 'Failed to load payments: {error}', { error: error.message || '' })) + "</td></tr>";
    }
  }

  function renderPayments(payments) {
    var tbody = document.getElementById("paymentsTableBody");
    if (!tbody) return;

    if (!payments.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">'+tr('no_payments','No payments found.')+'</td></tr>';
      return;
    }

    tbody.innerHTML = payments.map(function (payment) {
      var customerLines = "<strong>" + window.esc(payment.customer?.name || "—") + "</strong>";
      if (payment.customer?.phone) {
        customerLines += "<small>" + window.esc(payment.customer.phone) + "</small>";
      }

      return (
        "<tr>" +
        '<td>' + refText(payment.transactionId || payment.paymentNumber) + '</td>' +
        '<td><strong>' + window.esc(payment.order?.orderId || "—") + '</strong></td>' +
        '<td><div class="user-cell"><div class="user-avatar">' +
          window.esc((payment.customer?.name || "?").charAt(0)) +
          "</div><div>" + customerLines + "</div></div></td>" +
        "<td><strong>" + money(payment.amount) + " ETB</strong></td>" +
        "<td>" + methodLabel(payment.paymentMethod) + "</td>" +
        "<td>" + paymentBadge(payment.status) + "</td>" +
        "<td>" + window.AdminAPI.formatDateTime(payment.paymentDate) + "</td>" +
        "<td>" +
          '<div class="table-actions">' +
            '<button class="action-btn" data-action="view" data-id="' + payment.id + '" title="' + tr('view_payment_details', 'View payment details') + '"><i class="fa-solid fa-eye"></i></button>' +
          "</div>" +
        "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function changePage(delta) {
    state.page += delta;
    if (state.page < 1) state.page = 1;
    loadPayments();
  }

  /* ============================================================
   * PAYMENT DETAILS & HISTORY
   * ============================================================ */
  function renderPaymentItems(items) {
    var tbody = document.getElementById("modalPaymentItemsBody");
    if (!items || !items.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="table-empty">'+tr('no_items','No items')+'</td></tr>';
      return;
    }
    if (tbody) {
      tbody.innerHTML = items.map(function (item) {
        var sub = (Number(item.price) || 0) * (Number(item.quantity) || 0);
        return (
          "<tr>" +
          "<td>" + window.esc(item.name) + "</td>" +
          "<td>" + money(item.price) + " ETB</td>" +
          "<td>" + (item.quantity || 0) + "</td>" +
          "<td>" + money(sub) + " ETB</td>" +
          "</tr>"
        );
      }).join("");
    }
  }

  async function loadPaymentHistory(paymentId) {
    var historyContainer = document.getElementById("modalPaymentHistory");
    if (!historyContainer) return;

    historyContainer.innerHTML = '<p>'+tr('loading','Loading...')+'</p>';

    try {
      var data = await window.AdminAPI.get("/admin/payments/" + paymentId + "/history");
      var history = data.history || [];

      if (!history.length) {
        historyContainer.innerHTML = '<p class="text-muted">'+tr('no_records','No history events found.')+'</p>';
        return;
      }

      historyContainer.innerHTML = '<div class="timeline">' + history.map(function (evt) {
        return '<div class="timeline-item">' +
          '<div class="timeline-marker"></div>' +
          '<div class="timeline-content">' +
            '<strong>' + window.esc(evt.eventType) + '</strong><br>' +
            '<small>Status: ' + window.esc(evt.status || "—") + '</small><br>' +
            (evt.reason ? '<small>Reason: ' + window.esc(evt.reason) + '</small><br>' : '') +
            '<small class="text-muted">' + window.AdminAPI.formatDateTime(evt.createdAt) + '</small>' +
          '</div>' +
        '</div>';
      }).join("") + '</div>';
    } catch (error) {
      historyContainer.innerHTML = '<p class="text-danger">' + window.esc(tr('failed_load', 'Failed: {error}', { error: error.message })) + '</p>';
    }
  }

  async function viewPaymentDetails(id, cached) {
    var payment = cached || null;
    try {
      if (!payment) {
        var data = await window.AdminAPI.get("/admin/payments/" + id);
        payment = data.payment;
      }
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_load_payment', 'Failed to load payment'));
      return;
    }
    if (!payment) return;

    state.currentPaymentId = id;

    var order = payment.order || {};
    var customer = payment.customer || {};

    document.getElementById("modalPaymentNumber").textContent = payment.paymentNumber || "#0000";
    document.getElementById("modalPaymentStatus").innerHTML = paymentBadge(payment.status);
    document.getElementById("modalPaymentAmount").textContent = money(payment.amount) + " ETB";
    document.getElementById("modalPaymentCurrency").textContent = payment.currency || "ETB";
    document.getElementById("modalPaymentMethod").textContent = payment.paymentMethod || "—";
    document.getElementById("modalPaymentProvider").textContent = payment.provider || "—";
    document.getElementById("modalPaymentTransactionId").textContent = payment.transactionId || "—";
    document.getElementById("modalPaymentPaidAt").textContent = payment.paidAt ? window.AdminAPI.formatDateTime(payment.paidAt) : "—";
    document.getElementById("modalPaymentDate").textContent = window.AdminAPI.formatDateTime(payment.paymentDate);
    document.getElementById("modalRefundAmount").textContent = money(payment.refundAmount) + " ETB";

    document.getElementById("modalOrderId").textContent = order.id || "—";
    document.getElementById("modalOrderStatus").textContent = order.status || "—";
    document.getElementById("modalOrderItems").textContent = (order.itemCount || 0);
    document.getElementById("modalOrderTotal").textContent = money(order.totalAmount) + " ETB";

    document.getElementById("modalCustomerName").textContent = customer.name || "—";
    document.getElementById("modalCustomerEmail").textContent = customer.email || "—";
    document.getElementById("modalCustomerPhone").textContent = customer.phone || "—";

    // Load and display payment history
    await loadPaymentHistory(id);

    // Setup refund button
    var refundBtn = document.getElementById("refundPaymentBtn");
    if (refundBtn) {
      refundBtn.onclick = function () { processRefund(id); };
    }

    openModal("paymentDetailsModal");
  }

  async function processRefund(paymentId) {
    var amountInput = document.getElementById("refundAmountInput");
    var reasonInput = document.getElementById("refundReasonInput");

    if (!amountInput || !reasonInput) return;

    var amount = Number(amountInput.value);
    var reason = reasonInput.value.trim();

    if (!amount || amount <= 0) {
      if (window.AdminToast) window.AdminToast.error(tr('enter_valid_refund_amount', 'Please enter a valid refund amount'));
      return;
    }

    if (!reason) {
      if (window.AdminToast) window.AdminToast.error(tr('enter_refund_reason', 'Please provide a refund reason'));
      return;
    }

    try {
      var response = await window.AdminAPI.post("/admin/payments/" + paymentId + "/refund", {
        amount: amount,
        reason: reason
      });

      if (window.AdminToast) window.AdminToast.success(response.message || tr('refund_processed', 'Refund processed successfully'));
      amountInput.value = "";
      reasonInput.value = "";
      
      // Reload payment details
      await viewPaymentDetails(paymentId);
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_process_refund', 'Failed to process refund'));
    }
  }

  /* ============================================================
   * EVENT BINDINGS
   * ============================================================ */
  function bindEvents() {
    var refreshBtn = document.getElementById("refreshPaymentsBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", function () {
      loadPayments();
      loadStats();
      if (window.AdminToast) window.AdminToast.show(tr('payments_refreshed', 'Payments refreshed'));
    });

    document.querySelectorAll("[data-close-modal]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        closeModal(btn.getAttribute("data-close-modal"));
      });
    });

    // Search with debounce
    var searchInput = document.getElementById("paymentSearchInput");
    var searchTimeout;
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(function () {
          state.search = searchInput.value.trim();
          state.page = 1;
          loadPayments();
        }, 400);
      });
    }

    // Filters
    var methodFilter = document.getElementById("paymentMethodFilter");
    if (methodFilter) {
      methodFilter.addEventListener("change", function () {
        state.method = methodFilter.value;
        state.page = 1;
        loadPayments();
      });
    }

    var statusFilter = document.getElementById("paymentStatusFilter");
    if (statusFilter) {
      statusFilter.addEventListener("change", function () {
        state.status = statusFilter.value;
        state.page = 1;
        loadPayments();
      });
    }

    var dateRangeFilter = document.getElementById("paymentDateRangeFilter");
    var customDateContainer = document.getElementById("customDateRangeContainer");
    if (dateRangeFilter) {
      dateRangeFilter.addEventListener("change", function () {
        state.dateRange = dateRangeFilter.value;
        if (customDateContainer) {
          customDateContainer.style.display = state.dateRange === "custom" ? "block" : "none";
        }
        state.page = 1;
        loadPayments();
      });
    }

    var applyDateRangeBtn = document.getElementById("applyDateRangeBtn");
    if (applyDateRangeBtn) {
      applyDateRangeBtn.addEventListener("click", function () {
        var dateFrom = document.getElementById("paymentDateFrom");
        var dateTo = document.getElementById("paymentDateTo");
        state.dateFrom = dateFrom ? dateFrom.value : "";
        state.dateTo = dateTo ? dateTo.value : "";
        state.page = 1;
        loadPayments();
      });
    }

    var sortSelect = document.getElementById("paymentSortSelect");
    if (sortSelect) {
      sortSelect.addEventListener("change", function () {
        state.sort = sortSelect.value;
        state.page = 1;
        loadPayments();
      });
    }

    var resetBtn = document.getElementById("resetPaymentFiltersBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (searchInput) searchInput.value = "";
        if (methodFilter) methodFilter.value = "";
        if (statusFilter) statusFilter.value = "";
        if (dateRangeFilter) dateRangeFilter.value = "";
        if (customDateContainer) customDateContainer.style.display = "none";
        if (sortSelect) sortSelect.value = "newest";

        state.search = "";
        state.method = "";
        state.status = "";
        state.dateRange = "";
        state.dateFrom = "";
        state.dateTo = "";
        state.sort = "newest";
        state.page = 1;

        loadPayments();
        loadStats();
      });
    }

    var prevBtn = document.getElementById("paymentPrevPageBtn");
    var nextBtn = document.getElementById("paymentNextPageBtn");
    if (prevBtn) prevBtn.addEventListener("click", function () { changePage(-1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { changePage(1); });

    var tbody = document.getElementById("paymentsTableBody");
    if (tbody) {
      tbody.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        var id = btn.getAttribute("data-id");
        var action = btn.getAttribute("data-action");
        if (!id) return;

        if (action === "view") {
          var cached = (window.__paymentsCache || []).find(function (p) { return p.id === id; });
          viewPaymentDetails(id, cached);
        }
      });
    }
  }

  function init() {
    bindEvents();
    loadStats();
    loadPayments();

    __registerLangChange(function () {
        try {
          loadPayments();
          loadStats();
          if (state.currentPaymentId) {
            viewPaymentDetails(state.currentPaymentId, (window.__paymentsCache || []).find(function (p) { return String(p.id) === String(state.currentPaymentId); }));
          }
        } catch (e) { /* best-effort re-render */ }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();