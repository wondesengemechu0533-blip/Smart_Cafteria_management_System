function tr(key, fallback, vars) {
  if (typeof window.tr === "function") return window.tr(key, fallback, vars);
  return fallback;
}
import api from '../../js/api.js';

const toastEl = document.getElementById('toast');
const scheduledCountEl = document.getElementById('scheduledCount');
const activeCountEl = document.getElementById('activeCount');
const completedCountEl = document.getElementById('completedCount');
const currentShiftBody = document.getElementById('currentShiftBody');
const upcomingShiftsBody = document.getElementById('upcomingShiftsBody');
const pastShiftsBody = document.getElementById('pastShiftsBody');

let allShifts = [];
let currentShift = null;
let pollInterval = null;

function showToast(msg, type = 'success') {
    toastEl.textContent = msg;
    toastEl.className = 'toast ' + type + ' show';
    setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function fmtTime(dateStr) {
    if (!dateStr) return '--';
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(dateStr) {
    if (!dateStr) return '--';
    return new Date(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function duration(clockIn, clockOut) {
    if (!clockIn) return '--';
    const end = clockOut ? new Date(clockOut) : new Date();
    const ms = end - new Date(clockIn);
    const mins = Math.floor(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function statusBadge(status) {
    const cls = status === 'clocked_in' ? 'clocked-in' : status;
    return `<span class="status-badge ${cls}">${(typeof window.translateStatus==='function'?window.translateStatus(status):(status||'').replace(/_/g,' '))}</span>`;
}

function updateStats() {
    const today = new Date().toDateString();
    const todayStart = startOfToday();
    const scheduled = allShifts.filter(s =>
        s.status === 'scheduled' && Number.isFinite(shiftStart(s)) && shiftStart(s) >= todayStart).length;
    const active = allShifts.filter(s => s.status === 'active').length;
    const completed = allShifts.filter(s => s.status === 'completed' && new Date(s.date || s.startTime).toDateString() === today).length;
    scheduledCountEl.textContent = scheduled;
    activeCountEl.textContent = active;
    completedCountEl.textContent = completed;
}

function shiftTypeLabel(t) {
    const key = String(t || '').toLowerCase();
    if (key === 'morning') return tr('shift_morning', 'Morning');
    if (key === 'afternoon') return tr('shift_afternoon', 'Afternoon');
    if (key === 'evening') return tr('shift_evening', 'Evening');
    if (key === 'night') return tr('shift_night', 'Night');
    if (key === 'custom') return tr('shift_custom', 'Custom');
    return t || '--';
}

/** Is `s` the shift happening at this moment? */
function isLiveNow(s) {
    // Completed / cancelled shifts are never "live", even inside their window.
    if (s.status === 'completed' || s.status === 'cancelled') return false;
    const now = Date.now();
    const start = new Date(s.startTime).getTime();
    if (!Number.isFinite(start) || start > now) return false;
    if (!s.endTime) return true;
    const end = new Date(s.endTime).getTime();
    return !Number.isFinite(end) || end > now;
}

/**
 * Every shift this cook has on ONE day, morning -> evening.
 *
 * The /shifts/current response carries `dayShifts`, resolved server-side
 * against the signed-in account and ordered morning -> evening, so this
 * card never has to group the roster list in the browser.
 */
let dayShifts = [];
let dayShiftsDay = null;

/** Local-time YYYY-MM-DD key for a Date (or date string). */
function localDateKey(d) {
    const date = d instanceof Date ? d : new Date(d);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// The server resolves `dayShifts` against the day of whichever shift the
// ladder picked (today when one is live, otherwise the next/last one). The
// card heading must say WHICH day it is showing, or "Today's Shifts" lies
// on evenings when only tomorrow's roster is left.
function updateCurrentShiftTitle() {
    const titleEl = document.getElementById('currentShiftTitle');
    if (!titleEl) return;
    if (!dayShiftsDay || dayShiftsDay === localDateKey(new Date())) {
        titleEl.textContent = tr('schedule_today_shifts', "Today's Shifts");
    } else {
        titleEl.textContent = tr('schedule_shifts_for', 'Shifts for {date}')
            .replace('{date}', fmtDate(dayShiftsDay + 'T00:00:00'));
    }
}

function renderCurrentShift() {
    const rows = dayShifts;
    updateCurrentShiftTitle();

    if (!rows.length) {
        currentShiftBody.innerHTML = `
            <div class="empty-state" style="padding:20px;">
                <i class="fa-solid fa-calendar-xmark"></i>
                <p>${tr('no_shift_now', 'No shift scheduled right now')}</p>
            </div>`;
        return;
    }

    currentShiftBody.innerHTML = `
        <div class="shift-details">
            ${rows.map((s) => {
                const live = s.status === 'active' || (s.status === 'scheduled' && isLiveNow(s));
                // The card renders the whole day, so the action belongs to each
                // shift - and the backend only accepts clock-in from `scheduled`
                // and clock-out from `active`, so anything else would 400.
                // (A completed shift keeps its old clockInTime forever; only
                // status may decide, otherwise every past shift shows Clock Out.)
                const action = !canClock() ? ''
                    : s.status === 'active'
                    ? `<button class="btn btn-danger" onclick="window.clockOut('${s._id}')"><i class="fa-solid fa-right-from-bracket"></i> ${tr('clock_out', 'Clock Out')}</button>`
                    : s.status === 'scheduled'
                        ? `<button class="btn btn-primary" onclick="window.clockIn('${s._id}')"><i class="fa-solid fa-right-to-bracket"></i> ${tr('clock_in', 'Clock In')}</button>`
                        : '';
                return `
                <div class="shift-detail-item" style="${live ? 'border-left:3px solid #f97316;padding-left:10px;' : ''}">
                    <div class="shift-detail-label">
                        ${shiftTypeLabel(s.shiftType)}${live ? ' <span class="status-badge active">LIVE</span>' : ''}
                    </div>
                    <div class="shift-detail-value">
                        ${fmtTime(s.startTime)} &ndash; ${fmtTime(s.endTime)}
                    </div>
                    <div class="shift-detail-label" style="margin-top:4px;">${tr('status', 'Status')}</div>
                    <div class="shift-detail-value">${statusBadge(s.status)}</div>
                    ${s.clockInTime ? `<div class="shift-detail-label" style="margin-top:4px;">Clocked In</div><div class="shift-detail-value">${fmtTime(s.clockInTime)}</div>` : ''}
                    ${s.clockOutTime ? `<div class="shift-detail-label" style="margin-top:4px;">Clocked Out</div><div class="shift-detail-value">${fmtTime(s.clockOutTime)}</div>` : ''}
                    ${action ? `<div class="shift-actions">${action}</div>` : ''}
                </div>`;
            }).join('')}
        </div>
    `;
}

// Clock in/out is kitchen-only on the backend (authorize('kitchen')); managers
// may open this page to view the roster, so hide the buttons for them.
function canClock() {
    const role = String(localStorage.getItem('userRole') || localStorage.getItem('role') || '')
        .toLowerCase().replace(/-/g, '_');
    return ['kitchen', 'kitchen_staff', 'staff', 'foodmaker'].indexOf(role) !== -1;
}

function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function shiftStart(s) {
    return new Date(s.startTime).getTime();
}

function renderUpcomingShifts() {
    // Only future/today shifts that are still waiting to be worked. The
    // seeder leaves shifts `scheduled` forever, so a status-only filter
    // used to list last week's shifts under "Upcoming".
    const today = startOfToday();
    const upcoming = allShifts.filter(s =>
        s.status === 'scheduled' && Number.isFinite(shiftStart(s)) && shiftStart(s) >= today);
    if (upcoming.length === 0) {
        upcomingShiftsBody.innerHTML = `<div class="empty-state"><i class="fa-solid fa-calendar"></i><p>${tr('schedule_no_upcoming', 'No upcoming shifts')}</p></div>`;
        return;
    }
    upcomingShiftsBody.innerHTML = `
        <table class="data-table">
            <thead><tr><th>Date</th><th>${tr('shift_type', 'Shift Type')}</th><th>Staff</th><th>${tr('status', 'Status')}</th><th class="text-center">Action</th></tr></thead>
            <tbody>
                ${upcoming.map(s => `
                    <tr>
                        <td>${fmtDate(s.date || s.startTime)}</td>
                        <td>${s.shiftType || '--'}</td>
                        <td>${s.staffName || s.staff?.name || '--'}</td>
                        <td>${statusBadge(s.status)}</td>
                        <td class="text-center">${canClock() ? `<button class="btn btn-primary" onclick="window.clockIn('${s._id}')"><i class="fa-solid fa-right-to-bracket"></i> ${tr('clock_in', 'Clock In')}</button>` : '--'}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function renderPastShifts() {
    // Completed / cancelled, plus stale `scheduled` shifts nobody clocked
    // into (otherwise they would vanish from the page entirely).
    const today = startOfToday();
    const past = allShifts.filter(s =>
        s.status === 'completed' ||
        s.status === 'cancelled' ||
        (s.status === 'scheduled' && Number.isFinite(shiftStart(s)) && shiftStart(s) < today));
    if (past.length === 0) {
        pastShiftsBody.innerHTML = `<div class="empty-state"><i class="fa-solid fa-calendar"></i><p>${tr('schedule_no_past', 'No past shifts')}</p></div>`;
        return;
    }
    pastShiftsBody.innerHTML = `
        <table class="data-table">
            <thead><tr><th>Date</th><th>${tr('shift_type', 'Shift Type')}</th><th>Staff</th><th>Clock In</th><th>Clock Out</th><th>${tr('duration', 'Duration')}</th><th>${tr('status', 'Status')}</th></tr></thead>
            <tbody>
                ${past.map(s => `
                    <tr>
                        <td>${fmtDate(s.date || s.startTime)}</td>
                        <td>${s.shiftType || '--'}</td>
                        <td>${s.staffName || s.staff?.name || '--'}</td>
                        <td>${fmtTime(s.clockInTime)}</td>
                        <td>${fmtTime(s.clockOutTime)}</td>
                        <td>${duration(s.clockInTime, s.clockOutTime)}</td>
                        <td>${statusBadge(s.status)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function renderAll() {
    updateStats();
    renderCurrentShift();
    renderUpcomingShifts();
    renderPastShifts();
}

// Stop the 60s poll once the session is unusable (expired token / wrong
// role) - otherwise the page keeps firing requests that all fail silently.
function stopPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

function handleAuthError(err) {
    const status = err && err.status;
    if (status === 401 || status === 403) {
        stopPolling();
        showToast(status === 401
            ? tr('schedule_session_expired', 'Session expired. Please log in again.')
            : tr('schedule_access_denied', 'You do not have access to this page.'), 'error');
        return true;
    }
    return false;
}

async function fetchShifts() {
    try {
        const data = await api.get('/kitchen-staff/shifts');
        if (data.success) {
            allShifts = data.shifts || [];
            renderAll();
        }
    } catch (err) {
        console.error('Failed to load shifts:', err);
        handleAuthError(err);
    }
}

async function fetchCurrentShift() {
    try {
        const data = await api.get('/kitchen-staff/shifts/current');
        if (data.success) {
            currentShift = data.shift || null;
            // The day's full roster, resolved server-side against this account.
            // Fall back to the single `shift` pick so older backends that do not
            // send `dayShifts` still populate the card.
            dayShifts = Array.isArray(data.dayShifts)
                ? data.dayShifts
                : (data.shift ? [data.shift] : []);
            dayShiftsDay = data.day || null;
            renderCurrentShift();
        }
    } catch (err) {
        // The backend answers "no shift for this account" with 200 and
        // `shift: null`, so the branch above already handles it. The 404 guard
        // is kept only for talking to an older backend that still sent 404 -
        // it was never a failure, so it must not call handleAuthError().
        currentShift = null;
        dayShifts = [];
        dayShiftsDay = null;
        renderCurrentShift();
        if (err && err.status !== 404) {
            console.error('Failed to load current shift:', err);
            handleAuthError(err);
        }
    }
}

window.clockIn = async function (shiftId) {
    try {
        await api.patch(`/kitchen-staff/shifts/${shiftId}/clock-in`);
        showToast(tr('clock_in_success', 'Clocked in successfully'));
        await Promise.all([fetchShifts(), fetchCurrentShift()]);
    } catch (err) {
        console.error('Clock in error:', err);
        if (handleAuthError(err)) return;
        showToast((err && err.message) || tr('clock_in_failed', 'Failed to clock in'), 'error');
    }
};

window.clockOut = async function (shiftId) {
    try {
        await api.patch(`/kitchen-staff/shifts/${shiftId}/clock-out`);
        showToast(tr('clock_out_success', 'Clocked out successfully'));
        await Promise.all([fetchShifts(), fetchCurrentShift()]);
    } catch (err) {
        console.error('Clock out error:', err);
        if (handleAuthError(err)) return;
        showToast((err && err.message) || tr('clock_out_failed', 'Failed to clock out'), 'error');
    }
};

async function refresh() {
    await Promise.all([fetchShifts(), fetchCurrentShift()]);
}

refresh();
pollInterval = setInterval(refresh, 60000);
