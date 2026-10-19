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

// Only Cafeteria Admin / System Admin may resolve a stock alert (the backend
// answers 403 to everyone else) - hide the Resolve action for other roles.
function canResolveStockAlerts() {
    let role = '';
    if (window.ScosRoles && window.ScosRoles.getCurrentRole) {
        role = window.ScosRoles.getCurrentRole();
    } else {
        try {
            const cu = JSON.parse(localStorage.getItem('current_user') || 'null');
            role = (cu && cu.role) || localStorage.getItem('userRole') || localStorage.getItem('role') || '';
        } catch (e) {
            role = localStorage.getItem('userRole') || localStorage.getItem('role') || '';
        }
    }
    if (window.ScosRoles && window.ScosRoles.normalizeRole) role = window.ScosRoles.normalizeRole(role);
    return ['cafeteria_admin', 'admin', 'system_admin'].indexOf(String(role || '').toLowerCase()) !== -1;
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
            const isDone = alert.status === 'resolved' || alert.status === 'cancelled';
            const statusLabel = window.translateStatus ? window.translateStatus(alert.status) : escapeHtml(alert.status);

            card.innerHTML = `
                <div class="alert-content">
                    <div class="alert-header">
                        <div class="alert-icon">${getSeverityIcon(severity)}</div>
                        <div>
                            <div class="alert-title">${escapeHtml(alert.itemName)}</div>
                            <span class="severity-badge severity-${escapeHtml(severity)}">${escapeHtml(formatSeverity(severity))}</span>
                            <span class="status-badge ${isDone ? '' : stockBadgeClass}" ${isDone ? 'style="background:#dcfce7;color:#166534;"' : ''}>${isDone ? statusLabel : stockStatusLabel}</span>
                            ${alert.status === 'acknowledged' ? `<span class="status-badge status-acknowledged">${statusLabel}</span>` : ''}
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
                            <span class="detail-value">${isDone ? statusLabel : stockStatusLabel}</span>
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Last Updated</span>
                            <span class="detail-value">${formatDateTime(alert.updatedAt || alert.createdAt)}</span>
                        </div>
                    </div>

                    <div class="alert-reason">
                        <strong>Issue:</strong> ${escapeHtml(alert.reason)}
                    </div>

                    ${renderManagerResponse(alert)}
                </div>

                <div class="alert-actions">
                    <button class="btn btn-acknowledge" onclick="openDetails('${escapeHtml(alert.id)}')">
                        ${escapeHtml(tr('stock_view_details', 'View Details'))}
                    </button>
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
                    <button class="btn btn-acknowledge" onclick="openDetails('${escapeHtml(alert.id)}')">
                        ${escapeHtml(tr('stock_view_details', 'View Details'))}
                    </button>
                    ${alert.status === 'active' ? `
                        <button class="btn btn-acknowledge" onclick="acknowledgeAlert('${escapeHtml(alert.id)}')">
                            Mark Acknowledged
                        </button>
                    ` : ''}
                    ${alert.status !== 'resolved' && canResolveStockAlerts() ? `
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
        const resolutionLines = [];
        if (alert.resolutionReason) {
            resolutionLines.push(`<strong>${escapeHtml(tr('resolution_reason_label', 'Resolution Reason'))}:</strong> ${escapeHtml(alert.resolutionReason)}`);
        }
        if (alert.resolutionSolution) {
            resolutionLines.push(`<strong>${escapeHtml(tr('resolution_solution_label', 'Solution / Corrective Action'))}:</strong> ${escapeHtml(alert.resolutionSolution)}`);
        }
        if (alert.resolutionNote) {
            resolutionLines.push(escapeHtml(alert.resolutionNote));
        }
        parts.push(
            `<div class="alert-response response-resolved"><i class="fa-solid fa-circle-check"></i> ` +
            `<strong>${escapeHtml(tr('stock_resolved_label', 'Resolved'))}:</strong> ` +
            (resolutionLines.length ? resolutionLines.join('<br>') : escapeHtml(tr('stock_no_resolution', 'No resolution note.'))) +
            (meta.length ? `<span class="response-meta">${meta.join(' · ')}</span>` : '') +
            `</div>`
        );
    }

    return parts.join('');
}

function detailRow(label, value) {
    return `
        <div class="detail-item">
            <span class="detail-label">${escapeHtml(label)}</span>
            <span class="detail-value">${value == null || value === '' ? '—' : value}</span>
        </div>
    `;
}

