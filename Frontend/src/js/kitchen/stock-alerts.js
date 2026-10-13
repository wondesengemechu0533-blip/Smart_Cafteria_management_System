let allAlerts = [];
let loadFailed = false;
let loadErrorMessage = '';
let unreachableReported = false;
let authRedirectPending = false;

function redirectToLogin(message) {
    if (authRedirectPending) return;
    authRedirectPending = true;
    if (message) showNotification(message, 'error');
    setTimeout(() => {
        const href = typeof window.loginHref === 'function' ? window.loginHref() : '../common/login.html';
        window.location.href = href;
    }, 1200);
}

function getApiBase() {
    return window.__API_URL || window.API_BASE_URL || (window.__API_BASE ? `${window.__API_BASE}/api/v1` : '');
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

// Single initialization guard — prevents duplicate requests from repeated
// DOMContentLoaded handlers or double script inclusion.
if (!window.__stockAlertsInitialized) {
    window.__stockAlertsInitialized = true;

    const startStockAlerts = () => {
        loadStockAlerts();
        initStockRealtime();
        // Refresh every 30 seconds
        if (window.__stockAlertsTimer) clearInterval(window.__stockAlertsTimer);
        window.__stockAlertsTimer = setInterval(loadStockAlerts, 30000);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startStockAlerts);
    } else {
        startStockAlerts();
    }
}

function isAmharic() {
    return typeof window.getCurrentLanguage === 'function' && window.getCurrentLanguage() === 'am';
}

function tr(key, fallback, vars) {
    if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
    if (typeof window.getText === 'function') {
        const v = window.getText(key);
        if (v && v !== key) return v;
    }
    return fallback != null ? fallback : key;
}

function registerLangChange(fn) {
    const register = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
    if (typeof register === 'function') register(fn);
    else window.addEventListener('language:changed', fn);
}

registerLangChange(() => {
    try {
        if (!document.getElementById('alertsList')) return;
        renderAlerts();
    } catch (e) { /* best-effort re-render */ }
});

async function loadStockAlerts() {
    const apiBase = getApiBase();
    const statusEl = document.getElementById('statusFilter');
    const status = statusEl ? statusEl.value : '';

    if (!apiBase) {
        console.error('[Stock Alerts] API base URL is not configured (config.js missing/not loaded).');
        renderLoadError('API configuration missing.');
        return;
    }

    let url = `${apiBase}/kitchen/stock-alerts`;
    if (status) {
        url += `?status=${encodeURIComponent(status)}`;
    }
    // Log the API URL and HTTP status only — never the token.
    console.log(`[Stock Alerts] GET ${url}`);

const token = localStorage.getItem('auth_token');
    if (!token) {
        console.warn('[Stock Alerts] No auth token found in localStorage — redirecting to sign-in.');
        const msg = tr('error_session_expired', 'You are not signed in. Please log in again.');
        renderLoadError(msg);
        redirectToLogin(msg);
        return;
    }

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`[Stock Alerts] HTTP ${response.status} ${response.statusText || ''}`.trim());

        let data = null;
        try {
            data = await response.json();
        } catch (parseError) {
            console.error(`[Stock Alerts] Response was not valid JSON (HTTP ${response.status}).`);
        }

        if (!response.ok || !data || !data.success) {
            const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;

            // Session expired / invalid token → take the user to the sign-in page.
            if (response.status === 401) {
                console.warn('[Stock Alerts] Session expired (401) — redirecting to sign-in.');
                const msg = tr('error_session_expired', 'Session expired. Please log in again.');
                renderLoadError(msg);
                redirectToLogin(msg);
                return;
            }

            // Signed in but this role cannot view stock alerts → clear message,
            // no toast/console spam.
            if (response.status === 403) {
                const msg = tr('stock_no_permission', 'You do not have permission to view stock alerts.');
                console.warn('[Stock Alerts] Forbidden (403):', message);
                renderLoadError(msg);
                return;
            }

            // Other API errors: show once, stay quiet on follow-up polls.
            console.warn(`[Stock Alerts] Request failed: ${message}`);
            if (!unreachableReported) {
                unreachableReported = true;
                renderLoadError(typeof window.translateErrorMessage === 'function' ? window.translateErrorMessage(message) : message);
                showNotification(tr('stock_error_loading', 'Error loading stock alerts'), 'error');
            } else {
                renderLoadError(typeof window.translateErrorMessage === 'function' ? window.translateErrorMessage(message) : message);
            }
            return;
        }

        allAlerts = Array.isArray(data.alerts) ? data.alerts : [];
        loadFailed = false;
        loadErrorMessage = '';
        unreachableReported = false;
        renderAlerts();

    } catch (error) {
        // Server unreachable (backend down / restarting). Surface it once; the
        // 30s poll keeps retrying silently and the page recovers automatically.
        console.warn(`[Stock Alerts] Network error calling ${url}:`, error && (error.message || error));
        if (!unreachableReported) {
            unreachableReported = true;
            if (!loadFailed) {
                renderLoadError(tr('stock_server_unreachable', 'Cannot reach the server. Check your connection and retry.'));
            }
            showNotification(tr('stock_server_unreachable', 'Cannot reach the server. Check your connection and retry.'), 'error');
        } else if (!loadFailed) {
            renderLoadError(tr('stock_server_unreachable', 'Cannot reach the server. Check your connection and retry.'));
        }
    }
}

