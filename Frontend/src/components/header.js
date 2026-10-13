/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - HEADER COMPONENT
 * ================================================================
 * Pure UI Component - Renders the main header/navigation bar.
 * Receives data via parameters, no internal logic.
 * ================================================================
 */

/**
 * Create header HTML
 * @param {Object} options - Header configuration
 * @param {string} options.logoText - Logo text
 * @param {string} options.logoIcon - Logo icon class
 * @param {Array} options.navLinks - Navigation links [{ label, href, active }]
 * @param {Object} options.user - User data { name, role, avatar }
 * @param {boolean} options.isLoggedIn - Login status
 * @param {string} options.theme - 'light' or 'dark'
 * @param {string} options.language - 'en' or 'am'
 * @param {number} options.cartCount - Items in cart
 * @param {number} options.notificationCount - Unread notifications
 * @param {Object} options.authButtons - { loginLabel, registerLabel, loginHref, registerHref }
 * @param {Function} options.onToggleMenu - Mobile menu toggle callback
 * @param {Function} options.onToggleTheme - Theme toggle callback
 * @param {Function} options.onToggleLanguage - Language toggle callback
 * @param {Function} options.onLogout - Logout callback
 * @param {Function} options.onNotificationClick - Notification bell click callback
 * @returns {string} Header HTML
 */
export function createHeader(options = {}) {
    // ---- Defaults ----
    const {
        logoText = 'SmartCafeteria',
        logoIcon = 'fas fa-utensils',
        navLinks = [],
        user = null,
        isLoggedIn = false,
        theme = 'light',
        language = 'en',
        cartCount = 0,
        notificationCount = 0,
        authButtons = {
            loginLabel: 'Login',
            registerLabel: 'Register',
            loginHref: '/src/pages/common/login.html',
            registerHref: '/src/pages/common/register.html',
        },
        onLogout = null,
    } = options;

    // Store the callback so a single document-level listener can handle
    // logout no matter how the header HTML was injected (createHeader alone
    // cannot attach event listeners to its returned string).
    if (typeof window !== 'undefined') {
        window.__scosHeaderOnLogout = typeof onLogout === 'function' ? onLogout : null;
    }

    // ---- Build Nav Links ----
    const navLinksHTML = navLinks.map((link) => `
        <a href="${link.href}" class="${link.active ? 'active' : ''}">
            ${link.label}
        </a>
    `).join('');

    // ---- User Section ----
    let userSectionHTML = '';
    if (isLoggedIn && user) {
        const roleLabels = {
            admin: 'Admin',
            kitchen: 'Kitchen Staff',
            customer: 'Customer',
        };
        const roleLabel = roleLabels[user.role] || user.role || 'User';
        const initial = (user.name || 'U').charAt(0).toUpperCase();
        const avatarHTML = user.avatar
            ? `<img src="${user.avatar}" alt="${user.name}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`
            : initial;

        userSectionHTML = `
            <div class="user-menu" style="display:flex; align-items:center; gap:12px;">
                <button class="notification-btn" id="notificationBell" title="Notifications" style="position:relative; background:none; border:none; font-size:20px; color:#64748b; cursor:pointer; padding:8px; border-radius:50%;">
                    <i class="fas fa-bell"></i>
                    ${notificationCount > 0 ? `<span class="dot" style="position:absolute; top:4px; right:4px; width:8px; height:8px; background:#dc2626; border-radius:50%; border:2px solid white;"></span>` : ''}
                </button>

                <div class="admin-profile" style="display:flex; align-items:center; gap:8px; padding:4px 8px; border-radius:8px;">
                    <div class="avatar" style="width:36px; height:36px; border-radius:50%; background:#2563eb; color:white; display:flex; align-items:center; justify-content:center; font-weight:600; font-size:14px; overflow:hidden;">
                        ${avatarHTML}
                    </div>
                    <div style="text-align:left; line-height:1.3;">
                        <div style="font-weight:600; font-size:14px; color:#1e293b;">${user.name}</div>
                        <div style="font-size:11px; color:#64748b;">${roleLabel}</div>
                    </div>
                    <button class="logout-btn" id="headerLogoutBtn" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:16px; padding:4px;" title="Logout">
                        <i class="fas fa-sign-out-alt"></i>
                    </button>
                </div>
            </div>
        `;
    } else {
        userSectionHTML = `
            <div class="auth-buttons" style="display:flex; gap:8px;">
                <a href="${authButtons.loginHref}" class="btn btn-outline">${authButtons.loginLabel}</a>
                <a href="${authButtons.registerHref}" class="btn btn-primary">${authButtons.registerLabel}</a>
            </div>
        `;
    }

    // ---- Cart Icon ----
    const cartHTML = `
        <a href="/src/pages/customer/cart.html" class="cart-icon" style="position:relative; color:#64748b; font-size:20px; text-decoration:none; padding:4px;">
            <i class="fas fa-shopping-cart"></i>
            ${cartCount > 0 ? `<span style="position:absolute; top:-6px; right:-8px; background:#dc2626; color:white; font-size:10px; font-weight:700; width:20px; height:20px; border-radius:50%; display:flex; align-items:center; justify-content:center;">${cartCount}</span>` : ''}
        </a>
    `;

    // ---- Theme Toggle ----
    const themeIcon = theme === 'dark' ? 'fa-sun' : 'fa-moon';
    const themeLabel = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
    const currentLang = (typeof localStorage !== 'undefined' && (localStorage.getItem('scos_language') || localStorage.getItem('cafeteria_language'))) || language || 'en';

    // ---- Language Switcher (English / Amharic) - immediate switch without refresh, persisted in localStorage ----
    const langSwitcherHTML = `
        <div class="lang-switcher-widget" style="display:inline-flex;align-items:center;gap:6px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:3px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            <i class="fa-solid fa-globe" style="color:#2563eb;font-size:13px;"></i>
            <select class="scos-lang-select" aria-label="Language Selector" style="background:transparent;color:#0f172a;border:none;font-weight:700;cursor:pointer;font-size:13px;outline:none;min-width:110px;">
                <option value="en" ${currentLang==='en'?'selected':''}>🇬🇧 English</option>
                <option value="am" ${currentLang==='am'?'selected':''}>🇪🇹 አማርኛ</option>
            </select>
        </div>`;

    // ---- Build Header ----
    return `
        <header class="header" style="background:#ffffff; padding:12px 0; position:sticky; top:0; z-index:100; border-bottom:1px solid #e2e8f0;">
            <div class="container" style="display:flex; justify-content:space-between; align-items:center; max-width:1280px; margin:0 auto; padding:0 16px;">

                <!-- Logo -->
                <a href="/index.html" class="logo" style="display:flex; align-items:center; gap:10px; font-size:22px; font-weight:700; color:#2563eb; text-decoration:none;">
                    <i class="${logoIcon}"></i>
                    <span style="color:#1e293b;">${logoText}</span>
                </a>

                <!-- Mobile Menu Toggle -->
                <button class="menu-toggle" id="menuToggle" aria-label="Toggle navigation" style="display:none; font-size:24px; background:none; border:none; color:#1e293b; cursor:pointer; padding:4px;">
                    <i class="fas fa-bars"></i>
                </button>

                <!-- Navigation -->
                <nav class="nav" id="mainNav" style="display:flex; align-items:center; gap:24px;">
                    ${navLinksHTML}

                    <!-- Language Switcher -->
                    ${langSwitcherHTML}

                    <!-- Theme Toggle -->
                    <button class="theme-toggle" id="themeToggle" title="${themeLabel}" style="background:none; border:none; cursor:pointer; font-size:18px; color:#64748b; padding:4px; border-radius:50%;">
                        <i class="fas ${themeIcon}"></i>
                    </button>

                    <!-- Cart -->
                    ${cartHTML}

                    <!-- User Section -->
                    ${userSectionHTML}
                </nav>
            </div>
        </header>
    `;
}

