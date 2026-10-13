/**
 * ================================================================
 * SMART CAFETERIA - UNIFIED HEADER ENHANCER
 * ================================================================
 * Normalises the top-right controls of the customer and kitchen
 * navigation bars while preserving page-specific items (cart, search,
 * back buttons, etc.).
 *
 * The language switcher is injected centrally by js/utils/i18n.js
 * (ensureSwitcherInjected), and the theme toggle is handled by
 * js/theme.js, so this module only makes sure logout clears the
 * session.
 *
 * Include this module (type="module") on any customer/kitchen page:
 *   <script type="module" src="../../js/components/unified-header.js"></script>
 * ================================================================
 */
import { populateUserUI } from '../profile-ui.js';

(function () {
  'use strict';

  function ensureLogoutClearsSession() {
    document.querySelectorAll('a.nav-logout, a.logout, a.logout-link, a.logout-btn, .kds-logout-btn').forEach(function (anchor) {
      if (anchor.dataset.unifiedBound) return;
      anchor.dataset.unifiedBound = '1';
      anchor.addEventListener('click', function () {
        // Elements with their own inline onclick (e.g. kitchen logout with
        // confirm()) manage the session themselves — clearing here would
        // wipe the token even when the user cancels the confirm dialog.
        if (anchor.getAttribute('onclick')) return;
        try {
          localStorage.removeItem('isLoggedIn');
          localStorage.removeItem('auth_token');
          localStorage.removeItem('userRole');
          localStorage.removeItem('role');
          localStorage.removeItem('userName');
          localStorage.removeItem('userProfile');
          localStorage.removeItem('adminLoggedIn');
          localStorage.removeItem('current_user');
          localStorage.removeItem('name');
        } catch (err) {}
      });
    });
  }

  function init() {
    ensureLogoutClearsSession();
    // Keep every top-right profile avatar/name in sync with the saved profile
    // (shows the user's uploaded profile image instead of a placeholder).
    try { populateUserUI(); } catch (e) {}
    if (window.ScosTheme) {
      try { window.ScosTheme.refresh(); } catch (e) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.UnifiedHeader = { init: init };
})();