function alertStatusBadge(alert) {
    const status = alert.status || 'active';
    const label = window.translateStatus ? window.translateStatus(status) : status;
    if (status === 'resolved') {
        return `<span class="status-badge" style="background:#dcfce7;color:#166534;">${escapeHtml(tr('issue_status_resolved', 'Resolved'))}</span>`;
    }
    if (status === 'cancelled') {
        return `<span class="status-badge" style="background:#f1f5f9;color:#64748b;">${escapeHtml(label)}</span>`;
    }
    return `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function renderDetails(alert) {
    const content = document.getElementById('detailsContent');
    if (!content) return;

    const isResolved = alert.status === 'resolved';
    const qtyAtCreation = alert.quantityAtCreation ?? null;

    const resolutionHtml = isResolved
        ? `
            <div class="alert-response response-resolved">
                <i class="fa-solid fa-circle-check"></i>
                <strong>${escapeHtml(tr('stock_resolved_label', 'Resolved'))}:</strong>
                ${alert.resolutionReason ? `<div><strong>${escapeHtml(tr('resolution_reason_label', 'Resolution Reason'))}:</strong> ${escapeHtml(alert.resolutionReason)}</div>` : ''}
                ${alert.resolutionSolution ? `<div><strong>${escapeHtml(tr('resolution_solution_label', 'Solution / Corrective Action'))}:</strong> ${escapeHtml(alert.resolutionSolution)}</div>` : ''}
                ${alert.resolutionNote ? `<div>${escapeHtml(alert.resolutionNote)}</div>` : `<div>${escapeHtml(tr('stock_no_resolution', 'No resolution note.'))}</div>`}
                ${alert.resolvedBy || alert.resolvedAt ? `<span class="response-meta">${[
                    alert.resolvedBy ? escapeHtml(alert.resolvedBy) : '',
                    alert.resolvedAt ? formatDateTime(alert.resolvedAt) : ''
                ].filter(Boolean).join(' · ')}</span>` : ''}
            </div>
        `
        : `<div class="alert-response"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(tr('stock_not_resolved_yet', 'This alert has not been resolved yet.'))}</div>`;

    content.innerHTML = `
        <div class="alert-details" style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">
            ${detailRow(tr('stock_detail_item_name', 'Item Name'), escapeHtml(alert.itemName || '—'))}
            ${detailRow(tr('stock_detail_item_id', 'Item ID'), escapeHtml(alert.itemId ? String(alert.itemId) : '—'))}
            ${detailRow(tr('stock_detail_alert_type', 'Alert Type'), escapeHtml(formatAlertType(alert.alertType)))}
            ${detailRow(tr('stock_detail_severity', 'Severity'), escapeHtml(formatSeverity(alert.severity)))}
            ${detailRow(tr('stock_detail_created_qty', 'Quantity When Alert Created'), qtyAtCreation == null ? escapeHtml(tr('stock_detail_qty_not_stored', 'Not recorded')) : escapeHtml(qtyAtCreation))}
            ${detailRow(tr('stock_detail_current_qty', 'Current Inventory Quantity'), escapeHtml(alert.currentQuantity ?? '—'))}
            ${detailRow(tr('stock_detail_status', 'Status'), alertStatusBadge(alert))}
            ${detailRow(tr('stock_detail_created_at', 'Reported At'), formatDateTime(alert.createdAt))}
        </div>
        <div class="alert-reason" style="margin-top:12px;">
            <strong>${escapeHtml(tr('stock_detail_reason', 'Original Reason'))}:</strong> ${escapeHtml(alert.reason || '—')}
        </div>
        <h4 style="margin:16px 0 8px;">${escapeHtml(tr('stock_detail_resolution', 'Resolution'))}</h4>
        ${resolutionHtml}
    `;
}

async function openDetails(alertId) {
    const modal = document.getElementById('detailsModal');
    const content = document.getElementById('detailsContent');
    if (!modal || !content) return;

    modal.classList.add('active');
    content.innerHTML = `
        <div class="empty-state">
            <div class="empty-icon"><i class="fa-solid fa-spinner fa-spin"></i></div>
            <p>${escapeHtml(tr('stock_details_loading', 'Loading alert details…'))}</p>
        </div>
    `;

    // Authoritative record from the API; fall back to the cached list entry
    // (e.g. transient network hiccup) so details still open.
    let alert = allAlerts.find((a) => String(a.id) === String(alertId)) || null;

    try {
        const apiBase = getApiBase();
        const token = localStorage.getItem('auth_token');
        const response = await fetch(`${apiBase}/kitchen/stock-alerts/${encodeURIComponent(alertId)}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        let data = null;
        try { data = await response.json(); } catch (parseError) { data = null; }

        if (response.ok && data && data.success && data.alert) {
            alert = data.alert;
        } else if (!alert) {
            const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;
            content.innerHTML = `
                <div class="empty-state error-state">
                    <p>${escapeHtml(tr('stock_details_failed', 'Unable to load alert details.'))}</p>
                    <p class="error-detail">${escapeHtml(message)}</p>
                </div>
            `;
            return;
        }
    } catch (error) {
        console.warn('[Stock Alerts] Network error loading details:', error && (error.message || error));
        if (!alert) {
            content.innerHTML = `
                <div class="empty-state error-state">
                    <p>${escapeHtml(tr('stock_details_failed', 'Unable to load alert details.'))}</p>
                    <p class="error-detail">${escapeHtml(tr('stock_server_unreachable', 'Cannot reach the server. Check your connection and retry.'))}</p>
                </div>
            `;
            return;
        }
    }

    renderDetails(alert);
}