/**
 * Render header to a container element and bind the logout button.
 * @param {string|Element} container - Container selector or element
 * @param {Object} options - Same as createHeader options
 */
export function renderHeader(container, options = {}) {
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    if (!el) {
        console.warn('Header container not found');
        return;
    }
    el.innerHTML = createHeader(options);

    // Logout is handled by the document-level delegation set up below,
    // which reads window.__scosHeaderOnLogout (set by createHeader).

    // Bind language switcher - immediate without refresh, persisted in localStorage, centralized via i18n.js
    const langSelect = el.querySelector('.scos-lang-select');
    if (langSelect) {
        // Sync with current language
        try {
            const cur = localStorage.getItem('scos_language') || localStorage.getItem('cafeteria_language') || 'en';
            langSelect.value = cur === 'am' ? 'am' : 'en';
        } catch (_) {}
        if (!langSelect.dataset.i18nBound) {
            langSelect.dataset.i18nBound = '1';
            langSelect.addEventListener('change', function(e) {
                const lang = e.target.value;
                if (window.setLanguage) window.setLanguage(lang);
                else {
                    try { localStorage.setItem('scos_language', lang); localStorage.setItem('cafeteria_language', lang); } catch(_){}
                    if (window.applyTranslations) window.applyTranslations();
                }
            });
        }
    }
    // Ensure global i18n also handles it
    if (window.applyTranslations) setTimeout(() => window.applyTranslations(), 0);
}

// ---- Document-level logout delegation ----
// Works for pages that inject the header via createHeader() + insertAdjacentHTML
// without ever calling renderHeader().
if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
        const btn = e.target && e.target.closest ? e.target.closest('#headerLogoutBtn') : null;
        if (!btn) return;
        e.preventDefault();
        const custom = window.__scosHeaderOnLogout;
        if (typeof custom === 'function') {
            custom(e);
            return;
        }
        // Default logout behaviour
        if (!confirm('Are you sure you want to log out?')) return;
        try {
            ['auth_token', 'current_user', 'role', 'userRole', 'userName', 'name',
             'isLoggedIn', 'userProfile', 'latestOrder', 'adminLoggedIn',
             'customerLoggedIn', 'kitchenLoggedIn', 'cashierLoggedIn',
             'deliveryLoggedIn', 'managerLoggedIn'].forEach(function (k) {
                localStorage.removeItem(k);
            });
        } catch (_) {}
        window.location.href = '../common/login.html';
    });
}

export default {
    createHeader,
    renderHeader,
};
