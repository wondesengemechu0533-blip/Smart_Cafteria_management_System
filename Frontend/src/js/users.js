function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}

/**
 * ================================================================
 * SMART CAFETERIA - USER MANAGEMENT (All 6 Actions)
 * ================================================================
 * Actions: View, Edit, ID Card, Reset Password, Block/Unblock, Delete
 *
 * API endpoints:
 *   GET    /admin/users            (list)
 *   GET    /admin/users/:id        (details)
 *   GET    /admin/users/stats      (statistics)
 *   POST   /admin/users            (create)
 *   PUT    /admin/users/:id        (update)
 *   PATCH  /admin/users/:id/status (toggle status)
 *   PATCH  /admin/users/:id/role   (assign role)
 *   PATCH  /admin/users/:id/password (reset password)
 *   DELETE /admin/users/:id        (delete)
 * ================================================================
 */
(function () {
  "use strict";

  var state = { page: 1, limit: 10, search: "", role: "", status: "", total: 0, pages: 1 };
  var loadSeq = 0;
  var pendingToggleUser = null;
  var pendingDeleteUser = null;
  var isCafeteriaAdmin = (window.ScosRoles && typeof window.ScosRoles.getCurrentRole === "function" && window.ScosRoles.getCurrentRole() === "cafeteria_admin");

  function applyCafeteriaAdminRestrictions() {
    if (!isCafeteriaAdmin) return;
    var allowedRoles = ["kitchen", "delivery", "cashier"];
    var roleFilter = document.getElementById("roleFilter");
    if (roleFilter) {
      Array.prototype.slice.call(roleFilter.options).forEach(function (opt) {
        if (opt.value && allowedRoles.indexOf(opt.value) === -1) opt.remove();
      });
    }
    var roleSelect = document.getElementById("userRole");
    if (roleSelect) {
      Array.prototype.slice.call(roleSelect.options).forEach(function (opt) {
        if (allowedRoles.indexOf(opt.value) === -1) opt.remove();
      });
    }
    var h1 = document.querySelector(".page-header h1");
    if (h1) {
      h1.setAttribute("data-i18n", "admin_staff_management_title");
      h1.textContent = "Staff Management";
    }
    var subtitle = document.querySelector(".page-header .subtitle");
    if (subtitle) {
      subtitle.setAttribute("data-i18n", "admin_staff_management_subtitle");
      subtitle.textContent = "Manage cafeteria staff members";
    }
    var titleEl = document.querySelector("title");
    if (titleEl) {
      titleEl.setAttribute("data-i18n", "admin_staff_management_page_title");
      titleEl.textContent = "Staff Management - Smart Cafeteria";
    }
    document.title = "Staff Management - Smart Cafeteria";
  }

  /* ----------------------------------------------------------------
   * HELPERS
   * ---------------------------------------------------------------- */
  var ROLE_LABELS = {
    customer: { key: "role_customer", en: "Customer" },
    kitchen:  { key: "admin_user_role_kitchen", en: "Kitchen Staff" },
    delivery: { key: "role_delivery", en: "Delivery Staff" },
    cashier:  { key: "role_cashier", en: "Cashier" },
    manager:  { key: "role_cafeteria_manager", en: "Cafeteria Manager" },
    cafeteria_admin: { key: "role_cafeteria_admin", en: "Cafeteria Admin" },
    system_admin: { key: "role_system_admin", en: "System Admin" },
    admin:    { key: "role_system_admin", en: "System Admin" },
    staff:    { key: "role_staff", en: "Staff" },
    student:  { key: "role_student", en: "Student" }
  };
  var STATUS_LABELS = {
    ACTIVE:    { key: "status_active", en: "Active" },
    BLOCKED:   { key: "status_blocked", en: "Blocked" },
    SUSPENDED: { key: "status_suspended", en: "Suspended" },
    INACTIVE:  { key: "status_inactive", en: "Inactive" }
  };

  function getLang() {
    try { return (window.getCurrentLanguage && window.getCurrentLanguage()) || localStorage.getItem("scos_language") || "en"; }
    catch (e) { return "en"; }
  }
  function tr(key, fallback, vars) {
    if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
    if (typeof window.getText === "function") {
      var v = window.getText(key);
      if (v && v !== key) return v;
    }
    return fallback != null ? fallback : key;
  }
  function t(key, fallback) { return tr(key, fallback != null ? fallback : key); }
  function roleLabel(role) { var l = ROLE_LABELS[String(role).toLowerCase()]; if (l && l.key) { var v = t(l.key); if (v !== l.key) return v; } return l ? (l[getLang()] || l.en) : (role || "—"); }
  function statusLabel(s) { var l = STATUS_LABELS[String(s).toUpperCase()]; if (l && l.key) { var v = t(l.key); if (v !== l.key) return v; } return l ? (l[getLang()] || l.en) : (s || "—"); }
  function esc(str) { return window.esc ? window.esc(str) : String(str || ""); }
  function avatarInitial(name) { return (name && name.charAt(0).toUpperCase()) || "U"; }
  function formatDate(v) { return window.AdminAPI ? window.AdminAPI.formatDate(v) : new Date(v).toLocaleDateString(); }
  function formatDateTime(v) { return window.AdminAPI ? window.AdminAPI.formatDateTime(v) : new Date(v).toLocaleString(); }
  function currentAdminId() {
    try {
      var token = window.AdminAPI.getToken();
      if (!token) return null;
      return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).id || null;
    } catch (e) { return null; }
  }
  var adminId = currentAdminId();

  function rolePill(role) {
    var r = String(role || "").toUpperCase();
    var cls = "role-pill";
    if (r === "ADMIN" || r === "SYSTEM_ADMIN") cls += " role-admin";
    else if (r === "KITCHEN") cls += " role-kitchen";
    else if (r === "DELIVERY") cls += " role-delivery";
    else if (r === "CASHIER" || r === "MANAGER" || r === "CAFETERIA_ADMIN") cls += " role-admin";
    else cls += " role-customer";
    return '<span class="' + cls + '">' + esc(roleLabel(role)) + "</span>";
  }

  function statusPill(status, isActive) {
    var s = String(status || "ACTIVE").toUpperCase();
    var cls = "order-badge";
    if (s === "ACTIVE" && isActive !== false) cls += " active-badge";
    else if (s === "SUSPENDED") cls += " suspended-badge";
    else cls += " blocked-badge";
    return '<span class="' + cls + '">' + esc(statusLabel(status)) + "</span>";
  }

  /* ----------------------------------------------------------------
   * MODAL UTILS
   * ---------------------------------------------------------------- */
  function openModal(id) { var el = document.getElementById(id); if (el) el.classList.add("open"); }
  function closeModal(id) { var el = document.getElementById(id); if (el) el.classList.remove("open"); }
  function closeAllModals() { document.querySelectorAll(".modal-overlay.open").forEach(function (m) { m.classList.remove("open"); }); }

  /* ----------------------------------------------------------------
   * LOAD DATA
   * ---------------------------------------------------------------- */
  async function loadStats() {
    try {
      var data = await window.AdminAPI.get("/admin/users/stats");
      var s = data.stats || {};
      var e1 = document.getElementById("metricTotalUsers");
      var e2 = document.getElementById("metricActiveCustomers");
      var e3 = document.getElementById("metricStaff");
      var e4 = document.getElementById("metricBlockedUsers");
      if (e1) e1.textContent = s.totalUsers || 0;
      if (e2) e2.textContent = s.activeCustomers || 0;
      if (e3) e3.textContent = s.staffCount || 0;
      if (e4) e4.textContent = s.blockedCount || 0;
    } catch (e) {}
  }

  async function loadUsers() {
    var tbody = document.getElementById("usersTableBody");
    if (!tbody || !window.AdminAPI) return;
    var seq = ++loadSeq;
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty"><i class="fa-solid fa-spinner fa-spin"></i> ' + esc(t("loading", "Loading...")) + '</td></tr>';
    try {
      var data = await window.AdminAPI.get("/admin/users", {
        page: state.page, limit: state.limit, search: state.search, role: state.role, status: state.status
      });
      if (seq !== loadSeq) return;
      state.total = data.total || 0;
      state.pages = data.pages || Math.max(Math.ceil(state.total / state.limit), 1);
      window.__usersCache = data.users || [];
      renderUsers(window.__usersCache);
      renderPagination();
    } catch (error) {
      if (seq !== loadSeq) return;
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty"><i class="fa-solid fa-circle-exclamation"></i> ' + esc(error.message || t("error_server", "Server error")) + "</td></tr>";
    }
  }

  function renderUsers(users) {
    var tbody = document.getElementById("usersTableBody");
    if (!tbody) return;
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty"><i class="fa-solid fa-users"></i> ' + esc(t("no_users_found", tr('no_users_found', 'No users found'))) + '</td></tr>';
      return;
    }
    tbody.innerHTML = users.map(function (u) {
      var isActive = u.status === "ACTIVE" && u.isActive !== false;
      var isSelf = u.id === adminId;

      // Button 5: Block/Unblock toggle
      var toggleBtn;
      if (isSelf) {
        toggleBtn = '<button class="action-btn" title="' + esc(t("cannot_block_self", "Cannot block yourself")) + '" disabled><i class="fa-solid fa-lock"></i></button>';
      } else if (isActive) {
        toggleBtn = '<button class="action-btn" data-action="toggle" data-id="' + u.id + '" title="' + esc(t("block_user", "Block user")) + '"><i class="fa-solid fa-user-slash"></i></button>';
      } else {
        toggleBtn = '<button class="action-btn action-btn-success" data-action="toggle" data-id="' + u.id + '" title="' + esc(t("unblock_user", "Unblock user")) + '"><i class="fa-solid fa-user-check"></i></button>';
      }

      return (
        '<tr data-row-id="' + u.id + '"' + (!isActive ? ' class="row-inactive"' : "") + '>' +
          '<td>' +
            '<div class="user-cell">' +
              '<div class="user-avatar">' + avatarInitial(u.name) + "</div>" +
              "<div>" +
                "<strong>" + esc(u.name || "—") + "</strong>" +
                "<small>" + esc(u.email || "—") + "</small>" +
              "</div>" +
            "</div>" +
          "</td>" +
          '<td>' + rolePill(u.role) + "</td>" +
          '<td>' + statusPill(u.status, u.isActive) + "</td>" +
          "<td>" + formatDate(u.createdAt) + "</td>" +
          "<td>" +
            '<div class="table-actions">' +
              // 1. View
              '<button class="action-btn" data-action="view" data-id="' + u.id + '" title="' + esc(t("view_details", "View details")) + '"><i class="fa-solid fa-eye"></i></button>' +
              // 2. Edit
              '<button class="action-btn" data-action="edit" data-id="' + u.id + '" title="' + esc(t("edit_user", "Edit user")) + '"><i class="fa-solid fa-pen"></i></button>' +
              // 3. ID Card
              '<button class="action-btn" data-action="idcard" data-id="' + u.id + '" title="' + esc(t("id_badge", "ID Badge")) + '"><i class="fa-solid fa-id-card"></i></button>' +
              // 4. Reset Password
              '<button class="action-btn" data-action="password" data-id="' + u.id + '" title="' + esc(t("reset_password", "Reset password")) + '"><i class="fa-solid fa-key"></i></button>' +
              // 5. Block/Unblock
              toggleBtn +
              // 6. Delete
              '<button class="action-btn danger" data-action="delete" data-id="' + u.id + '" title="' + esc(t("delete_user", "Delete user")) + '"><i class="fa-solid fa-trash"></i></button>' +
            "</div>" +
          "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderPagination() {
    var info = document.getElementById("paginationInfo");
    var prev = document.getElementById("prevPageBtn");
    var next = document.getElementById("nextPageBtn");
    if (info) info.textContent = tr('page_info', 'Page {page} of {pages} ({total} items)').replace('{page}', state.page).replace('{pages}', Math.max(state.pages, 1)).replace('{total}', state.total);
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= state.pages;
  }

  function changePage(d) { state.page = Math.min(Math.max(state.page + d, 1), Math.max(state.pages, 1)); loadUsers(); }

  async function findUserById(id) {
    try { var d = await window.AdminAPI.get("/admin/users/" + id); return d.user || null; } catch (e) { return null; }
  }

  function getCachedUser(id) {
    return (window.__usersCache || []).find(function (u) { return u.id === id; }) || null;
  }

  /* ==================================================================
   * ACTION 1: VIEW USER DETAILS
   * Fetches fresh data from GET /admin/users/:id
   * ================================================================== */
  async function actionView(id) {
    var user = getCachedUser(id);
    if (!user) user = await findUserById(id);
    if (!user) { if (window.AdminToast) window.AdminToast.error("User not found"); return; }

    document.getElementById("detailAvatar").textContent = avatarInitial(user.name);
    document.getElementById("detailName").textContent = user.name || "—";
    document.getElementById("detailRoleWrap").innerHTML = rolePill(user.role);
    document.getElementById("detailId").textContent = user.id;
    document.getElementById("detailUsername").textContent = user.username || "—";
    document.getElementById("detailEmail").textContent = user.email || "—";
    document.getElementById("detailPhone").textContent = user.phone || "—";
    document.getElementById("detailStatus").innerHTML = statusPill(user.status, user.isActive);
    document.getElementById("detailJoined").textContent = formatDate(user.createdAt);
    openModal("viewUserModal");
  }

  /* ==================================================================
   * ACTION 2: EDIT USER
   * Populates edit form, submits via PUT /admin/users/:id
   * ================================================================== */
  function actionEdit(user) {
    document.getElementById("userForm").reset();
    document.getElementById("userId").value = user.id;
    document.getElementById("userName").value = user.name || "";
    document.getElementById("userEmail").value = user.email || "";
    document.getElementById("userPhone").value = user.phone || "";
    document.getElementById("userUsername").value = user.username || "";
    document.getElementById("userRole").value = user.role === "customer" ? "kitchen" : (user.role || "kitchen");
    document.getElementById("userStatus").value = user.status || "ACTIVE";
    document.getElementById("modalTitle").textContent = "Edit Staff";
    document.getElementById("saveUserBtn").textContent = "Update Staff";
    document.getElementById("passwordLabel").textContent = "New Password (optional)";
    document.getElementById("userPassword").required = false;
    document.getElementById("userPassword").value = "";
    document.getElementById("userConfirmPassword").value = "";
    openModal("userModal");
  }

  /* ==================================================================
   * ACTION 3: ID CARD BADGE
   * Renders digital ID badge preview
   * ================================================================== */
  function actionIdCard(user) {
    document.getElementById("idBadgeAvatar").textContent = avatarInitial(user.name);
    document.getElementById("idBadgeName").textContent = user.name || "—";

    var roleEl = document.getElementById("idBadgeRole");
    roleEl.textContent = roleLabel(user.role);
    roleEl.className = "id-badge-role role-" + (user.role || "customer");

    document.getElementById("idBadgeId").textContent = user.id ? user.id.slice(-8).toUpperCase() : "—";
    document.getElementById("idBadgeEmail").textContent = user.email || "—";
    document.getElementById("idBadgePhone").textContent = user.phone || "—";
    document.getElementById("idBadgeStatus").textContent = statusLabel(user.status);
    document.getElementById("idBadgeJoined").textContent = formatDate(user.createdAt);
    openModal("idCardModal");
  }

  /* ==================================================================
   * ACTION 4: RESET PASSWORD
   * PATCH /admin/users/:id/password, shows generated password
   * ================================================================== */
  function actionResetPassword(user) {
    closeAllModals();
    document.getElementById("resetPwdUserName").textContent = user.name + " (" + user.email + ")";
    document.getElementById("resetPwdUserId").value = user.id;
    document.getElementById("resetPwdNewPassword").value = "";
    document.getElementById("resetPwdConfirmPassword").value = "";
    var confirmBtn = document.getElementById("confirmResetPwdBtn");
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.innerHTML = "Reset Password"; }
    document.getElementById("resetPwdFormFields").style.display = "";
    document.getElementById("resetPwdResult").style.display = "none";
    confirmBtn.style.display = "";
    openModal("resetPasswordModal");
  }

  async function confirmResetPassword() {
    var id = document.getElementById("resetPwdUserId").value;
    var newPwd = document.getElementById("resetPwdNewPassword").value;
    var confirmPwd = document.getElementById("resetPwdConfirmPassword").value;
    if (!id) return;

    if (!newPwd || newPwd.length < 6) {
      if (window.AdminToast) window.AdminToast.error("Password must be at least 6 characters");
      return;
    }
    if (newPwd !== confirmPwd) {
      if (window.AdminToast) window.AdminToast.error("Passwords do not match");
      return;
    }

    var btn = document.getElementById("confirmResetPwdBtn");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Resetting...'; }

    try {
      await window.AdminAPI.patch("/admin/users/" + id + "/password", { password: newPwd });
      document.getElementById("resetPwdFormFields").style.display = "none";
      document.getElementById("resetPwdGenerated").textContent = newPwd;
      document.getElementById("resetPwdResult").style.display = "";
      if (btn) btn.style.display = "none";
      if (window.AdminToast) window.AdminToast.success("Password reset successfully");
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || "Failed to reset password");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = "Reset Password"; }
    }
  }

  /* ==================================================================
   * ACTION 5: BLOCK / UNBLOCK (TOGGLE STATUS)
   * PATCH /admin/users/:id/status
   * Updates UI badge + button state instantly
   * ================================================================== */
  function actionToggle(user) {
    var isActive = user.status === "ACTIVE" && user.isActive !== false;
    pendingToggleUser = user;

    document.getElementById("toggleStatusTitle").textContent = isActive ? "Block User" : "Unblock User";
    var icon = document.getElementById("toggleStatusIcon");
    icon.className = isActive ? "status-icon block" : "status-icon unblock";
    icon.innerHTML = isActive
      ? '<i class="fa-solid fa-user-slash"></i>'
      : '<i class="fa-solid fa-user-check"></i>';
    document.getElementById("toggleStatusText").innerHTML = isActive
      ? 'Are you sure you want to <strong>block</strong> <strong>' + esc(user.name) + '</strong>?<br><span style="font-size:13px;color:#64748b;">They will not be able to access the system.</span>'
      : 'Do you want to <strong>unblock</strong> <strong>' + esc(user.name) + '</strong>?<br><span style="font-size:13px;color:#64748b;">They will regain access to the system.</span>';

    var confirmBtn = document.getElementById("confirmToggleStatusBtn");
    confirmBtn.className = isActive ? "btn btn-danger" : "btn btn-success";
    confirmBtn.textContent = isActive ? "Block User" : "Unblock User";
    openModal("toggleStatusModal");
  }

  async function confirmToggleStatus() {
    if (!pendingToggleUser) return;
    var user = pendingToggleUser;
    var isActive = user.status === "ACTIVE" && user.isActive !== false;
    var newStatus = isActive ? "BLOCKED" : "ACTIVE";

    var btn = document.getElementById("confirmToggleStatusBtn");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...'; }

    try {
      await window.AdminAPI.patch("/admin/users/" + user.id + "/status", { status: newStatus });

      // Instant UI update — update cached user
      user.status = newStatus;
      user.isActive = newStatus === "ACTIVE";

      // Re-render just this row
      var row = document.querySelector('tr[data-row-id="' + user.id + '"]');
      if (row) {
        var statusTd = row.querySelectorAll("td")[2];
        if (statusTd) statusTd.innerHTML = statusPill(newStatus, newStatus === "ACTIVE");

        // Update toggle button
        var actionsDiv = row.querySelector(".table-actions");
        if (actionsDiv) {
          var oldToggle = actionsDiv.querySelector('[data-action="toggle"]');
          if (oldToggle) {
            if (newStatus === "ACTIVE") {
              oldToggle.className = "action-btn action-btn-success";
              oldToggle.title = "Block user";
              oldToggle.innerHTML = '<i class="fa-solid fa-user-check"></i>';
            } else {
              oldToggle.className = "action-btn";
              oldToggle.title = "Unblock user";
              oldToggle.innerHTML = '<i class="fa-solid fa-user-slash"></i>';
            }
          }
        }

        // Update row highlight
        if (newStatus !== "ACTIVE") { row.classList.add("row-inactive"); }
        else { row.classList.remove("row-inactive"); }
      }

      closeModal("toggleStatusModal");
      pendingToggleUser = null;
      loadStats();
      if (window.AdminToast) window.AdminToast.success("User " + (isActive ? "blocked" : "unblocked") + " successfully");
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || "Failed to update status");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = isActive ? "Block User" : "Unblock User"; }
    }
  }

  /* ==================================================================
   * ACTION 6: DELETE USER
   * DELETE /admin/users/:id, removes row from DOM
   * ================================================================== */
  function actionDelete(user) {
    pendingDeleteUser = user;
    document.getElementById("deleteText").innerHTML =
      'Are you sure you want to delete <strong>' + esc(user.name) + '</strong>?<br>' +
      '<span style="font-size:13px;color:#64748b;">This action cannot be undone.</span>';
    openModal("deleteModal");
  }

  async function confirmDelete() {
    if (!pendingDeleteUser) return;
    var user = pendingDeleteUser;

    var btn = document.getElementById("confirmDeleteBtn");
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...'; }

    try {
      await window.AdminAPI.del("/admin/users/" + user.id);

      // Remove row from DOM instantly
      var row = document.querySelector('tr[data-row-id="' + user.id + '"]');
      if (row) {
        row.style.transition = "opacity 0.3s, transform 0.3s";
        row.style.opacity = "0";
        row.style.transform = "translateX(20px)";
        setTimeout(function () { row.remove(); }, 300);
      }

      // Update cache
      window.__usersCache = (window.__usersCache || []).filter(function (u) { return u.id !== user.id; });
      state.total = Math.max(0, state.total - 1);

      closeModal("deleteModal");
      pendingDeleteUser = null;

      if (state.total === 0 && state.page > 1) {
        state.page--;
        loadUsers();
      } else {
        renderPagination();
      }
      loadStats();
      if (window.AdminToast) window.AdminToast.success("User deleted successfully");
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || "Failed to delete user");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Delete Staff"; }
    }
  }

  /* ==================================================================
   * EVENT BINDINGS
   * ================================================================== */
  function bindEvents() {
    // Add staff button
    var addBtn = document.getElementById("openAddUserModalBtn");
    if (addBtn) addBtn.addEventListener("click", function () {
      document.getElementById("userForm").reset();
      document.getElementById("userId").value = "";
      document.getElementById("modalTitle").textContent = "Add New Staff";
      document.getElementById("saveUserBtn").textContent = "Save Staff";
      document.getElementById("passwordLabel").textContent = "Password *";
      document.getElementById("userPassword").required = true;
      document.getElementById("userPassword").value = "";
      document.getElementById("userConfirmPassword").value = "";
      document.getElementById("userStatus").value = "ACTIVE";
      openModal("userModal");
    });

    // Form submit (create / update)
    var userForm = document.getElementById("userForm");
    if (userForm) userForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var id = document.getElementById("userId").value;
      var name = document.getElementById("userName").value.trim();
      var email = document.getElementById("userEmail").value.trim();
      var phone = document.getElementById("userPhone").value.trim();
      var username = document.getElementById("userUsername").value.trim();
      var role = document.getElementById("userRole").value;
      var status = document.getElementById("userStatus").value;
      var password = document.getElementById("userPassword").value;
      var confirmPassword = document.getElementById("userConfirmPassword").value;

      if (!id && !email) return;
      if (!id && password !== confirmPassword) {
        if (window.AdminToast) window.AdminToast.error("Passwords do not match"); return;
      }
      if (id && password && password !== confirmPassword) {
        if (window.AdminToast) window.AdminToast.error("Passwords do not match"); return;
      }

      var submitBtn = document.getElementById("saveUserBtn");
      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }

      try {
        if (!id) {
          if (!password) { if (window.AdminToast) window.AdminToast.error("Password is required"); return; }
          await window.AdminAPI.post("/admin/users", { name: name, email: email, phone: phone, username: username, role: role, status: status, balance: 0, password: password });
        } else {
          var payload = { name: name, email: email, phone: phone, username: username, role: role, status: status, balance: 0 };
          if (password) payload.password = password;
          await window.AdminAPI.put("/admin/users/" + id, payload);
        }
        closeModal("userModal");
        if (window.AdminToast) window.AdminToast.success(id ? "User updated" : "User created");
        loadUsers(); loadStats();
      } catch (error) {
        if (window.AdminToast) window.AdminToast.error(error.message || "Failed to save user");
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = id ? "Update Staff" : "Save Staff"; }
      }
    });

    // Close buttons
    document.querySelectorAll("[data-close-modal]").forEach(function (btn) {
      btn.addEventListener("click", function () { closeModal(btn.getAttribute("data-close-modal")); });
    });

    // Search
    var searchInput = document.getElementById("userSearchInput");
    if (searchInput) {
      var timer = null;
      searchInput.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () { state.search = searchInput.value.trim(); state.page = 1; loadUsers(); }, 400);
      });
    }

    // Role filter
    var roleFilter = document.getElementById("roleFilter");
    if (roleFilter) roleFilter.addEventListener("change", function () { state.role = roleFilter.value; state.page = 1; loadUsers(); });

    // Status filter
    var statusFilter = document.getElementById("statusFilter");
    if (statusFilter) statusFilter.addEventListener("change", function () { state.status = statusFilter.value; state.page = 1; loadUsers(); });

    // Reset filters
    var resetBtn = document.getElementById("resetFiltersBtn");
    if (resetBtn) resetBtn.addEventListener("click", function () {
      if (searchInput) searchInput.value = "";
      if (roleFilter) roleFilter.value = "";
      if (statusFilter) statusFilter.value = "";
      state.search = ""; state.role = ""; state.status = ""; state.page = 1;
      loadUsers();
    });

    // Pagination
    var prevBtn = document.getElementById("prevPageBtn");
    var nextBtn = document.getElementById("nextPageBtn");
    if (prevBtn) prevBtn.addEventListener("click", function () { changePage(-1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { changePage(1); });

    // Table action buttons (event delegation)
    var tbody = document.getElementById("usersTableBody");
    if (tbody) {
      tbody.addEventListener("click", async function (e) {
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        var id = btn.getAttribute("data-id");
        var action = btn.getAttribute("data-action");
        if (!id || !action) return;

        var user = getCachedUser(id);
        if (!user) user = await findUserById(id);
        if (!user) { if (window.AdminToast) window.AdminToast.error("User not found"); return; }

        // Dispatch to action handler
        if (action === "view")     return actionView(id);
        if (action === "edit")     return actionEdit(user);
        if (action === "idcard")   return actionIdCard(user);
        if (action === "password") return actionResetPassword(user);
        if (action === "toggle")   return actionToggle(user);
        if (action === "delete")   return actionDelete(user);
      });
    }

    // Reset password confirm button
    var confirmPwdBtn = document.getElementById("confirmResetPwdBtn");
    if (confirmPwdBtn) confirmPwdBtn.addEventListener("click", confirmResetPassword);

    // Toggle status confirm button
    var confirmToggleBtn = document.getElementById("confirmToggleStatusBtn");
    if (confirmToggleBtn) confirmToggleBtn.addEventListener("click", confirmToggleStatus);

    // Delete confirm button
    var confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener("click", confirmDelete);

    // Password show/hide toggle
    document.querySelectorAll(".toggle-password-icon").forEach(function (icon) {
      icon.addEventListener("click", function () {
        var targetId = icon.getAttribute("data-target");
        var input = document.getElementById(targetId);
        if (!input) return;
        var isPassword = input.type === "password";
        input.type = isPassword ? "text" : "password";
        icon.classList.toggle("fa-eye", !isPassword);
        icon.classList.toggle("fa-eye-slash", isPassword);
        icon.title = isPassword ? "Hide password" : "Show password";
      });
    });
  }

  /* ----------------------------------------------------------------
   * INIT
   * ---------------------------------------------------------------- */
  function init() {
    applyCafeteriaAdminRestrictions();
    bindEvents();
    loadStats();
    loadUsers();

    __registerLangChange(function () {
        try {
          if (!document.getElementById("usersTableBody")) return;
          if (!window.__usersCache) return;
          renderUsers(window.__usersCache);
          renderPagination();
        } catch (e) { /* best-effort re-render */ }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
