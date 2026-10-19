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
                throw new Error(timeoutMsg);
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
                        throw new Error(noHost);
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
                            const e2 = new Error(localized); e2.status = altRes.status; e2.data = altData; e2.rawMessage = rawMsg; throw e2;
                        }
                        return altData;
                    } catch {}
                }
                const netMsg = typeof window.translateErrorMessage === 'function'
                    ? window.translateErrorMessage('network')
                    : tr("error_connect_dev", "Could not connect to backend server. Please ensure the backend is running on port 5000.");
                throw new Error(netMsg);
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