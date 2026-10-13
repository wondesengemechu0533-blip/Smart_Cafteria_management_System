/**
 * Delivery Staff - Profile
 *
 * Everything on this page comes from the authenticated account, never from a
 * hardcoded template:
 *   GET  /auth/me                      -> the rider's own record
 *   PUT  /auth/me                      -> editable fields only (name/phone/email)
 *   PUT  /auth/password                -> password change
 *   GET  /deliveries/stats             -> JWT-scoped delivery totals
 *   GET/PUT /notifications/preferences -> persisted notification sound toggle
 *
 * Role, account status and every total are read-only here: the server owns them
 * and the page never derives them from localStorage.
 */
import api from "../api.js";
import { tr, money, esc } from "./shared.js";

function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}


const $ = (id) => document.getElementById(id);

function showAlert(message, type) {
    const el = $("profileAlert");
    if (!el) return;
    el.textContent = message;
    el.className = "alert-banner " + (type || "success");
    el.style.display = "block";
    clearTimeout(showAlert.timer);
    showAlert.timer = setTimeout(() => { el.style.display = "none"; }, 5000);
}

function setLoading(btn, loading, busyLabel) {
    if (!btn) return;
    if (loading) {
        btn.disabled = true;
        btn.dataset.originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + (busyLabel || tr("delivery_updating", "Updating..."));
    } else {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
    }
}

