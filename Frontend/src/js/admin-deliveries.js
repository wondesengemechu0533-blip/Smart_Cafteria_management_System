/**
 * Admin Delivery Management
 * - Lists delivery orders, assigns delivery staff, and optionally advances
 *   delivery status (out for delivery / delivered) on behalf of staff.
 */
(function () {
  "use strict";

  var STATUS_LABELS = {
    PENDING: "Pending",
    PREPARING: "Preparing",
    READY: "Ready",
    PICKED_UP: "Picked Up",
    OUT_FOR_DELIVERY: "Out for Delivery",
    DELIVERED: "Delivered",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled"
  };

  var STATUS_BADGE_CLASS = {
    PENDING: "badge-pending",
    PREPARING: "badge-preparing",
    READY: "badge-ready",
    PICKED_UP: "badge-picked-up",
    OUT_FOR_DELIVERY: "badge-out-for-delivery",
    DELIVERED: "badge-delivered",
    COMPLETED: "badge-completed",
    CANCELLED: "badge-cancelled"
  };

  var activeOrders = [];
  var deliveredOrders = [];
  var deliveryStaff = [];
  var currentFilter = "ALL";

  function normalizeStatus(s) {
    return (s || "").toString().trim().toUpperCase().replace(/\s+/g, "_");
  }

  function statusLabel(s) {
    return STATUS_LABELS[normalizeStatus(s)] || s || "—";
  }

  function statusBadge(s) {
    var n = normalizeStatus(s);
    return '<span class="badge ' + (STATUS_BADGE_CLASS[n] || "badge-pending") + '">' + window.esc(statusLabel(n)) + "</span>";
  }

  function formatDateTime(value) {
    if (!value) return "—";
    var d = new Date(value);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function formatMoney(v) {
    return Number(v || 0).toFixed(2) + " ETB";
  }

  function addressLine(order) {
    var info = order.deliveryInfo || {};
    var parts = [info.subCity, info.location].filter(Boolean);
    return parts.join(", ") || "—";
  }

  function itemSummary(order) {
    var items = order.items || [];
    if (!items.length) return "—";
    return items.map(function (i) {
      return (Number(i.quantity) || 1) + "x " + (i.name || "Item");
    }).join(", ");
  }

  async function loadStats() {
    try {
      var res = await window.AdminAPI.get("/deliveries/stats");
      var stats = res.stats || {};
      document.getElementById("statReady").textContent = stats.ready || 0;
      document.getElementById("statOutForDelivery").textContent = stats.outForDelivery || 0;
      document.getElementById("statDelivered").textContent = stats.delivered || 0;
      document.getElementById("statUnassigned").textContent = stats.unassigned || 0;
    } catch (e) {
      console.warn("Could not load delivery stats:", e.message);
    }
  }

  async function loadStaff() {
    try {
      var res = await window.AdminAPI.get("/deliveries/staff");
      deliveryStaff = res.staff || [];
    } catch (e) {
      deliveryStaff = [];
    }
  }

  function staffSelectHtml(order) {
    var current = order.deliveryStaffAssigned ? order.deliveryStaffAssigned.id || order.deliveryStaffAssigned._id : "";
    var currentName = order.deliveryStaffAssigned ? order.deliveryStaffAssigned.name : "";
    var html = '<select class="delivery-staff-select" data-order="' + window.esc(order.orderId) + '" title="Assign delivery staff" style="padding:6px 8px;border-radius:8px;border:1px solid #e2e8f0;max-width:190px;font-size:13px;">';
    if (current) {
      html += '<option value="" disabled selected>' + window.esc(currentName) + " ✓</option>";
      html += '<option value="" disabled>──────────</option>';
    } else {
      html += '<option value="" selected disabled>Unassigned — select staff</option>';
    }
    deliveryStaff.forEach(function (staff) {
      html += '<option value="' + window.esc(staff.id) + '">' + window.esc(staff.name) + "</option>";
    });
    html += "</select>";
    return html;
  }

  function actionButtons(order) {
    var s = normalizeStatus(order.status);
    if (["DELIVERED", "CANCELLED", "COMPLETED"].indexOf(s) !== -1) return "—";

    var buttons = [];
    if (s === "READY" || s === "PICKED_UP") {
      buttons.push('<button class="btn btn-sm btn-outline-warning out-delivery-action" data-order="' + window.esc(order.orderId) + '">Out for Delivery</button>');
    }
    if (s === "OUT_FOR_DELIVERY") {
      buttons.push('<button class="btn btn-sm btn-outline-success delivered-action" data-order="' + window.esc(order.orderId) + '">Mark Delivered</button>');
    }
    return buttons.length ? buttons.join(" ") : '<span class="text-muted">—</span>';
  }

  function renderActive() {
    var body = document.getElementById("deliveriesTableBody");
    var shownCount = document.getElementById("deliveryCountBadge");
    if (shownCount) shownCount.textContent = activeOrders.length;

    if (!activeOrders.length) {
      body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">No delivery orders found.</td></tr>';
      return;
    }

    var html = "";
    activeOrders.forEach(function (order) {
      var s = normalizeStatus(order.status);
      if (currentFilter !== "ALL" && s !== currentFilter) return;
      html += "<tr>";
      html += '<td><strong>#' + window.esc(order.orderId) + "</strong><br><small>" + formatDateTime(order.createdAt || order.orderTime) + "</small></td>";
      html += "<td><strong>" + window.esc(order.customerName) + "</strong><br><small>"
        + window.esc((order.deliveryInfo && order.deliveryInfo.phone) || order.customerPhone || "—")
        + "</small></td>";
      html += "<td>" + window.esc(addressLine(order)) + "</td>";
      html += "<td><small>" + window.esc(itemSummary(order)) + "</small></td>";
      html += "<td><strong>" + formatMoney(order.totalAmount) + "</strong></td>";
      html += "<td>" + statusBadge(s) + "</td>";
      html += "<td>" + staffSelectHtml(order) + "</td>";
      html += "<td>" + actionButtons(order) + "</td>";
      html += "</tr>";
    });

    if (html === "") {
      html = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">No orders match the selected filter.</td></tr>';
    }
    body.innerHTML = html;
  }

  function renderCompleted() {
    var body = document.getElementById("deliveredTableBody");
    if (!deliveredOrders.length) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:24px;">No completed / cancelled deliveries yet.</td></tr>';
      return;
    }
    var html = "";
    deliveredOrders.forEach(function (order) {
      var staff = order.deliveryStaffAssigned;
      html += "<tr>";
      html += '<td><strong>#' + window.esc(order.orderId) + "</strong><br><small>" + formatDateTime(order.createdAt) + "</small></td>";
      html += "<td>" + window.esc(order.customerName) + "</td>";
      html += "<td>" + window.esc(addressLine(order)) + "</td>";
      html += "<td>" + formatMoney(order.totalAmount) + "</td>";
      html += "<td>" + statusBadge(normalizeStatus(order.status)) + "</td>";
      html += "<td>" + (staff ? window.esc(staff.name) : "—") + "</td>";
      html += "</tr>";
    });
    body.innerHTML = html;
  }

  async function loadAll() {
    try {
      var params = { status: currentFilter };
      var res = await window.AdminAPI.get("/deliveries", params);
      activeOrders = res.orders || [];

      var done = await window.AdminAPI.get("/deliveries", { report: "completed" });
      deliveredOrders = done.orders || [];

      renderActive();
      renderCompleted();
      loadStats();
    } catch (e) {
      var body = document.getElementById("deliveriesTableBody");
      if (body) body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#dc2626;padding:24px;">Failed to load deliveries: ' + window.esc(e.message) + "</td></tr>";
    }
  }

  async function assignStaff(orderId, staffId) {
    var staff = deliveryStaff.find(function (s) { return String(s.id) === String(staffId); });
    if (!staff) {
      window.AdminToast.error("Please select a delivery staff member first.");
      return;
    }
    var order = activeOrders.find(function (o) { return o.orderId === orderId; });
    var currentId = order && order.deliveryStaffAssigned ? String(order.deliveryStaffAssigned.id || order.deliveryStaffAssigned._id) : "";
    if (currentId && currentId !== String(staffId)) {
      if (!window.confirm("Reassign order #" + orderId + " from the current staff to " + staff.name + "?")) return;
    }
    try {
      var res = await window.AdminAPI.patch("/deliveries/" + encodeURIComponent(orderId) + "/assign", { deliveryStaffId: staffId });
      window.AdminToast.success(res.message || "Delivery staff assigned.");
      loadAll();
    } catch (e) {
      window.AdminToast.error(e.message);
    }
  }

  async function markOutForDelivery(orderId) {
    if (!window.confirm("Mark order #" + orderId + " as out for delivery?")) return;
    try {
      var res = await window.AdminAPI.patch("/deliveries/" + encodeURIComponent(orderId) + "/out-for-delivery", {});
      window.AdminToast.success(res.message || "Order marked out for delivery.");
      loadAll();
    } catch (e) {
      window.AdminToast.error(e.message);
    }
  }

  async function markDelivered(orderId) {
    if (!window.confirm("Mark order #" + orderId + " as delivered?")) return;
    try {
      var res = await window.AdminAPI.patch("/deliveries/" + encodeURIComponent(orderId) + "/delivered", {});
      window.AdminToast.success(res.message || "Order marked as delivered.");
      loadAll();
    } catch (e) {
      window.AdminToast.error(e.message);
    }
  }

  function bindEvents() {
    var filter = document.getElementById("deliveryFilter");
    if (filter) {
      filter.addEventListener("change", function () {
        currentFilter = filter.value;
        loadAll();
      });
    }

    var refreshBtn = document.getElementById("refreshDeliveriesBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", loadAll);

    document.addEventListener("change", function (e) {
      var select = e.target.closest(".delivery-staff-select");
      if (select) {
        var orderId = select.getAttribute("data-order");
        if (select.value) assignStaff(orderId, select.value);
        select.value = "";
        return;
      }
    });

    document.addEventListener("click", function (e) {
      var outBtn = e.target.closest(".out-delivery-action");
      if (outBtn) {
        markOutForDelivery(outBtn.getAttribute("data-order"));
        return;
      }
      var deliveredBtn = e.target.closest(".delivered-action");
      if (deliveredBtn) {
        markDelivered(deliveredBtn.getAttribute("data-order"));
      }
    });
  }

  function setupSocket() {
    if (!window.io || typeof window.io !== "function") return;
    var token = localStorage.getItem("auth_token");
    var socket;
    try {
      socket = window.io(window.SOCKET_URL || undefined, {
        transports: ["websocket", "polling"],
        auth: token ? { token: token } : undefined
      });
    } catch (e) {
      return;
    }
    socket.on("connect", function () {
      socket.emit("join:admin", {});
      socket.emit("join:delivery", {});
    });
    ["delivery:new", "delivery:assigned", "order:status"].forEach(function (event) {
      socket.on(event, function () {
        loadAll();
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    loadStaff().then(loadAll);
    bindEvents();
    setupSocket();
  });
})();