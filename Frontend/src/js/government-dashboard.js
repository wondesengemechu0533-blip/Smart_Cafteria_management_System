function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - GOVERNMENT / TAX AUTHORITY DASHBOARD
   ==========================================================================
   Restricted surface for the tax_authority role. Consumes only the two
   government endpoints (both authorize tax_authority + system/cafeteria admin):
     - GET /reports/tax-compliance  (aggregate VAT figures, no PII)
     - GET /reports/revenue         (gross/VAT/income context)
   Every access to /reports/tax-compliance is audit-logged on the backend.
   ========================================================================== */
(function () {
  'use strict';

  var API = window.__API_URL || 'http://localhost:5000/api/v1';
  var ALLOWED = ['tax_authority', 'admin', 'cafeteria_admin'];

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function statusMsg(message, type) {
    var box = document.getElementById('govStatusMsg');
    if (!box) return;
    box.innerHTML = '<div class="alert ' + (type === 'error' ? 'alert-danger' : 'alert-info') + '" style="padding:10px 14px;border-radius:10px;">' + esc(message) + '</div>';
    if (type !== 'error') setTimeout(function () { box.innerHTML = ''; }, 5000);
  }

  function setText(id, prefix, value) {
    var el = document.getElementById(id);
    if (!el) return;
    if (prefix) el.innerHTML = fmt(value) + ' <small>' + prefix + '</small>';
    else el.textContent = value === null || value === undefined ? '0' : String(value);
  }

function api(path) {
  var token = localStorage.getItem('auth_token') || '';
  return fetch(API + path, {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(function (r) {
    return r.json().catch(function () {
      return { success: false, error: tr('error_invalid_response', 'Invalid server response') };
    }).then(function (data) {
      data._status = r.status;
      if (!r.ok) {
        var err = new Error((data.error || data.message || 'Request failed') + ' (' + r.status + ')');
        err.status = r.status;
        throw err;
      }
      if (!data.success) {
        var err2 = new Error(data.error || data.message || 'Request failed');
        err2.status = data._status;
        throw err2;
      }
      return data;
    });
  });
}

  function renderTaxCompliance(report) {
    setText('govGrossSales', 'ETB', report.grossSales);
    setText('govVatCollected', 'ETB', report.vatCollected);
    setText('govTaxableBase', 'ETB', report.taxableBase);
    setText('govTransactionCount', '', report.transactionCount);
    setText('tblGrossSales', '', fmt(report.grossSales));
    setText('tblVatCollected', '', fmt(report.vatCollected));
    setText('tblTaxableBase', '', fmt(report.taxableBase));
    setText('tblTransactionCount', '', String(report.transactionCount));

    var tbody = document.getElementById('govMonthlyTableBody');
    if (!tbody) return;
    if (!report.monthlyBreakdown || !report.monthlyBreakdown.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="table-empty">No VAT data for this period.</td></tr>';
      return;
    }
    var html = '';
    report.monthlyBreakdown.forEach(function (row) {
      html += '<tr>'
        + '<td>' + esc(row.month) + '</td>'
        + '<td>' + fmt(row.grossSales) + '</td>'
        + '<td>' + fmt(row.vatCollected) + '</td>'
        + '</tr>';
    });
    tbody.innerHTML = html;
  }

   function renderRevenue(report) {
     var s = report.summary || {};
     setText('revGross', 'ETB', s.gross);
     setText('revVat', 'ETB', report.totalTaxRemitted != null ? report.totalTaxRemitted : s.vat);
     setText('revNet', 'ETB', report.netCafeteriaIncome);
     setText('revOrders', '', s.orderCount);
    setText('tblRevGross', '', fmt(s.gross));
    setText('tblRevVat', '', fmt(report.totalTaxRemitted != null ? report.totalTaxRemitted : s.vat));
    setText('tblRevNet', '', fmt(report.netCafeteriaIncome));
    setText('tblRevOrders', '', String(s.orderCount));

    var tbody = document.getElementById('govDailyTableBody');
     if (!tbody) return;
     var rows = report.dailyBreakdown || [];
     if (!rows.length) {
       tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No revenue rows yet.</td></tr>';
       return;
     }
     var html = '';
     rows.slice(-14).reverse().forEach(function (row) {
       html += '<tr>'
         + '<td>' + esc(row.date) + '</td>'
         + '<td>' + (row.orders || 0) + '</td>'
         + '<td>' + fmt(row.gross) + '</td>'
         + '<td>' + fmt(row.subtotal) + '</td>'
         + '<td>' + fmt(row.vat) + '</td>'
         + '</tr>';
     });
     tbody.innerHTML = html;
   }

var loading = false;

function loadData(opts) {
     opts = opts || {};
     var silent = opts.silent === true;
     if (loading) return;
     loading = true;

     var refreshBtn = document.getElementById('refreshMetricsBtn');
     var spinIcon = refreshBtn ? refreshBtn.querySelector('i') : null;
     if (!silent) {
       if (refreshBtn) { refreshBtn.classList.add('loading'); refreshBtn.disabled = true; }
       if (spinIcon) { spinIcon.classList.add('fa-spin'); }
     }

     var yearSel = document.getElementById('govYearSelect');
     var y = yearSel && yearSel.value !== 'all' ? yearSel.value : '';
     var tBody = document.getElementById('govMonthlyTableBody');
     var dBody = document.getElementById('govDailyTableBody');
     if (tBody) tBody.innerHTML = '<tr><td colspan="3" class="table-empty">Loading tax compliance report...</td></tr>';
     if (dBody) dBody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading revenue report...</td></tr>';

     var taxPath = '/reports/tax-compliance' + (y ? '?year=' + encodeURIComponent(y) : '');
     var revPath = '/reports/revenue';
     if (y) {
       var startDate = y + '-01-01';
       var endDate = y + '-12-31';
       revPath += '?fromDate=' + encodeURIComponent(startDate) + '&toDate=' + encodeURIComponent(endDate);
     }

     var pending = 2;
     var finish = function() {
       pending -= 1;
       if (pending > 0) return;
       loading = false;
       if (refreshBtn) { refreshBtn.classList.remove('loading'); refreshBtn.disabled = false; }
       if (spinIcon) { spinIcon.classList.remove('fa-spin'); }
     };

     api(taxPath)
       .then(function (data) { renderTaxCompliance(data.report || {}); })
       .catch(function (err) {
         if (tBody) tBody.innerHTML = '<tr><td colspan="3" class="table-empty">' + esc(err.message) + '</td></tr>';
         statusMsg('Tax compliance report unavailable: ' + err.message, 'error');
       })
       .then(finish, finish);

     api(revPath)
       .then(function (data) { renderRevenue(data.report || {}); })
       .catch(function (err) {
         if (dBody) dBody.innerHTML = '<tr><td colspan="5" class="table-empty">' + esc(err.message) + '</td></tr>';
         statusMsg('Revenue report unavailable: ' + err.message, 'error');
       })
       .then(finish, finish);
   }

  function init() {
    // Role guard
    var role = window.ScosRoles ? ScosRoles.getCurrentRole() : '';
    if (ALLOWED.indexOf(role) === -1) {
      window.location.href = '../common/login.html';
      return;
    }

    var name = '';
    try {
      var p = JSON.parse(localStorage.getItem('userProfile') || 'null');
      name = p && p.name ? p.name : '';
    } catch (e) { /* ignore */ }
    var nameEl = document.getElementById('govNameDisplay');
    if (nameEl && name) nameEl.textContent = name;
    var av = document.getElementById('govAvatar');
    if (av && name) av.textContent = name.charAt(0).toUpperCase();

    // Year selector: this year and the previous 4
    var yearSel = document.getElementById('govYearSelect');
    if (yearSel) {
      var current = new Date().getFullYear();
      for (var i = 0; i < 5; i++) {
        var opt = document.createElement('option');
        opt.value = String(current - i);
        opt.textContent = String(current - i);
        yearSel.appendChild(opt);
      }
      yearSel.addEventListener('change', function () { loadData(); });
    }

    var refreshBtn = document.getElementById('refreshMetricsBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { loadData(); });

    var logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn && !logoutBtn.dataset.logoutBound) {
      logoutBtn.dataset.logoutBound = '1';
      logoutBtn.addEventListener('click', function () {
        if (window.confirm(tr('logout_confirm', 'Are you sure you want to log out?'))) {
          if (window.ScosSession) { window.ScosSession.logout(); return; }
          ['auth_token', 'userRole', 'role', 'userProfile', 'current_user', 'isLoggedIn', 'userName', 'name', 'adminLoggedIn', 'taxAuthorityLoggedIn', 'customerLoggedIn'].forEach(function (k) { localStorage.removeItem(k); });
          window.location.href = '../common/login.html';
        }
      });
    }

    loadData({ silent: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();