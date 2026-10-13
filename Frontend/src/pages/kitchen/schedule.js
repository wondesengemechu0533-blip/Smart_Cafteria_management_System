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
    const scheduled = allShifts.filter(s => s.status === 'scheduled').length;
    const active = allShifts.filter(s => s.status === 'active' || s.status === 'clocked_in').length;
    const completed = allShifts.filter(s => s.status === 'completed' && new Date(s.date || s.startTime).toDateString() === today).length;
    scheduledCountEl.textContent = scheduled;
    activeCountEl.textContent = active;
    completedCountEl.textContent = completed;
}

function renderCurrentShift() {
    if (!currentShift) {
        currentShiftBody.innerHTML = `
            <div class="empty-state" style="padding:20px;">
                <i class="fa-solid fa-calendar-xmark"></i>
                <p>${tr('no_shift_now', 'No shift scheduled right now')}</p>
            </div>`;
        return;
    }
    const s = currentShift;
    const isClockedIn = s.status === 'clocked_in' || s.clockInTime;
    const clockActionBtn = isClockedIn
        ? `<button class="btn btn-danger" onclick="window.clockOut('${s._id}')"><i class="fa-solid fa-right-from-bracket"></i> ${tr('clock_out', 'Clock Out')}</button>`
        : `<button class="btn btn-primary" onclick="window.clockIn('${s._id}')"><i class="fa-solid fa-right-to-bracket"></i> ${tr('clock_in', 'Clock In')}</button>`;

    currentShiftBody.innerHTML = `
        <div class="shift-details">
            <div class="shift-detail-item">
                <div class="shift-detail-label">${tr('shift_type', 'Shift Type')}</div>
                <div class="shift-detail-value">${s.shiftType || '--'}</div>
            </div>
            <div class="shift-detail-item">
                <div class="shift-detail-label">${tr('start_time', 'Start Time')}</div>
                <div class="shift-detail-value">${fmtTime(s.startTime)}</div>
            </div>
            <div class="shift-detail-item">
                <div class="shift-detail-label">${tr('end_time', 'End Time')}</div>
                <div class="shift-detail-value">${fmtTime(s.endTime)}</div>
            </div>
            <div class="shift-detail-item">
                <div class="shift-detail-label">${tr('status', 'Status')}</div>
                <div class="shift-detail-value">${statusBadge(s.status)}</div>
            </div>
            ${s.clockInTime ? `<div class="shift-detail-item"><div class="shift-detail-label">Clocked In</div><div class="shift-detail-value">${fmtTime(s.clockInTime)}</div></div>` : ''}
            ${s.clockOutTime ? `<div class="shift-detail-item"><div class="shift-detail-label">Clocked Out</div><div class="shift-detail-value">${fmtTime(s.clockOutTime)}</div></div>` : ''}
        </div>
        <div class="shift-actions">${clockActionBtn}</div>
    `;
}

function renderUpcomingShifts() {
    const upcoming = allShifts.filter(s => s.status === 'scheduled');
    if (upcoming.length === 0) {
        upcomingShiftsBody.innerHTML = '<div class="empty-state"><i class="fa-solid fa-calendar"></i><p>No upcoming shifts</p></div>';
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
                        <td class="text-center"><button class="btn btn-primary" onclick="window.clockIn('${s._id}')"><i class="fa-solid fa-right-to-bracket"></i> ${tr('clock_in', 'Clock In')}</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function renderPastShifts() {
    const past = allShifts.filter(s => s.status === 'completed' || s.status === 'cancelled');
    if (past.length === 0) {
        pastShiftsBody.innerHTML = '<div class="empty-state"><i class="fa-solid fa-calendar"></i><p>No past shifts</p></div>';
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

async function fetchShifts() {
    try {
        const data = await api.get('/kitchen-staff/shifts');
        if (data.success) {
            allShifts = data.shifts || [];
            renderAll();
        }
    } catch (err) {
        console.error('Failed to load shifts:', err);
    }
}

async function fetchCurrentShift() {
    try {
        const data = await api.get('/kitchen-staff/shifts/current');
        if (data.success) {
            currentShift = data.shift || null;
            renderCurrentShift();
        }
    } catch (err) {
        console.error('Failed to load current shift:', err);
    }
}

window.clockIn = async function (shiftId) {
    try {
        await api.patch(`/kitchen-staff/shifts/${shiftId}/clock-in`);
        showToast('Clocked in successfully');
        await Promise.all([fetchShifts(), fetchCurrentShift()]);
    } catch (err) {
        console.error('Clock in error:', err);
        showToast('Failed to clock in', 'error');
    }
};

window.clockOut = async function (shiftId) {
    try {
        await api.patch(`/kitchen-staff/shifts/${shiftId}/clock-out`);
        showToast('Clocked out successfully');
        await Promise.all([fetchShifts(), fetchCurrentShift()]);
    } catch (err) {
        console.error('Clock out error:', err);
        showToast('Failed to clock out', 'error');
    }
};

async function refresh() {
    await Promise.all([fetchShifts(), fetchCurrentShift()]);
}

refresh();
pollInterval = setInterval(refresh, 60000);
