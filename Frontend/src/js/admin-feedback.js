function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ==========================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN FEEDBACK MANAGEMENT
 * ==========================================================================
 * Admin Feedback Management driven by the backend API:
 *   GET    /admin/feedback           (list / search / filter / paginate)
 *   GET    /admin/feedback/:id       (details)
 *   PATCH  /admin/feedback/:id/reply (reply to feedback)
 *   DELETE /admin/feedback/:id       (delete)
 *
 * Requires window.AdminAPI (admin-api.js) loaded first.
 * ============================================================================
 */
(function () {
  "use strict";

  var state = {
    page: 1,
    limit: 10,
    search: "",
    status: "",
    rating: ""
  };

  function escapeHtml(value) {
    return window.esc(value);
  }

  function openModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add("open");
  }

  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove("open");
  }

  function closeAllModals() {
    document.querySelectorAll(".modal-overlay.open").forEach(function(m) {
      m.classList.remove("open");
    });
  }

  document.addEventListener("click", function(e) {
    var closeBtn = e.target.closest("[data-close-modal]");
    if (closeBtn) closeModal(closeBtn.getAttribute("data-close-modal"));
  });

  function ratingStars(rating) {
    var r = Number(rating) || 0;
    var html = "";
    for (var i = 1; i <= 5; i++) {
      html += '<i class="fa-solid fa-star' + (i <= r ? "" : "-o") + '" style="color: ' + (i <= r ? "#f59e0b" : "#d1d5db") + '"></i>';
    }
    return html;
  }

  function statusBadge(status) {
    var s = String(status || "").toUpperCase();
    var cls = "order-badge";
    switch (s) {
      case "PENDING": cls += " pend"; break;
      case "RESOLVED": cls += " cmp"; break;
      case "ARCHIVED": cls += " cxl"; break;
      default: cls += " pend";
    }
    return '<span class="' + cls + '">' + s + "</span>";
  }

  async function loadFeedback() {
    var tbody = document.getElementById("feedbackTableBody");
    if (!tbody || !window.AdminAPI) return;

    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">'+tr('loading_feedback','Loading feedback...')+'</td></tr>';

    try {
      var data = await window.AdminAPI.get("/feedback", {
        page: state.page,
        limit: state.limit,
        search: state.search,
        status: state.status,
        rating: state.rating
      });

      state.total = data.total || 0;
      state.pages = data.pages || Math.max(Math.ceil(state.total / state.limit), 1);
      window.__feedbackCache = data.feedback || [];
      renderFeedback(window.__feedbackCache);
      renderPagination();
    } catch (error) {
      tbody.innerHTML = tr('failed_load_feedback', 'Failed to load feedback: {error}', { error: error.message || '' });
    }
  }

  function renderFeedback(items) {
    var tbody = document.getElementById("feedbackTableBody");
    if (!tbody) return;

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">'+tr('no_feedback','No feedback found.')+'</td></tr>';
      return;
    }

    tbody.innerHTML = items.map(function(f) {
      return (
        "<tr>" +
        '<td><strong>' + window.esc(f._id || f.id || "-") + '</strong></td>' +
        '<td>' + window.esc(f.user?.name || f.userName || "-") + '</td>' +
        '<td>' + ratingStars(f.rating) + ' <small>(' + (f.rating || 0) + '/5)</small></td>' +
        '<td>' + window.esc(f.category || "-") + '</td>' +
        '<td>' + window.esc(f.dishName || "-") + '</td>' +
        '<td>' + statusBadge(f.status) + '</td>' +
        '<td>' + window.AdminAPI.formatDateTime(f.createdAt) + '</td>' +
        '<td>' +
        '<div class="table-actions">' +
          '<button class="action-btn" data-action="view" data-id="' + (f._id || f.id) + '" title="' + tr('view_details', 'View details') + '"><i class="fa-solid fa-eye"></i></button>' +
          '<button class="action-btn" data-action="reply" data-id="' + (f._id || f.id) + '" title="' + tr('reply', 'Reply') + '"><i class="fa-solid fa-reply"></i></button>' +
          '<button class="action-btn danger" data-action="delete" data-id="' + (f._id || f.id) + '" title="' + tr('delete', 'Delete') + '"><i class="fa-solid fa-trash"></i></button>' +
        '</div>' +
        '</td>' +
        '</tr>'
      );
    }).join("");
  }

  function renderPagination() {
    var info = document.getElementById("paginationInfo");
    var prevBtn = document.getElementById("prevPageBtn");
    var nextBtn = document.getElementById("nextPageBtn");

    if (info) info.textContent = tr('page_of_feedback', 'Page {page} of {pages} ({total} feedback)').replace('{page}', state.page).replace('{pages}', Math.max(state.pages, 1)).replace('{total}', state.total);
    if (prevBtn) prevBtn.disabled = state.page <= 1;
    if (nextBtn) nextBtn.disabled = state.page >= state.pages;
  }

  function changePage(delta) {
    state.page += delta;
    if (state.page < 1) state.page = 1;
    loadFeedback();
  }

  async function viewFeedback(feedback) {
    closeAllModals();

    document.getElementById("modalFeedbackIdVal").textContent = feedback._id || feedback.id || "-";
    document.getElementById("modalFeedbackUser").textContent = feedback.user?.name || feedback.userName || "-";
    document.getElementById("modalFeedbackRole").textContent = feedback.user?.role || "Customer";
    document.getElementById("modalFeedbackAvatar").textContent = (feedback.user?.name || "U").charAt(0).toUpperCase();
    document.getElementById("modalFeedbackOrder").textContent = feedback.orderId || "-";
    document.getElementById("modalFeedbackRating").innerHTML = ratingStars(feedback.rating) + ' <strong>(' + (feedback.rating || 0) + '/5)</strong>';
    document.getElementById("modalFeedbackCategory").textContent = feedback.category || "-";
    document.getElementById("modalFeedbackDish").textContent = feedback.dishName || "-";
    document.getElementById("modalFeedbackDate").textContent = window.AdminAPI.formatDateTime(feedback.createdAt);
    document.getElementById("modalFeedbackStatus").innerHTML = statusBadge(feedback.status);
    document.getElementById("modalFeedbackComment").textContent = feedback.comment || "-";
    document.getElementById("modalFeedbackReply").value = feedback.reply || "";
    document.getElementById("modalFeedbackMarkResolved").checked = feedback.status === "RESOLVED";

    document.getElementById("modalFeedbackReply").dataset.feedbackId = feedback._id || feedback.id;
    document.getElementById("modalFeedbackMarkResolved").dataset.feedbackId = feedback._id || feedback.id;

    openModal("feedbackDetailsModal");
  }

  async function sendFeedbackReply() {
    var replyInput = document.getElementById("modalFeedbackReply");
    var resolvedCheck = document.getElementById("modalFeedbackMarkResolved");
    var feedbackId = replyInput.dataset.feedbackId;

    var reply = replyInput.value.trim();
    var markResolved = resolvedCheck.checked;

    // Reply is OPTIONAL: staff may acknowledge/dismiss feedback without
    // writing a response (the backend has no feedback reply endpoint).
    if (!reply) {
      closeModal("feedbackDetailsModal");
      if (window.AdminToast) window.AdminToast.success(tr('feedback_handled', 'Feedback marked as handled'));
      loadFeedback();
      return;
    }

    try {
      await window.AdminAPI.patch("/feedback/" + feedbackId + "/reply", {
        reply: reply,
        resolved: markResolved
      });
      closeModal("feedbackDetailsModal");
      if (window.AdminToast) window.AdminToast.success(tr('feedback_reply_sent', 'Reply sent successfully'));
      loadFeedback();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_send_reply', 'Failed to send reply'));
    }
  }

  async function deleteFeedback(feedback) {
    if (!window.confirm(tr('admin_delete_feedback_confirm', 'Delete feedback from "{name}"? This action cannot be undone.', { name: feedback.user?.name || "User" }))) return;

    try {
      await window.AdminAPI.del("/feedback/" + (feedback._id || feedback.id));
      if (window.AdminToast) window.AdminToast.success(tr('feedback_deleted_ok', 'Feedback deleted successfully'));
      if (state.total === 1 && state.page > 1) state.page--;
      loadFeedback();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_delete_feedback', 'Failed to delete feedback'));
    }
  }

  function bindEvents() {
    var searchInput = document.getElementById("feedbackSearchInput");
    if (searchInput) {
      var debounceTimer = null;
      searchInput.addEventListener("input", function() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function() {
          state.search = searchInput.value.trim();
          state.page = 1;
          loadFeedback();
        }, 400);
      });
    }

    var statusFilter = document.getElementById("feedbackStatusFilter");
    if (statusFilter) {
      statusFilter.addEventListener("change", function() {
        state.status = statusFilter.value;
        state.page = 1;
        loadFeedback();
      });
    }

    var ratingFilter = document.getElementById("feedbackRatingFilter");
    if (ratingFilter) {
      ratingFilter.addEventListener("change", function() {
        state.rating = ratingFilter.value;
        state.page = 1;
        loadFeedback();
      });
    }

    var resetBtn = document.getElementById("resetFeedbackFiltersBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", function() {
        if (searchInput) searchInput.value = "";
        if (statusFilter) statusFilter.value = "";
        if (ratingFilter) ratingFilter.value = "";
        state.search = "";
        state.status = "";
        state.rating = "";
        state.page = 1;
        loadFeedback();
      });
    }

    var prevBtn = document.getElementById("prevPageBtn");
    var nextBtn = document.getElementById("nextPageBtn");
    if (prevBtn) prevBtn.addEventListener("click", function() {
      if (state.page > 1) {
        state.page--;
        loadFeedback();
      }
    });
    if (nextBtn) nextBtn.addEventListener("click", function() {
      state.page++;
      loadFeedback();
    });

    var tbody = document.getElementById("feedbackTableBody");
    if (tbody) {
      tbody.addEventListener("click", async function(e) {
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        var id = btn.getAttribute("data-id");
        var action = btn.getAttribute("data-action");
        if (!id) return;

        var feedback = (window.__feedbackCache || []).find(function(f) {
          return (f._id || f.id) === id;
        });
        if (!feedback) {
          try {
            var data = await window.AdminAPI.get("/feedback/" + id);
            feedback = data.feedback;
          } catch (e) {
            feedback = null;
          }
        }
        if (!feedback) {
          if (window.AdminToast) window.AdminToast.error(tr('feedback_not_found', 'Feedback not found'));
          return;
        }

        if (action === "view") viewFeedback(feedback);
        else if (action === "reply") viewFeedback(feedback);
        else if (action === "delete") deleteFeedback(feedback);
      });
    }

    var sendReplyBtn = document.getElementById("sendFeedbackReplyBtn");
    if (sendReplyBtn) sendReplyBtn.addEventListener("click", sendFeedbackReply);
  }

  function renderPagination() {
    var info = document.getElementById("paginationInfo");
    var prevBtn = document.getElementById("prevPageBtn");
    var nextBtn = document.getElementById("nextPageBtn");

    if (info) info.textContent = tr('page_of_feedback', 'Page {page} of {pages} ({total} feedback)').replace('{page}', state.page).replace('{pages}', Math.max(state.pages, 1)).replace('{total}', state.total);
    if (prevBtn) prevBtn.disabled = state.page <= 1;
    if (nextBtn) nextBtn.disabled = state.page >= state.pages;
  }

  function init() {
    bindEvents();
    loadFeedback();
    setupRealtime();
  }

  function setupRealtime() {
    try {
      const token = localStorage.getItem("auth_token");
      if (!token || typeof io === "undefined") {
        // Try dynamic load
        if (typeof io === "undefined") {
          const s = document.createElement("script");
          s.src = "/public/assets/vendor/js/socket.io-4.7.5.min.js";
          s.onload = setupRealtime;
          document.head.appendChild(s);
        }
        return;
      }
      const socket = io(window.__API_BASE, { auth: { token }, transports: ["websocket", "polling"] });
      socket.on("connect", () => {
        socket.emit("join:admin");
      });
      socket.on("feedback:new", () => {
        if (window.AdminToast) window.AdminToast.info(tr('new_feedback_received', 'New feedback received'));
        loadFeedback();
      });
      socket.on("notification:new", () => {
        // In case admin also gets notifications
        loadFeedback();
      });
    } catch (e) {
      console.warn("Admin realtime setup failed", e);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();