function renderLoadError(message) {
    loadFailed = true;
    loadErrorMessage = message || '';
    renderAlerts();
}

function renderAlerts() {
    const container = document.getElementById('alertsList');
    if (!container) return;

    // API failed → show an error, NOT the empty-state message.
    if (loadFailed) {
        container.innerHTML = `
            <div class="empty-state error-state">
                <div class="empty-icon"><i class="fa-solid fa-triangle-exclamation" style="color:#dc2626"></i></div>
                <p>${escapeHtml(tr('stock_load_failed', 'Unable to load stock alerts. Please try again.'))}</p>
                ${loadErrorMessage ? `<p class="error-detail">${escapeHtml(loadErrorMessage)}</p>` : ''}
                <button class="btn btn-acknowledge" style="margin-top:16px;" onclick="loadStockAlerts()">
                    ${escapeHtml(tr('try_again', 'Retry'))}
                </button>
            </div>
        `;
        return;
    }

    container.innerHTML = '';

    if (allAlerts.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fa-solid fa-check"></i></div>
                <p>${escapeHtml(tr('stock_no_alerts', 'No stock alerts at this time.'))}</p>
            </div>
        `;
        return;
    }

    allAlerts.forEach(alert => {
        const card = document.createElement('div');
        const severity = alert.severity || 'medium';
        card.className = `alert-card ${severity}`;

        if (alert.source === 'inventory') {
            const isOut = alert.stockStatus === 'OUT_OF_STOCK';
            const stockBadgeClass = isOut ? 'status-out-of-stock' : 'status-low-stock';
            const stockStatusLabel = isOut ? tr('stock_out_of_stock', 'OUT OF STOCK') : tr('stock_low_stock', 'LOW STOCK');

            card.innerHTML = `
                <div class="alert-content">
                    <div class="alert-header">
                        <div class="alert-icon">${getSeverityIcon(severity)}</div>
                        <div>
                            <div class="alert-title">${escapeHtml(alert.itemName)}</div>
                            <span class="severity-badge severity-${escapeHtml(severity)}">${escapeHtml(formatSeverity(severity))}</span>
                            <span class="status-badge ${stockBadgeClass}">${stockStatusLabel}</span>
                        </div>
                    </div>

                    <div class="alert-details">
                        <div class="detail-item">
                            <span class="detail-label">Current Stock</span>
                            <span class="detail-value">${escapeHtml(alert.currentQuantity)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Minimum Stock</span>
                            <span class="detail-value">${escapeHtml(alert.minimumQuantity)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Status</span>
                            <span class="detail-value">${stockStatusLabel}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Last Updated</span>
                            <span class="detail-value">${formatDateTime(alert.updatedAt || alert.createdAt)}</span>
                        </div>
                    </div>

                    <div class="alert-reason">
                        <strong>Issue:</strong> ${escapeHtml(alert.reason)}
                    </div>
                </div>
            `;
        } else {
            const createdDate = formatDateTime(alert.createdAt);

            card.innerHTML = `
                <div class="alert-content">
                    <div class="alert-header">
                        <div class="alert-icon">${getSeverityIcon(severity)}</div>
                        <div>
                            <div class="alert-title">${escapeHtml(alert.itemName)}</div>
                            <span class="severity-badge severity-${escapeHtml(severity)}">${escapeHtml(formatSeverity(severity))}</span>
                            <span class="status-badge status-${escapeHtml(alert.status)}">${window.translateStatus ? window.translateStatus(alert.status) : escapeHtml(alert.status)}</span>
                        </div>
                    </div>

                    <div class="alert-details">
                        <div class="detail-item">
                            <span class="detail-label">Type</span>
                            <span class="detail-value">${escapeHtml(formatAlertType(alert.alertType))}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Reported By</span>
                            <span class="detail-value">${escapeHtml(alert.reportedBy || 'System')}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Affected Orders</span>
                            <span class="detail-value">${escapeHtml(alert.affectedOrders || 0)}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Reported At</span>
                            <span class="detail-value">${createdDate}</span>
                        </div>
                    </div>

                    <div class="alert-reason">
                        <strong>Issue:</strong> ${escapeHtml(alert.reason)}
                    </div>

                    ${renderManagerResponse(alert)}
                </div>

                <div class="alert-actions">
                    ${alert.status === 'active' ? `
                        <button class="btn btn-acknowledge" onclick="acknowledgeAlert('${escapeHtml(alert.id)}')">
                            Mark Acknowledged
                        </button>
                    ` : ''}
                    ${alert.status !== 'resolved' ? `
                        <button class="btn btn-resolve" onclick="resolveAlert('${escapeHtml(alert.id)}')">
                            Mark Resolved
                        </button>
                    ` : ''}
                </div>
            `;
        }

        container.appendChild(card);
    });
}

function renderManagerResponse(alert) {
    const parts = [];

    if (alert.status === 'acknowledged' || alert.status === 'resolved') {
        const ackLine = [
            alert.acknowledgedBy ? `${escapeHtml(tr('stock_acknowledged_by', 'Acknowledged by'))} ${escapeHtml(alert.acknowledgedBy)}` : '',
            alert.assignedNote ? ` ${escapeHtml(tr('stock_assignment_note', 'Note'))}: ${escapeHtml(alert.assignedNote)}` : ''
        ].filter(Boolean).join('');
        if (ackLine) {
            parts.push(`<div class="alert-response response-acknowledged"><i class="fa-solid fa-user-check"></i> ${ackLine}</div>`);
        }
    }

    if (alert.status === 'resolved') {
        const meta = [];
        if (alert.resolvedBy) meta.push(escapeHtml(alert.resolvedBy));
        if (alert.resolvedAt) meta.push(formatDateTime(alert.resolvedAt));
        parts.push(
            `<div class="alert-response response-resolved"><i class="fa-solid fa-circle-check"></i> ` +
            `<strong>${escapeHtml(tr('stock_resolved_label', 'Resolved'))}:</strong> ` +
            `${escapeHtml(alert.resolutionNote || tr('stock_no_resolution', 'No resolution note.'))}` +
            (meta.length ? `<span class="response-meta">${meta.join(' · ')}</span>` : '') +
            `</div>`
        );
    }

    return parts.join('');
}

function filterAlerts() {
    loadStockAlerts();
}

function getSeverityIcon(severity) {
    switch(severity) {
        case 'critical': return '<i class="fa-solid fa-circle-exclamation" style="color:#dc2626"></i>';
        case 'high': return '<i class="fa-solid fa-circle-exclamation" style="color:#ea580c"></i>';
        case 'medium': return '<i class="fa-solid fa-circle-exclamation" style="color:#eab308"></i>';
        case 'low': return '<i class="fa-solid fa-circle-info" style="color:#2563eb"></i>';
        default: return '<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b"></i>';
    }
}

function formatSeverity(severity) {
    const labels = {
        critical: 'Critical',
        high: 'High',
        medium: 'Medium',
        low: 'Low'
    };
    return labels[severity] || severity || '—';
}

function formatAlertType(type) {
    const types = {
        'out_of_stock': 'Out of Stock',
        'low_stock': 'Low Stock',
        'ingredient_shortage': 'Ingredient Shortage',
        'quality_issue': 'Quality Issue'
    };
    return types[type] || type;
}

function openReportModal() {
    const form = document.getElementById('reportForm');
    if (form) form.reset();
    document.getElementById('reportModal').classList.add('active');
}

function closeReportModal() {
    document.getElementById('reportModal').classList.remove('active');
    document.getElementById('reportForm').reset();
}

document.getElementById('reportForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const itemName = document.getElementById('itemName').value;
    const alertType = document.getElementById('alertType').value;
    const severity = document.getElementById('severity').value;
    const reason = document.getElementById('reason').value;

    // Client-side guard — the field is required; never guess a default.
    if (!severity) {
        showNotification(tr('stock_severity_required', 'Please select a severity level'), 'error');
        document.getElementById('severity').focus();
        return;
    }

    try {
        const apiBase = getApiBase();
        const url = `${apiBase}/kitchen/stock-alerts`;
        console.log(`[Stock Alerts] POST ${url}`);
        const token = localStorage.getItem('auth_token');
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                itemName: itemName,
                alertType: alertType,
                severity: severity,
                reason: reason
            })
        });

        console.log(`[Stock Alerts] HTTP ${response.status}`);
        let data = null;
        try { data = await response.json(); } catch (parseError) { data = null; }

        if (!response.ok || !data || !data.success) {
            const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;
            console.error(`[Stock Alerts] Report failed: ${message}`);
            showNotification((message && (typeof window.translateErrorMessage === 'function' ? window.translateErrorMessage(message) : message)) || tr('stock_failed_report', 'Failed to report issue'), 'error');
            return;
        }

        showNotification(tr('stock_report_success', 'Stock alert reported successfully'), 'success');
        closeReportModal();
        loadStockAlerts();

    } catch (error) {
        console.error('[Stock Alerts] Network error reporting issue:', error && (error.message || error));
        showNotification(tr('stock_failed_report', 'Failed to report issue'), 'error');
    }
});

async function acknowledgeAlert(alertId) {
    try {
        const apiBase = getApiBase();
        const url = `${apiBase}/kitchen/stock-alerts/${alertId}/acknowledge`;
        console.log(`[Stock Alerts] PATCH ${url}`);
        const token = localStorage.getItem('auth_token');
        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`[Stock Alerts] HTTP ${response.status}`);
        let data = null;
        try { data = await response.json(); } catch (parseError) { data = null; }

        if (!response.ok || !data || !data.success) {
            const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;
            console.error(`[Stock Alerts] Acknowledge failed: ${message}`);
            showNotification((message && (typeof window.translateErrorMessage === 'function' ? window.translateErrorMessage(message) : message)) || tr('stock_failed_ack', 'Failed to acknowledge alert'), 'error');
            return;
        }

        showNotification(tr('stock_ack_success', 'Alert acknowledged successfully'), 'success');
        loadStockAlerts();

    } catch (error) {
        console.error('[Stock Alerts] Network error acknowledging alert:', error && (error.message || error));
        showNotification(tr('stock_failed_ack', 'Failed to acknowledge alert'), 'error');
    }
}

async function resolveAlert(alertId) {
    if (!confirm(tr('stock_confirm_resolve', 'Mark this alert as resolved?'))) return;

    try {
        const apiBase = getApiBase();
        const url = `${apiBase}/kitchen/stock-alerts/${alertId}/resolve`;
        console.log(`[Stock Alerts] PATCH ${url}`);
        const token = localStorage.getItem('auth_token');
        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });

        console.log(`[Stock Alerts] HTTP ${response.status}`);
        let data = null;
        try { data = await response.json(); } catch (parseError) { data = null; }

        if (!response.ok || !data || !data.success) {
            const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;
            console.error(`[Stock Alerts] Resolve failed: ${message}`);
            showNotification((message && (typeof window.translateErrorMessage === 'function' ? window.translateErrorMessage(message) : message)) || tr('stock_failed_resolve', 'Failed to resolve alert'), 'error');
            return;
        }

        showNotification(tr('stock_resolve_success', 'Alert marked as resolved'), 'success');
        loadStockAlerts();

    } catch (error) {
        console.error('[Stock Alerts] Network error resolving alert:', error && (error.message || error));
        showNotification(tr('stock_failed_resolve', 'Failed to resolve alert'), 'error');
    }
}

function showNotification(message, type = 'info') {
    const container = document.getElementById('notificationContainer');
    if (!container) return;
    const notification = document.createElement('div');
    notification.className = `alert-notification notification-${type}`;
    notification.textContent = message;
    container.appendChild(notification);

    setTimeout(() => notification.remove(), 4000);
}

// Real-time: reload the list the moment a manager acknowledges or resolves a
// report (or another kitchen member files one), so the kitchen side shows the
// manager's response without a manual refresh or waiting for the 30s poll.
function initStockRealtime() {
    const token = localStorage.getItem('auth_token');
    if (!token) return;

    const connect = () => {
        import('/src/js/socket.js')
            .then((mod) => {
                const socketClient = mod.socketClient;
                if (typeof io === 'undefined') return;
                socketClient.connect(token);
                socketClient.on('stock:alert', (payload) => {
                    if (payload && payload.itemName) {
                        showNotification(tr('stock_new_realtime', 'New stock issue reported: {item}', { item: payload.itemName }), 'info');
                    }
                    loadStockAlerts();
                });
                socketClient.on('stock:alert:updated', (payload) => {
                    if (payload && payload.status === 'resolved' && payload.itemName) {
                        showNotification(tr('stock_resolved_realtime', 'Stock issue resolved: {item}', { item: payload.itemName }), 'success');
                    }
                    loadStockAlerts();
                });
            })
            .catch(() => { /* 30s polling remains the fallback */ });
    };

    if (typeof io === 'undefined') {
        const script = document.createElement('script');
        script.src = '/public/assets/vendor/js/socket.io-4.7.5.min.js';
        script.onload = connect;
        script.onerror = () => { /* polling fallback */ };
        document.head.appendChild(script);
    } else {
        connect();
    }
}
