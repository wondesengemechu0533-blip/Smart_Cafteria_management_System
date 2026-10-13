/**
 * Kitchen Staff — Issue Reports page logic.
 *
 * - Report Issue form → POST /api/v1/issues (reporter/cafeteria stamped by backend)
 * - My Reports list  → GET  /api/v1/issues (backend returns only this user's reports)
 * - Details modal    → GET  /api/v1/issues/:id (original issue + manager solution)
 * - Real-time        → Socket.IO notification:new / issue:updated (refresh + toast)
 *
 * Manager-only controls (Accept / Send Solution) are intentionally absent here.
 */
let allIssues = [];
let loadFailed = false;
let loadErrorMessage = '';

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

function tr(key, fallback, vars) {
    if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
    if (typeof window.getText === 'function') {
        const v = window.getText(key);
        if (v && v !== key) return v;
    }
    if (fallback != null && fallback !== '') {
        if (vars && typeof vars === 'object') {
            let out = String(fallback);
            Object.keys(vars).forEach((k) => {
                out = out.split('{' + k + '}').join(String(vars[k]));
            });
            return out;
        }
        return fallback;
    }
    return key;
}

function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatCategory(category) {
    const map = {
        equipment: 'issue_category_equipment',
        stock: 'issue_category_stock',
        quality: 'issue_category_quality',
        safety: 'issue_category_safety',
        cleaning: 'issue_category_cleaning',
        staffing: 'issue_category_staffing',
        other: 'issue_category_other'
    };
    const key = map[category];
    return key ? tr(key, category || 'Other') : (category || tr('issue_category_other', 'Other'));
}

function statusLabel(status) {
    const map = {
        PENDING: 'issue_status_pending',
        ACCEPTED: 'issue_status_accepted',
        RESOLVED: 'issue_status_resolved'
    };
    if (typeof window.translateStatus === 'function') {
        const localized = window.translateStatus(status);
        if (localized && localized !== status) return localized;
    }
    const key = map[status];
    return key ? tr(key, status || '') : (status || '');
}

function personName(person, fallback) {
    if (!person) return fallback || '—';
    if (typeof person === 'object') return person.name || fallback || '—';
    return fallback || '—';
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

// Single initialization guard — prevents duplicate requests from repeated
// DOMContentLoaded handlers or double script inclusion.
if (!window.__kitchenIssuesInitialized) {
    window.__kitchenIssuesInitialized = true;

    const startIssues = () => {
        loadIssues();
        if (window.__kitchenIssuesTimer) clearInterval(window.__kitchenIssuesTimer);
        window.__kitchenIssuesTimer = setInterval(loadIssues, 30000);
        initIssueRealtime();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startIssues);
    } else {
        startIssues();
    }
}

async function loadIssues() {
    const apiBase = getApiBase();
    const statusEl = document.getElementById('statusFilter');
    const status = statusEl ? statusEl.value : '';

    if (!apiBase) {
        renderLoadError(tr('error_network', 'API configuration missing.'));
        return;
    }

    let url = `${apiBase}/issues`;
    if (status) url += `?status=${encodeURIComponent(status)}`;

    const token = localStorage.getItem('auth_token');
    if (!token) {
        renderLoadError(tr('error_unauthorized', 'You are not signed in. Please log in again.'));
        showNotification(tr('error_unauthorized', 'Not signed in. Please log in again.'), 'error');
        return;
    }

    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        let data = null;
        try { data = await response.json(); } catch (parseError) { data = null; }

        if (!response.ok || !data || !data.success) {
            if (response.status === 401) {
                renderLoadError(tr('error_session_expired', 'Session expired. Please log in again.'));
                showNotification(tr('error_session_expired', 'Session expired. Please log in again.'), 'error');
                return;
            }
            const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;
            renderLoadError(typeof window.translateErrorMessage === 'function' ? window.translateErrorMessage(message) : message);
            showNotification(tr('issue_load_error', 'Error loading issue reports'), 'error');
            return;
        }

        allIssues = Array.isArray(data.issues) ? data.issues : [];
        loadFailed = false;
        loadErrorMessage = '';
        renderIssues();
    } catch (error) {
        console.error('[Issue Reports] Network error calling url:', error && (error.message || error));
        renderLoadError(tr('error_network', 'Network error — could not reach the server.'));
        showNotification(tr('issue_load_error', 'Failed to load issue reports'), 'error');
    }
}

