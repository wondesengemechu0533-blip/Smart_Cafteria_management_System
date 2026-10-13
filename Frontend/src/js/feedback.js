function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}

/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - FEEDBACK MODULE
 * ================================================================
 * Handles customer feedback, ratings, and reviews.
 * ================================================================
 */

import { getCurrentUser } from './auth.js';
import api from './api.js';

function showToast(message, type = "success") {
    if (window.AdminToast && typeof window.AdminToast.show === "function") {
        window.AdminToast.show(message, type);
        return;
    }
    window.alert(message);
}

function getLang() {
    try { return (window.getCurrentLanguage && window.getCurrentLanguage()) || localStorage.getItem("scos_language") || localStorage.getItem("cafeteria_language") || "en"; } catch (e) { return "en"; }
}

function ft(key, fallback) {
    if (typeof window !== "undefined" && typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback);
    return fallback;
}

/**
 * Look up an order from localStorage (orderHistory / latestOrder).
 * Kept local to avoid importing order-status.js, whose page-side
 * effects would replace this page's <main> content.
 * @param {string} orderId - Order ID (may include a leading #)
 * @returns {Object|null}
 */
function getOrderById(orderId) {
    if (!orderId) return null;
    const normalized = String(orderId).replace(/^#/, "");

    const historyData = JSON.parse(localStorage.getItem("orderHistory")) || [];
    const fromHistory = historyData.find(o => (o.orderId || o.id || "").replace(/^#/, "") === normalized);
    if (fromHistory) return fromHistory;

    const latestOrder = JSON.parse(localStorage.getItem("latestOrder"));
    if (latestOrder && (latestOrder.orderId || latestOrder.id || "").replace(/^#/, "") === normalized) {
        return latestOrder;
    }
    return null;
}

// ===== 1. FEEDBACK STATE =====
let feedbackList = [];
let feedbackListeners = [];

// ===== 2. MOCK FEEDBACK DATA =====
const MOCK_FEEDBACK = [
    {
        id: 'f1',
        userId: 'u3',
        orderId: 'o1',
        rating: 5,
        comment: 'Excellent food and service! The pasta was delicious.',
        createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
        status: 'approved',
        reply: null,
    },
    {
        id: 'f2',
        userId: 'u4',
        orderId: 'o2',
        rating: 4,
        comment: 'Good food, but a bit slow on preparation.',
        createdAt: new Date(Date.now() - 86400000 * 1).toISOString(),
        status: 'pending',
        reply: null,
    },
];

// ===== 3. FEEDBACK FUNCTIONS =====

/**
 * Initialize feedback with mock data if empty
 */
function initFeedback() {
    if (feedbackList.length === 0) {
        feedbackList = [...MOCK_FEEDBACK];
    }
}
initFeedback();

/**
 * Get all feedback (Admin only)
 * @param {Object} filters - Filter options
 * @param {number} filters.rating - Rating filter
 * @param {string} filters.status - Status filter
 * @param {string} filters.date - Date filter
 * @returns {Array} Feedback list
 */
export function getAllFeedback(filters = {}) {
    let result = [...feedbackList];

    if (filters.rating) {
        result = result.filter(f => f.rating === filters.rating);
    }

    if (filters.status) {
        result = result.filter(f => f.status === filters.status);
    }

    if (filters.date) {
        const dateStr = filters.date;
        result = result.filter(f => f.createdAt.startsWith(dateStr));
    }

    result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return result;
}

/**
 * Get user's feedback
 * @param {string} userId - User ID
 * @returns {Array} User feedback
 */
export function getUserFeedback(userId) {
    return feedbackList.filter(f => f.userId === userId);
}

/**
 * Get current user's feedback
 * @returns {Array} Current user's feedback
 */
export async function getMyFeedback() {
    try {
        const data = await api.get("/feedback/my");
        return Array.isArray(data.feedback) ? data.feedback : [];
    } catch (error) {
        console.error("Get my feedback error:", error);
        return [];
    }
}

/**
 * Get feedback by order ID
 * @param {string} orderId - Order ID
 * @returns {Object|null} Feedback or null
 */
export function getFeedbackByOrder(orderId) {
    return feedbackList.find(f => f.orderId === orderId) || null;
}

/**
 * Submit feedback for an order
 * @param {string} orderId - Order ID
 * @param {number} rating - Rating (1-5)
 * @param {string} comment - Feedback comment
 * @returns {Promise<Object>} Submitted feedback or error
 */
export async function submitFeedback(orderId, rating, comment = '') {
    try {
        const user = getCurrentUser();
        if (!user) {
            return { success: false, error: ft("feedback_login_required", getLang() === "am" ? "አስተያየት ለመስጠት እባክዎ ይግቡ" : "Please login to submit feedback") };
        }

        // Validate rating
        if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
            return { success: false, error: ft("feedback_rating_range", getLang() === "am" ? "ደረጃው ከ1 እስከ 5 መሆን አለበት።" : "Rating must be between 1 and 5") };
        }

        // Parse category + dish from the combined comment ("Category - (Dish) - comments")
        let category = "Food Quality";
        let dishName = "";
        let text = comment || "";

        if (text.includes(" - ")) {
            const parts = text.split(" - ");
            category = parts[0]?.trim() || category;
            if (parts[1] && parts[1].startsWith("(") && parts[1].endsWith(")")) {
                dishName = parts[1].slice(1, -1).trim();
                parts.splice(1, 1);
            }
            text = parts.join(" - ").trim();
        }

        const payload = {
            orderId: orderId || null,
            rating: rating,
            comment: text,
            category: category,
            dishName: dishName,
        };

        const result = await api.post("/feedback", payload);

        showToast(ft("feedback_thanks", getLang() === "am" ? "ስለ አስተያየትዎ እናመሰግናለን!" : "Thank you for your feedback!"), 'success');

        return { success: true, feedback: result.feedback || result };

    } catch (error) {
        console.error('Submit feedback error:', error);
        return { success: false, error: error.message || ft("feedback_submit_failed", getLang() === "am" ? "አስተያየት ማስገባት አልተሳካም" : "Failed to submit feedback") };
    }
}

/**
 * Reply to feedback (Admin only)
 * @param {string} feedbackId - Feedback ID
 * @param {string} reply - Reply message
 * @returns {Promise<Object>} Updated feedback or error
 */
export async function replyToFeedback(feedbackId, reply) {
    try {
        if (!reply || !reply.trim()) {
            return { success: false, error: ft("feedback_reply_required", getLang() === "am" ? "የመልስ መልእክት ያስፈልጋል" : "Reply message is required") };
        }

        // Persist server-side; the old implementation only mutated the in-memory
        // list (and had a broken `message` reference that made every reply fail
        // validation).
        const result = await api.patch("/feedback/" + encodeURIComponent(feedbackId) + "/reply", { reply: reply.trim() });

        const index = feedbackList.findIndex((f) => String(f.id || f._id) === String(feedbackId));
        if (index !== -1) {
            feedbackList[index].reply = reply.trim();
            feedbackList[index].status = 'approved';
            notifyFeedbackListeners();
        }

        showToast(ft("feedback_reply_sent", getLang() === "am" ? "መልሱ በተሳካ ሁኔታ ተላከ" : "Reply sent successfully"), 'success');

        return { success: true, feedback: (result && result.feedback) || feedbackList[index] };

    } catch (error) {
        console.error('Reply to feedback error:', error);
        return { success: false, error: error.message || ft("feedback_reply_failed", getLang() === "am" ? "መልስ መላክ አልተሳካም" : "Failed to send reply") };
    }
}

/**
 * Delete feedback (Admin only)
 * @param {string} feedbackId - Feedback ID
 * @returns {Promise<Object>} Success or error
 */
export async function deleteFeedback(feedbackId) {
    try {
        const index = feedbackList.findIndex(f => f.id === feedbackId);

if (index === -1) {
            return { success: false, error: ft("feedback_not_found", getLang() === "am" ? "አስተያየት አልተገኘም" : "Feedback not found") };
        }

        feedbackList.splice(index, 1);
        notifyFeedbackListeners();

        showToast(ft("feedback_deleted", getLang() === "am" ? "አስተያየት ተሰርዟል" : "Feedback deleted"), 'info');

        return { success: true };

    } catch (error) {
        console.error('Delete feedback error:', error);
        return { success: false, error: ft("feedback_delete_failed", getLang() === "am" ? "አስተያየት መሰረዝ አልተሳካም" : "Failed to delete feedback") };
    }
}

/**
 * Get feedback statistics
 * @returns {Object} Feedback statistics
 */
export function getFeedbackStats() {
    const total = feedbackList.length;
    const pending = feedbackList.filter(f => f.status === 'pending').length;
    const approved = feedbackList.filter(f => f.status === 'approved').length;

    const ratings = feedbackList.map(f => f.rating);
    const averageRating = ratings.length > 0
        ? ratings.reduce((sum, r) => sum + r, 0) / ratings.length
        : 0;

    const ratingDistribution = {
        1: feedbackList.filter(f => f.rating === 1).length,
        2: feedbackList.filter(f => f.rating === 2).length,
        3: feedbackList.filter(f => f.rating === 3).length,
        4: feedbackList.filter(f => f.rating === 4).length,
        5: feedbackList.filter(f => f.rating === 5).length,
    };

    return {
        total,
        pending,
        approved,
        averageRating: Math.round(averageRating * 10) / 10,
        ratingDistribution,
    };
}

// ===== 4. FEEDBACK LISTENERS =====

/**
 * Add feedback change listener
 * @param {Function} listener - Callback function
 */
export function addFeedbackListener(listener) {
    if (typeof listener === 'function') {
        feedbackListeners.push(listener);
    }
}

/**
 * Remove feedback change listener
 * @param {Function} listener - Callback function
 */
export function removeFeedbackListener(listener) {
    feedbackListeners = feedbackListeners.filter(l => l !== listener);
}

/**
 * Notify all feedback listeners
 */
function notifyFeedbackListeners() {
    feedbackListeners.forEach(listener => {
        try {
            listener(feedbackList);
        } catch (error) {
            console.error('Feedback listener error:', error);
        }
    });
}
// ===== 5. EXPORTS =====
export default {
    getAllFeedback,
    getUserFeedback,
    getMyFeedback,
    getFeedbackByOrder,
    submitFeedback,
    replyToFeedback,
    deleteFeedback,
    getFeedbackStats,
    addFeedbackListener,
    removeFeedbackListener,
};

// ===== 6. FEEDBACK PAGE UI =====

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("feedback-form");
    if (!form) return;

    const starBtns = Array.from(document.querySelectorAll("#star-rating-group .star-btn"));
    const ratingText = document.getElementById("rating-text");
    const alertBox = document.getElementById("feedback-alert");
    const pastList = document.getElementById("past-feedback-list");

    let selectedRating = 0;

    function showAlert(message, type = "error") {
        if (!alertBox) return;
        alertBox.textContent = message;
        alertBox.className = "alert-box " + (type === "success" ? "alert-success" : "alert-error");
        alertBox.style.display = "block";
        alertBox.style.padding = "10px 14px";
        alertBox.style.borderRadius = "6px";
        alertBox.style.marginBottom = "14px";
        alertBox.style.fontSize = "14px";
        alertBox.style.color = type === "success" ? "#155724" : "#dc3545";
        alertBox.style.background = type === "success" ? "#d4edda" : "#fde8e8";
    }

    function updateStars(rating) {
        starBtns.forEach((btn) => {
            const value = parseInt(btn.getAttribute("data-value"), 10);
            btn.style.color = value <= rating ? "#ffb400" : "#d1d5db";
        });
    }

    async function renderPastFeedback() {
        if (!pastList) return;
        const isAm = getLang() === "am";
        const items = (await getMyFeedback()).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        if (items.length === 0) {
            pastList.innerHTML = `<p style="color:#6b7280; text-align:center; padding:16px 0;">${isAm ? "እስካሁን ምንም ግምገማ የለም። ከላይ የመጀመሪያ ግምገማዎን ያጋሩ።" : "No reviews yet. Share your first review above."}</p>`;
            return;
        }

        pastList.innerHTML = items.map((f) => {
            const starIcons = Array.from({ length: 5 }, (_, i) => {
                const filled = i < f.rating;
                return `<i class="fa-solid fa-star" style="color:${filled ? "#ffb400" : "#d1d5db"}; font-size:14px;"></i>`;
            }).join("");
            const replyHtml = f.reply
                ? `<div style="margin-top:8px; padding:8px 10px; background:#f3f4f6; border-radius:6px; font-size:13px; color:#374151;"><strong>${isAm ? "ምላሽ:" : "Reply:"}</strong> ${escapeHtml(f.reply)}</div>`
                : "";
            return `
                <div class="review-card" style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px; margin-bottom:12px;">
                    <div style="margin-bottom:6px;">${starIcons}</div>
                    <p style="margin:0 0 6px; color:#1f2937; font-size:14px; line-height:1.5;">${escapeHtml(f.comment || "")}</p>
                    <span style="color:#6b7280; font-size:12px;">${new Date(f.createdAt).toLocaleDateString()}</span>
                    ${replyHtml}
                </div>
            `;
        }).join("");
    }

    starBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
            selectedRating = parseInt(btn.getAttribute("data-value"), 10);
            updateStars(selectedRating);
            if (ratingText) ratingText.textContent = ft("feedback_out_of", getLang() === "am" ? `ከ5 ውስጥ ${selectedRating}` : selectedRating + " out of 5").replace("{rating}", selectedRating);
        });
        btn.addEventListener("mouseenter", () => {
            if (!selectedRating) updateStars(parseInt(btn.getAttribute("data-value"), 10));
        });
        btn.addEventListener("mouseleave", () => {
            if (!selectedRating) updateStars(0);
        });
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const comments = document.getElementById("feedback-comments")?.value || "";
        const category = document.getElementById("feedback-category")?.value || "Other";
        const dish = document.getElementById("dish-reviewed")?.value || "";

        if (!comments.trim()) {
            showAlert(ft("feedback_write_comment", getLang() === "am" ? "ከማስገባትዎ በፊት እባክዎ አስተያየት ይጻፉ።" : "Please write a comment before submitting."));
            return;
        }

        const urlParams = new URLSearchParams(window.location.search);
        const orderId = urlParams.get("orderId") || "";

        const combinedComment = [category, dish ? `(${dish})` : "", comments.trim()].filter(Boolean).join(" - ");
        const result = await submitFeedback(orderId, selectedRating, combinedComment);

        if (result.success) {
            showAlert(ft("feedback_thanks", getLang() === "am" ? "ስለ አስተያየትዎ እናመሰግናለን!" : "Thank you for your feedback!"), "success");
            form.reset();
            selectedRating = 0;
            updateStars(0);
            if (ratingText) ratingText.textContent = ft("feedback_select_rating", getLang() === "am" ? "ደረጃ ይምረጡ" : "Select a rating");
            renderPastFeedback();
        } else {
            showAlert(result.error || ft("feedback_submit_failed", getLang() === "am" ? "አስተያየት ማስገባት አልተሳካም" : "Failed to submit feedback"), "error");
        }
    });

    renderPastFeedback();
    // Re-render the past-feedback list instantly when the language changes.
    __registerLangChange(() => {
        try { renderPastFeedback(); } catch (e) {}
    });

    // Real-time: when admin replies, notification arrives via customer-realtime.js
    window.addEventListener("customer:notification", (e) => {
        const n = e.detail;
        if (n && n.title && n.title.toLowerCase().includes("feedback")) {
            renderPastFeedback();
            showToast(n.message, "info");
        }
    });
    window.addEventListener("notification:refresh", renderPastFeedback);
    // Also listen directly to socket if customer-realtime not loaded
    if (typeof io !== "undefined") {
        try {
            const token = localStorage.getItem("auth_token");
            if (token) {
                const s = io(window.__API_BASE, { auth: { token }, transports: ["websocket", "polling"] });
                s.on("notification:new", (n) => {
                    if (n && n.title && n.title.toLowerCase().includes("feedback")) {
                        renderPastFeedback();
                    }
                });
            }
        } catch {}
    }
});