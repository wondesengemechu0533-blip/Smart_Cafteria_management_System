import api from '../../js/api.js';

function tr(key, fallback, vars) {
  if (typeof window.tr === "function") return window.tr(key, fallback, vars);
  return fallback;
}

const DEFAULT_SETTINGS = {
    stationName: 'Station 1',
    orderAlertSound: true,
    preparationTimerAlert: true,
    generalNotificationSound: true,
    autoRefreshEnabled: true,
    autoRefreshInterval: 10,
    showCompletedOrders: true,
};

let settings = { ...DEFAULT_SETTINGS };

const settingsContainer = document.getElementById('settingsContent');
const toastEl = document.getElementById('toast');

function showToast(msg, type = 'success') {
    toastEl.textContent = msg;
    toastEl.className = 'toast ' + type + ' show';
    setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function toggleSwitch(id, label, checked) {
    return `
        <div class="setting-row">
            <div>
                <div class="setting-label">${label}</div>
            </div>
            <label class="toggle-switch">
                <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
                <span class="toggle-slider"></span>
            </label>
        </div>
    `;
}

function passwordControl(id, label, placeholder) {
    return `
        <div class="setting-row">
            <div>
                <div class="setting-label">${label}</div>
            </div>
            <div class="input-wrapper">
                <input type="password" class="setting-input" id="${id}" placeholder="${placeholder}" autocomplete="new-password">
                <i class="fa-solid fa-eye toggle-password-icon" data-target="${id}" title="Show password"></i>
            </div>
        </div>
    `;
}

function renderSettings() {
    settingsContainer.innerHTML = `
        <div class="settings-card">
            <h3><i class="fa-solid fa-location-dot"></i> Station Settings</h3>
            <div class="setting-row">
                <div>
                    <div class="setting-label">Station Name</div>
                    <div class="setting-desc">Display name for this kitchen station</div>
                </div>
                <input type="text" class="setting-input" id="stationName" value="${escapeHtml(settings.stationName)}" placeholder="e.g. Station 1">
            </div>
        </div>

        <div class="settings-card">
            <h3><i class="fa-solid fa-bell"></i> Notification Preferences</h3>
            ${toggleSwitch('orderAlertSound', 'Order Alert Sound', settings.orderAlertSound)}
            ${toggleSwitch('preparationTimerAlert', 'Preparation Timer Alert', settings.preparationTimerAlert)}
            ${toggleSwitch('generalNotificationSound', 'General Notification Sound', settings.generalNotificationSound)}
        </div>

        <div class="settings-card">
            <h3><i class="fa-solid fa-rotate"></i> Auto-Refresh</h3>
            ${toggleSwitch('autoRefreshEnabled', 'Auto-Refresh Enabled', settings.autoRefreshEnabled)}
            <div class="setting-row">
                <div>
                    <div class="setting-label">Refresh Interval</div>
                    <div class="setting-desc">How often to refresh order data</div>
                </div>
                <select class="setting-select" id="autoRefreshInterval">
                    <option value="5" ${settings.autoRefreshInterval === 5 ? 'selected' : ''}>5 seconds</option>
                    <option value="10" ${settings.autoRefreshInterval === 10 ? 'selected' : ''}>10 seconds</option>
                    <option value="15" ${settings.autoRefreshInterval === 15 ? 'selected' : ''}>15 seconds</option>
                    <option value="30" ${settings.autoRefreshInterval === 30 ? 'selected' : ''}>30 seconds</option>
                    <option value="60" ${settings.autoRefreshInterval === 60 ? 'selected' : ''}>60 seconds</option>
                    <option value="120" ${settings.autoRefreshInterval === 120 ? 'selected' : ''}>120 seconds</option>
                </select>
            </div>
        </div>

        <div class="settings-card">
            <h3><i class="fa-solid fa-desktop"></i> Display</h3>
            ${toggleSwitch('showCompletedOrders', tr('kitchen_show_completed', 'Show Completed Orders'), settings.showCompletedOrders)}
        </div>

        <div class="settings-card">
            <h3><i class="fa-solid fa-key"></i> Change Password</h3>
            ${passwordControl('currentPassword', tr('current_password', 'Current Password'), tr('enter_current_password', 'Enter current password'))}
            ${passwordControl('newPassword', tr('new_password', 'New Password'), tr('min_6_chars', 'Min 6 characters'))}
            ${passwordControl('confirmPassword', tr('confirm_new_password', 'Confirm New Password'), tr('reenter_new_password', 'Re-enter new password'))}
            <div class="btn-save-wrap">
                <button class="btn btn-primary" id="changePasswordBtn" onclick="window.changeKitchenPassword()">
                    <i class="fa-solid fa-key"></i> Update Password
                </button>
            </div>
        </div>

        <div class="btn-save-wrap">
            <button class="btn btn-primary" id="saveBtn" onclick="window.saveSettings()">
                <i class="fa-solid fa-floppy-disk"></i> Save Settings
            </button>
        </div>
    `;
    bindPasswordToggles();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

/**
 * Translate the server's stored shape into the shape this form uses.
 *
 * WHY: the API persists station / notificationSound / autoRefresh / refreshInterval
 * (see KitchenSetting.js), while the form is built from stationName /
 * generalNotificationSound / autoRefreshEnabled / autoRefreshInterval.
 *
 * The page used to just spread the response over its own defaults:
 *     settings = { ...settings, ...data.settings };
 * which added the server's four keys alongside the form's four - so the inputs,
 * which read the FORM names, always showed the hardcoded defaults and the real
 * saved values were never rendered, no matter what was stored. It also left the
 * old stationName/autoRefreshEnabled keys on the object, so a later save could
 * re-send stale values.
 *
 * `??` rather than `||` throughout: these are booleans and a 0 interval is
 * meaningful, and `||` would quietly replace a saved `false` with `true`.
 */
function fromServer(s) {
    const v = s || {};
    return {
        stationName: v.station ?? v.stationName ?? DEFAULT_SETTINGS.stationName,
        orderAlertSound: v.orderAlertSound ?? DEFAULT_SETTINGS.orderAlertSound,
        preparationTimerAlert: v.preparationTimerAlert ?? DEFAULT_SETTINGS.preparationTimerAlert,
        generalNotificationSound:
            v.notificationSound ?? v.generalNotificationSound ?? DEFAULT_SETTINGS.generalNotificationSound,
        autoRefreshEnabled: v.autoRefresh ?? v.autoRefreshEnabled ?? DEFAULT_SETTINGS.autoRefreshEnabled,
        autoRefreshInterval: v.refreshInterval ?? v.autoRefreshInterval ?? DEFAULT_SETTINGS.autoRefreshInterval,
        showCompletedOrders: v.showCompletedOrders ?? DEFAULT_SETTINGS.showCompletedOrders,
    };
}

async function loadSettings() {
    try {
        const data = await api.get('/kitchen/settings');
        if (data.success && data.settings) {
            settings = fromServer(data.settings);
            // Seed the shared sound flag from kitchen prefs on first load
            // (only when user has not already set an explicit toggle this session).
            try {
                if (localStorage.getItem('scos_notify_sound') === null) {
                    const soundOn = !!(settings.orderAlertSound && settings.generalNotificationSound);
                    localStorage.setItem('scos_notify_sound', soundOn ? '1' : '0');
                }
            } catch (e) { /* ignore */ }
        }
    } catch (err) {
        console.warn('Could not load settings, using defaults:', err);
    }
    // The header badge shows the station name everywhere else in the kitchen, so
    // it must follow what was actually saved rather than the placeholder.
    const badge = document.getElementById('stationBadge');
    if (badge) badge.textContent = settings.stationName;
    renderSettings();
}

function collectForm() {
    return {
        stationName: document.getElementById('stationName').value.trim() || 'Station 1',
        orderAlertSound: document.getElementById('orderAlertSound').checked,
        preparationTimerAlert: document.getElementById('preparationTimerAlert').checked,
        generalNotificationSound: document.getElementById('generalNotificationSound').checked,
        autoRefreshEnabled: document.getElementById('autoRefreshEnabled').checked,
        autoRefreshInterval: parseInt(document.getElementById('autoRefreshInterval').value, 10),
        showCompletedOrders: document.getElementById('showCompletedOrders').checked,
    };
}

window.saveSettings = async function () {
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    try {
        const payload = collectForm();
        const data = await api.put('/kitchen/settings', payload);
        if (data.success) {
            // Re-read the server's copy rather than assuming the write landed.
            // The old code merged the REQUEST back into `settings`, so a field
            // the server quietly dropped still looked saved in the UI until the
            // next reload - which is how four settings could appear to work and
            // persist nothing at all.
            settings = fromServer(data.settings || payload);

            if (Array.isArray(data.ignoredFields) && data.ignoredFields.length) {
                console.warn(
                    `[kitchen-settings] server ignored: ${data.ignoredFields.join(', ')} - ` +
                    'the request and the API disagree on these names'
                );
            }
            // Keep dashboard / notification-sound mute in sync with kitchen settings.
            try {
                const soundOn = !!(settings.orderAlertSound && settings.generalNotificationSound);
                localStorage.setItem('scos_notify_sound', soundOn ? '1' : '0');
            } catch (e) { /* ignore */ }
            const badge = document.getElementById('stationBadge');
            if (badge) badge.textContent = settings.stationName;
            // Put the confirmed value back in the input so what is on screen is
            // what the server actually stored.
            const nameInput = document.getElementById('stationName');
            if (nameInput) nameInput.value = settings.stationName;
            showToast(tr('kitchen_settings_saved', 'Settings saved successfully'));
        } else {
            showToast(tr('kitchen_settings_save_failed', 'Failed to save settings'), 'error');
        }
    } catch (err) {
        console.error('Save settings error:', err);
        showToast(tr('kitchen_settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Settings';
    }
};

function bindPasswordToggles() {
    document.querySelectorAll('.toggle-password-icon').forEach(function (icon) {
        if (icon.dataset.toggleBound) return;
        icon.dataset.toggleBound = '1';
        icon.addEventListener('click', function () {
            const input = document.getElementById(icon.getAttribute('data-target'));
            if (!input) return;
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            icon.classList.toggle('fa-eye', !isPassword);
            icon.classList.toggle('fa-eye-slash', isPassword);
            icon.title = isPassword ? 'Hide password' : 'Show password';
        });
    });
}

window.changeKitchenPassword = async function () {
    const cur = document.getElementById('currentPassword');
    const nw = document.getElementById('newPassword');
    const cf = document.getElementById('confirmPassword');
    const btn = document.getElementById('changePasswordBtn');
    if (!cur || !nw || !cf || !btn) return;

    if (!cur.value || !nw.value || !cf.value) {
        showToast('All password fields are required', 'error');
        return;
    }
    if (nw.value.length < 6) {
        showToast('New password must be at least 6 characters', 'error');
        return;
    }
    if (nw.value !== cf.value) {
        showToast('New passwords do not match', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating...';
    try {
        const data = await api.put('/auth/password', {
            currentPassword: cur.value,
            newPassword: nw.value,
            confirmPassword: cf.value
        });
        if (data && data.token) api.setToken(data.token);
        cur.value = '';
        nw.value = '';
        cf.value = '';
        showToast('Password updated successfully');
    } catch (err) {
        console.error('Change password error:', err);
        showToast(err.message || 'Failed to update password', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-key"></i> Update Password';
    }
};

loadSettings();
