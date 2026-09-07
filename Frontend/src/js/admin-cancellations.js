/**
 * ==========================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN CANCELLATIONS
 * ==========================================================================
 * Admin cancellation management driven by the backend API:
 *   GET   /cancellations/stats                         (stats)
 *   GET   /cancellations?search=&status=&paymentStatus=&refundStatus=&sort=&page=&limit=
 *   GET   /cancellations/:id                           (detail)
 *   PATCH /cancellations/:id/approve                   (approve)
 *   PATCH /cancellations/:id/reject                    (reject)
 *   POST  /cancellations/:id/refund/request            (request refund)
 *   POST  /cancellations/:id/refund/confirm            (confirm refund - provider)
 *   POST  /cancellations/:id/refund/fail               (mark refund failed)
 *
 * Requires window.AdminAPI (admin-api.js) loaded first.
 * ============================================================================
 */
(function () {
  "use strict";

  var state = {
    page: 1,
    limit: 10,
    status: "all",
    paymentStatus: "all",
    refundStatus: "all",
    sort: "newest",
    search: ""
  };

  var STATUS_META = {
    REQUESTED: { cls: "pend", label: "Requested" },
    APPROVED: { cls: "info", label: "Approved" },
    REJECTED: { cls: "cxl", label: "Rejected" },
    CANCELLED: { cls: "cxl", label: "Cancelled" },
    PROCESSING: { cls: "info", label: "Processing" },
    COMPLETED: { cls: "cmp", label: "Completed" }
  };

  var REFUND_META = {
    NOT_REQUIRED: { cls: "muted", label: "Not Required" },
    REFUND_REQUESTED: { cls: "pend", label: "Refund Requested" },
    REFUND_APPROVED: { cls: "info", label: "Refund Approved" },
    REFUND_PROCESSING: { cls: "info", label: "Processing" },
    REFUNDED: { cls: "cmp", label: "Refunded" },
    REFUND_FAILED: { cls: "cxl", label: "Refund Failed" }
  };

  function money(value) {
    if (value === null || value === undefined) return "0.00";
    return Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function openModal(id) { var el = document.getElementById(id); if (el) el.classList.add("open"); }
  function closeModal(id) { var el = document.getElementById(id); if (el) el.classList.remove("open"); }
  function closeAllModals() { document.querySelectorAll(".modal-overlay.open").forEach(function(m) { m.classList.remove("open"); }); }

  document.addEventListener("click", function(e) {
    var closeBtn = e.target.closest("[data-close-modal]");
    if (closeBtn) closeModal(closeBtn.getAttribute("data-close-modal"));
  });

  function badge(meta, value) {
    var key = String(value || "").toUpperCase();
    var m = meta[key] || { cls: "", label: value || "—" };
    return '<span class="order-badge ' + m.cls + '">' + m.label + "</span>";
  }

  function statusBadge(status) { return badge(STATUS_META, status); }
  function refundBadge(refundStatus) { return badge(REFUND_META, refundStatus); }

  function paymentBadge(paymentStatus) {
    var s = String(paymentStatus || "").toUpperCase();
    var cls = "pend";
    var label = s || "—";
    if (s === "PAID" || s === "REFUNDED") { cls = "cmp"; }
    else if (s === "FAILED" || s === "CANCELLED") { cls = "cxl"; }
    return '<span class="order-badge ' + cls + '">' + label + "</span>";
  }

  async function loadStats() {
    if (!window.AdminAPI) return;
    try {
      var data = await window.AdminAPI.get("/cancellations/stats");
      var s = data.stats || {};
      var totalEl = document.getElementById("statTotalCancellations");
      var pendingEl = document.getElementById("statPendingCancellations");
      var refundedEl = document.getElementById("statRefundedToday");
      var refundAmountEl = document.getElementById("statTotalRefunds");
      var completedEl = document.getElementById("statCompletedCancellations");
      var refundFailedEl = document.getElementById("statRefundFailed");

      if (totalEl) totalEl.textContent = s.totalCancellations || 0;
      if (pendingEl) pendingEl.textContent = s.pendingApproval || 0;
      if (refundedEl) refundedEl.textContent = s.refunded || 0;
      if (completedEl) completedEl.textContent = s.completed || 0;
      if (refundFailedEl) refundFailedEl.textContent = s.refundFailed || 0;
      if (refundAmountEl) refundAmountEl.innerHTML = money(s.totalRefundAmount) + " <small>ETB</small>";

      var sidebarBadge = document.getElementById("sidebarRefundBadge");
      if (sidebarBadge) {
        sidebarBadge.textContent = s.totalCancellations || 0;
        sidebarBadge.style.display = (s.totalCancellations || 0) > 0 ? "inline-block" : "none";
      }
    } catch (e) {
      /* stats are non-critical */
    }
  }

  async function loadCancellations() {
    var tbody = document.getElementById("cancellationsTableBody");
    if (!tbody || !window.AdminAPI) return;

    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">Loading cancellations...</td></tr>';

    try {
      var data = await window.AdminAPI.get("/cancellations", {
        page: state.page,
        limit: state.limit,
        status: state.status,
        paymentStatus: state.paymentStatus,
        refundStatus: state.refundStatus,
        sort: state.sort,
        search: state.search || undefined
      });

      var items = data.cancellations || [];

      state.total = data.total || items.length;
      state.pages = Math.max(Math.ceil(state.total / state.limit), 1);
      window.__cancellationsCache = items;
      renderCancellations(items);
      renderPagination();
    } catch (error) {
      tbody.innerHTML = '<tr><td colspan="9" class="table-empty">Failed to load cancellations: ' + window.esc(error.message || "Server error") + "</td></tr>";
    }
  }

  function renderCancellations(items) {
    var tbody = document.getElementById("cancellationsTableBody");
    if (!tbody) return;

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No cancellation records found.</td></tr>';
      return;
    }

    tbody.innerHTML = items.map(function(c) {
      var customer = c.customerName || (c.customer && c.customer.name) || "—";
      return (
        "<tr>" +
        '<td><strong>' + window.esc(c.cancellationNumber || "—") + "</strong></td>" +
        '<td><strong>' + window.esc(c.orderId || "—") + "</strong></td>" +
        '<td>' + window.esc(customer) + '<br><small class="table-muted">' + window.esc(c.customerPhone || (c.customer && c.customer.phone) || "") + '</small></td>' +
        '<td>' + window.esc(c.reason || "—") + "</td>" +
        '<td>' + money(c.orderAmount) + " ETB</td>" +
        '<td>' + paymentBadge(c.paymentStatus) + "</td>" +
        '<td>' + refundBadge(c.refundStatus) + "</td>" +
        '<td>' + window.AdminAPI.formatDateTime(c.requestedAt) + "</td>" +
        '<td>' +
        '<div class="table-actions">' +
          '<button class="action-btn" data-action="view" data-id="' + window.esc(c.id || c.orderId) + '" title="View details"><i class="fa-solid fa-eye"></i></button>' +
          (c.status === "REQUESTED"
            ? '<button class="action-btn" data-action="approve" data-id="' + window.esc(c.id || c.orderId) + '" title="Approve"><i class="fa-solid fa-check"></i></button>' +
              '<button class="action-btn danger" data-action="reject" data-id="' + window.esc(c.id || c.orderId) + '" title="Reject"><i class="fa-solid fa-times"></i></button>'
            : "") +
        "</div>" +
        "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderPagination() {
    var info = document.getElementById("paginationInfo");
    var prevBtn = document.getElementById("prevPageBtn");
    var nextBtn = document.getElementById("nextPageBtn");

    if (info) info.textContent = "Page " + state.page + " of " + Math.max(state.pages, 1) + " (" + state.total + " cancellations)";
    if (prevBtn) prevBtn.disabled = state.page <= 1;
    if (nextBtn) nextBtn.disabled = state.page >= state.pages;
  }

  function changePage(delta) {
    state.page += delta;
    if (state.page < 1) state.page = 1;
    loadCancellations();
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function viewCancellation(c) {
    closeAllModals();

    setText("modalCancNumber", c.cancellationNumber || "—");
    setText("modalCancellationOrderId", c.orderId || "—");
    setText("modalCancCustomer", c.customerName || (c.customer && c.customer.name) || "—");
    setText("modalCancPhone", c.customerPhone || (c.customer && c.customer.phone) || "—");
    setText("modalCancEmail", (c.customer && c.customer.email) || "—");
    setText("modalCancOrderType", c.orderType || "—");
    setText("modalCancTableNumber", c.tableNumber || "—");
    setText("modalCancOrderStatus", c.orderStatus || "—");
    var paymentEl = document.getElementById("modalCancPaymentStatus");
    if (paymentEl) paymentEl.innerHTML = paymentBadge(c.paymentStatus);
    var refundEl = document.getElementById("modalCancRefundStatus");
    if (refundEl) refundEl.innerHTML = refundBadge(c.refundStatus);
    setText("modalCancRefundAmount", money(c.refundAmount) + " ETB");
    setText("modalCancRefundReference", c.refundReference || "—");
    setText("modalCancAmount", money(c.orderAmount) + " ETB");
    setText("modalCancReason", c.reason || "—");
    setText("modalCancRequestedAt", window.AdminAPI.formatDateTime(c.requestedAt));
    setText("modalCancProcessedAt", c.approvedAt || c.rejectedAt || c.completedAt ? window.AdminAPI.formatDateTime(c.approvedAt || c.rejectedAt || c.completedAt) : "—");
    setText("modalCancAdminNoteValue", c.adminNote || "—");
    var statusEl = document.getElementById("modalCancStatus");
    if (statusEl) statusEl.innerHTML = statusBadge(c.status);

    var itemsBody = document.getElementById("modalCancItemsBody");
    if (itemsBody) {
      var items = c.items || [];
      if (!items.length) {
        itemsBody.innerHTML = '<tr><td colspan="4" class="table-empty">No items</td></tr>';
      } else {
        itemsBody.innerHTML = items.map(function(i) {
          var subtotal = (Number(i.price) || 0) * (Number(i.quantity) || 0);
          return '<tr>' +
            "<td>" + window.esc(i.name || "—") + "</td>" +
            "<td>" + money(i.price) + " ETB</td>" +
            "<td>" + (i.quantity || 0) + "</td>" +
            "<td>" + money(subtotal) + " ETB</td>" +
            "</tr>";
        }).join("");
      }
    }

    var subtotal = Number(c.orderSubtotal) || 0;
    var serviceFee = Number(c.serviceFee) || 0;
    var total = Number(c.orderAmount) || 0;
    setText("modalCancSubtotal", money(subtotal) + " ETB");
    setText("modalCancServiceFee", money(serviceFee) + " ETB");
    setText("modalCancTotal", money(total) + " ETB");

    var noteEl = document.getElementById("cancAdminNote");
    if (noteEl) noteEl.value = "";

    var id = c.id || c.orderId;
    var approveBtn = document.getElementById("approveCancellationBtn");
    var rejectBtn = document.getElementById("rejectCancellationBtn");
    var refundRequestBtn = document.getElementById("requestRefundBtn");
    var refundConfirmBtn = document.getElementById("confirmRefundBtn");
    var refundFailBtn = document.getElementById("refundFailBtn");
    if (approveBtn) approveBtn.dataset.id = id || "";
    if (rejectBtn) rejectBtn.dataset.id = id || "";
    if (refundRequestBtn) refundRequestBtn.dataset.id = id || "";
    if (refundConfirmBtn) refundConfirmBtn.dataset.id = id || "";
    if (refundFailBtn) refundFailBtn.dataset.id = id || "";

    var canAct = c.status === "REQUESTED";
    if (approveBtn) approveBtn.style.display = canAct ? "inline-flex" : "none";
    if (rejectBtn) rejectBtn.style.display = canAct ? "inline-flex" : "none";

    var refundState = String(c.refundStatus || "").toUpperCase();
    var showRefundGroup = ["REFUND_REQUESTED", "REFUND_APPROVED", "REFUND_PROCESSING"].indexOf(refundState) !== -1;
    if (refundRequestBtn) refundRequestBtn.style.display = refundState === "REFUND_FAILED" ? "inline-flex" : "none";
    if (refundConfirmBtn) refundConfirmBtn.style.display = showRefundGroup ? "inline-flex" : "none";
    if (refundFailBtn) refundFailBtn.style.display = showRefundGroup ? "inline-flex" : "none";

    openModal("cancellationDetailsModal");
  }

  function findCancellation(id) {
    return (window.__cancellationsCache || []).find(function(c) { return String(c.id) === String(id) || String(c.orderId) === String(id); });
  }

  async function processCancellation(id, action) {
    if (!id) return;
    var noteEl = document.getElementById("cancAdminNote");
    var adminNote = noteEl ? noteEl.value.trim() : "";
    var isRefundAction = ["request", "confirm", "fail"].indexOf(action) !== -1;

    if (action === "approve") {
      if (!window.confirm("Approve cancellation? The order will be cancelled and a refund will be processed if payment was successful.")) return;
    } else if (action === "reject") {
      if (!window.confirm("Reject cancellation? The order will remain active.")) return;
    } else if (action === "confirm") {
      if (!window.confirm("Confirm refund with the payment provider? This permanently marks the refund as completed.")) return;
    } else if (action === "fail") {
      if (!window.confirm("Mark refund as failed?")) return;
    } else if (action === "request") {
      if (!window.confirm("Request refund for this order?")) return;
    }

    try {
      if (action === "approve") {
        // Admin-controlled refund amount (full by default, or 0 for no refund,
        // or a partial amount). Backend honors this value.
        var refundInput = window.prompt(
          "Refund amount to issue (ETB). Enter 0 for no refund, or leave blank for a full refund:"
        );
        var payload = { adminNote: adminNote };
        if (refundInput !== null && refundInput !== "") {
          var num = Number(refundInput);
          if (Number.isFinite(num) && num >= 0) payload.refundAmount = num;
        }
        await window.AdminAPI.patch("/cancellations/" + encodeURIComponent(id) + "/approve", payload);
      } else if (action === "reject") {
        await window.AdminAPI.patch("/cancellations/" + encodeURIComponent(id) + "/reject", {
          adminNote: adminNote || "Cancellation request rejected"
        });
      } else if (action === "request") {
        await window.AdminAPI.post("/cancellations/" + encodeURIComponent(id) + "/refund/request", {});
      } else if (action === "confirm") {
        await window.AdminAPI.post("/cancellations/" + encodeURIComponent(id) + "/refund/confirm", {
          providerReference: "SIM-" + Date.now()
        });
      } else if (action === "fail") {
        await window.AdminAPI.post("/cancellations/" + encodeURIComponent(id) + "/refund/fail", { error: "Marked failed by admin" });
      }

      if (window.AdminToast) {
        var msg = action === "approve" ? "Cancellation approved" :
                  action === "reject" ? "Cancellation rejected" :
                  action === "request" ? "Refund requested" :
                  action === "confirm" ? "Refund confirmed and completed" :
                  action === "fail" ? "Refund marked as failed" : "Updated";
        window.AdminToast.success(msg);
      }
      closeModal("cancellationDetailsModal");
      loadStats();
      loadCancellations();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || "Failed to process cancellation");
    }
  }

  function bindEvents() {
    var searchInput = document.getElementById("cancellationSearchInput");
    if (searchInput) {
      var debounceTimer = null;
      searchInput.addEventListener("input", function() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function() {
          state.search = searchInput.value.trim();
          state.page = 1;
          loadCancellations();
        }, 400);
      });
    }

    var statusFilter = document.getElementById("cancellationStatusFilter");
    if (statusFilter) {
      statusFilter.addEventListener("change", function() {
        state.status = statusFilter.value;
        state.page = 1;
        loadCancellations();
      });
    }

    var paymentFilter = document.getElementById("cancellationPaymentFilter");
    if (paymentFilter) {
      paymentFilter.addEventListener("change", function() {
        state.paymentStatus = paymentFilter.value;
        state.page = 1;
        loadCancellations();
      });
    }

    var refundFilter = document.getElementById("cancellationRefundFilter");
    if (refundFilter) {
      refundFilter.addEventListener("change", function() {
        state.refundStatus = refundFilter.value;
        state.page = 1;
        loadCancellations();
      });
    }

    var sortSelect = document.getElementById("cancellationSortSelect");
    if (sortSelect) {
      sortSelect.addEventListener("change", function() {
        state.sort = sortSelect.value;
        state.page = 1;
        loadCancellations();
      });
    }

    var resetBtn = document.getElementById("resetCancellationFiltersBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", function() {
        if (searchInput) searchInput.value = "";
        if (statusFilter) statusFilter.value = "all";
        if (paymentFilter) paymentFilter.value = "all";
        if (refundFilter) refundFilter.value = "all";
        if (sortSelect) sortSelect.value = "newest";
        state.search = "";
        state.status = "all";
        state.paymentStatus = "all";
        state.refundStatus = "all";
        state.sort = "newest";
        state.page = 1;
        loadCancellations();
      });
    }

    var prevBtn = document.getElementById("prevPageBtn");
    if (prevBtn) prevBtn.addEventListener("click", function() { if (state.page > 1) changePage(-1); });
    var nextBtn = document.getElementById("nextPageBtn");
    if (nextBtn) nextBtn.addEventListener("click", function() { changePage(1); });

    var approveBtn = document.getElementById("approveCancellationBtn");
    if (approveBtn) approveBtn.addEventListener("click", function() { processCancellation(approveBtn.dataset.id, "approve"); });
    var rejectBtn = document.getElementById("rejectCancellationBtn");
    if (rejectBtn) rejectBtn.addEventListener("click", function() { processCancellation(rejectBtn.dataset.id, "reject"); });

    var refundRequestBtn = document.getElementById("requestRefundBtn");
    if (refundRequestBtn) refundRequestBtn.addEventListener("click", function() { processCancellation(refundRequestBtn.dataset.id, "request"); });
    var refundConfirmBtn = document.getElementById("confirmRefundBtn");
    if (refundConfirmBtn) refundConfirmBtn.addEventListener("click", function() { processCancellation(refundConfirmBtn.dataset.id, "confirm"); });
    var refundFailBtn = document.getElementById("refundFailBtn");
    if (refundFailBtn) refundFailBtn.addEventListener("click", function() { processCancellation(refundFailBtn.dataset.id, "fail"); });

    var tbody = document.getElementById("cancellationsTableBody");
    if (tbody) {
      tbody.addEventListener("click", function(e) {
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        var id = btn.getAttribute("data-id");
        var action = btn.getAttribute("data-action");
        if (!id) return;

        var c = findCancellation(id);
        if (!c) {
          if (window.AdminToast) window.AdminToast.error("Cancellation not found");
          return;
        }

        if (action === "view") viewCancellation(c);
        else if (action === "approve") processCancellation(c.id || c.orderId, "approve");
        else if (action === "reject") processCancellation(c.id || c.orderId, "reject");
      });
    }
  }

  function init() {
    bindEvents();
    loadStats();
    loadCancellations();
  }

  document.addEventListener("DOMContentLoaded", init);
})();