function renderLoadError(message) {
    loadFailed = true;
    loadErrorMessage = message || '';
    renderIssues();
}

function renderIssues() {
    const container = document.getElementById('issuesList');
    if (!container) return;

    if (loadFailed) {
        container.innerHTML = `
            <div class="empty-state error-state">
                <div class="empty-icon"><i class="fa-solid fa-triangle-exclamation" style="color:#dc2626"></i></div>
                <p>${escapeHtml(tr('issue_load_failed', 'Unable to load issue reports. Please try again.'))}</p>
                ${loadErrorMessage ? `<p class="error-detail">${escapeHtml(loadErrorMessage)}</p>` : ''}
                <button class="btn btn-view" style="margin-top:16px;" onclick="loadIssues()">${escapeHtml(tr('try_again', 'Retry'))}</button>
            </div>
        `;
        return;
    }

    container.innerHTML = '';

    if (allIssues.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fa-solid fa-check"></i></div>
                <p>${escapeHtml(tr('issue_empty_cafeteria', 'You have not submitted any issue reports yet.'))}</p>
            </div>
        `;
        return;
    }

    allIssues.forEach(issue => {
        const card = document.createElement('div');
        const priority = issue.priority || 'medium';
        card.className = `alert-card ${escapeHtml(priority)}`;
        const status = issue.status || 'PENDING';
        const hasSolution = Boolean(issue.solution);
        const sevKey = 'severity_' + priority;

        card.innerHTML = `
            <div class="alert-content">
                <div class="alert-header">
                    <div class="alert-icon"><i class="fa-solid fa-flag" style="color:#f59e0b"></i></div>
                    <div>
                        <div class="alert-title">${escapeHtml(issue.title)}</div>
                        <span class="severity-badge severity-${escapeHtml(priority)}">${escapeHtml(tr(sevKey, priority))}</span>
                        <span class="category-badge">${escapeHtml(formatCategory(issue.category))}</span>
                        <span class="status-badge status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
                    </div>
                </div>

                <div class="alert-details">
                    <div class="detail-item">
                        <span class="detail-label">${escapeHtml(tr('issue_col_reported_at', 'Reported At'))}</span>
                        <span class="detail-value">${formatDateTime(issue.createdAt)}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">${escapeHtml(tr('issue_col_status', 'Status'))}</span>
                        <span class="detail-value">${escapeHtml(statusLabel(status))}</span>
                    </div>
                    ${issue.acceptedAt ? `
                    <div class="detail-item">
                        <span class="detail-label">${escapeHtml(tr('issue_title_accepted', 'Accepted At'))}</span>
                        <span class="detail-value">${formatDateTime(issue.acceptedAt)}</span>
                    </div>` : ''}
                    ${issue.repliedAt ? `
                    <div class="detail-item">
                        <span class="detail-label">${escapeHtml(tr('issue_title_solution', 'Replied At'))}</span>
                        <span class="detail-value">${formatDateTime(issue.repliedAt)}</span>
                    </div>` : ''}
                </div>

                <div class="alert-reason">
                    <strong>${escapeHtml(tr('issue_title_description', 'Issue'))}:</strong> ${escapeHtml(issue.description)}
                </div>
            </div>

            <div class="alert-actions">
                <button class="btn btn-view" onclick="openIssueDetails('${escapeHtml(issue.id)}')">
                    ${escapeHtml(tr('view_details', 'View Details'))}
                </button>
                ${hasSolution ? `
                <button class="btn btn-solution" onclick="openIssueDetails('${escapeHtml(issue.id)}')">
                    <i class="fa-solid fa-comment-dots"></i> ${escapeHtml(tr('issue_title_solution', 'View Solution'))}
                </button>` : ''}
            </div>
        `;

        container.appendChild(card);
    });
}

function filterIssues() {
    loadIssues();
}

function openReportModal() {
    document.getElementById('reportModal').classList.add('active');
}

function closeReportModal() {
    document.getElementById('reportModal').classList.remove('active');
    document.getElementById('reportForm').reset();
}

document.getElementById('reportForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const title = document.getElementById('issueTitle').value.trim();
    const category = document.getElementById('issueCategory').value;
    const priority = document.getElementById('issuePriority').value;
    const description = document.getElementById('issueDescription').value.trim();
    const submitBtn = document.getElementById('submitIssueBtn');

    if (!title || !description) {
        showNotification(tr('issue_title_required', 'Issue title and description are required'), 'error');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = tr('issue_sending', 'Submitting…');
    }

    try {
        const apiBase = getApiBase();
        const url = `${apiBase}/issues`;
        const token = localStorage.getItem('auth_token');
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title, category, priority, description })
        });

        let data = null;
        try { data = await response.json(); } catch (parseError) { data = null; }

        if (response.status === 401) {
            showNotification(tr('error_session_expired', 'Session expired. Please log in again.'), 'error');
            return;
        }
        if (!response.ok || !data || !data.success) {
            const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;
            showNotification((typeof window.translateErrorMessage === 'function' ? window.translateErrorMessage(message) : message) || tr('issue_load_error', 'Failed to submit issue report'), 'error');
            return;
        }

        showNotification(tr('issue_accepted_toast', 'Issue report submitted successfully'), 'success');
        closeReportModal();
        loadIssues();
    } catch (error) {
        console.error('[Issue Reports] Network error submitting issue:', error && (error.message || error));
        showNotification(tr('error_network', 'Network error — could not submit the report. Please try again.'), 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = tr('issue_send_solution', 'Submit Report');
        }
    }
});

function closeDetailsModal() {
    document.getElementById('detailsModal')?.classList.remove('active');
}

async function openIssueDetails(issueId) {
    const modal = document.getElementById('detailsModal');
    const body = document.getElementById('detailsBody');
    const titleEl = document.getElementById('detailsTitle');
    if (!modal || !body) return;

    titleEl.textContent = tr('issue_title_details', 'Issue Details');
    body.innerHTML = `<p style="color:#999;">${escapeHtml(tr('issue_loading', 'Loading…'))}</p>`;
    modal.classList.add('active');

    try {
        const apiBase = getApiBase();
        const token = localStorage.getItem('auth_token');
        const response = await fetch(`${apiBase}/issues/${encodeURIComponent(issueId)}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });

        let data = null;
        try { data = await response.json(); } catch (parseError) { data = null; }

        if (!response.ok || !data || !data.success) {
            const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;
            body.innerHTML = `<div class="alert-notification notification-error">${escapeHtml(message)}</div>`;
            return;
        }

        const issue = data.issue;
        const status = issue.status || 'PENDING';
        titleEl.textContent = issue.title || tr('issue_title_details', 'Issue Details');
        const sevKey = 'severity_' + (issue.priority || 'medium');

        body.innerHTML = `
            <div class="detail-section">
                <h4>${escapeHtml(tr('issue_col_status', 'Status'))}</h4>
                <span class="status-badge status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
                <span class="severity-badge severity-${escapeHtml(issue.priority || 'medium')}">${escapeHtml(tr(sevKey, issue.priority || 'medium'))}</span>
                <span class="category-badge">${escapeHtml(formatCategory(issue.category))}</span>
            </div>
            <div class="detail-section">
                <h4>${escapeHtml(tr('issue_title_description', 'Original Issue'))}</h4>
                <p style="white-space:pre-wrap;font-size:14px;color:#333;">${escapeHtml(issue.description)}</p>
            </div>
            <div class="detail-section">
                <h4>${escapeHtml(tr('Timeline', 'Timeline'))}</h4>
                <div class="alert-details">
                    <div class="detail-item">
                        <span class="detail-label">${escapeHtml(tr('issue_title_reported_by', 'Reported By'))}</span>
                        <span class="detail-value">${escapeHtml(personName(issue.reportedBy, 'You'))}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">${escapeHtml(tr('issue_col_reported_at', 'Reported At'))}</span>
                        <span class="detail-value">${formatDateTime(issue.createdAt)}</span>
                    </div>
                    ${issue.acceptedAt ? `
                    <div class="detail-item">
                        <span class="detail-label">${escapeHtml(tr('issue_title_accepted', 'Accepted By'))}</span>
                        <span class="detail-value">${escapeHtml(personName(issue.acceptedBy, tr('role_manager', 'Manager')))}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">${escapeHtml(tr('issue_title_accepted', 'Accepted At'))}</span>
                        <span class="detail-value">${formatDateTime(issue.acceptedAt)}</span>
                    </div>` : ''}
                    ${issue.repliedAt ? `
                    <div class="detail-item">
                        <span class="detail-label">${escapeHtml(tr('issue_title_send_solution', 'Replied By'))}</span>
                        <span class="detail-value">${escapeHtml(personName(issue.repliedBy, tr('role_manager', 'Manager')))}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">${escapeHtml(tr('issue_title_solution', 'Replied At'))}</span>
                        <span class="detail-value">${formatDateTime(issue.repliedAt)}</span>
                    </div>` : ''}
                </div>
            </div>
            ${issue.solution ? `
            <div class="detail-section">
                <h4>${escapeHtml(tr('issue_title_solution', "Manager's Solution"))}</h4>
                <div class="solution-box">${escapeHtml(issue.solution)}</div>
                <div class="solution-meta">
                    ${escapeHtml(tr('issue_by', 'By {name}', { name: personName(issue.repliedBy, tr('role_cafeteria_manager', 'Cafeteria Manager')) }))} · ${formatDateTime(issue.repliedAt)}
                </div>
            </div>` : `
            <div class="detail-section">
                <h4>${escapeHtml(tr('issue_title_solution', "Manager's Solution"))}</h4>
                <p style="font-size:14px;color:#999;">${escapeHtml(tr('issue_empty_status', 'No solution yet — the cafeteria manager has not replied.'))}</p>
            </div>`}
        `;
    } catch (error) {
        console.error('[Issue Reports] Network error loading details:', error && (error.message || error));
        body.innerHTML = `<div class="alert-notification notification-error">${escapeHtml(tr('error_network', 'Network error — could not load the issue details.'))}</div>`;
    }
}

