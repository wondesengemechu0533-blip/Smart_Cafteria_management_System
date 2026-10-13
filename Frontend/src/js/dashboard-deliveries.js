/**
 * Delivery Assignment on the Cafeteria Manager Dashboard.
 *
 * Reuses the EXISTING delivery system - there is no second assignment store and
 * no mock data. Every value below comes from the same backend endpoints the
 * Delivery Orders page already uses:
 *
 *   GET   /api/v1/deliveries          -> eligible delivery orders
 *   GET   /api/v1/deliveries/staff    -> selectable delivery staff
 *   PATCH /api/v1/deliveries/:id/assign
 *
 * The PATCH is the single source of truth for an assignment: the backend writes
 * Order.deliveryStaffAssigned + Delivery.deliveryPerson, and emits
 * `delivery:assigned` to the selected rider's own `user:<id>` room, which their
 * dashboard listens for. This module only reflects that response - it never
 * assigns anything client-side.
 */

(function () {
  "use strict";

  var POLL_INTERVAL_MS = 30000;
  var orders = [];
  var staff = [];
  var loadInFlight = false;
  var pollTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    if (window.esc) return window.esc(value);
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function tr(key, fallback) {
    if (window.tr) return window.tr(key, fallback);
    return fallback;
  }

  function money(value) {
    var n = Number(value || 0);
    return n.toFixed(2) + " ETB";
  }

  function formatDateTime(value) {
    if (!value) return "—";
    var d = new Date(value);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  // The delivery state machine is authoritative: ASSIGNED / ACCEPTED are both
  // mirrored onto the order as PENDING, so order.status alone would show a
  // brand-new assignment as "Pending".
  function deliveryState(o) {
    return String(o && (o.deliveryStatus || o.status) || "").toLowerCase();
  }

  var STATE_LABELS = {
    requested: ["delivery_state_awaiting_assignment", "Awaiting Assignment"],
    assigned: ["delivery_state_assigned", "Assigned"],
    accepted: ["delivery_state_accepted", "Accepted"],
    picked_up: ["delivery_state_picked_up", "Picked Up"],
    out_for_delivery: ["delivery_state_out_for_delivery", "Out for Delivery"],
    arrived: ["delivery_state_arrived", "Arrived"],
    delivered: ["delivery_state_delivered", "Delivered"],
    failed: ["delivery_state_failed", "Failed"],
    cancelled: ["delivery_state_cancelled", "Cancelled"],
  };

  // Same badge vocabulary the Delivery Orders page already uses, so the two
  // screens look identical.
  var STATE_BADGE = {
    requested: "badge-pending",
    assigned: "badge-out-for-delivery",
    accepted: "badge-out-for-delivery",
    picked_up: "badge-picked-up",
    out_for_delivery: "badge-out-for-delivery",
    arrived: "badge-delivered",
    delivered: "badge-delivered",
    completed: "badge-completed",
    ready: "badge-ready",
    failed: "badge-failed",
    cancelled: "badge-cancelled",
  };

  function stateBadge(o) {
    var s = deliveryState(o);
    var pair = STATE_LABELS[s];
    var label = pair ? tr(pair[0], pair[1]) : (o.deliveryStatusLabel || s || "—");
    return '<span class="badge ' + (STATE_BADGE[s] || "badge-pending") + '">' + esc(label) + "</span>";
  }

  function addressLine(o) {
    if (o.deliveryAddress) return o.deliveryAddress;
    var info = o.deliveryInfo || {};
    return [info.subCity, info.location].filter(Boolean).join(", ") || "—";
  }

  function itemSummary(o) {
    var items = o.items || [];
    if (!items.length) return "—";
    return items
      .map(function (i) { return (Number(i.quantity) || 1) + "x " + (i.name || "Item"); })
      .join(", ");
  }

  /**
   * Whether a rider may be assigned.
   *
   * `GET /deliveries/staff` returns a server-computed `isActive` (which already
   * folds together account status and the isActive flag). Prefer that; only
   * fall back to the raw fields when it is absent. An earlier version required
   * `status === 'ACTIVE'`, but that field is not guaranteed to be present in
   * the payload - which silently produced an EMPTY selector and made it
   * impossible for a manager to assign anybody.
   */
  function isStaffActive(u) {
    if (!u) return false;
    if (typeof u.isActive === "boolean") return u.isActive;
    if (u.status === undefined) return true; // no status info: do not hide riders
    return String(u.status).toUpperCase() === "ACTIVE" && u.isActive !== false;
  }

  /** A delivery that has reached a terminal state (completed / failed / cancelled). */
  function isTerminal(o) {
    if (!o) return true;
    if (typeof o.isTerminal === "boolean") return o.isTerminal;
    var s = deliveryState(o);
    return s === "completed" || s === "failed" || s === "cancelled";
  }

  /** A delivery the manager may still attach a courier to. */
  function isEligible(o) {
    if (!o) return false;
    if (isTerminal(o)) return false;
    var s = deliveryState(o);
    return s === "requested" || s === "assigned" || s === "accepted" || s === "ready";
  }

  function activeStaffCount(staffId) {
    return orders.filter(function (o) {
      return String(o.deliveryPersonId || "") === String(staffId);
    }).length;
  }

  function renderStats() {
    var eligible = orders.filter(isEligible);
    var unassigned = eligible.filter(function (o) { return !o.deliveryStaffAssigned; });
    setText("dashDeliveryUnassigned", unassigned.length);
    setText("dashDeliveryAssigned", eligible.length - unassigned.length);
    setText("dashDeliveryActive", orders.filter(function (o) { return !isTerminal(o); }).length);
    setText("dashDeliveryStaff", staff.filter(isStaffActive).length);
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  function staffSelectHtml(o) {
    var current = o.deliveryStaffAssigned
      ? (o.deliveryStaffAssigned.id || o.deliveryStaffAssigned._id)
      : "";
    var currentName = o.deliveryStaffAssigned ? o.deliveryStaffAssigned.name : "";
    var orderId = esc(o.orderId);

    var html =
      '<select class="form-select form-select-sm dash-delivery-staff-select" ' +
      'data-order="' + orderId + '" ' +
      'style="min-width:170px">' +
      '<option value="">' + esc(tr("dash_delivery_choose_staff", "Select delivery staff")) + "</option>";

    if (current) {
      html +=
        '<option value="' + esc(currentName ? currentName + " ✓" : "Assigned") + '" disabled selected>' +
        esc(currentName ? currentName + " ✓" : "Assigned") +
        "</option>";
    }

    staff.filter(isStaffActive).forEach(function (u) {
      var id = u.id || u._id;
      var load = activeStaffCount(id);
      var suffix = load > 0 ? " (" + load + " " + tr("dash_delivery_active_jobs", "active") + ")" : "";
      html += '<option value="' + esc(id) + '">' + esc((u.name || "Rider") + suffix) + "</option>";
    });

    html += "</select>";
    return html;
  }

  function render() {
    var tbody = $("dashDeliveryTableBody");
    if (!tbody) return;

    // Every delivery order for this cafeteria is listed, not just the ones still
    // waiting for a courier. The rows used to be filtered down to `isEligible`,
    // which hid picked-up / out-for-delivery / arrived / delivered orders and
    // everything already finished. The Assign control below stays gated.
    if (!orders.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="table-empty">' +
        esc(tr("dash_delivery_none_all", "No delivery orders yet.")) +
        "</td></tr>";
      renderStats();
      return;
    }

    var html = "";
    orders.forEach(function (o) {
      var assigned = Boolean(o.deliveryStaffAssigned);
      var canAssign = isEligible(o) && !assigned;
      html += "<tr>";
      html += '<td><strong>#' + esc(o.orderId) + "</strong><br><small>" +
        esc(formatDateTime(o.createdAt || o.orderTime)) + "</small></td>";
      html += "<td>" + esc(o.customerName || "—") + "</td>";
      html += '<td><small>' + esc(addressLine(o)) + "</small></td>";
      html += '<td><small>' + esc(itemSummary(o)) + "</small></td>";
      html += "<td><strong>" + esc(money(o.totalAmount)) + "</strong></td>";
      html += "<td>" + stateBadge(o) + "</td>";
      html += "<td>" + staffSelectHtml(o) + "</td>";
      // The Assign button is disabled until a staff member is chosen, and is
      // shown only while the delivery still needs a courier.
      html += '<td class="text-nowrap">' +
        (assigned
          ? '<span class="text-muted small">' + esc(tr("dash_delivery_assigned_to", "Assigned")) + "</span>"
          : canAssign
            ? '<button class="btn btn-sm btn-primary dash-delivery-assign-btn" data-order="' +
              esc(o.orderId) + '">' + esc(tr("dash_delivery_assign", "Assign")) + "</button>"
            : '<span class="text-muted small">&mdash;</span>') +
        "</td>";
      html += "</tr>";
    });

    tbody.innerHTML = html;
    renderStats();
  }

  function showError(message) {
    var banner = $("dashDeliveryError");
    if (!banner) return;
    banner.style.display = "block";
    banner.textContent = "⚠️ " + message;
  }

  function hideError() {
    var banner = $("dashDeliveryError");
    if (banner) banner.style.display = "none";
  }

  function toast(message, kind) {
    if (window.AdminToast && window.AdminToast.show) {
      window.AdminToast.show(message, kind);
    }
  }

  async function load() {
    if (loadInFlight) return;
    loadInFlight = true;
    try {
      // Staff first: the select is unusable without it.
      try {
        var staffRes = await window.AdminAPI.get("/deliveries/staff");
        staff = staffRes.staff || [];
      } catch (e) {
        staff = [];
      }

      var res = await window.AdminAPI.get("/deliveries", { status: "ALL" });
      orders = res.orders || [];
      render();
      hideError();
    } catch (e) {
      showError(
        (e && e.message) || tr("dash_delivery_load_failed", "Failed to load deliveries.")
      );
    } finally {
      loadInFlight = false;
    }
  }

  async function assign(orderId, staffId) {
    if (!staffId) {
      toast(tr("dash_delivery_pick_staff", "Please select a delivery staff member first."));
      return;
    }
    var chosen = staff.filter(function (u) { return String(u.id || u._id) === String(staffId); })[0];
    if (!chosen) {
      toast(tr("dash_delivery_pick_staff", "Please select a delivery staff member first."));
      return;
    }
    if (!window.confirm(
      tr("dash_delivery_confirm_assign", "Assign order #{order} to {name}?", {
        order: orderId, name: chosen.name,
      })
    )) return;

    var btn = document.querySelector('.dash-delivery-assign-btn[data-order="' + cssEscape(orderId) + '"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    try {
      // The ONE real assignment call. The backend persists it and emits
      // delivery:assigned to the selected rider's own socket room.
      var res = await window.AdminAPI.patch(
        "/deliveries/" + encodeURIComponent(orderId) + "/assign",
        { deliveryStaffId: staffId }
      );
      toast(res.message || tr("dash_delivery_assigned_ok", "Delivery staff assigned."));
      // Re-read from the server so the row shows the persisted truth.
      await load();
    } catch (e) {
      toast((e && e.message) || tr("dash_delivery_assign_failed", "Failed to assign delivery staff."));
      if (btn) {
        btn.disabled = false;
        btn.textContent = tr("dash_delivery_assign", "Assign");
      }
    }
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function onClick(e) {
    var btn = e.target.closest(".dash-delivery-assign-btn");
    if (!btn) return;
    var orderId = btn.getAttribute("data-order");
    var tbody = $("dashDeliveryTableBody");
    var row = btn.closest("tr");
    var select = row ? row.querySelector(".dash-delivery-staff-select") : null;
    if (orderId) assign(orderId, select ? select.value : "");
  }

  function bind() {
    var card = $("dashDeliveryCard");
    if (!card) return;
    card.addEventListener("click", onClick);

    var refreshBtn = $("dashDeliveryRefreshBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", function () { load(); });

    // Polling fallback so a kitchen "Send to Delivery" shows up here even if
    // the socket event is missed. The socket listener below is the fast path.
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      load();
    }, POLL_INTERVAL_MS);

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) load();
    });
    window.addEventListener("pagehide", function () {
      if (pollTimer) clearInterval(pollTimer);
    });
  }

  function setupSocket() {
    // Prefer the shared bridge client when the page loaded it, otherwise talk
    // to the Socket.IO server directly exactly like admin-deliveries.js does.
    var listen = function (target) {
      ["delivery:new", "delivery:assigned", "delivery:retried", "delivery:unassigned", "order:status", "delivery:staff"]
        .forEach(function (event) {
          target.on(event, function () { load(); });
        });
    };

    if (window.socketClient && typeof window.socketClient.on === "function") {
      listen(window.socketClient);
      return;
    }
    if (typeof window.io !== "function") return; // socket optional; polling covers it

    try {
      var token = localStorage.getItem("auth_token") || localStorage.getItem("token") || "";
      var socket = window.io(window.SOCKET_URL || undefined, {
        auth: { token: token },
        transports: ["websocket", "polling"],
      });
      if (!socket) return;
      listen(socket);
      socket.on("connect", function () {
        socket.emit("join:admin", {});
        socket.emit("join:delivery", {});
        load();
      });
    } catch (e) {
      // A missing socket only costs live updates; the poll still refreshes.
    }
  }

  function init() {
    if (!$("dashDeliveryTableBody")) return;
    bind();
    setupSocket();
    load();
  }

  window.AdminDashboardDeliveries = {
    init: init,
    load: load,
    refresh: load,
    assign: assign,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