function closeDetailsModal() {
    const modal = document.getElementById('detailsModal');
    if (modal) modal.classList.remove('active');
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

function resolveAlert(alertId) {
    openResolveModal(alertId);
}

function populateResolveSelect(selectEl, options) {
    if (!selectEl) return;
    selectEl.innerHTML = '<option value="">' + escapeHtml(tr('select_option', 'Select an option')) + '</option>' +
        options.map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('');
}

function openResolveModal(alertId) {
    const modal = document.getElementById('resolveModal');
    if (!modal) return;
    const idInput = document.getElementById('resolveAlertId');
    const reasonSel = document.getElementById('resolveReason');
    const solSel = document.getElementById('resolveSolution');
    const otherGroup = document.getElementById('resolveOtherGroup');
    const form = document.getElementById('resolveForm');
    if (form) form.reset();
    if (idInput) idInput.value = alertId || '';
    const opts = window.ScosResolution;
    const category = opts && opts.categoryForStockAlert ? opts.categoryForStockAlert() : 'stock';
    populateResolveSelect(reasonSel, opts && opts.reasonsFor ? opts.reasonsFor(category) : ['Out of Stock', 'Low Stock', 'Expired Items', 'Supplier Delay', 'Incorrect Stock Record', 'Other']);
    populateResolveSelect(solSel, opts && opts.solutionsFor ? opts.solutionsFor(category) : ['Restocked Items', 'Updated Stock Quantity', 'Ordered New Supplies', 'Removed Expired Items', 'Contacted Supplier', 'Corrected Inventory Record', 'Other']);
    if (otherGroup) otherGroup.style.display = 'none';
    modal.classList.add('active');
}

function closeResolveModal() {
    const modal = document.getElementById('resolveModal');
    if (modal) modal.classList.remove('active');
}

document.getElementById('resolveForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const alertId = document.getElementById('resolveAlertId')?.value;
    const reasonSel = document.getElementById('resolveReason');
    const solSel = document.getElementById('resolveSolution');
    const otherInput = document.getElementById('resolveOther');
    const detailsInput = document.getElementById('resolveDetails');

    const setError = (sel, message) => {
        const group = sel?.closest('.form-group');
        let err = group?.querySelector('.form-error');
        if (group && !err) {
            err = document.createElement('div');
            err.className = 'form-error';
            group.appendChild(err);
        }
        if (err) err.textContent = message || '';
    };
    setError(reasonSel, '');
    setError(solSel, '');
    setError(otherInput, '');

    const reason = reasonSel?.value || '';
    const solution = solSel?.value || '';
    const otherText = otherInput?.value.trim() || '';
    const details = detailsInput?.value.trim() || '';

    if (!reason) {
        setError(reasonSel, tr('reason_required', 'Resolution reason is required.'));
        reasonSel?.focus();
        return;
    }
    if (!solution) {
        setError(solSel, tr('solution_required', 'Solution is required.'));
        solSel?.focus();
        return;
    }
    if ((reason === 'Other' || solution === 'Other') && !otherText) {
        setError(otherInput, tr('other_required', 'Please explain the Other selection.'));
        otherInput?.focus();
        return;
    }
    if (!alertId) {
        showNotification(tr('stock_not_found', 'Stock alert not found'), 'error');
        return;
    }

    const noteParts = [];
    if (otherText) noteParts.push(tr('resolution_other_prefix', 'Other explanation') + ': ' + otherText);
    if (details) noteParts.push(details);

    try {
        const apiBase = getApiBase();
        const url = `${apiBase}/kitchen/stock-alerts/${alertId}/resolve`;
        const token = localStorage.getItem('auth_token');
        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                resolutionReason: reason,
                resolutionSolution: solution,
                resolutionNote: noteParts.join('\n\n') || null
            })
        });

        let data = null;
        try { data = await response.json(); } catch (parseError) { data = null; }

        if (!response.ok || !data || !data.success) {
            const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;
            showNotification((message && (typeof window.translateErrorMessage === 'function' ? window.translateErrorMessage(message) : message)) || tr('stock_failed_resolve', 'Failed to resolve alert'), 'error');
            return;
        }

        showNotification(tr('stock_resolve_success', 'Alert marked as resolved'), 'success');
        closeResolveModal();
        loadStockAlerts();

    } catch (error) {
        console.error('[Stock Alerts] Network error resolving alert:', error && (error.message || error));
        showNotification(tr('stock_failed_resolve', 'Failed to resolve alert'), 'error');
    }
});

document.getElementById('resolveForm')?.addEventListener('change', (e) => {
    if (e.target?.id !== 'resolveReason' && e.target?.id !== 'resolveSolution') return;
    const reason = document.getElementById('resolveReason')?.value || '';
    const solution = document.getElementById('resolveSolution')?.value || '';
    const otherGroup = document.getElementById('resolveOtherGroup');
    if (otherGroup) otherGroup.style.display = (reason === 'Other' || solution === 'Other') ? '' : 'none';
});

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