// ---------------------------------------------------------------
// Real-time: Socket.IO (notification:new / issue:updated) with a
// REST polling fallback if the socket library is unavailable.
// ---------------------------------------------------------------
function initIssueRealtime() {
    const token = localStorage.getItem('auth_token');
    if (!token) return;

    const connectSocket = () => {
        import('/src/js/socket.js')
            .then(({ socketClient }) => {
                if (typeof io === 'undefined') return;
                socketClient.connect(token);
                socketClient.on('notification:new', (notification) => {
                    if (!notification) return;
                    showNotification(notification.title ? `${notification.title}: ${notification.message || ''}` : (notification.message || 'New notification'), 'success');
                    loadIssues();
                    if (window.refreshNotificationBadge) {
                        try { window.refreshNotificationBadge(); } catch (e) { /* ignore */ }
                    }
                });
                socketClient.on('issue:updated', () => {
                    loadIssues();
                });
            })
            .catch(() => { /* polling fallback below keeps the page live */ });
    };

    if (typeof io === 'undefined') {
        const script = document.createElement('script');
        script.src = '/public/assets/vendor/js/socket.io-4.7.5.min.js';
        script.onload = connectSocket;
        script.onerror = () => { /* polling fallback */ };
        document.head.appendChild(script);
    } else {
        connectSocket();
    }
}
