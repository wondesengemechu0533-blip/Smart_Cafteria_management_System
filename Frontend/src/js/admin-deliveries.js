function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}

/**
 * Admin Delivery Management
 * - Lists delivery orders, assigns delivery staff, and optionally advances
 *   delivery status (out for delivery / delivered) on behalf of staff.
 */
(function () {
  "use strict";

  var STATUS_LABELS = {
    PENDING: "status_pending",
    PREPARING: "status_preparing",
    READY: "status_ready",
    PICKED_UP: "status_picked_up",
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

  function isAmharic() {
    return typeof window.getCurrentLanguage === "function" && window.getCurrentLanguage() === "am";
  }

  var STATUS_BADGE_CLASS = {
    PENDING: "badge-pending",
    PREPARING: "badge-preparing",
    READY: "badge-ready",
    PICKED_UP: "badge-picked-up",
    OUT_FOR_DELIVERY: "badge-out-for-delivery",
    ARRIVED: "badge-delivered",
    DELIVERED: "badge-delivered",
    COMPLETED: "badge-completed",
    CANCELLED: "badge-cancelled"
  };

  var activeOrders = [];
  var deliveredOrders = [];
  var deliveryStaff = [];
  var currentFilter = "ALL";
  // Latest live GPS point per orderId received via Socket.IO
  // (event: delivery:location, emitted by the server after each saved fix).
  var liveGps = {};
  // Problems reported by couriers. The server already scopes this list to the
  // manager's own cafeteria, so the client never filters by tenant itself.
  var issues = [];
  var issueStatusFilter = "open";
  // Emergencies (rider SOS). Kept separate from `issues` on purpose: an
  // emergency must be acknowledged before it can disappear, and must never be
  // cleared by the issue/hold bookkeeping.
  var emergencies = [];
  var activeEmergency = null;

  function normalizeStatus(s) {
    return (s || "").toString().trim().toUpperCase().replace(/\s+/g, "_");
  }

  function gpsLiveHtml(orderId) {
    var p = liveGps[orderId];
    if (!p || !Number.isFinite(Number(p.latitude)) || !Number.isFinite(Number(p.longitude))) return "";
    var when = p.updatedAt || p.timestamp;
    var t = "";
    try { t = when ? new Date(when).toLocaleTimeString() : ""; } catch (e) { t = ""; }
    // Accuracy + distance come straight from the server's own Haversine result,
    // so the manager sees exactly what the rider and the customer see.
    var accuracy = Number.isFinite(Number(p.accuracy)) && p.accuracy != null
      ? " ±" + Math.round(Number(p.accuracy)) + "m"
      : "";
    var distance = Number.isFinite(Number(p.distanceToCustomerKm)) && p.distanceToCustomerKm != null
      ? " · " + (window.ScosLiveMap ? window.ScosLiveMap.formatDistance(Number(p.distanceToCustomerKm)) : Number(p.distanceToCustomerKm).toFixed(2) + " km")
      : "";
    return "🟢 " + Number(p.latitude).toFixed(5) + ", " + Number(p.longitude).toFixed(5) + accuracy + distance + (t ? " · " + t : "");
  }

  // -------------------------------------------------------------------------
  // LIVE DELIVERY MONITOR (manager view)
  //
  // Read-only. A manager can watch an active delivery - courier position,
  // customer position, distance, accuracy, last update, live map - and can
  // dispatch / advance the delivery through the existing controls. There is
  // deliberately NO control here that writes a courier's coordinates: the rider's
  // GPS is the rider's own device data, and the only endpoint that accepts it is
  // the courier-only, assigned-rider-only one on the backend.
  // -------------------------------------------------------------------------

  var monitorMap = null;      // window.ScosLiveMap.LiveDeliveryMap instance
  var monitorOrderId = null;  // the order currently open in the monitor
  var monitorSocket = null;   // the page's Socket.IO connection
  var monitorReady = null;    // resolved once the ES-module map helpers land

  /** Resolves once the shared map helpers are on window (or after a timeout). */
  function whenMapHelpersReady() {
    if (window.ScosLiveMap) return Promise.resolve(window.ScosLiveMap);
    if (monitorReady) return monitorReady;
    monitorReady = new Promise(function (resolve) {
      var done = function () { resolve(window.ScosLiveMap || null); };
      window.addEventListener("scos:live-map-ready", done, { once: true });
      // Leaflet or the module may be blocked by the network. Do not hang.
      setTimeout(done, 3000);
    });
    return monitorReady;
  }

  function monitorSocketInstance() {
    return monitorSocket;
  }

  /** Latest fix we know about: the newest socket frame, else the stored one. */
  function monitorCourierFix(order) {
    var frame = order && liveGps[order.orderId];
    if (frame && Number.isFinite(Number(frame.latitude)) && Number.isFinite(Number(frame.longitude))) {
      return {
        latitude: Number(frame.latitude),
        longitude: Number(frame.longitude),
        accuracy: frame.accuracy != null ? Number(frame.accuracy) : null,
        updatedAt: frame.updatedAt || frame.timestamp || null,
        live: true
      };
    }
    var stored = (order && (order.deliveryLocation || order.currentLocation)) || null;
    if (stored && Number.isFinite(Number(stored.latitude)) && Number.isFinite(Number(stored.longitude))) {
      return {
        latitude: Number(stored.latitude),
        longitude: Number(stored.longitude),
        accuracy: stored.accuracy != null ? Number(stored.accuracy) : null,
        updatedAt: stored.updatedAt || stored.timestamp || null,
        live: false
      };
    }
    return null;
  }

  function monitorCustomerLocation(order) {
    var canonical = order && order.customerLocation;
    if (canonical && (canonical.latitude != null || canonical.longitude != null)) return canonical;
    var info = (order && order.deliveryInfo) || {};
    return {
      latitude: info.latitude != null ? info.latitude : null,
      longitude: info.longitude != null ? info.longitude : null,
      address: info.deliveryAddress || [info.subCity, info.location].filter(Boolean).join(", ") || ""
    };
  }

  function monitorRows(order, courier) {
    var helpers = window.ScosLiveMap;
    var customer = monitorCustomerLocation(order);
    var measure = helpers
      ? helpers.measureToCustomer(courier, customer)
      : { hasCustomerLocation: false, distanceKm: null, nearCustomer: false };
    var serverKm = typeof order.distanceToCustomerKm === "number" ? order.distanceToCustomerKm : null;
    var distanceKm = measure.distanceKm != null ? measure.distanceKm : serverKm;
    var distance = helpers ? helpers.formatDistance(distanceKm) : null;
    var accuracy = helpers && courier && courier.accuracy != null ? helpers.formatAccuracy(courier.accuracy) : null;
    var updated = helpers && courier && courier.updatedAt ? helpers.formatRelativeTime(courier.updatedAt) : null;
    var staff = order.deliveryStaffAssigned;
    var staffName = staff ? (staff.name || staff) : null;

    var rows = [];
    rows.push("<div class='live-track-meta'>");
    rows.push("<div class='row'><span class='k'>" + window.esc(tr("track_courier", "Delivery Person")) + "</span><span>" +
      window.esc(staffName || tr("map_location_unavailable", "Location unavailable")) + "</span></div>");
    rows.push("<div class='row'><span class='k'>" + window.esc(tr("admin_col_status", "Status")) + "</span><span>" + statusBadge(normalizeStatus(order.status)) + "</span></div>");
    rows.push("<div class='row'><span class='k'>" + window.esc(tr("track_courier_location", "Courier location")) + "</span><span>" +
      (courier ? window.esc(courier.latitude.toFixed(5) + ", " + courier.longitude.toFixed(5)) :
        window.esc(tr("map_waiting_location", "Waiting for delivery location"))) + "</span></div>");
    rows.push("<div class='row'><span class='k'>" + window.esc(tr("track_customer_location", "Customer location")) + "</span><span>" +
      (customer && customer.latitude != null ?
        window.esc(customer.latitude.toFixed(5) + ", " + customer.longitude.toFixed(5)) :
        window.esc(tr("map_no_customer_gps", "GPS location unavailable for this order."))) + "</span></div>");
    rows.push("<div class='row'><span class='k'>" + window.esc(tr("track_distance", "Distance")) + "</span><span>" +
      window.esc(distance || "—") + "</span></div>");
    rows.push("<div class='row'><span class='k'>" + window.esc(tr("track_accuracy", "Accuracy")) + "</span><span>" +
      window.esc(accuracy || "—") + "</span></div>");
    rows.push("<div class='row'><span class='k'>" + window.esc(tr("map_last_update", "Last GPS update")) + "</span><span>" +
      window.esc(updated || (courier && courier.updatedAt ? formatDateTime(courier.updatedAt) : "—")) + "</span></div>");
    rows.push("</div>");
    return { html: rows.join(""), measure: measure, distanceKm: distanceKm };
  }

  function renderMonitorBody(order) {
    var body = document.getElementById("liveTrackBody");
    if (!body) return;
    var courier = monitorCourierFix(order);
    var built = monitorRows(order, courier);
    var title = document.getElementById("liveTrackTitle");
    if (title) {
      title.textContent = tr("track_monitor_title", "Live Delivery Monitor") + " — #" + order.orderId;
    }

    var mapBlock = "";
    var hasCustomer = built.measure.hasCustomerLocation;
    if (window.ScosLiveMap && window.ScosLiveMap.mapAvailable()) {
      // Place search above the map (shared helper, delivery/geocode-search.js):
      // a manager can look up a spot and see its exact coordinates on the map.
      var searchBlock = window.ScosGeocode ? window.ScosGeocode.html("liveTrack") : "";
      mapBlock = searchBlock + "<div id='liveTrackMap' class='delivery-map' style='height:320px;'></div>";
      if (!hasCustomer) {
        mapBlock += "<p class='text-muted' style='margin-top:8px;'>" +
          window.esc(tr("map_no_customer_gps", "GPS location unavailable for this order.")) + "</p>";
      }
    } else {
      // Leaflet blocked / offline: text summary only, never a blank panel.
      mapBlock = "<p class='text-muted'>" +
        window.esc(tr("map_unavailable_offline", "Live map is unavailable right now.")) + "</p>";
    }

    body.innerHTML =
      "<div class='live-track-head'><span class='live-track-conn' id='liveTrackConn'></span></div>" +
      built.html + mapBlock;
    paintMonitorConnection();
    mountMonitorMap(order, courier, hasCustomer);
  }

  function paintMonitorConnection() {
    var el = document.getElementById("liveTrackConn");
    if (!el) return;
    var sock = monitorSocketInstance();
    if (sock && sock.connected) {
      el.className = "live-track-conn is-live";
      el.innerHTML = "<i class='fa-solid fa-wifi'></i> " + window.esc(tr("track_connected", "Connected"));
    } else {
      el.className = "live-track-conn is-waiting";
      el.innerHTML = "<i class='fa-solid fa-spinner fa-spin'></i> " + window.esc(tr("track_reconnecting", "Reconnecting…"));
    }
  }

  function mountMonitorMap(order, courier, hasCustomer) {
    var container = document.getElementById("liveTrackMap");
    if (!container || !window.ScosLiveMap || !window.ScosLiveMap.mapAvailable()) return;
    if (monitorMap) { monitorMap.destroy(); monitorMap = null; }
    try {
      monitorMap = new window.ScosLiveMap.LiveDeliveryMap(container, { zoomToFit: true });
      if (!monitorMap.init()) { monitorMap = null; return; }
      var customer = monitorCustomerLocation(order);
      monitorMap.setCustomer(
        { latitude: customer.latitude, longitude: customer.longitude },
        tr("track_customer_location", "Customer location")
      );
      if (order.pickupLocation) {
        monitorMap.setCafeteria(order.pickupLocation, order.pickupLocation.name || tr("map_cafeteria", "Cafeteria"));
      }
      if (courier) monitorMap.setCourier(courier, tr("track_courier", "Delivery Person"));
      monitorMap.refreshSize();
      if (hasCustomer) monitorMap.drawRoute();
      // Wire the search box to THIS map instance (idempotent per node, and the
      // node is new on every open because renderMonitorBody() rebuilds the body).
      if (window.ScosGeocode) {
        window.ScosGeocode.mount(document.getElementById("geocodeSearch-liveTrack"), {
          getMap: function () { return monitorMap; }
        });
      }
    } catch (e) {
      monitorMap = null;
    }
  }

  function findOrder(orderId) {
    var pools = [activeOrders, deliveredOrders];
    for (var i = 0; i < pools.length; i++) {
      for (var j = 0; j < pools[i].length; j++) {
        if (String(pools[i][j].orderId) === String(orderId)) return pools[i][j];
      }
    }
    return null;
  }

  async function openLiveMonitor(orderId) {
    var modal = document.getElementById("liveTrackModal");
    var body = document.getElementById("liveTrackBody");
    if (!modal || !body) return;
    var order = findOrder(orderId);
    if (!order) return;

    monitorOrderId = String(orderId);
    body.innerHTML = "<p class='text-muted'>" + window.esc(tr("loading", "Loading...")) + "</p>";
    modal.classList.add("open");

    // Wait for the shared map helpers (ES module) so the monitor uses the same
    // map as the customer tracker instead of a second implementation.
    await whenMapHelpersReady();

    // Always re-read from the server: the list payload may predate the newest
    // fix, and the monitor must show the real stored position on open.
    try {
      var res = await window.AdminAPI.get("/deliveries/" + encodeURIComponent(orderId) + "/location");
      if (res && res.orderId === String(orderId)) {
        order = Object.assign({}, order, {
          currentLocation: order.currentLocation,
          deliveryLocation: res.deliveryLocation || order.deliveryLocation,
          customerLocation: res.customerLocation || order.customerLocation,
          distanceToCustomerKm: res.distanceToCustomerKm != null ? res.distanceToCustomerKm : order.distanceToCustomerKm
        });
      }
    } catch (e) {
      // Fall back to the list payload - the monitor still opens.
    }

    renderMonitorBody(order);
    subscribeMonitorSocket();
  }

  function closeLiveMonitor() {
    var modal = document.getElementById("liveTrackModal");
    if (modal) modal.classList.remove("open");
    if (monitorMap) { monitorMap.destroy(); monitorMap = null; }
    // Stop watching this order: no live marker, no socket subscription.
    var sock = monitorSocketInstance();
    if (sock && monitorOrderId) {
      try { sock.emit("delivery:leave", String(monitorOrderId)); } catch (e) { /* ignore */ }
    }
    monitorOrderId = null;
  }

  /**
   * Join the monitored order's authorized GPS room.
   * The server checks the same rule as everywhere else (management role), so a
   * manager can watch an active delivery and cannot watch anyone else's.
   */
  function subscribeMonitorSocket() {
    var sock = monitorSocketInstance();
    if (!sock || !monitorOrderId) return;
    try {
      sock.emit("delivery:join", String(monitorOrderId));
    } catch (e) { /* ignore */ }
  }

  function onMonitorFrame(point) {
    if (!point || !monitorOrderId) return;
    if (String(point.orderId) !== String(monitorOrderId)) return;
    var order = findOrder(monitorOrderId);
    if (!order) return;
    var courier = monitorCourierFix(order); // applyLiveGps already stored the frame
    var built = monitorRows(order, courier);
    var body = document.getElementById("liveTrackBody");
    if (!body) return;
    // Replace only the fact rows; the map element must survive so Leaflet keeps
    // its instance and its tile cache.
    var meta = body.querySelector(".live-track-meta");
    if (meta) meta.outerHTML = built.html;
    if (monitorMap) monitorMap.moveCourier(point, tr("track_courier", "Delivery Person"));
  }

  function liveTrackButton(order) {
    var s = normalizeStatus(order.status);
    var trackable = s === "PICKED_UP" || s === "OUT_FOR_DELIVERY" || s === "ARRIVED";
    var hasFix = !!(order.currentLocation || order.deliveryLocation);
    // Only offered for a delivery that is actually moving (or already has a
    // real fix). A finished delivery is history - see lastKnownLocationHtml().
    if (!trackable && !hasFix) return "";
    return '<button class="btn btn-sm btn-outline-info live-track-action" data-order="' + window.esc(order.orderId) + '">' +
      window.esc(tr("track_live", "Track")) + "</button>";
  }

  /**
   * Last known location for a FINISHED delivery.
   * Requirement: history shows WHERE it ended, with no live marker and no
   * socket subscription - so this is plain text plus a "Track" button that opens
   * the same read-only monitor on a frozen fix.
   */
  function lastKnownLocationHtml(order) {
    var loc = order.deliveryLocation || order.currentLocation;
    if (!loc || !Number.isFinite(Number(loc.latitude)) || !Number.isFinite(Number(loc.longitude))) return "";
    var when = "";
    try { when = (loc.updatedAt || loc.timestamp) ? formatDateTime(loc.updatedAt || loc.timestamp) : ""; }
    catch (e) { when = ""; }
    return '<small style="color:#64748b;display:block;margin-top:4px;">' +
      window.esc(tr("map_last_known", "Last known location")) + ": " +
      Number(loc.latitude).toFixed(5) + ", " + Number(loc.longitude).toFixed(5) +
      (when ? " · " + window.esc(when) : "") + "</small>";
  }

  // Update the live GPS line for one order without re-rendering the table.
  function applyLiveGps(point) {
    if (!point || !point.orderId) return;
    liveGps[point.orderId] = point;
    var html = gpsLiveHtml(point.orderId);
    document.querySelectorAll('[data-gps-live]').forEach(function (el) {
      if (el.getAttribute("data-gps-live") === String(point.orderId)) {
        el.innerHTML = html;
      }
    });
  }

  function statusLabel(s) {
    var n = normalizeStatus(s);
    var localized = window.translateStatus ? window.translateStatus(n) : "";
    if (localized && String(localized).toUpperCase() !== n) return localized;
    var key = STATUS_LABELS[n];
    if (key) return tr(key, s || "—");
    return s || "—";
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

  /**
   * Whether a courier may be assigned.
   *
   * `GET /deliveries/staff` returns a server-computed `isActive` that already
   * folds together the account status and the isActive flag - prefer it. The
   * previous version required `status === 'ACTIVE'`, but that field is not
   * always present in the payload, so every courier was filtered out and the
   * "Unassigned - select staff" dropdown rendered empty.
   */
  function isDeliveryStaffActive(user) {
    if (!user) return false;
    if (typeof user.isActive === 'boolean') return user.isActive;
    if (user.status === undefined) return true;
    return String(user.status).toUpperCase() === 'ACTIVE' && user.isActive !== false;
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
    var html = '<select class="delivery-staff-select" data-order="' + window.esc(order.orderId) + '" title="' + tr('assign_delivery_staff', 'Assign delivery staff') + '" style="padding:6px 8px;border-radius:8px;border:1px solid #e2e8f0;max-width:190px;font-size:13px;">';
    if (current) {
      html += '<option value="" disabled selected>' + window.esc(currentName) + " ✓</option>";
      html += '<option value="" disabled>──────────</option>';
    } else {
      html += '<option value="" selected disabled>Unassigned — select staff</option>';
    }
    deliveryStaff.filter(function (s) { return isDeliveryStaffActive(s); }).forEach(function (staff) {
      html += '<option value="' + window.esc(staff.id) + '">' + window.esc(staff.name) + "</option>";
    });
    html += "</select>";
    return html;
  }

  /**
   * The one action a manager may take from the current state.
   *
   * The delivery state machine only allows ONE next step at a time:
   *   READY/PICKED_UP -> OUT_FOR_DELIVERY -> ARRIVED -> DELIVERED -> COMPLETED
   * and the server rejects anything else, including for a manager (the
   * transition check has no management bypass - it only produces a clearer
   * message). So the button has to track the chain exactly.
   *
   * Previously "Mark Delivered" was offered at OUT_FOR_DELIVERY, skipping
   * ARRIVED, so clicking it always failed with "Out for delivery cannot move to
   * Delivered" and a manager had no way to move a delivery forward at all.
   */
  function actionButtons(order) {
    var s = normalizeStatus(order.status);
    // COMPLETED and CANCELLED are terminal - the machine forbids leaving them.
    if (["COMPLETED", "CANCELLED"].indexOf(s) !== -1) return "—";

    var id = window.esc(order.orderId);
    var buttons = [];
    if (s === "READY" || s === "PICKED_UP") {
      buttons.push('<button class="btn btn-sm btn-outline-warning out-delivery-action" data-order="' + id + '">Out for Delivery</button>');
    }
    if (s === "OUT_FOR_DELIVERY") {
      buttons.push('<button class="btn btn-sm btn-outline-success arrived-action" data-order="' + id + '">Mark Arrived</button>');
    }
    if (s === "ARRIVED") {
      buttons.push('<button class="btn btn-sm btn-outline-success delivered-action" data-order="' + id + '">Mark Delivered</button>');
    }
    if (s === "DELIVERED") {
      buttons.push('<button class="btn btn-sm btn-outline-success completed-action" data-order="' + id + '">Mark Completed</button>');
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
      html += "<td>" + statusBadge(s)
        + '<br><small data-gps-live="' + window.esc(order.orderId) + '" style="color:#16a34a;display:block;min-height:1em;">'
        + gpsLiveHtml(order.orderId) + "</small>"
        + '<small style="display:block;margin-top:4px;">' + liveTrackButton(order) + "</small></td>";
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
      html += "<td>" + window.esc(addressLine(order))
        + lastKnownLocationHtml(order) + "</td>";
      html += "<td>" + formatMoney(order.totalAmount) + "</td>";
      html += "<td>" + statusBadge(normalizeStatus(order.status)) + "</td>";
      html += "<td>" + (staff ? window.esc(staff.name) : "—") + "</td>";
      // Proof + Track. For a finished delivery Track opens a FROZEN last-known
      // fix: no live marker, no socket subscription - that is history, not
      // tracking (see requirement "Do not continue Socket.IO tracking for
      // completed orders").
      html += '<td style="white-space:nowrap;">' + proofButton(order) + " " + liveTrackButton(order) + "</td>";
      html += "</tr>";
    });
    body.innerHTML = html;
  }

  var deliveriesLoading = false;
  function setRefreshLoading(loading) {
    var btn = document.getElementById("refreshDeliveriesBtn");
    if (!btn) return;
    btn.disabled = loading;
    var icon = btn.querySelector("i");
    if (icon) icon.className = loading ? "fa-solid fa-spinner fa-spin" : "fa-solid fa-rotate";
  }

  async function loadAll(options) {
    options = options || {};
    if (options.fromRefresh) {
      if (deliveriesLoading) return;
      deliveriesLoading = true;
      setRefreshLoading(true);
      var bodyLoading = document.getElementById("deliveriesTableBody");
      if (bodyLoading) {
        bodyLoading.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">' + window.esc(tr("loading", "Loading...")) + "</td></tr>";
      }
    }
    try {
      // The Delivery Staff selector is built from this list, so it must load on
      // EVERY render - not only when the Refresh button is pressed. Previously it
      // was skipped on the first load, which left the selector empty until the
      // user hit Refresh and hid any courier created since (e.g. from the
      // Manager Dashboard's "Add Delivery Staff").
      await loadStaff();
      // "ALL" on THIS page means "all still-active deliveries" - the finished
      // ones get their own table below. Ask for the explicit ACTIVE set so the
      // server keeps that split now that a literal ALL returns every order.
      var params = { status: currentFilter === "ALL" ? "ACTIVE" : currentFilter };
      var res = await window.AdminAPI.get("/deliveries", params);
      activeOrders = res.orders || [];

      var done = await window.AdminAPI.get("/deliveries", { report: "completed" });
      deliveredOrders = done.orders || [];

      renderActive();
      renderCompleted();
      await loadStats();
      loadIssues();
      if (options.fromRefresh && window.AdminToast) {
        window.AdminToast.show(tr("admin_deliveries_refreshed", "Deliveries refreshed"));
      }
    } catch (e) {
      var body = document.getElementById("deliveriesTableBody");
      if (body) body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#dc2626;padding:24px;">' + window.esc(tr('admin_load_deliveries_failed', 'Failed to load deliveries: {error}', { error: e.message })) + "</td></tr>";
      if (options.fromRefresh && window.AdminToast) window.AdminToast.error(e.message);
    } finally {
      if (options.fromRefresh) {
        deliveriesLoading = false;
        setRefreshLoading(false);
      }
    }
  }

  async function assignStaff(orderId, staffId) {
    var staff = deliveryStaff.find(function (s) { return String(s.id) === String(staffId); });
    if (!staff) {
      window.AdminToast.error(tr('admin_select_delivery_staff', 'Please select a delivery staff member first.'));
      return;
    }
    var order = activeOrders.find(function (o) { return o.orderId === orderId; });
    var currentId = order && order.deliveryStaffAssigned ? String(order.deliveryStaffAssigned.id || order.deliveryStaffAssigned._id) : "";
    if (currentId && currentId !== String(staffId)) {
      if (!window.confirm(tr('admin_reassign_delivery', 'Reassign order #{orderId} from the current staff to {name}?', { orderId: orderId, name: staff.name }))) return;
    }
    try {
      var res = await window.AdminAPI.patch("/deliveries/" + encodeURIComponent(orderId) + "/assign", { deliveryStaffId: staffId });
      window.AdminToast.success(res.message || tr('admin_delivery_staff_assigned', 'Delivery staff assigned.'));
      loadAll();
    } catch (e) {
      window.AdminToast.error(e.message);
    }
  }

  async function markOutForDelivery(orderId) {
    if (!window.confirm(tr('admin_confirm_out_for_delivery', 'Mark order #{orderId} as out for delivery?', { orderId: orderId }))) return;
    try {
      var res = await window.AdminAPI.patch("/deliveries/" + encodeURIComponent(orderId) + "/out-for-delivery", {});
      window.AdminToast.success(res.message || tr('admin_out_for_delivery_done', 'Order marked out for delivery.'));
      loadAll();
    } catch (e) {
      window.AdminToast.error(e.message);
    }
  }

  /**
 * OUT_FOR_DELIVERY -> ARRIVED.
 * *
 * * Pure state move: moveDelivery() enforces the chain and the ownership rules.
 */
async function markArrived(orderId) {
  if (!window.confirm(tr('admin_confirm_arrived', 'Mark order #{orderId} as arrived at the customer?', { orderId: orderId }))) return;
  try {
    var res = await window.AdminAPI.patch("/deliveries/" + encodeURIComponent(orderId) + "/arrived", {});
    window.AdminToast.success(res.message || tr('admin_arrived_done', 'Order marked as arrived.'));
    loadAll();
  } catch (e) {
    window.AdminToast.error(e.message);
  }
}

/**
 * ARRIVED -> DELIVERED.
 * *
 * This is the only handover step that is gated on proof of delivery, and it is
 * enforced server-side: without a proof photo or a verified customer code the
 * request is refused with PROOF_REQUIRED, and a manager gets past it only by
 * sending `isManagerOverride` together with a non-empty `overrideReason`.
 *
 * So a manager acting from this page is always an override, and the reason is
 * collected up front rather than letting the server reject the click. The
 * override is recorded on the delivery (proofOverrideBy / proofOverrideReason),
 * which is what makes the exception auditable instead of silent.
 */
async function markDelivered(orderId) {
  var reason = window.prompt(
    tr(
      'admin_delivered_reason_prompt',
      'Marking this delivery as delivered without proof. Record why (shown on the delivery record):'
    )
  );
  // null = the manager dismissed the prompt, so do nothing at all.
  if (reason === null) return;
  if (!String(reason || "").trim()) {
    window.AdminToast.error(tr('admin_delivered_reason_required', 'A reason is required to mark a delivery as delivered.'));
    return;
  }
  try {
    var res = await window.AdminAPI.patch(
      "/deliveries/" + encodeURIComponent(orderId) + "/delivered",
      { isManagerOverride: true, overrideReason: String(reason).trim() }
    );
    window.AdminToast.success(res.message || tr('admin_delivered_done', 'Order marked as delivered.'));
    loadAll();
  } catch (e) {
    window.AdminToast.error(e.message);
  }
}

/**
 * DELIVERED -> COMPLETED. The final step; it also finalises the ORDER.
 */
async function markCompleted(orderId) {
  if (!window.confirm(tr('admin_confirm_completed', 'Mark order #{orderId} as completed?', { orderId: orderId }))) return;
  try {
    var res = await window.AdminAPI.patch("/deliveries/" + encodeURIComponent(orderId) + "/complete", {});
    window.AdminToast.success(res.message || tr('admin_completed_done', 'Order marked as completed.'));
    loadAll();
  } catch (e) {
    window.AdminToast.error(e.message);
  }
}

  // -------------------------------------------------------------------------
  // DELIVERY PROBLEMS REPORTED BY COURIERS
  // -------------------------------------------------------------------------

  function humanizeIssue(value) {
    return String(value == null ? "" : value)
      .split("_")
      .map(function (w) { return w.charAt(0) + w.slice(1).toLowerCase(); })
      .join(" ");
  }

  function issueStatusBadgeClass(status) {
    if (status === "RESOLVED") return "badge-delivered";
    if (status === "CANCELLED") return "badge-cancelled";
    if (status === "IN_PROGRESS") return "badge-out-for-delivery";
    return "badge-pending";
  }

  function isIssueOpen(issue) {
    return issue.status === "OPEN" || issue.status === "IN_PROGRESS";
  }

  /**
   * Action buttons for one issue. The issue id is used for every call, so the
   * server re-checks cafeteria ownership on each action - the buttons are a
   * convenience, not the security boundary.
   */
  function issueActions(issue) {
    var id = window.esc(issue.id);
    if (!isIssueOpen(issue)) return "";
    return (
      '<select class="delivery-staff-select" data-issue-reassign="' + id + '" title="' +
        window.esc(tr("admin_issue_reassign", "Reassign delivery")) + '" style="padding:6px 8px;border-radius:6px;border:1px solid #e2e8f0;">' +
        '<option value="">' + window.esc(tr("admin_issue_reassign", "Reassign delivery")) + "</option>" +
        deliveryStaff
          .map(function (s) {
            return '<option value="' + window.esc(s.id) + '">' + window.esc(s.name) + "</option>";
          })
          .join("") +
      "</select>" +
      '<button class="btn btn-sm btn-secondary" data-issue-action="start" data-issue="' + id + '">' +
        window.esc(tr("admin_issue_start", "Start")) + "</button> " +
      '<button class="btn btn-sm btn-warning" data-issue-action="hold" data-issue="' + id + '">' +
        window.esc(tr("admin_issue_hold", "Hold")) + "</button> " +
      '<button class="btn btn-sm btn-primary" data-issue-action="resolve" data-issue="' + id + '">' +
        window.esc(tr("admin_issue_resolve", "Resolve")) + "</button> " +
      '<button class="btn btn-sm btn-danger" data-issue-action="cancel-delivery" data-issue="' + id + '">' +
        window.esc(tr("admin_issue_cancel_delivery", "Cancel delivery")) + "</button>"
    );
  }

  function renderIssues() {
    var body = document.getElementById("issuesTableBody");
    if (!body) return;
    if (!issues.length) {
      body.innerHTML =
        '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:24px;">' +
        window.esc(tr("admin_issues_none", "No delivery problems reported.")) + "</td></tr>";
      var badge = document.getElementById("issueCountBadge");
      if (badge) badge.textContent = "0";
      return;
    }
    body.innerHTML = issues
      .map(function (issue) {
        var when = "";
        try { when = issue.reportedAt ? new Date(issue.reportedAt).toLocaleString() : ""; } catch (e) { when = String(issue.reportedAt || ""); }
        var hold = issue.deliveryOnHold
          ? ' <span class="badge badge-cancelled">' + window.esc(tr("admin_issue_on_hold", "On hold")) + "</span>"
          : "";
        var gps = issue.locationAvailable
          ? '<br><small style="color:#64748b;"><i class="fa-solid fa-location-crosshairs"></i> ' +
            escNum(issue.latitude) + ", " + escNum(issue.longitude) + "</small>"
          : '<br><small style="color:#b45309;"><i class="fa-solid fa-triangle-exclamation"></i> ' +
            window.esc(tr("admin_issue_no_gps", "No GPS fix")) + "</small>";
        var contact = issue.courierPhone
          ? '<br><a href="tel:' + window.esc(issue.courierPhone) + '"><small><i class="fa-solid fa-phone"></i> ' +
            window.esc(issue.courierName || "") + "</small></a>"
          : "";
        return (
          "<tr>" +
          '<td>' + window.esc(issue.orderId) + "</td>" +
          "<td><strong>" + window.esc(humanizeIssue(issue.issueType)) + "</strong>" + gps +
            '<br><small style="color:#475569;">' + window.esc(issue.description || "") + "</small></td>" +
          "<td>" + window.esc(issue.reportedByName || tr("admin_delivery_rider", "Rider")) + contact + "</td>" +
          '<td><span class="badge ' + issueStatusBadgeClass(issue.status) + '">' +
            window.esc(humanizeIssue(issue.status)) + "</span>" + hold + "</td>" +
          "<td><small>" + window.esc(when) + "</small></td>" +
          '<td>' + issueActions(issue) + "</td>" +
          "</tr>"
        );
      })
      .join("");
    var badge = document.getElementById("issueCountBadge");
    if (badge) badge.textContent = String(issues.length);
  }

  function escNum(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n.toFixed(5) : "";
  }

  async function loadIssues() {
    var body = document.getElementById("issuesTableBody");
    if (body) {
      body.innerHTML =
        '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:24px;">' +
        window.esc(tr("loading", "Loading...")) + "</td></tr>";
    }
    try {
      var res = await window.AdminAPI.get("/delivery-issues", { status: issueStatusFilter });
      issues = res.issues || [];
      renderIssues();
    } catch (e) {
      issues = [];
      renderIssues();
      if (body) {
        body.innerHTML =
          '<tr><td colspan="6" style="text-align:center;color:#dc2626;padding:24px;">' +
          window.esc(tr("admin_issues_load_failed", "Failed to load problems: {error}", { error: e.message })) + "</td></tr>";
      }
    }
  }

  async function issueAction(id, action, extra) {
    var confirmKey = {
      resolve: "admin_confirm_issue_resolve",
      "cancel-delivery": "admin_confirm_issue_cancel_delivery",
      hold: "admin_confirm_issue_hold",
      start: null,
      reassign: "admin_confirm_issue_reassign"
    }[action];
    if (confirmKey) {
      var msg = tr(confirmKey, "Are you sure?", { orderId: id });
      if (!window.confirm(msg)) return;
    }
    try {
      var res = await window.AdminAPI.patch("/delivery-issues/" + encodeURIComponent(id) + "/" + action, extra || {});
      window.AdminToast.success(res.message || tr("admin_issue_action_done", "Done."));
      loadAll();
    } catch (e) {
      window.AdminToast.error(e.message);
    }
  }

  // -------------------------------------------------------------------------
  // DELIVERY EMERGENCIES (rider SOS)
  // -------------------------------------------------------------------------

  function emergencyBanner() {
    return document.getElementById("emergencyBanner");
  }

  function showEmergencyBanner(em) {
    var banner = emergencyBanner();
    if (!banner || !em) return;
    var title = document.getElementById("emergencyTitle");
    var detail = document.getElementById("emergencyDetail");
    if (title) title.textContent = "DELIVERY EMERGENCY - ORDER #" + window.esc(em.orderId);
    var where = em.locationAvailable && Number.isFinite(Number(em.latitude))
      ? ("GPS " + Number(em.latitude).toFixed(5) + ", " + Number(em.longitude).toFixed(5))
      : "GPS unavailable";
    if (detail) {
      detail.textContent = (em.deliveryPersonName || "A delivery person") + " pressed SOS · " + where +
        " · " + formatDateTime(em.triggeredAt);
    }
    banner.hidden = false;
    // Scroll to the top so the banner is actually on screen when it appears.
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { window.scrollTo(0, 0); }
  }

  function hideEmergencyBanner() {
    var banner = emergencyBanner();
    if (banner) banner.hidden = true;
  }

  /**
   * Start the emergency alarm.
   *
   * Loops until stopEmergencyAlarm() is called, which only happens on
   * acknowledgement or resolution. An unacknowledged SOS keeps sounding.
   */
  function startEmergencyAlarm() {
    if (typeof window.ScosNotify === "undefined") return;
    if (typeof window.ScosNotify.isEmergencyLooping === "function" && window.ScosNotify.isEmergencyLooping()) return;
    try {
      window.ScosNotify.startLoop("emergency", "emergency", {
        intervalMs: 1500,
        maxDurationMs: Infinity
      });
    } catch (e) { /* sound is best-effort; the banner is the real alert */ }
  }

  function stopEmergencyAlarm() {
    if (typeof window.ScosNotify === "undefined") return;
    try {
      if (typeof window.ScosNotify.stopEmergency === "function") window.ScosNotify.stopEmergency();
      else if (typeof window.ScosNotify.stopLoop === "function") window.ScosNotify.stopLoop("emergency");
    } catch (e) { /* ignore */ }
  }

  function setActiveEmergency(em) {
    activeEmergency = em;
    if (em) {
      showEmergencyBanner(em);
      startEmergencyAlarm();
    } else {
      hideEmergencyBanner();
      stopEmergencyAlarm();
    }
  }

  async function loadEmergencies() {
    try {
      var res = await window.AdminAPI.get("/deliveries/emergencies", { status: "ACTIVE" });
      emergencies = res.emergencies || [];
      var next = emergencies.length ? emergencies[0] : null;
      // Only swap the banner if the active emergency actually changed, so a
      // background poll cannot restart the alarm for the same incident.
      var prevId = activeEmergency ? activeEmergency.id : null;
      var nextId = next ? next.id : null;
      if (prevId !== nextId) setActiveEmergency(next);
    } catch (e) {
      // A failed poll must not silence an existing alarm.
    }
  }

  async function acknowledgeEmergency() {
    if (!activeEmergency) return;
    var orderId = activeEmergency.orderId;
    try {
      var res = await window.AdminAPI.patch(
        "/deliveries/" + encodeURIComponent(orderId) + "/emergency/ack", {}
      );
      window.AdminToast.success(res.message || tr("admin_emergency_ack_done", "Emergency acknowledged."));
      setActiveEmergency(null);
      loadAll();
    } catch (e) {
      window.AdminToast.error(e.message);
    }
  }

  async function resolveEmergency() {
    if (!activeEmergency) return;
    var orderId = activeEmergency.orderId;
    var note = window.prompt(tr("admin_emergency_resolve_prompt", "Resolution note (optional):"));
    if (note === null) return;
    try {
      var res = await window.AdminAPI.patch(
        "/deliveries/" + encodeURIComponent(orderId) + "/emergency/resolve",
        { note: note || undefined }
      );
      window.AdminToast.success(res.message || tr("admin_emergency_resolved", "Emergency resolved."));
      setActiveEmergency(null);
      loadAll();
    } catch (e) {
      window.AdminToast.error(e.message);
    }
  }

  // -------------------------------------------------------------------------
  // PROOF OF DELIVERY (manager view)
  // -------------------------------------------------------------------------

  async function openProofModal(orderId) {
    var modal = document.getElementById("proofModal");
    var body = document.getElementById("proofBody");
    if (!modal || !body) return;
    body.innerHTML = "<p class='text-muted'>" + window.esc(tr("loading", "Loading...")) + "</p>";
    modal.classList.add("open");
    try {
      var res = await window.AdminAPI.get("/deliveries/" + encodeURIComponent(orderId) + "/proof");
      var p = res.proof || {};
      var rows = [];
      rows.push("<div class='proof-meta'>");
      rows.push("<div class='row'><span class='k'>" + window.esc(tr("proof_delivered_at", "Delivered at")) + "</span><span>" + formatDateTime(res.deliveredAt) + "</span></div>");
      rows.push("<div class='row'><span class='k'>" + window.esc(tr("proof_customer_confirmed", "Customer confirmed (OTP)")) + "</span><span>" +
        (p.confirmedByCustomer
          ? "<span class='proof-flag ok'><i class='fa-solid fa-check'></i> " + window.esc(tr("proof_yes", "Yes")) + "</span>"
          : "<span class='proof-flag warn'><i class='fa-solid fa-xmark'></i> " + window.esc(tr("proof_no", "No")) + "</span>") +
        "</span></div>");
      rows.push("<div class='row'><span class='k'>" + window.esc(tr("proof_photo", "Proof photo")) + "</span><span>" +
        (p.photo
          ? "<a href='" + window.esc(p.photo) + "' target='_blank' rel='noopener'>" + window.esc(tr("proof_view_photo", "View photo")) + "</a>"
          : "<span class='proof-flag warn'>" + window.esc(tr("proof_none", "None")) + "</span>") +
        "</span></div>");
      if (p.note) rows.push("<div class='row'><span class='k'>" + window.esc(tr("proof_note", "Note")) + "</span><span>" + window.esc(p.note) + "</span></div>");
      rows.push("<div class='row'><span class='k'>" + window.esc(tr("proof_verified_at", "Proof verified")) + "</span><span>" + formatDateTime(p.verifiedAt) + "</span></div>");
      if (p.overridden) {
        rows.push("<div class='row'><span class='k'>" + window.esc(tr("proof_override", "Manager override")) + "</span><span><span class='proof-flag warn'>" + window.esc(tr("proof_overridden", "Yes")) + "</span> " + window.esc(p.overrideReason || "") + "</span></div>");
      }
      rows.push("</div>");
      if (p.photo) {
        rows.push("<a href='" + window.esc(p.photo) + "' target='_blank' rel='noopener'><img class='proof-photo' src='" + window.esc(p.photo) + "' alt='Proof of delivery' /></a>");
      }
      if (res.statusHistory && res.statusHistory.length) {
        rows.push("<hr style='margin:14px 0;border:none;border-top:1px solid #e2e8f0;'/>");
        rows.push("<strong>" + window.esc(tr("proof_status_history", "Status history")) + "</strong>");
        rows.push("<ul style='margin:8px 0 0;padding-left:18px;font-size:0.85rem;color:#475569;'>");
        res.statusHistory.forEach(function (h) {
          rows.push("<li>" + window.esc(h.status) + " - " + formatDateTime(h.at) + (h.note ? " <em>(" + window.esc(h.note) + ")</em>" : "") + "</li>");
        });
        rows.push("</ul>");
      }
      body.innerHTML = rows.join("");
    } catch (e) {
      body.innerHTML = "<p style='color:#b91c1c;'>" + window.esc(e.message || tr("proof_load_failed", "Failed to load proof.")) + "</p>";
    }
  }

  function closeProofModal() {
    var modal = document.getElementById("proofModal");
    if (modal) modal.classList.remove("open");
  }

  function proofButton(order) {
    var s = normalizeStatus(order.status);
    if (s !== "DELIVERED" && s !== "COMPLETED") return "";
    return '<button class="btn btn-sm btn-outline-success proof-action" data-order="' + window.esc(order.orderId) + '">' +
      window.esc(tr("admin_proof_view", "Proof")) + "</button>";
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
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        loadAll({ fromRefresh: true });
      });
    }

    var issueFilter = document.getElementById("issueStatusFilter");
    if (issueFilter) {
      issueFilter.addEventListener("change", function () {
        issueStatusFilter = issueFilter.value;
        loadIssues();
      });
    }

    document.addEventListener("change", function (e) {
      var reassign = e.target.closest("[data-issue-reassign]");
      if (reassign) {
        var rid = reassign.getAttribute("data-issue-reassign");
        var staffId = reassign.value;
        reassign.value = "";
        if (staffId) {
          var who = (deliveryStaff.find(function (s) { return String(s.id) === String(staffId); }) || {}).name || staffId;
          if (!window.confirm(tr("admin_confirm_issue_reassign", "Reassign this delivery to {name}?", { name: who }))) return;
          issueAction(rid, "reassign", { deliveryStaffId: staffId });
        }
        return;
      }
      var select = e.target.closest(".delivery-staff-select");
      if (select) {
        var orderId = select.getAttribute("data-order");
        if (select.value) assignStaff(orderId, select.value);
        select.value = "";
        return;
      }
    });

    document.addEventListener("click", function (e) {
      var issueBtn = e.target.closest("[data-issue-action]");
      if (issueBtn) {
        issueAction(
          issueBtn.getAttribute("data-issue"),
          issueBtn.getAttribute("data-issue-action")
        );
        return;
      }
      var outBtn = e.target.closest(".out-delivery-action");
      if (outBtn) {
        markOutForDelivery(outBtn.getAttribute("data-order"));
        return;
      }
      var arrivedBtn = e.target.closest(".arrived-action");
      if (arrivedBtn) {
        markArrived(arrivedBtn.getAttribute("data-order"));
        return;
      }
      var deliveredBtn = e.target.closest(".delivered-action");
      if (deliveredBtn) {
        markDelivered(deliveredBtn.getAttribute("data-order"));
        return;
      }
      var completedBtn = e.target.closest(".completed-action");
      if (completedBtn) {
        markCompleted(completedBtn.getAttribute("data-order"));
        return;
      }
      var proofBtn = e.target.closest(".proof-action");
      if (proofBtn) {
        openProofModal(proofBtn.getAttribute("data-order"));
        return;
      }
      var proofClose = e.target.closest("[data-proof-close]");
      if (proofClose) {
        closeProofModal();
        return;
      }
      var trackBtn = e.target.closest(".live-track-action");
      if (trackBtn) {
        openLiveMonitor(trackBtn.getAttribute("data-order"));
        return;
      }
      var trackClose = e.target.closest("[data-live-track-close]");
      if (trackClose) {
        closeLiveMonitor();
        return;
      }
    });

    // Emergency banner buttons. The banner is fixed to the viewport, so it is
    // bound here rather than inside the table handlers above.
    var ackBtn = document.getElementById("emergencyAckBtn");
    if (ackBtn) ackBtn.addEventListener("click", acknowledgeEmergency);
    var resolveBtn = document.getElementById("emergencyResolveBtn");
    if (resolveBtn) resolveBtn.addEventListener("click", resolveEmergency);

    // Clicking the backdrop (not the dialog) closes the proof modal.
    var proofModal = document.getElementById("proofModal");
    if (proofModal) {
      proofModal.addEventListener("click", function (e) {
        if (e.target === proofModal) closeProofModal();
      });
    }

    // Same for the live delivery monitor.
    var trackModal = document.getElementById("liveTrackModal");
    if (trackModal) {
      trackModal.addEventListener("click", function (e) {
        if (e.target === trackModal) closeLiveMonitor();
      });
    }
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
    // Exposed to the live monitor, which joins one order's authorized GPS room.
    monitorSocket = socket;
    socket.on("connect", function () {
      socket.emit("join:admin", {});
      socket.emit("join:delivery", {});
      // A reconnect drops every room on the server side, so re-join whatever the
      // manager was watching. Without this the monitor silently freezes.
      paintMonitorConnection();
      subscribeMonitorSocket();
    });
    socket.on("disconnect", function () { paintMonitorConnection(); });
    ["delivery:new", "delivery:assigned", "order:status", "delivery:issue", "delivery:staff"].forEach(function (event) {
      socket.on(event, function () {
        loadAll();
      });
    });
    // Live GPS fixes for active deliveries (server broadcasts to the 'admin'
    // room after each saved location; payload: orderId, deliveryStaffId,
    // latitude, longitude, accuracy, updatedAt/timestamp, distanceToCustomerKm,
    // nearCustomer).
    socket.on("delivery:location", function (point) {
      applyLiveGps(point);
      onMonitorFrame(point);
    });
    // A rider pressed SOS. Show the banner + alarm immediately rather than
    // waiting for the next poll.
    socket.on("delivery:emergency", function (em) {
      if (!em) return;
      emergencies = [em].concat(emergencies.filter(function (e) { return e.id !== em.id; }));
      setActiveEmergency(em);
      loadAll();
    });
    socket.on("delivery:emergency:ack", function (em) {
      if (!em) return;
      emergencies = emergencies.map(function (e) { return e.id === em.id ? em : e; });
      if (activeEmergency && activeEmergency.id === em.id) {
        // Acknowledging does not resolve: the banner stays until resolved.
        activeEmergency = em;
        showEmergencyBanner(em);
      }
      loadAll();
    });
    socket.on("delivery:emergency:resolved", function (em) {
      if (!em) return;
      emergencies = emergencies.map(function (e) { return e.id === em.id ? em : e; });
      if (activeEmergency && activeEmergency.id === em.id) setActiveEmergency(null);
      loadAll();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    // loadAll() loads the staff list itself, so it covers the selector too.
    loadAll();
    bindEvents();
    setupSocket();

    // Poll for emergencies as a safety net. The socket event is the fast path;
    // this guarantees a banner appears even if the frame was missed (reconnect,
    // backgrounded tab, a manager who opened the page after the SOS).
    loadEmergencies();
    setInterval(loadEmergencies, 15000);

    __registerLangChange(function () {
        try {
          if (!document.getElementById("deliveriesTableBody") && !document.getElementById("deliveredTableBody")) return;
          renderActive();
          renderCompleted();
          renderIssues();
        } catch (e) { /* best-effort re-render */ }
    });

    // Never leave a Leaflet instance (or its tile requests) running.
    window.addEventListener("pagehide", function () {
      if (monitorMap) { monitorMap.destroy(); monitorMap = null; }
    });
  });
})();