function getCachedProfile() {
    try {
        const raw = localStorage.getItem("userProfile") || localStorage.getItem("current_user");
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

function cacheProfile(p) {
    if (!p) return;
    try {
        localStorage.setItem("userProfile", JSON.stringify(p));
        localStorage.setItem("current_user", JSON.stringify(p));
        localStorage.setItem("userName", p.name || "");
        localStorage.setItem("name", p.name || "");
    } catch (e) {}
}

function statusText(status) {
    const s = String(status || "").toUpperCase();
    if (s === "ACTIVE") return tr("delivery_account_active", "Active");
    if (s === "SUSPENDED") return tr("delivery_account_suspended", "Suspended");
    if (s === "PENDING") return tr("delivery_account_pending", "Pending");
    return s || "—";
}

/** Fill the read-only identity rows + the header block from the account. */
function updateUi(profile) {
    const hasName = Boolean(profile && profile.name);
    const displayName = (profile && profile.name) || tr("delivery_role", "Delivery Staff");
    const displayEmail = (profile && profile.email) || "";
    const displayRole = String((profile && profile.role) || "").toUpperCase() || "DELIVERY STAFF";
    const displayStatus = statusText(profile && profile.status);

    const nameEl = $("profileName");
    if (nameEl) {
        nameEl.textContent = displayName;
        // Once a real (possibly non-translatable) name is rendered, detach the
        // data-i18n hook so applyTranslations never overwrites it. When no name
        // exists the localized fallback keeps data-i18n and stays translated.
        if (hasName) nameEl.removeAttribute("data-i18n");
    }
    $("profileEmail").textContent = displayEmail;
    $("profileRole").textContent = displayRole;

    const statusEl = $("profileStatus");
    if (statusEl) {
        statusEl.textContent = displayStatus;
        // Colour comes from the server's own status flag, not a guess.
        const s = String((profile && profile.status) || "").toUpperCase();
        statusEl.className = "badge " + (s === "ACTIVE" ? "badge-success" : s === "SUSPENDED" ? "badge-danger" : "badge-neutral");
    }

    const avatar = $("profileAvatar");
    if (avatar) {
        if (profile && profile.avatar) {
            avatar.innerHTML = '<img src="' + esc(profile.avatar) + '" alt="Avatar" class="navbar-avatar-img">';
        } else if (hasName) {
            avatar.textContent = profile.name.charAt(0).toUpperCase();
        }
    }

    setText("detailName", displayName);
    setText("detailEmail", displayEmail || "—");
    setText("detailPhone", (profile && profile.phone) || "—");
    setText("detailRole", displayRole);
    setText("detailStatus", displayStatus);
    const since = profile && profile.createdAt ? new Date(profile.createdAt) : null;
    setText("detailSince", since && !Number.isNaN(since.getTime()) ? since.toLocaleDateString() : "—");

    // Seed the editable form from the account, but never clobber a value the
    // rider is currently typing (re-render only happens after a save/load).
    if (!$("editName")) return;
    if (document.activeElement !== $("editName")) $("editName").value = (profile && profile.name) || "";
    if (document.activeElement !== $("editPhone")) $("editPhone").value = (profile && profile.phone) || "";
    if (document.activeElement !== $("editEmail")) $("editEmail").value = displayEmail;
}

function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
}

/** Render the delivery totals computed server-side for THIS rider. */
function renderStats(s) {
    const stats = s || {};
    // 0 is a valid count, so test for a real number instead of truthiness.
    const count = (key) => (Number.isFinite(stats[key]) ? stats[key] : "—");
    setText("statActive", count("myActive"));
    setText("statOut", count("myOut"));
    setText("statArrived", count("myArrived"));
    setText("statDelivered", count("myDelivered"));
    setText("statToday", count("myDeliveredToday"));
    setText("statFailed", count("myFailed"));
    setText("statCollected", Number.isFinite(stats.myCollected) ? money(stats.myCollected) : "—");
    setText("statAvg", Number.isFinite(stats.myAvgDeliveryMinutes) ? stats.myAvgDeliveryMinutes + " min" : "—");
}

async function loadStats() {
    try {
        const data = await api.get("/deliveries/stats");
        renderStats(data && data.stats);
    } catch (e) {
        // A failed stats call must not blank the identity card above it.
        console.log("Could not load delivery stats:", e?.message);
    }
}

async function loadProfile() {
    // First render from cached local data so the UI is instant.
    const cached = getCachedProfile();
    if (cached) updateUi(cached);

    try {
        const data = await api.get("/auth/me");
        if (data && data.user) {
            cacheProfile(data.user);
            updateUi(data.user);
        }
    } catch (e) {
        console.log("Could not refresh profile:", e.message);
        if (!cached) showAlert(tr("delivery_profile_load_failed", "Could not load your profile from the server."), "error");
    }

    loadStats();
    loadSoundPreference();
}

/**
 * Only the fields the server accepts from a self-service profile edit are sent:
 * name, phone and email. Role/status are never included, so a tampered request
 * body cannot change them either.
 */
async function saveProfile(e) {
    e.preventDefault();
    const btn = $("saveProfileBtn");
    const name = $("editName").value.trim();
    const phone = $("editPhone").value.trim();
    const email = $("editEmail").value.trim();

    if (!name) {
        showAlert(tr("delivery_name_required", "Your name cannot be empty."), "error");
        return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAlert(tr("delivery_email_invalid", "Please enter a valid email address."), "error");
        return;
    }
    if (phone && !/^(\+251[0-9]{9}|(09|07)[0-9]{8})$/.test(phone)) {
        showAlert(tr("delivery_phone_invalid", "Enter a valid Ethiopian phone number (e.g. 09XXXXXXXX or +2519XXXXXXXX)"), "error");
        return;
    }

    setLoading(btn, true, tr("delivery_saving", "Saving..."));
    try {
        const data = await api.put("/auth/me", { name, phone, email });
        if (data && data.user) {
            cacheProfile(data.user);
            updateUi(data.user);
        }
        showAlert(tr("delivery_profile_updated_msg", "Profile updated successfully."));
    } catch (error) {
        showAlert(tr("delivery_profile_update_failed", "Failed to update profile: ") + (error.message || error), "error");
    } finally {
        setLoading(btn, false);
    }
}

async function changePassword(e) {
    e.preventDefault();
    const btn = $("changePasswordBtn");
    const current = $("currentPassword").value;
    const newPass = $("newPassword").value;
    const confirm = $("confirmPassword").value;

    if (!current || !newPass || !confirm) {
        showAlert(tr("delivery_all_fields_required", "All fields are required"), "error");
        return;
    }
    if (newPass.length < 6) {
        showAlert(tr("delivery_password_min_length", "New password must be at least 6 characters"), "error");
        return;
    }
    if (newPass !== confirm) {
        showAlert(tr("delivery_password_mismatch", "Passwords do not match"), "error");
        return;
    }

    setLoading(btn, true);
    try {
        const data = await api.put("/auth/password", { currentPassword: current, newPassword: newPass, confirmPassword: confirm });
        if (data.token) localStorage.setItem("auth_token", data.token);
        showAlert(tr("delivery_password_updated_msg", "Password updated successfully. Please sign out and sign back in with your new password."));
        $("passwordForm").reset();
    } catch (error) {
        showAlert(tr("delivery_password_update_failed", "Failed to update password: ") + (error.message || error), "error");
    } finally {
        setLoading(btn, false);
    }
}

/* ---------- Notification sound preference (persisted server-side) ---------- */

function applySoundToggle(enabled) {
    const toggle = $("soundToggle");
    if (toggle) toggle.checked = Boolean(enabled);
    const label = $("soundState");
    if (label) {
        label.textContent = enabled
            ? tr("delivery_pref_sound_on", "On")
            : tr("delivery_pref_sound_off", "Off");
    }
    // Keep the in-page sound helper in step with the stored preference.
    if (window.ScosNotify && typeof window.ScosNotify.toggle === "function") {
        window.ScosNotify.toggle(Boolean(enabled));
    }
}

async function loadSoundPreference() {
    try {
        const data = await api.get("/notifications/preferences");
        const enabled = data && data.preferences ? data.preferences.soundEnabled !== false : true;
        applySoundToggle(enabled);
    } catch (e) {
        // Fall back to the browser-local preference rather than guessing.
        let local = true;
        try { local = localStorage.getItem("scos_notify_sound") !== "0"; } catch (_) { /* ignore */ }
        applySoundToggle(local);
    }
}

async function toggleSound() {
    const toggle = $("soundToggle");
    if (!toggle) return;
    const next = toggle.checked;
    try {
        await api.put("/notifications/preferences", { soundEnabled: next });
        applySoundToggle(next);
        if (next && window.ScosNotify && typeof window.ScosNotify.unlock === "function") {
            // Turning the sound on is a user gesture - unlock playback and
            // preview the configured chime so the rider knows it works.
            window.ScosNotify.unlock("profile-toggle");
            window.ScosNotify.play("order");
        }
    } catch (error) {
        toggle.checked = !next;
        applySoundToggle(!next);
        showAlert(tr("delivery_sound_pref_failed", "Could not save the notification sound preference."), "error");
    }
}

function bindEvents() {
    const profileForm = $("profileForm");
    if (profileForm) profileForm.addEventListener("submit", saveProfile);

    const passwordForm = $("passwordForm");
    if (passwordForm) passwordForm.addEventListener("submit", changePassword);

    const soundToggle = $("soundToggle");
    if (soundToggle) soundToggle.addEventListener("change", toggleSound);

    document.querySelectorAll(".toggle-password-icon").forEach(function (icon) {
        icon.addEventListener("click", function () {
            const input = document.getElementById(icon.getAttribute("data-target"));
            if (!input) return;
            const isPassword = input.type === "password";
            input.type = isPassword ? "text" : "password";
            icon.classList.toggle("fa-eye", !isPassword);
            icon.classList.toggle("fa-eye-slash", isPassword);
            icon.title = isPassword
                ? tr("delivery_show_password", "Show password")
                : tr("delivery_hide_password", "Hide password");
        });
    });
}

document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    loadProfile();

    // Re-apply localized fallbacks (name placeholder, titles) on language change.
    __registerLangChange(() => {
        try {
            const nameEl = $("profileName");
            if (nameEl && !nameEl.textContent.trim()) {
                nameEl.textContent = tr("delivery_role", "Delivery Staff");
            }
            document.querySelectorAll(".toggle-password-icon").forEach(function (icon) {
                if (icon.title === "Show password" || icon.title === "የይለፍ ቃል አሳይ") {
                    icon.title = tr("delivery_show_password", "Show password");
                } else if (icon.title === "Hide password" || icon.title === "የይለፍ ቃል ደብቅ") {
                    icon.title = tr("delivery_hide_password", "Hide password");
                }
            });
        } catch (e) { /* best-effort re-render */ }
    });
});