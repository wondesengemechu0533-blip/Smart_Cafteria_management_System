/**
 * Manager Delivery Staff Management
 * - Fetches delivery staff list from backend
 * - Provides Add/Edit/Delete/Toggle Availability functionality
 * - Shows status colors: Green=Available, Orange=On Delivery, Gray=Offline
 * - Real-time updates via Socket.IO
 */

(function () {
  "use strict";

  var deliveryStaff = [];
  var staffStatusColors = {
    available: "bg-success",
    on_delivery: "bg-warning",
    offline: "bg-secondary"
  };
  var staffStatusLabels = {
    available: "Available",
    on_delivery: "On Delivery",
    offline: "Offline"
  };

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

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  function renderStatusBadge(status) {
    var normalized = (status || "").toLowerCase();
    var colorClass = staffStatusColors[normalized] || staffStatusColors.offline;
    var label = staffStatusLabels[normalized] || staffStatusLabels.offline;
    return '<span class="badge ' + colorClass + '">' + esc(label) + "</span>";
  }

  function renderStaffRow(staff) {
    var activeDeliveries = staff.activeDeliveries || 0;
    var statusBadge = renderStatusBadge(staff.status);
    var onlineClass = staff.isOnline ? "online" : "";
    var locationHtml = "";

    if (staff.lastKnownLocation && staff.lastKnownLocation.latitude !== null) {
      locationHtml = '<br><small style="color:#64748b;">' +
        'GPS: ' + staff.lastKnownLocation.latitude.toFixed(4) + ', ' +
        staff.lastKnownLocation.longitude.toFixed(4) + '</small>';
    }

    var assignBtn = '';
    if (staff.isAvailable) {
      assignBtn = '<button class="btn btn-sm btn-outline-primary assign-staff-btn" data-staff-id="' + esc(staff.id) + '" title="Assign to delivery">' +
        '<i class="fa-solid fa-truck"></i>' +
        '</button>';
    } else {
      assignBtn = '<span class="text-muted small">-' +
        ' <i class="fa-solid fa-lock"></i>' +
        '</span>';
    }

    // Every rider gets the order list, available or not: a manager checking
    // "who is carrying what" must not be blocked by the availability toggle.
    var ordersBtn = '<button type="button" class="btn btn-sm btn-outline-secondary staff-orders-btn" ' +
      'data-staff-id="' + esc(staff.id) + '" ' +
      'title="' + esc(tr("mgr_staff_orders_view", "View delivery orders")) + '">' +
      '<i class="fa-solid fa-boxes-stacked"></i>' +
      '</button>';

    return (
      '<tr>' +
      '<td>' + esc(staff.name) + '</td>' +
      '<td>' + esc(staff.phone) + '</td>' +
      '<td>' + esc(staff.email) + '</td>' +
      '<td>' + esc(staff.username || "—") + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td>' +
      (activeDeliveries > 0 ?
        '<span class="text-primary small">' + esc(activeDeliveries) + ' ' + tr("dash_delivery_active_jobs", "active") + '</span>' :
        '<span class="text-muted small">—</span>') +
      '</td>' +
      '<td><span style="display:inline-flex;gap:6px;align-items:center;">' + ordersBtn + assignBtn + '</span></td>' +
      '</tr>'
    );
  }

  function renderStaffTable() {
    var tbody = $("deliveryStaffTableBody");
    if (!tbody) return;

    if (!deliveryStaff.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="table-empty">' +
        esc(tr("mgr_staff_empty", "No delivery staff yet. Use \"Add Delivery Staff\" to hire a rider.")) +
        "</td></tr>";
      return;
    }

    var html = deliveryStaff
      .map(function (staff) { return renderStaffRow(staff); })
      .join("");
    tbody.innerHTML = html;
  }

  function loadStaff() {
    var token = localStorage.getItem("auth_token");
    if (!token) {
      setText("deliveryStaffTableBody", "");
      return;
    }

    window.AdminAPI.get("/deliveries/staff")
      .then(function (res) {
        deliveryStaff = res.staff || [];
        renderStaffTable();

        // Update stats
        var activeCount = deliveryStaff.filter(function (s) { return s.isAvailable; }).length;
        setText("dashDeliveryStaff", activeCount);
      })
      .catch(function (err) {
        console.error("Failed to load delivery staff:", err);
        setText("deliveryStaffTableBody", '<tr><td colspan="7" class="table-empty" style="color:#dc2626;">' +
          esc(tr("mgr_staff_load_failed", "Failed to load delivery staff.")) + "</td></tr>");
      });
  }

  function toggleAvailability(staffId) {
    var staff = deliveryStaff.find(function (s) { return s.id === staffId || s._id === staffId; });
    if (!staff) return;

    var newStatus = staff.isAvailable ? "unavailable" : "available";
    var targetStatus = staff.isAvailable ? "AVAILABLE" : "UNAVAILABLE";

    window.AdminAPI.patch("/deliveries/staff/" + staffId + "/availability", { isAvailable: staff.isAvailable !== false })
      .then(function (res) {
        // Refresh the list
        loadStaff();

        // Show success notification
        if (window.AdminToast && window.AdminToast.show) {
          window.AdminToast.show(
            res.message || "Staff availability updated successfully.",
            "success"
          );
        }
      })
      .catch(function (err) {
        console.error("Failed to update staff availability:", err);
        if (window.AdminToast) window.AdminToast.error(err.message || "Failed to update staff availability.");
      });
  }

  function deleteStaff(staffId) {
    if (!window.confirm("Are you sure you want to delete this delivery staff member?")) return;

    window.AdminAPI.delete("/deliveries/staff/" + staffId)
      .then(function (res) {
        loadStaff();
        if (window.AdminToast && window.AdminToast.show) {
          window.AdminToast.show(
            res.message || "Delivery staff removed successfully.",
            "success"
          );
        }
      })
      .catch(function (err) {
        console.error("Failed to delete staff:", err);
        if (window.AdminToast) window.AdminToast.error(err.message || "Failed to remove delivery staff.");
      });
  }

  function initAddStaffForm() {
    var form = document.getElementById("addDeliveryStaffForm");
    if (!form) return;

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      var name = document.getElementById("staffName").value.trim();
      var phone = document.getElementById("staffPhone").value.trim();
      var email = document.getElementById("staffEmail").value.trim();
      var username = document.getElementById("staffUsername").value.trim();
      var password = document.getElementById("staffPassword").value.trim();
      var confirmPassword = document.getElementById("staffConfirmPassword").value.trim();

      // Validate required fields
      if (!name || !phone || !email || !password) {
        showFormError("All required fields must be filled out.");
        return;
      }

      // Validate password match
      if (password !== confirmPassword) {
        showFormError("Passwords do not match.");
        return;
      }

      // Validate password length
      if (password.length < 8) {
        showFormError("Password must be at least 8 characters.");
        return;
      }

      // Send to backend
      window.AdminAPI.post("/deliveries/staff", {
        name: name,
        phone: phone,
        email: email,
        username: username,
        password: password
      })
      .then(function (res) {
        // Close modal (the overlay IS #addDeliveryStaffModal)
        closeModal("addDeliveryStaffModal");

        // Refresh staff list
        loadStaff();

        // Show success
        if (window.AdminToast && window.AdminToast.show) {
          window.AdminToast.show(
            res.message || "Delivery Staff added successfully.",
            "success"
          );
        }
      })
      .catch(function (err) {
        console.error("Failed to create delivery staff:", err);
        showFormError(err.message || "Failed to create delivery staff. Please try again.");
      });
    });
  }

  function showFormError(message) {
    var errorDiv = document.getElementById("addDeliveryStaffError");
    if (errorDiv) {
      errorDiv.style.display = "block";
      errorDiv.textContent = message;
    }
    if (window.AdminToast) window.AdminToast.error(message);
  }

  function initToggleButtons() {
    // Attach click handlers to status toggle buttons
    document.addEventListener("click", function (e) {
      var toggleBtn = e.target.closest(".toggle-staff-availability");
      if (!toggleBtn) return;

      var staffId = toggleBtn.getAttribute("data-staff-id");
      if (staffId) toggleAvailability(staffId);
    });
  }

  // -------------------------------------------------------------------------
  // Delivery orders for ONE rider (opened from the "Delivery Orders" button)
  // -------------------------------------------------------------------------
  //
  // Reads GET /deliveries/staff/:staffId/orders, which applies the exact same
  // status semantics as the dispatch board (GET /deliveries), so this list can
  // never disagree with the Delivery Orders screen.

  var STAFF_ORDERS_QUERY = {
    active: { status: "ACTIVE" },
    all: { status: "ALL" },
    completed: { report: "completed" },
    failed: { report: "failed" },
    cancelled: { report: "cancelled" }
  };

  var STATUS_LABEL_KEYS = {
    PENDING: "status_pending",
    PREPARING: "status_preparing",
    READY: "status_ready",
    PICKED_UP: "status_picked_up",
    SERVED: "status_served",
    OUT_FOR_DELIVERY: "status_out_for_delivery",
    ARRIVED: "status_arrived",
    DELIVERED: "status_delivered",
    COMPLETED: "status_completed",
    FAILED: "status_failed",
    CANCELLED: "status_cancelled"
  };

  var STATUS_BADGE_CLASSES = {
    PENDING: "pend",
    PREPARING: "prep",
    READY: "rd",
    PICKED_UP: "pu",
    SERVED: "svd",
    OUT_FOR_DELIVERY: "od",
    ARRIVED: "del",
    DELIVERED: "del",
    COMPLETED: "cmp",
    FAILED: "cxl",
    CANCELLED: "cxl"
  };

  var staffOrdersState = { staffId: null, filter: "active" };

  function openModal(id) {
    var el = $(id);
    if (el) el.classList.add("open");
  }

  function closeModal(id) {
    var el = $(id);
    if (el) el.classList.remove("open");
  }

  function orderStatusLabel(status) {
    var s = String(status || "").toUpperCase();
    if (window.translateStatus) {
      var localized = window.translateStatus(s);
      if (localized && String(localized).toUpperCase() !== s) return localized;
    }
    var key = STATUS_LABEL_KEYS[s];
    if (key) {
      var value = tr(key, "");
      if (value && value !== key) return value;
    }
    return s ? s.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : "—";
  }

  function orderStatusBadge(status) {
    var s = String(status || "PENDING").toUpperCase();
    var cls = STATUS_BADGE_CLASSES[s] || "pend";
    return '<span class="order-badge ' + cls + '">' + esc(orderStatusLabel(s)) + "</span>";
  }

  function renderStaffOrdersMeta(staff, shown) {
    var meta = $("staffOrdersMeta");
    if (!meta) return;
    var html = "<strong>" + esc(staff.name || "") + "</strong>";
    if (staff.phone) html += " · " + esc(staff.phone);
    html += ' <span style="color:#94a3b8;">|</span> ' +
      esc(staff.activeDeliveries || 0) + " " + esc(tr("mgr_staff_orders_active", "active")) +
      " · " + esc(shown) + " " + esc(tr("mgr_staff_orders_shown", "shown"));
    meta.innerHTML = html;
  }

  function ordersRowMessage(message, color) {
    return '<tr><td colspan="6" class="table-empty" style="color:' + color + ';">' +
      esc(message) + "</td></tr>";
  }

  function renderStaffOrdersRow(order) {
    var items = order.items || [];
    var summary = items
      .slice(0, 2)
      .map(function (i) { return (Number(i.quantity) || 1) + "× " + (i.name || ""); })
      .join(", ");
    if (items.length > 2) summary += " +" + (items.length - 2);
    var quantity = order.itemCount || items.reduce(function (sum, i) { return sum + (Number(i.quantity) || 0); }, 0);

    return (
      "<tr>" +
      "<td><strong>" + esc(order.orderId || "—") + "</strong>" +
      (order.deliveryAddress ? '<br><small style="color:#94a3b8;">' + esc(order.deliveryAddress) + "</small>" : "") +
      "</td>" +
      "<td>" + esc(order.customerName || "—") +
      (order.customerPhone ? '<br><small style="color:#94a3b8;">' + esc(order.customerPhone) + "</small>" : "") +
      "</td>" +
      "<td>" + esc(summary || "—") +
      '<br><small style="color:#94a3b8;">' + esc(quantity) + " " + esc(tr("items", "items")) + "</small>" +
      "</td>" +
      "<td><strong>" + esc(window.AdminAPI.formatCurrency(order.totalAmount)) + "</strong></td>" +
      "<td>" + orderStatusBadge(order.status) + "</td>" +
      "<td>" + esc(window.AdminAPI.formatDateTime(order.orderTime || order.createdAt)) + "</td>" +
      "</tr>"
    );
  }

  function loadStaffOrders() {
    var body = $("staffOrdersTableBody");
    if (!body || !staffOrdersState.staffId) return;

    body.innerHTML = ordersRowMessage(tr("mgr_staff_orders_loading", "Loading delivery orders..."), "#64748b");

    var query = STAFF_ORDERS_QUERY[staffOrdersState.filter] || STAFF_ORDERS_QUERY.active;
    window.AdminAPI.get(
      "/deliveries/staff/" + encodeURIComponent(staffOrdersState.staffId) + "/orders",
      query
    )
      .then(function (res) {
        var orders = res.orders || [];
        renderStaffOrdersMeta(res.staff || {}, orders.length);
        if (!orders.length) {
          body.innerHTML = ordersRowMessage(
            tr("mgr_staff_orders_empty", "No delivery orders match the selected filter."),
            "#64748b"
          );
          return;
        }
        body.innerHTML = orders.map(renderStaffOrdersRow).join("");
      })
      .catch(function (err) {
        console.error("Failed to load staff delivery orders:", err);
        body.innerHTML = ordersRowMessage(
          tr("mgr_staff_orders_failed", "Failed to load delivery orders."),
          "#dc2626"
        );
      });
  }

  function openStaffOrders(staffId) {
    var staff = deliveryStaff.find(function (s) { return s.id === staffId || s._id === staffId; });
    staffOrdersState.staffId = staffId;
    staffOrdersState.filter = "active";

    var select = $("staffOrdersStatus");
    if (select) select.value = "active";
    renderStaffOrdersMeta(staff || {}, 0);
    openModal("staffOrdersModal");
    loadStaffOrders();
  }

  function initStaffOrders() {
    if (!window.__staffOrdersModalBound) {
      window.__staffOrdersModalBound = true;
      document.addEventListener("click", function (e) {
        var ordersBtn = e.target.closest && e.target.closest(".staff-orders-btn");
        if (ordersBtn) {
          var staffId = ordersBtn.getAttribute("data-staff-id");
          if (staffId) openStaffOrders(staffId);
          return;
        }
        var closeBtn = e.target.closest && e.target.closest("[data-close-modal]");
        if (closeBtn) closeModal(closeBtn.getAttribute("data-close-modal"));
      });
    }

    var select = $("staffOrdersStatus");
    if (select && !select.dataset.ordersBound) {
      select.dataset.ordersBound = "1";
      select.addEventListener("change", function (e) {
        staffOrdersState.filter = e.target.value || "active";
        loadStaffOrders();
      });
    }
  }

  function init() {
    // Load staff list
    loadStaff();

    // Initialize Add Staff form
    initAddStaffForm();

    // Initialize toggle buttons
    initToggleButtons();

    // Delivery orders modal (list of what each rider is carrying)
    initStaffOrders();

    // Set up socket for real-time updates
    setupSocket();

    // Initialize assign button handlers
    initAssignButtons();

    // Show Add Staff modal
    var addStaffBtn = document.getElementById("addDeliveryStaffBtn");
    if (addStaffBtn) {
      addStaffBtn.addEventListener("click", function (e) {
        e.preventDefault();
        var modal = document.getElementById("addDeliveryStaffModal");
        if (modal) {
          openModal("addDeliveryStaffModal");
          // Reset form
          var form = document.getElementById("addDeliveryStaffForm");
          if (form) form.reset();
          // Hide any previous error messages
          var errorDiv = document.getElementById("addDeliveryStaffError");
          if (errorDiv) errorDiv.style.display = "none";
        }
      });
    }
  }

  function initAssignButtons() {
    document.addEventListener("click", function (e) {
      var assignBtn = e.target.closest(".assign-staff-btn");
      if (!assignBtn) return;

      var staffId = assignBtn.getAttribute("data-staff-id");
      if (!staffId) return;

      var staff = deliveryStaff.find(function (s) { return s.id === staffId || s._id === staffId; });
      if (!staff) {
        if (window.AdminToast) window.AdminToast.error("Staff member not found.");
        return;
      }

      if (!staff.isAvailable) {
        if (window.AdminToast) window.AdminToast.error("Staff member is not available for assignment.");
        return;
      }

      if (!window.confirm("Assign this delivery staff member to a delivery order?")) return;

      // Navigate to the deliveries page to assign
      window.location.href = "../admin/deliveries.html";
    });
  }

  function setupSocket() {
    if (typeof window.io === "undefined") return;

    var token = localStorage.getItem("auth_token");
    if (!token) return;

    try {
      var socket = window.io(window.SOCKET_URL || undefined, {
        transports: ["websocket", "polling"],
        auth: { token: token }
      });

      socket.on("connect", function () {
        socket.emit("join:admin", {});
        socket.emit("join:delivery", {});
        // Refresh staff list on connection
        loadStaff();
      });

      socket.on("delivery:staff", function (staffRow) {
        // Update specific staff member in the list
        var idx = deliveryStaff.findIndex(function (s) { return s.id === staffRow.id || s._id === staffRow.id; });
        if (idx !== -1) {
          deliveryStaff[idx] = staffRow;
          renderStaffTable();
        } else {
          deliveryStaff.push(staffRow);
          renderStaffTable();
        }
      });

    } catch (e) {
      // Socket.io not fully loaded; polling handles it
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose globally for testing
  window.ManagerDeliveryStaff = {
    init: init,
    loadStaff: loadStaff,
    toggleAvailability: toggleAvailability,
    deleteStaff: deleteStaff,
    openStaffOrders: openStaffOrders,
    loadStaffOrders: loadStaffOrders
  };

})();