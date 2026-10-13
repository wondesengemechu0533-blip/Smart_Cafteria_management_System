function csTr(key, fallback) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback);
  if (typeof getText === "function") { const g = getText(key); if (g && g !== key) return g; }
  return fallback;
}
/**
 * customer-sidebar.js
 * Injects a unified, responsive navigation sidebar into every customer page.
 *
 * - The sidebar is a fixed left rail on desktop (collapsible to an icon rail)
 *   and an off-canvas drawer on mobile/tablet (slide-in + backdrop).
 * - The current page is highlighted by matching the filename.
 * - A hamburger toggle is injected into the customer header to open/close it.
 *
 * Non-destructive: it only appends elements and adds one body class, so the
 * existing centered/narrow layouts (history, status, cart, checkout) are
 * preserved via the fixed-position rail (margins shift the content over).
 */
(function () {
  "use strict";

  if (window.__customerSidebarLoaded) return;
  window.__customerSidebarLoaded = true;

  var page = document.body.getAttribute("data-page") ||
    (location.pathname.split("/").pop() || "menu.html");

  var navItems = [
    { href: "menu.html", icon: "fa-solid fa-utensils", label: csTr('nav_menu', 'Menu'), current: "menu.html" },
    { href: "order-tracking.html", icon: "fa-solid fa-location-crosshairs", label: csTr('nav_track_order', 'Track Order'), current: "order-tracking.html" },
    { href: "order-history.html", icon: "fa-solid fa-clock-rotate-left", label: csTr('nav_order_history', 'Order History'), current: "order-history.html" },
    { href: "cart.html", icon: "fa-solid fa-cart-shopping", label: csTr('nav_cart', 'My Cart'), current: "cart.html" },
    { href: "profile.html", icon: "fa-solid fa-user-gear", label: csTr('nav_account_settings', 'Account Settings'), current: "profile.html" },
    { href: "feedback.html", icon: "fa-solid fa-comment-dots", label: csTr('nav_feedback', 'Feedback & Reviews'), current: "feedback.html" }
  ];

  var currentFile = page.toLowerCase();

  function buildNav() {
    var html = "";
    navItems.forEach(function (item) {
      var isActive = currentFile === item.current;
      html +=
        '<a href="' + item.href + '" class="customer-nav-item' + (isActive ? " active" : "") + '">' +
        '<i class="' + item.icon + '"></i>' +
        '<span>' + item.label + "</span>" +
        "</a>";
    });
    return html;
  }

  function buildSidebar() {
    var aside = document.createElement("aside");
    aside.className = "customer-sidebar";
    aside.setAttribute("id", "customerSidebar");
    aside.setAttribute("aria-label", "Customer navigation");

    aside.innerHTML =
      '<div class="sidebar-logo">' +
      '<i class="fa-solid fa-utensils"></i>' +
      "<span>Smart Cafeteria</span>" +
      "</div>" +
      '<div class="sidebar-card">' +
      '<img alt="Customer avatar" class="avatar-img" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'42\' height=\'42\'%3E%3Ccircle cx=\'21\' cy=\'21\' r=\'21\' fill=\'%23cbd5e1\'/%3E%3Ctext x=\'50%25\' y=\'55%25\' dominant-baseline=\'middle\' text-anchor=\'middle\' fill=\'%23475569\' font-size=\'16\'%3E%3F%3C/text%3E%3C/svg%3E">' +
      '<div>' +
      '<div class="sc-name" id="sidebarCustomerName">Guest</div>' +
      '<div class="sc-mail" id="sidebarCustomerMail">customer</div>' +
      "</div>" +
      "</div>" +
      '<nav class="customer-nav">' + buildNav() + "</nav>" +
      '<div class="customer-sidebar-footer">' +
      '<button type="button" class="rail-toggle" id="customerRailToggle" aria-label="Collapse sidebar">' +
      '<i class="fa-solid fa-angles-left"></i><span>Collapse</span>' +
      "</button>" +
      "</div>";

    document.body.appendChild(aside);
    document.body.classList.add("has-customer-sidebar");
  }

  function buildBackdrop() {
    var backdrop = document.createElement("div");
    backdrop.className = "customer-sidebar-backdrop";
    backdrop.id = "customerSidebarBackdrop";
    document.body.appendChild(backdrop);
  }

  function injectToggle() {
    // Place the hamburger at the start of the left header group.
    var hosts = [
      document.querySelector(".navbar-header .nav-left-group"),
      document.querySelector(".navbar .nav-left-group"),
      document.querySelector(".btn-back-home"),
      document.querySelector(".btn-back"),
      document.querySelector(".navbar-header .nav-container"),
      document.querySelector(".navbar .nav-container")
    ];

    var host = null;
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i]) {
        host = hosts[i];
        break;
      }
    }
    if (!host) return;

    var btn = document.createElement("button");
    btn.className = "customer-sidebar-toggle";
    btn.id = "customerSidebarToggle";
    btn.type = "button";
    btn.setAttribute("aria-label", "Open navigation");
    btn.innerHTML = '<i class="fa-solid fa-bars"></i>';

    if (host.classList.contains("btn-back-home") ||
        host.classList.contains("btn-back")) {
      host.parentNode.insertBefore(btn, host);
    } else {
      host.insertBefore(btn, host.firstChild);
    }
  }

  // Turn a backend-relative /uploads/... path into an absolute URL the browser
  // can load (backend serves uploads from port 5000, frontend from a dev port).
  function resolveAvatarSrc(avatar) {
    if (!avatar) return "";
    var value = String(avatar);
    if (value.indexOf("data:") === 0 || /^https?:\/\//i.test(value)) {
      return value;
    }
    if (value.indexOf("/uploads/") === 0) {
      var origin = window.__API_BASE;
      if (typeof location !== "undefined" && location.origin) {
        origin = location.origin.replace(/:\d+$/, "") + ":5000";
      }
      return origin + value;
    }
    return value;
  }

  // Hydrate the profile card from any stored customer data.
  function hydrateProfile() {
    var nameEl = document.getElementById("sidebarCustomerName");
    var mailEl = document.getElementById("sidebarCustomerMail");
    var imgEl = document.querySelector(".customer-sidebar .sidebar-card .avatar-img");
    if (!nameEl) return;

    // Read from the same localStorage keys the rest of the app uses.
    var profile = null;
    try {
      profile = JSON.parse(localStorage.getItem("current_user") || "null");
    } catch (e) { profile = null; }
    if (!profile || !(profile.name || profile.avatar)) {
      try {
        profile = JSON.parse(localStorage.getItem("userProfile") || "null");
      } catch (e) { profile = null; }
    }

    if (profile) {
      if (profile.name && nameEl) nameEl.textContent = profile.name;
      if (profile.email && mailEl) mailEl.textContent = profile.email;

      // Set the avatar image
      if (imgEl) {
        if (profile.avatar) {
          imgEl.src = resolveAvatarSrc(profile.avatar);
        } else if (profile.name) {
          // Generate initials avatar inline
          var initial = profile.name.trim().charAt(0).toUpperCase() || "U";
          imgEl.src = "data:image/svg+xml;utf8," + encodeURIComponent(
            "<svg xmlns='http://www.w3.org/2000/svg' width='42' height='42'>" +
            "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
            "<stop offset='0' stop-color='%233b82f6'/>" +
            "<stop offset='1' stop-color='%232563eb'/>" +
            "</linearGradient></defs>" +
            "<circle cx='21' cy='21' r='21' fill='url(%23g)'/>" +
            "<text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle' fill='#ffffff' font-size='19' font-family='Arial,sans-serif' font-weight='600'>" + initial + "</text>" +
            "</svg>"
          );
        }
        imgEl.onerror = function () {
          this.onerror = null;
          var fallbackInitial = (profile.name || "U").trim().charAt(0).toUpperCase() || "U";
          this.src = "data:image/svg+xml;utf8," + encodeURIComponent(
            "<svg xmlns='http://www.w3.org/2000/svg' width='42' height='42'>" +
            "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
            "<stop offset='0' stop-color='%233b82f6'/>" +
            "<stop offset='1' stop-color='%232563eb'/>" +
            "</linearGradient></defs>" +
            "<circle cx='21' cy='21' r='21' fill='url(%23g)'/>" +
            "<text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle' fill='#ffffff' font-size='19' font-family='Arial,sans-serif' font-weight='600'>" + fallbackInitial + "</text>" +
            "</svg>"
          );
        };
      }
    }
  }

  function bindEvents() {
    var sidebar = document.getElementById("customerSidebar");
    var backdrop = document.getElementById("customerSidebarBackdrop");
    var toggle = document.getElementById("customerSidebarToggle");
    var railToggle = document.getElementById("customerRailToggle");

    var isMobile = function () {
      return window.innerWidth <= 992;
    };

    if (toggle) {
      toggle.addEventListener("click", function () {
        if (isMobile()) {
          sidebar.classList.toggle("open");
          if (backdrop) backdrop.classList.toggle("open", sidebar.classList.contains("open"));
        } else {
          sidebar.classList.toggle("collapsed");
          document.body.classList.toggle("main-rail-collapsed", sidebar.classList.contains("collapsed"));
          if (railToggle) {
            railToggle.innerHTML = sidebar.classList.contains("collapsed")
              ? '<i class="fa-solid fa-angles-right"></i>'
              : '<i class="fa-solid fa-angles-left"></i><span>Collapse</span>';
          }
        }
      });
    }

    if (backdrop) {
      backdrop.addEventListener("click", function () {
        sidebar.classList.remove("open");
        backdrop.classList.remove("open");
      });
    }

    if (railToggle) {
      railToggle.addEventListener("click", function () {
        sidebar.classList.toggle("collapsed");
        document.body.classList.toggle("main-rail-collapsed", sidebar.classList.contains("collapsed"));
        railToggle.innerHTML = sidebar.classList.contains("collapsed")
          ? '<i class="fa-solid fa-angles-right"></i>'
          : '<i class="fa-solid fa-angles-left"></i><span>Collapse</span>';
      });
    }

    // Close the drawer when resizing up to desktop.
    window.addEventListener("resize", function () {
      if (!isMobile() && sidebar) {
        sidebar.classList.remove("open");
        if (backdrop) backdrop.classList.remove("open");
      }
    });

    // Keep the toggle glyph consistent on desktop.
    if (railToggle) {
      railToggle.innerHTML = '<i class="fa-solid fa-angles-left"></i><span>Collapse</span>';
    }
  }

  function init() {
    // The customer sidebar is only shown to authenticated customers. Guests
    // browsing the public menu should see a clean menu without the customer
    // dashboard rail.
    var loggedIn =
      localStorage.getItem("isLoggedIn") === "true" ||
      Boolean(localStorage.getItem("auth_token"));
    if (!loggedIn) return;

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        buildBackdrop();
        buildSidebar();
        injectToggle();
        hydrateProfile();
        bindEvents();
        // Sync all avatar/name elements now that the sidebar DOM exists.
        if (typeof window.populateUserUI === "function") {
          try { window.populateUserUI(); } catch (e) {}
        }
      });
    } else {
      buildBackdrop();
      buildSidebar();
      injectToggle();
      hydrateProfile();
      bindEvents();
      if (typeof window.populateUserUI === "function") {
        try { window.populateUserUI(); } catch (e) {}
      }
    }
  }

  init();
})();