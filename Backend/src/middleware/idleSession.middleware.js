/**
 * Idle-session (inactivity) enforcement for authenticated staff requests.
 *
 * The frontend performs a 10-minute inactivity countdown and logs the user
 * out with a warning; this backend guard is the non-UI enforcement so that
 * a "back dooring" client that ignores the UI idle timer still gets a 401
 * after the same inactivity window.
 *
 * Timeout source (in precedence order):
 *   SESSION_IDLE_TIMEOUT_MINUTES env  -> Settings.session_timeout_minutes
 * OriginManager keeps a per-user in-memory last-active timestamp. The map is
 * bounded by sessions currently alive; stale entries expire after 2x timeout.
 */
const { ALL_STAFF_ROLES } = require('../config/roles');

const activeSessions = new Map();
let timeoutMinutes = Math.max(parseInt(process.env.SESSION_IDLE_TIMEOUT_MINUTES || '10', 10) || 10, 1);

function refreshTimeout() {
  const envValue = Math.max(parseInt(process.env.SESSION_IDLE_TIMEOUT_MINUTES || '', 10) || 0, 0);
  if (envValue > 0) {
    timeoutMinutes = envValue;
    return;
  }
  // Fallback to the runtime setting when the env var is not set.
  const { getSettingsMap } = require('../utils/settings');
  getSettingsMap()
    .then((settings) => {
      const value = Number(settings.session_timeout_minutes ?? 10);
      timeoutMinutes = Math.max(Number.isFinite(value) && value > 0 ? value : 10, 1);
    })
    .catch(() => {});
}

// Refresh from settings once at boot; env overrides each call.
refreshTimeout();
setInterval(refreshTimeout, 60 * 1000);

/**
 * Mark an authenticated request as "recent" and, if the window has lapsed,
 * reject it. Only staff roles are enforced; customer browsing (menus, carts)
 * is deliberately left free of idle expirations.
 */
const idleSessionGuard = (req, res, next) => {
  if (!req.user || !req.user.id) return next();
  if (!ALL_STAFF_ROLES.includes(String(req.user.role).toLowerCase())) return next();

  const id = String(req.user.id);
  const now = Date.now();
  const lastActive = activeSessions.get(id);

  if (lastActive && now - lastActive > timeoutMinutes * 60 * 1000) {
    activeSessions.delete(id);
    return res.status(401).json({
      success: false,
      error: 'Session timed out due to inactivity. Please sign in again.',
      code: 'SESSION_IDLE_TIMEOUT',
    });
  }

  activeSessions.set(id, now);

  // Bound memory: drop stale entries periodically.
  if (activeSessions.size > 5000) {
    for (const [key, ts] of activeSessions) {
      if (now - ts > timeoutMinutes * 2 * 60 * 1000) activeSessions.delete(key);
    }
  }

  next();
};

module.exports = { idleSessionGuard, activeSessions, refreshTimeout };
