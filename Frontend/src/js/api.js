function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  if (typeof window.getText === 'function') { var r = window.getText(key); if (r && r !== key) return r; }
  return fallback;
}
/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/api.js
 *
 * Central API client.
 */

// Keys that together describe "who is signed in" on the client. On a 401 the
// session is dead, so ALL of them must go: clearing only `auth_token` used to
// leave `role`/`userRole` behind, which meant every page's role guard still
// believed a user was signed in and the page kept firing authenticated
// requests that all answered 401 - the console filled with
// "Failed to load resource ... 401 (Unauthorized)" and never recovered.
const SESSION_STORAGE_KEYS = [
    'auth_token', 'userRole', 'role', 'userProfile', 'current_user',
    'userName', 'name', 'isLoggedIn', 'adminLoggedIn', 'customerLoggedIn',
    'managerLoggedIn', 'kitchenLoggedIn', 'cashierLoggedIn', 'deliveryLoggedIn',
    'taxAuthorityLoggedIn', 'redirect_after_auth'
];

let unauthorizedRedirecting = false;

// HTTP statuses worth repeating for a read-only request. The backend answers
// 503 with { retryable: true } when MongoDB is momentarily unreachable (an
// Atlas replica-set failover, a brief network drop) - that is a transient
// condition, not a broken endpoint.
const RETRYABLE_STATUS = { 502: true, 503: true, 504: true };
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 600;

