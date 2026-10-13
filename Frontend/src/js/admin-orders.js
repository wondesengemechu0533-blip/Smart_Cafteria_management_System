function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}

/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN ORDER MANAGEMENT
 * ================================================================
 * Admin Order Management driven by the backend API:
 *   GET    /admin/orders            (list / search / filter / sort / paginate)
 *   GET    /admin/orders/stats      (metric cards)
 *   GET    /admin/orders/:id        (details with customer + payment)
 *   PATCH  /admin/orders/:id/status (update status, respects flow rules)
 *   PATCH  /admin/orders/:id/cancel (cancel order)
 *
 * Requires window.AdminAPI (admin-api.js) loaded first.
 * ================================================================
 */
(function () {
  "use strict";

  // Socket.io client for real-time order updates (set by socket.js)
  window.socketClient = window.socketClient || (typeof window.ScosSocketBridge !== "undefined" ? window.ScosSocketBridge : null);

  var PICKUP_FLOW = ["PENDING", "PREPARING", "READY", "SERVED", "COMPLETED"];
  var DELIVERY_FLOW = ["PENDING", "PREPARING", "READY", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVED", "DELIVERED"];

  function getFlow(order) {
    return String((order && order.orderType) || "").toLowerCase() === "delivery"
      ? DELIVERY_FLOW
      : PICKUP_FLOW;
  }

  var STATUS_LABELS = {
    PENDING: "status_pending",
    PREPARING: "status_preparing",
    READY: "status_ready",
    PICKED_UP: "status_picked_up",
    SERVED: "status_served",
    OUT_FOR_DELIVERY: "status_out_for_delivery",
    ARRIVED: "status_arrived",
    DELIVERED: "status_delivered",
    COMPLETED: "status_completed",
    CANCELLED: "status_cancelled"
  };

  function tr(key, fallback, vars) {
    if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
    if (typeof window.getText === "function") {
      var v = window.getText(key);
      if (v && v !== key) return v;
    }
    return fallback != null ? fallback : key;
  }

  var state = {
    page: 1,
    limit: 10,
    search: "",
    status: "",
    paymentStatus: "",
    orderType: "",
    sort: "newest",
    dateRange: "",
    dateFrom: null,
    dateTo: null
  };

  function money(value) {
    if (value === null || value === undefined) return "0";
    return Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHtml(value) {
    return window.esc(value);
  }

  function statusLabel(status) {
    var s = String(status || "").toUpperCase();
    var localized = window.translateStatus ? window.translateStatus(s) : "";
    if (localized && String(localized).toUpperCase() !== s) return localized;
    var key = STATUS_LABELS[s];
    if (key) return tr(key, s);
    return s;
  }

  function statusBadge(status) {
    var cls = "order-badge";
    var s = String(status || "").toUpperCase();
    switch (s) {
      case "PENDING": cls += " pend"; break;
      case "PREPARING": cls += " prep"; break;
      case "READY": cls += " rd"; break;
      case "PICKED_UP": cls += " pu"; break;
      case "SERVED": cls += " svd"; break;
      case "OUT_FOR_DELIVERY": cls += " od"; break;
      case "ARRIVED": cls += " del"; break;
      case "DELIVERED": cls += " del"; break;
      case "COMPLETED": cls += " cmp"; break;
      case "CANCELLED": cls += " cxl"; break;
      default: cls += " pend"; break;
    }
    return '<span class="' + cls + '">' + statusLabel(s) + "</span>";
  }

  function paymentBadge(paymentStatus) {
    var cls = "order-badge";
    var ps = String(paymentStatus || "PENDING").toUpperCase();
    switch (ps) {
      case "PAID": cls += " cmp"; break;
      case "FAILED": cls += " cxl"; break;
      case "CANCELLED": cls += " cxl"; break;
      case "REFUNDED": cls += " rfnd"; break;
      default: cls += " pend"; break;
    }
    var label = window.translateStatus ? window.translateStatus(ps) : ps;
    return '<span class="' + cls + '">' + label + "</span>";
  }

  function getNextStatus(current, order) {
    var flow = getFlow(order);
    var idx = flow.indexOf(String(current || "").toUpperCase());
    if (idx >= 0 && idx < flow.length - 1) return flow[idx + 1];
    return null;
  }

function canCancel(current, order) {
    var flow = getFlow(order);
    var idx = flow.indexOf(String(current || "").toUpperCase());
    if (idx >= 0 && idx < flow.length - 1) return true;
    return false;
  }

  // A cancelled + paid order that has not been refunded yet is eligible for a
  // refund (PENDING -> CANCELLED -> REFUNDED workflow).
  function refundEligible(order) {
    if (!order) return false;
    if (String(order.status || "").toUpperCase() !== "CANCELLED") return false;
    // Check both top-level paymentStatus and embedded payment.status
    var topStatus = String(order.paymentStatus || "").toUpperCase();
    var embeddedStatus = order.payment && order.payment.status
      ? String(order.payment.status).toUpperCase()
      : topStatus;
    var isPaid = topStatus === "PAID" || embeddedStatus === "PAID";
    if (!isPaid) return false;
    if (String(order.refundStatus || "").toUpperCase() === "REFUNDED") return false;
    return Number(order.totalAmount || 0) > 0;
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
      var data = await window.AdminAPI.get("/admin/orders/stats");
      var stats = data.stats || {};
      document.getElementById("metricTotalOrders").textContent = stats.totalOrders || 0;
      document.getElementById("metricPendingOrders").textContent = stats.pendingOrders || 0;
      document.getElementById("metricPreparingOrders").textContent = stats.preparingOrders || 0;
      document.getElementById("metricReadyOrders").textContent = stats.readyOrders || 0;
      document.getElementById("metricCompletedOrders").textContent =
        (stats.completedOrders || 0) + (stats.servedOrders || 0) + (stats.deliveredOrders || 0);
      document.getElementById("metricCancelledOrders").textContent = stats.cancelledOrders || 0;
    } catch (e) {
      // stats are supplementary
    }
  }

  async function loadOrders() {
    var tbody = document.getElementById("ordersTableBody");
    if (!tbody || !window.AdminAPI) return;

    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">'+tr('loading_orders','Loading orders...')+'</td></tr>';

    try {
      var params = {
        page: state.page,
        limit: state.limit,
        search: state.search,
        status: state.status,
        paymentStatus: state.paymentStatus,
        orderType: state.orderType,
        sort: state.sort
      };
      if (state.dateFrom) params.from = state.dateFrom;
      if (state.dateTo) params.to = state.dateTo;
      
      var data = await window.AdminAPI.get("/admin/orders", params);

      window.__ordersCache = data.orders || [];
      renderOrders(window.__ordersCache);

      var total = data.total || 0;
      var pages = Math.max(data.pages || 1, 1);
      var info = document.getElementById("orderPaginationInfo");
      if (info) info.textContent = tr('page_of_orders', 'Page {page} of {pages} ({total} orders)').replace('{page}', data.page || state.page).replace('{pages}', pages).replace('{total}', total);
      var prevBtn = document.getElementById("orderPrevPageBtn");
      var nextBtn = document.getElementById("orderNextPageBtn");
      if (prevBtn) prevBtn.disabled = (data.page || 1) <= 1;
      if (nextBtn) nextBtn.disabled = (data.page || 1) >= pages;
      state.page = data.page || 1;
    } catch (error) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">' + window.esc(tr('admin_load_orders_failed', 'Failed to load orders: {error}', { error: error.message || 'Server error' })) + "</td></tr>";
    }
  }

  function renderOrders(orders) {
    // Sort by newest first using the real createdAt timestamp from MongoDB
    // This is a safety fallback if the backend sort is somehow bypassed.
    // Falls back to index order if createdAt is missing/invalid.
    orders.sort(
      (a, b) => {
        const ac = new Date(a.createdAt).getTime();
        const bc = new Date(b.createdAt).getTime();
        if (Number.isNaN(ac) || Number.isNaN(bc)) return 0;
        return bc - ac;
      }
    );

    var tbody = document.getElementById("ordersTableBody");
    if (!tbody) return;

    if (!orders.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No orders found.</td></tr>';
      return;
    }

    function formatType(order) {
      var type = String(order.orderType || "dine-in").toLowerCase();
      if (type === "takeaway") type = "Takeaway";
      else if (type === "dine-in") type = "Dine-in";
      else if (type === "delivery") {
        var info = order.deliveryInfo || {};
        var addr = [info.subCity, info.location].filter(Boolean).join(", ");
        return addr ? "Delivery · " + escapeHtml(addr) : "Delivery";
      }
      else type = type.charAt(0).toUpperCase() + type.slice(1);

      // Sanitise the stored table number: strip redundant type suffixes such as
      // "N/A (Takeaway)" / "5 (Dine-in)", a leading "Table " prefix, and ignore
      // "N/A" placeholders so we never render a bare "N/A".
      var table = String(order.tableNumber || "").trim().replace(/\s*\(.*\)\s*$/i, "").replace(/^table\s+/i, "").trim();
      if (table && table.toUpperCase() !== "N/A" && table.toUpperCase() !== "NA") {
        type += " · " + escapeHtml(table);
      }
      return type;
    }

    tbody.innerHTML = orders.map(function (order) {
      var status = String(order.status || "PENDING").toUpperCase();
      var showCancel = canCancel(status, order);
      var cancelBtn = showCancel
        ? '<button class="action-btn danger" data-action="cancel" data-id="' + order.id + '" title="' + tr('cancel_order_title', 'Cancel order') + '"><i class="fa-solid fa-ban"></i></button>'
        : "";
      var showRefund = refundEligible(order);
      var refundBtn = showRefund
        ? '<button class="action-btn" data-action="refund" data-id="' + order.id + '" title="' + tr('process_refund', 'Process refund') + '"><i class="fa-solid fa-money-bill-transfer"></i></button>'
        : "";
      // The cancelled + paid orders that still owe the customer money. This is
      // the badge the Manager/Admin flow is driven by: it appears when the
      // customer (or an admin) cancels a paid order and disappears the moment
      // the refund is processed.
      var refundBadge = showRefund
        ? ' <span class="order-badge rfnd refund-required" data-refund-required="1" title="' +
          tr('refund_required_hint', 'Paid order was cancelled - a Manager/Admin must process the refund') +
          '">' + tr('refund_required', 'Refund Required') + "</span>"
        : "";

      var customerLines =
        "<strong>" + escapeHtml(order.customerName) + "</strong>" +
        "<small>" + escapeHtml(order.customerPhone || "") + "</small>" +
        (order.customer && order.customer.email ? "<small>" + escapeHtml(order.customer.email) + "</small>" : "");

      var paymentLine =
        '<div class="pay-col">' +
          '<span class="pay-method">' + escapeHtml(order.paymentMethod || "—") + "</span>" +
          paymentBadge(order.paymentStatus) +
        "</div>";

      var typeLine =
        '<div class="order-type-cell">' +
          "<strong>" + formatType(order) + "</strong>" +
          "<small>" + (order.itemCount || 0) + " items</small>" +
        "</div>";

      return (
        "<tr>" +
        '<td class="order-id-col"><strong>' + escapeHtml(order.orderId) + "</strong></td>" +
        '<td><div class="user-cell"><div class="user-avatar">' + escapeHtml((order.customerName || "?").charAt(0)) + "</div><div>" + customerLines + "</div></div></td>" +
        "<td>" + typeLine + "</td>" +
        '<td class="amount-col"><strong>' + money(order.totalAmount) + " ETB</strong></td>" +
        "<td>" + paymentLine + "</td>" +
        "<td>" + statusBadge(status) + refundBadge + "</td>" +
        "<td>" + window.AdminAPI.formatDateTime(order.createdAt || order.orderTime) + "</td>" +
        "<td>" +
          '<div class="table-actions">' +
            '<button class="action-btn" data-action="view" data-id="' + order.id + '" title="' + tr('view_order_details', 'View order details') + '"><i class="fa-solid fa-eye"></i></button>' +
            refundBtn +
            cancelBtn +
          "</div>" +
        "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function changePage(delta) {
    state.page += delta;
    if (state.page < 1) state.page = 1;
    loadOrders();
  }

  /* ============================================================
   * ORDER DETAILS
   * ============================================================ */
  function renderOrderItems(items) {
    var tbody = document.getElementById("modalOrderItemsBody");
    if (!items || !items.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No items</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (item) {
      var sub = (Number(item.price) || 0) * (Number(item.quantity) || 0);
      return (
        "<tr>" +
        "<td>" +
          escapeHtml(item.name) +
          (item.notes ? ' <small class="item-note">(' + escapeHtml(item.notes) + ")</small>" : "") +
        "</td>" +
        "<td>" + money(item.price) + " ETB</td>" +
        "<td>" + item.quantity + "</td>" +
        "<td>" + money(sub) + " ETB</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderStatusSelect(status, order) {
    var select = document.getElementById("updateOrderStatusSelect");
    var hint = document.getElementById("statusFlowHint");
    var cancelBtn = document.getElementById("cancelOrderBtn");

    if (!select) return;
    var s = String(status || "PENDING").toUpperCase();
    var next = getNextStatus(s, order);
    var flow = getFlow(order);

    cancelBtn.style.display = canCancel(s, order) ? "inline-flex" : "none";

    if (!next) {
      select.innerHTML = '<option value="">' + (s === "CANCELLED" ? (window.translateStatus ? window.translateStatus("CANCELLED") : "") + " — " + tr("admin_status_no_updates", window.getCurrentLanguage && window.getCurrentLanguage() === "am" ? "ተጨማሪ ማዘመን የለም" : "no further updates") : tr("order", "Order") + " " + statusLabel(s) + " — " + tr("admin_status_flow_complete", window.getCurrentLanguage && window.getCurrentLanguage() === "am" ? "ፍሰት ተጠናቋል" : "flow complete")) + "</option>";
      select.disabled = true;
      if (hint) hint.textContent = "";
      return;
    }

    select.disabled = false;
    select.innerHTML =
      '<option value="">' + tr("select_next_status", "Select next status...") + '</option>' +
      '<option value="' + next + '">' + statusLabel(next) + "</option>";
    if (hint) {
      hint.textContent = flow.join(" → ") + (window.getCurrentLanguage && window.getCurrentLanguage() === "am" ? ". የአሁኑ: " : ". Current: ") + s + ".";
    }
  }

  async function viewOrderDetails(id, cached) {
    var order = cached || null;
    try {
      if (!order) {
        var data = await window.AdminAPI.get("/admin/orders/" + id);
        order = data.order;
      }
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_load_order', 'Failed to load order'));
      return;
    }
    if (!order) return;

    var status = String(order.status || "PENDING").toUpperCase();
    var orderType = String(order.orderType || "dine-in").toLowerCase();

    document.getElementById("modalOrderId").textContent = order.orderId || "#0000";
    document.getElementById("modalCustomerName").textContent = order.customerName || "—";
    document.getElementById("modalCustomerPhone").textContent = order.customerPhone || "—";
    document.getElementById("modalCustomerEmail").textContent = (order.customer && order.customer.email) || "—";
    document.getElementById("modalOrderDate").textContent = window.AdminAPI.formatDateTime(order.createdAt || order.orderTime);
    document.getElementById("modalOrderType").textContent =
      orderType === "delivery" ? "Delivery" : (orderType === "takeaway" ? "Takeaway" : "Dine-in");
    if (orderType === "delivery") {
      var info = order.deliveryInfo || {};
      var addr = [info.subCity, info.location].filter(Boolean).join(", ");
      var addrLines = [];
      if (addr) addrLines.push(addr);
      if (info.phone) addrLines.push("Phone: " + info.phone);
      if (info.note) addrLines.push("Note: " + info.note);
      document.getElementById("modalTableNumber").textContent = addrLines.length ? addrLines.join(" · ") : "—";
    } else {
      document.getElementById("modalTableNumber").textContent = order.tableNumber || "N/A";
    }
    document.getElementById("modalPaymentMethod").textContent = order.paymentMethod || "—";
    document.getElementById("modalPaymentStatus").innerHTML = paymentBadge(order.paymentStatus);
    document.getElementById("modalTransactionId").textContent =
      (order.payment && order.payment.transactionId) || order.transactionId || "—";

    renderOrderItems(order.items);
    document.getElementById("modalSubtotal").textContent = money(order.subtotal) + " ETB";
    document.getElementById("modalServiceFee").textContent = money(order.serviceFee) + " ETB";
    document.getElementById("modalOrderTotal").textContent = money(order.totalAmount) + " ETB";

    document.getElementById("modalOrderTime").textContent = window.AdminAPI.formatDateTime(order.orderTime || order.createdAt);
    document.getElementById("modalReadyTime").textContent = order.readyTime ? window.AdminAPI.formatDateTime(order.readyTime) : "—";
    document.getElementById("modalCompletedTime").textContent = order.completedTime ? window.AdminAPI.formatDateTime(order.completedTime) : "—";

    var cancelInfo = "—";
    if (order.cancellation && (order.cancellation.reason || order.cancellation.requested)) {
      var parts = [];
      if (order.cancellation.reason) parts.push("Reason: " + order.cancellation.reason);
      if (order.cancellation.requested) parts.push("Requested");
      if (order.cancellation.adminNote) parts.push("Note: " + order.cancellation.adminNote);
      cancelInfo = parts.join(" · ") || "—";
    } else if (status === "CANCELLED") {
      cancelInfo = "Cancelled";
    }
    document.getElementById("modalCancellationInfo").textContent = cancelInfo;

    var refundInfoEl = document.getElementById("modalRefundInfo");
    if (refundInfoEl) {
      var rfndUp = String(order.refundStatus || "").toUpperCase();
      refundInfoEl.innerHTML = order.paymentStatus === "REFUNDED" || rfndUp === "REFUNDED"
        ? "Refunded" +
          (order.refundReference ? ' <small>(' + window.esc(order.refundReference) + ")</small>" : "") +
          (order.refundedAt ? " · " + window.AdminAPI.formatDateTime(order.refundedAt) : "")
        : (rfndUp === "REFUND_REQUESTED" || rfndUp === "REFUND_PROCESSING"
            ? "Refund Required" +
              (Number(order.refundAmount) > 0 ? " · " + money(order.refundAmount) + " ETB" : "") +
              " <small>(awaiting Manager/Admin processing)</small>"
            : "—");
    }
    var modalRefundBtn = document.getElementById("refundOrderBtn");
    if (modalRefundBtn) modalRefundBtn.style.display = refundEligible(order) ? "inline-flex" : "none";

    document.getElementById("modalStatusHistory").textContent = tr("loading_history", "Loading history...");
    window.AdminAPI.get("/admin/orders/" + order.id + "/history").then(function(data) {
      var history = data.history || [];
      document.getElementById("modalStatusHistory").innerHTML = history.length ? history.map(function(entry) { return '<div class="detail-item"><span>' + window.AdminAPI.formatDateTime(entry.createdAt) + '</span><strong>' + escapeHtml(entry.previousStatus) + ' → ' + escapeHtml(entry.newStatus) + (entry.changedBy ? ' · ' + escapeHtml(entry.changedBy.name) : '') + '</strong></div>'; }).join('') : tr('no_status_history', 'No status history available.');
    }).catch(function() { document.getElementById("modalStatusHistory").textContent = tr("status_history_unavailable", "Status history unavailable."); });

    window.__activeOrder = order;
    renderStatusSelect(status, order);
    openModal("orderDetailsModal");
  }

  async function saveOrderStatus() {
    var select = document.getElementById("updateOrderStatusSelect");
    var order = window.__activeOrder;
    if (!order || !select.value) {
      if (window.AdminToast) window.AdminToast.error("Select a status to apply");
      return;
    }

    try {
      await window.AdminAPI.patch("/admin/orders/" + order.id + "/status", { status: select.value });
      closeModal("orderDetailsModal");
      if (window.AdminToast) window.AdminToast.success("Order status updated to " + select.value);
      loadOrders();
      loadStats();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_update_status', 'Failed to update order status'));
    }
  }

  async function processOrderRefund() {
    var order = window.__activeOrder;
    if (!order) return;
    if (!window.confirm(tr("admin_confirm_refund", "Process refund for order #{orderId}? The payment status will become REFUNDED and the customer will be notified.", { orderId: order.orderId || "" }))) return;

    try {
      await window.AdminAPI.post("/admin/orders/" + order.id + "/refund", {});
      closeModal("orderDetailsModal");
      if (window.AdminToast) window.AdminToast.success("Refund processed for " + (order.orderId || "order"));
      loadOrders();
      loadStats();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_process_refund', 'Failed to process refund'));
    }
  }

  async function cancelCurrentOrder() {
    var order = window.__activeOrder;
    if (!order) return;

    window.__pendingCancelOrder = order;
    document.getElementById("cancelOrderId").textContent = order.orderId || "#0000";
    document.getElementById("cancelReasonSelect").value = "Cancelled by admin";
    document.getElementById("cancelReasonInput").value = "";
    openModal("cancelOrderModal");
  }

  async function confirmCancelOrder() {
    var order = window.__pendingCancelOrder;
    if (!order) return;

    var reason = document.getElementById("cancelReasonSelect").value;
    var note = document.getElementById("cancelReasonInput").value.trim();
    var confirmBtn = document.getElementById("confirmCancelOrderBtn");

    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cancelling...';

    try {
      await window.AdminAPI.patch("/admin/orders/" + order.id + "/cancel", {
        reason: reason || "Cancelled by admin",
        adminNote: note || reason || "Cancelled by admin"
      });
      closeModal("cancelOrderModal");
      if (window.AdminToast) window.AdminToast.success("Order " + order.orderId + " cancelled");

      var row = document.querySelector('[data-action="cancel"][data-id="' + order.id + '"]');
      if (row) {
        var tr = row.closest("tr");
        if (tr) {
          var statusCell = tr.querySelectorAll("td")[5];
          if (statusCell) statusCell.innerHTML = statusBadge("CANCELLED");
          var actionsCell = tr.querySelector(".table-actions");
          if (actionsCell) {
            var cancelBtnEl = actionsCell.querySelector('[data-action="cancel"]');
            if (cancelBtnEl) cancelBtnEl.remove();
          }
        }
      }

      loadStats();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_cancel_order', 'Failed to cancel order'));
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fa-solid fa-ban"></i> Cancel Order';
      window.__pendingCancelOrder = null;
    }
  }

  async function printReceipt() {
    var order = window.__activeOrder;
    if (!order) return;

    try {
      var data = await window.AdminAPI.get("/admin/orders/" + order.id + "/receipt");
      var receipt = data.receipt;
      if (!receipt) throw new Error("Receipt not found");

      var itemsHTML = (receipt.items || []).map(function(item) {
        return '<tr><td>' + escapeHtml(item.name) + '</td><td>' + money(item.unitPrice) + '</td><td>' + item.qty + '</td><td>' + money(item.subtotal) + '</td></tr>';
      }).join('');

      var printContent = `
        <html>
          <head>
            <title>Receipt - ${receipt.orderNumber}</title>
            <style>
              body { font-family: Arial, sans-serif; padding: 20px; }
              .receipt { max-width: 600px; margin: 0 auto; }
              .header { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #000; padding-bottom: 10px; }
              .header h1 { margin: 0; font-size: 24px; }
              .info-row { display: flex; justify-content: space-between; margin: 5px 0; }
              .info-label { font-weight: bold; }
              .items-table { width: 100%; margin: 20px 0; border-collapse: collapse; }
              .items-table th { text-align: left; border-bottom: 2px solid #000; padding: 5px 0; }
              .items-table td { padding: 8px 0; }
              .totals { margin-top: 20px; border-top: 2px solid #000; padding-top: 10px; }
              .total-row { display: flex; justify-content: space-between; margin: 5px 0; }
              .grand-total { font-weight: bold; font-size: 18px; }
              .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
              @media print { body { margin: 0; padding: 0; } }
            </style>
          </head>
          <body>
            <div class="receipt">
              <div class="header">
                <h1>Receipt</h1>
                <p>${receipt.orderNumber}</p>
              </div>

              <div class="info-row">
                <span class="info-label">Customer:</span>
                <span>${escapeHtml(receipt.customerName)}</span>
              </div>
              ${receipt.customerPhone ? '<div class="info-row"><span class="info-label">Phone:</span><span>' + escapeHtml(receipt.customerPhone) + '</span></div>' : ''}
              ${receipt.customerEmail ? '<div class="info-row"><span class="info-label">Email:</span><span>' + escapeHtml(receipt.customerEmail) + '</span></div>' : ''}

              <div class="info-row">
                <span class="info-label">Date:</span>
                <span>${window.AdminAPI.formatDateTime(receipt.orderDate)}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Type:</span>
                <span>${receipt.orderType || 'Dine-in'}</span>
              </div>

              <table class="items-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Unit Price</th>
                    <th>Qty</th>
                    <th>Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHTML}
                </tbody>
              </table>

              <div class="totals">
                <div class="total-row">
                  <span>Subtotal:</span>
                  <span>${money(receipt.subtotal)} ETB</span>
                </div>
                ${receipt.serviceFee ? '<div class="total-row"><span>Service Fee:</span><span>' + money(receipt.serviceFee) + ' ETB</span></div>' : ''}
                <div class="total-row grand-total">
                  <span>Total:</span>
                  <span>${money(receipt.total)} ETB</span>
                </div>
              </div>

              <div class="info-row">
                <span class="info-label">Payment Status:</span>
                <span>${receipt.paymentStatus || 'Pending'}</span>
              </div>
              ${receipt.paymentMethod ? '<div class="info-row"><span class="info-label">Payment Method:</span><span>' + escapeHtml(receipt.paymentMethod) + '</span></div>' : ''}

              <div class="footer">
                <p>Thank you for your order!</p>
                <p>Printed on ${new Date().toLocaleString()}</p>
              </div>
            </div>
          </body>
        </html>
      `;

      var printWindow = window.open('', '', 'height=600,width=800');
      printWindow.document.write(printContent);
      printWindow.document.close();
      printWindow.print();
      if (window.AdminToast) window.AdminToast.success("Opening receipt for printing...");
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_print_receipt', 'Failed to print receipt'));
    }
  }

  /* ============================================================
   * EVENT BINDINGS
   * ============================================================ */
  function bindEvents() {
    var refreshBtn = document.getElementById("refreshOrdersBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", function () {
      loadOrders();
      loadStats();
      if (window.AdminToast) window.AdminToast.show("Orders refreshed");
    });

    document.querySelectorAll("[data-close-modal]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        closeModal(btn.getAttribute("data-close-modal"));
      });
    });

    var searchInput = document.getElementById("orderSearchInput");
    if (searchInput) {
      var debounceTimer = null;
      searchInput.addEventListener("input", function () {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
          state.search = searchInput.value.trim();
          state.page = 1;
          loadOrders();
        }, 400);
      });
    }

    var statusFilter = document.getElementById("orderStatusFilter");
    if (statusFilter) {
      statusFilter.addEventListener("change", function () {
        state.status = statusFilter.value;
        state.page = 1;
        loadOrders();
      });
    }

    var paymentFilter = document.getElementById("paymentStatusFilter");
    if (paymentFilter) {
      paymentFilter.addEventListener("change", function () {
        state.paymentStatus = paymentFilter.value;
        state.page = 1;
        loadOrders();
      });
    }

    var typeFilter = document.getElementById("orderTypeFilter");
    if (typeFilter) {
      typeFilter.addEventListener("change", function () {
        state.orderType = typeFilter.value;
        state.page = 1;
        loadOrders();
      });
    }

    var dateRangeFilter = document.getElementById("orderDateRangeFilter");
    if (dateRangeFilter) {
      dateRangeFilter.addEventListener("change", function() {
        var container = document.getElementById("customDateRangeContainer");
        if (dateRangeFilter.value === "custom") {
          if (container) container.style.display = "block";
        } else {
          if (container) container.style.display = "none";
          var today = new Date();
          state.dateFrom = null;
          state.dateTo = null;
          
          switch(dateRangeFilter.value) {
            case "today":
              state.dateFrom = today.toISOString().split('T')[0];
              state.dateTo = today.toISOString().split('T')[0];
              break;
            case "yesterday":
              var yesterday = new Date(today);
              yesterday.setDate(yesterday.getDate() - 1);
              state.dateFrom = yesterday.toISOString().split('T')[0];
              state.dateTo = yesterday.toISOString().split('T')[0];
              break;
            case "last7":
              var sevenDaysAgo = new Date(today);
              sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
              state.dateFrom = sevenDaysAgo.toISOString().split('T')[0];
              state.dateTo = today.toISOString().split('T')[0];
              break;
            case "last30":
              var thirtyDaysAgo = new Date(today);
              thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
              state.dateFrom = thirtyDaysAgo.toISOString().split('T')[0];
              state.dateTo = today.toISOString().split('T')[0];
              break;
          }
          if (state.dateFrom) {
            state.page = 1;
            loadOrders();
          }
        }
      });
    }

    var applyDateRangeBtn = document.getElementById("applyDateRangeBtn");
    if (applyDateRangeBtn) {
      applyDateRangeBtn.addEventListener("click", function() {
        var dateFrom = document.getElementById("orderDateFrom");
        var dateTo = document.getElementById("orderDateTo");
        state.dateFrom = dateFrom ? dateFrom.value : null;
        state.dateTo = dateTo ? dateTo.value : null;
        state.page = 1;
        loadOrders();
      });
    }

    var sortSelect = document.getElementById("orderSortSelect");
    if (sortSelect) {
      sortSelect.addEventListener("change", function () {
        state.sort = sortSelect.value;
        state.page = 1;
        loadOrders();
      });
    }

    var resetBtn = document.getElementById("resetOrderFiltersBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (searchInput) searchInput.value = "";
        if (statusFilter) statusFilter.value = "";
        if (paymentFilter) paymentFilter.value = "";
        if (typeFilter) typeFilter.value = "";
        if (sortSelect) sortSelect.value = "newest";
        var dateRangeFilter = document.getElementById("orderDateRangeFilter");
        if (dateRangeFilter) dateRangeFilter.value = "";
        var customDateContainer = document.getElementById("customDateRangeContainer");
        if (customDateContainer) customDateContainer.style.display = "none";
        var dateFromInput = document.getElementById("orderDateFrom");
        var dateToInput = document.getElementById("orderDateTo");
        if (dateFromInput) dateFromInput.value = "";
        if (dateToInput) dateToInput.value = "";
        state.search = "";
        state.status = "";
        state.paymentStatus = "";
        state.orderType = "";
        state.sort = "newest";
        state.dateFrom = null;
        state.dateTo = null;
        state.page = 1;
        loadOrders();
      });
    }

    var prevBtn = document.getElementById("orderPrevPageBtn");
    var nextBtn = document.getElementById("orderNextPageBtn");
    if (prevBtn) prevBtn.addEventListener("click", function () { changePage(-1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { changePage(1); });

    var saveStatusBtn = document.getElementById("saveOrderStatusBtn");
    if (saveStatusBtn) saveStatusBtn.addEventListener("click", saveOrderStatus);

    var cancelBtn = document.getElementById("cancelOrderBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", cancelCurrentOrder);

    var refundOrderBtn = document.getElementById("refundOrderBtn");
    if (refundOrderBtn) refundOrderBtn.addEventListener("click", processOrderRefund);

    var confirmCancelBtn = document.getElementById("confirmCancelOrderBtn");
    if (confirmCancelBtn) confirmCancelBtn.addEventListener("click", confirmCancelOrder);

    var printReceiptBtn = document.getElementById("printReceiptBtn");
    if (printReceiptBtn) printReceiptBtn.addEventListener("click", printReceipt);

    var tbody = document.getElementById("ordersTableBody");
    if (tbody) {
      tbody.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        var id = btn.getAttribute("data-id");
        var action = btn.getAttribute("data-action");
        if (!id) return;

        if (action === "view") {
          var cached = (window.__ordersCache || []).find(function (o) { return o.id === id; });
          viewOrderDetails(id, cached);
        } else if (action === "cancel") {
          var order = (window.__ordersCache || []).find(function (o) { return o.id === id; });
          if (!order) return;
          window.__pendingCancelOrder = order;
          document.getElementById("cancelOrderId").textContent = order.orderId || "#0000";
          document.getElementById("cancelReasonSelect").value = "Cancelled by admin";
          document.getElementById("cancelReasonInput").value = "";
          openModal("cancelOrderModal");
        } else if (action === "refund") {
          // The review step of the refund workflow: open the cancelled order so
          // the customer, items, total and payment information are on screen
          // BEFORE any money moves. The modal footer holds the Refund button,
          // which asks for confirmation and then POSTs the refund.
          var refundOrder = (window.__ordersCache || []).find(function (o) { return o.id === id; });
          if (!refundOrder) return;
          window.__activeOrder = refundOrder;
          viewOrderDetails(id, refundOrder);
        }
      });
    }
  }

function init() {
    bindEvents();
    loadStats();
    loadOrders();

    // Initialize socket connection for real-time order updates
    initSocketUpdates();

    __registerLangChange(function () {
        try {
          loadOrders();
          loadStats();
          if (window.__activeOrder && document.getElementById("updateOrderStatusSelect")) {
            renderStatusSelect(String(window.__activeOrder.status || "PENDING").toUpperCase(), window.__activeOrder);
          }
        } catch (e) { /* best-effort re-render */ }
    });
}

/**
 * Set up socket.io real-time updates for new orders.
 * Kitchen staff receive order:new events and the All Orders list
 * is updated immediately without manual refresh.
 */
function initSocketUpdates() {
    // Connect to socket if not already connected and we have a token
    var token = localStorage.getItem("auth_token");
    var sc = window.socketClient || window.ScosSocketBridge || null;
    if (token && sc && !sc.connected) {
        sc.connect(token);
    }

    // Join kitchen room so we receive order:new events
    if (sc && sc.connected) {
        sc.socket.emit('join:kitchen');
    }

    // Listen for new order events from the kitchen
    if (sc) {
        sc.on('order:new', function (order) {
            // When a new order arrives, reload the orders list
            // The backend sorts by createdAt: -1, so the new order will appear at top
            loadOrders();
        });

        // Cancel/refund frames arrive as `order:status` and carry the refund
        // fields, so this is what drops the "Refund Required" badge the moment
        // a refund is processed (and raises it when a paid order is cancelled)
        // instead of waiting for a manual refresh. Debounced because a single
        // action can emit several frames.
        var statusReloadTimer = null;
        sc.on('order:status', function () {
            if (statusReloadTimer) clearTimeout(statusReloadTimer);
            statusReloadTimer = setTimeout(function () {
                loadOrders();
                loadStats();
            }, 300);
        });
    }

    // Handle disconnection - try to reconnect
    if (sc && sc.socket) {
        sc.socket.on('disconnect', function () {
            var token = localStorage.getItem("auth_token");
            if (token && sc && !sc.connected) {
                sc.connect(token);
            }
        });
    }
}

  document.addEventListener("DOMContentLoaded", init);
})();