function clearLocalSession() {
    try {
        SESSION_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch (e) { /* storage unavailable */ }
}

function redirectToLogin() {
    let onLoginPage = false;
    try { onLoginPage = /login\.html$/i.test(window.location.pathname); } catch (e) { /* ignore */ }
    if (onLoginPage || unauthorizedRedirecting) return;
    unauthorizedRedirecting = true;
    try { sessionStorage.setItem('scos_session_expired', '1'); } catch (e) { /* ignore */ }
    // Pages live under src/pages/<area>/, a sibling of common/.
    window.location.href = '../common/login.html';
}

class ApiClient {
    // Exposed so the retry policy is inspectable (and testable) from outside.
    static RETRYABLE_STATUS = RETRYABLE_STATUS;
    static MAX_RETRY_ATTEMPTS = MAX_RETRY_ATTEMPTS;
    static RETRY_BASE_DELAY_MS = RETRY_BASE_DELAY_MS;

    constructor(baseURL) {
        const configured =
            (typeof window.__API_URL === "string" && window.__API_URL) ||
            (typeof window.__API_BASE === "string"
                ? window.__API_BASE + "/api/v1"
                : "");
        this.baseURL =
            baseURL ||
            configured ||
            "http://localhost:5000/api/v1";
        this.defaultTimeout = 15000;
    }

    getToken() {
        return localStorage.getItem("auth_token");
    }

    setToken(token) {
        if (token) {
            localStorage.setItem("auth_token", token);
        }
    }

    removeToken() {
        localStorage.removeItem("auth_token");
    }

    getHeaders(customHeaders = {}, body = null) {
        const token = this.getToken();
        const isFormData = body instanceof FormData;

        const headers = {
            Accept: "application/json",
            ...customHeaders
        };

        // Do not force Content-Type for FormData so browser can set boundary
        if (!isFormData) {
            headers["Content-Type"] = "application/json";
        }

        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }

        return headers;
    }

    async request(endpoint, options = {}) {
        // Transient backend failures (a MongoDB Atlas failover or a brief
        // network drop) come back as 503 with { retryable: true }. The backend
        // has been flagging those for a while, but nothing ever read the flag,
        // so a single blip turned every open dashboard into a wall of failed
        // requests. Read-only requests are now retried automatically with a
        // short backoff before the failure is surfaced to the caller.
        const method = (options.method || "GET").toUpperCase();
        const maxAttempts = ApiClient.isRetryableMethod(method)
            ? ApiClient.MAX_RETRY_ATTEMPTS
            : 1;

        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                return await this._requestOnce(endpoint, options);
            } catch (error) {
                lastError = error;
                if (!ApiClient.shouldRetry(error, attempt, maxAttempts)) throw error;
                await ApiClient.delay(ApiClient.RETRY_BASE_DELAY_MS * attempt);
            }
        }

        throw lastError;
    }

    static isRetryableMethod(method) {
        // Only safe, side-effect-free verbs are replayed: a write must never
        // be sent twice because of a timeout.
        return method === "GET" || method === "HEAD";
    }

    static shouldRetry(error, attempt, maxAttempts) {
        if (!error) return false;
        if (attempt >= maxAttempts) return false;
        // The backend explicitly told us whether this failure is worth
        // repeating; honour that verdict first.
        if (error.retryable === false) return false;
        if (error.retryable === true) return true;
        if (!error.status) return false;
        return Boolean(ApiClient.RETRYABLE_STATUS[error.status]);
    }

    static delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async _requestOnce(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const isAuthEndpoint = /^\/auth\//.test(endpoint);

        const controller = new AbortController();
        const timeout = options.timeout || this.defaultTimeout;

        const timeoutId = setTimeout(() => {
            controller.abort();
        }, timeout);

        try {
            const isFormData = options.body instanceof FormData;

            const fetchOptions = {
                ...options,
                signal: controller.signal,
                headers: this.getHeaders(options.headers || {}, options.body)
            };

            if (
                fetchOptions.body &&
                typeof fetchOptions.body === "object" &&
                !isFormData
            ) {
                fetchOptions.body = JSON.stringify(fetchOptions.body);
            }

            const response = await fetch(url, fetchOptions);

            let data = null;

            const contentType = response.headers.get("content-type");

            if (contentType && contentType.includes("application/json")) {
                data = await response.json();
            } else {
                const text = await response.text();

                try {
                    data = text ? JSON.parse(text) : null;
                } catch {
                    data = text;
                }
            }

            if (!response.ok) {
                const raw =
                    data?.message ||
                    data?.error ||
                    `Request failed with status ${response.status}`;
                const message =
                    typeof window.translateErrorMessage === 'function'
                        ? window.translateErrorMessage(raw, data?.code || data?.errorCode)
                        : raw;

                const error = new Error(message);
                error.status = response.status;
                error.data = data;
                error.rawMessage = raw;
                // Preserve the machine-readable code so callers can react to a
                // specific condition (e.g. DELIVERY_ON_HOLD) instead of
                // string-matching the human message.
                error.code = data?.code || data?.errorCode || null;
                // Carry the backend's own verdict on whether this failure is
                // worth repeating. The backend marks a transient database
                // outage with { retryable: true }; an explicit false wins over
                // the generic status heuristic.
                if (data && data.retryable === false) {
                    error.retryable = false;
                } else {
                    error.retryable =
                        Boolean(data && data.retryable === true) ||
                        Boolean(RETRYABLE_STATUS[response.status]);
                }

                if (response.status === 401) {
                    // The JWT is missing, malformed, expired, or the backend
                    // session lapsed. Drop the whole local session so no page
                    // guard keeps a half-dead login alive, then send the user
                    // back to sign in (mirrors the admin API client). The
                    // sign-in endpoints themselves are exempt: a wrong password
                    // is a normal 401 the form has to render, not a reason to
                    // reload the login page.
                    this.removeToken();
                    clearLocalSession();

                    window.dispatchEvent(
                        new CustomEvent("auth:unauthorized")
                    );

                    if (!isAuthEndpoint) redirectToLogin();
                }

                throw error;
            }

            return data;
        } catch (error) {
            if (error.name === "AbortError") {
                const timeoutMsg = typeof window.translateErrorMessage === 'function'
                    ? window.translateErrorMessage('timeout')
                    : tr("error_timeout", "Request timed out. Please try again.");
                const timeoutError = new Error(timeoutMsg);
                // A timeout is NOT replayed: repeating it would triple the wait
                // before the caller finally hears about it.
                timeoutError.retryable = false;
                throw timeoutError;
            }
            // Network failure (backend down) - provide actionable message
            if (error instanceof TypeError && error.message === "Failed to fetch") {
                // Fallback: try alternate host once before failing
                const altHost = this.baseURL.includes("localhost") ? "http://127.0.0.1:5000/api/v1" : null;
                if (url.startsWith(this.baseURL) && altHost !== this.baseURL && !options._retriedAltHost) {
                    if (!altHost) {
                        const noHost = typeof window.translateErrorMessage === 'function'
                            ? window.translateErrorMessage('network')
                            : tr("error_connect", "Could not connect to backend server.");
                        const noHostError = new Error(noHost);
                        noHostError.retryable = true;
                        throw noHostError;
                    }
                    try {
                        const altUrl = url.replace(this.baseURL, altHost);
                        const altOptions = { ...options, _retriedAltHost: true };
                        // retry via direct fetch to avoid recursion loop on baseURL
                        const altRes = await fetch(altUrl, {
                            ...fetchOptions,
                            signal: controller.signal
                        });
                        // reuse parsing logic
                        let altData = null;
                        const ct = altRes.headers.get("content-type");
                        if (ct && ct.includes("application/json")) altData = await altRes.json();
                        else { const t = await altRes.text(); try { altData = t ? JSON.parse(t) : null; } catch { altData = t; } }
                        if (!altRes.ok) {
                            const rawMsg = altData?.message || altData?.error || `Request failed with status ${altRes.status}`;
                            const localized = typeof window.translateErrorMessage === 'function'
                                ? window.translateErrorMessage(rawMsg, altData?.code || altData?.errorCode)
                                : rawMsg;
                            const e2 = new Error(localized); e2.status = altRes.status; e2.data = altData; e2.rawMessage = rawMsg;
                            e2.retryable = altData && altData.retryable === false
                                ? false
                                : Boolean(altData && altData.retryable === true) || Boolean(RETRYABLE_STATUS[altRes.status]);
                            throw e2;
                        }
                        return altData;
                    } catch {}
                }
                const netMsg = typeof window.translateErrorMessage === 'function'
                    ? window.translateErrorMessage('network')
                    : tr("error_connect_dev", "Could not connect to backend server. Please ensure the backend is running on port 5000.");
                const netError = new Error(netMsg);
                // A backend that is momentarily unreachable comes back; a
                // read-only request is safe to repeat.
                netError.retryable = true;
                throw netError;
            }

            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    get(endpoint, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: "GET"
        });
    }

    post(endpoint, body = null, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: "POST",
            body
        });
    }

    put(endpoint, body = null, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: "PUT",
            body
        });
    }

    patch(endpoint, body = null, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: "PATCH",
            body
        });
    }

    delete(endpoint, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: "DELETE"
        });
    }

    upload(endpoint, formData, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: "POST",
            body: formData
        });
    }
}

const api = new ApiClient();

export default api;
export { ApiClient };
export const API_BASE_URL = window.__API_URL || (window.__API_BASE + '/api/v1');