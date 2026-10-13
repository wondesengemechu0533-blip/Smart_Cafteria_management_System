import authService from "../services/auth.service.js";
import { Storage } from "../js/utils/storage.js";
const STORAGE_KEYS = window.STORAGE_KEYS || { cart: 'smart_cafeteria_cart' };

/**
 * Top Navigation Bar Component
 */
function resolveUserProfile() {
    // Prefer authService's canonical session, fall back to userProfile so the
    // navbar reflects profile updates saved under either key.
    const current = authService.getCurrentUser();
    if (current) return current;
    try {
        const fallback = JSON.parse(localStorage.getItem("userProfile") || "null");
        return fallback;
    } catch (e) {
        return null;
    }
}

export function renderNavbar(containerId = "navbar-container") {
    const container = document.getElementById(containerId);
    if (!container) return;

    const isLoggedIn = localStorage.getItem("isLoggedIn") === "true" || Boolean(authService.isAuthenticated());
    const user = isLoggedIn ? resolveUserProfile() : null;
    const cart = Storage.get(STORAGE_KEYS.cart, []);
    const cartCount = cart.reduce((sum, item) => sum + (item.qty || 1), 0);

    const userName = user?.name || "User";
    const userNavHtml = user ? `
        <span class="user-greeting">Hello, <strong>${userName}</strong></span>
        <button id="logoutBtn" class="nav-btn btn-logout">Logout</button>
    ` : `
        <a href="../common/login.html" class="nav-btn">Login</a>
        <a href="../common/register.html" class="nav-btn btn-primary">Register</a>
    `;

    container.innerHTML = `
        <nav class="main-navbar">
            <div class="nav-brand">
                <a href="../common/index.html">
                    <img src="../../public/assets/images/logo.png" alt="Logo" class="nav-logo" onerror="this.style.display='none'">
                    <span>Smart Cafeteria</span>
                </a>
            </div>
            <div class="nav-links">
                <a href="../customer/menu.html">Menu</a>
                <a href="../customer/order-tracking.html">Track Order</a>
                <a href="../customer/cart.html" class="cart-link">
                    <i class="fa-solid fa-cart-shopping"></i> Cart <span class="cart-badge">${cartCount}</span>
                </a>
            </div>
            <div class="nav-auth">
                ${userNavHtml}
            </div>
        </nav>
    `;

    // Bind Logout event
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", async () => {
            try {
                await authService.logout();
            } catch (e) {
                console.warn("Logout failed:", e.message);
            }
            ["isLoggedIn", "userProfile", "adminLoggedIn", "customerLoggedIn",
             "managerLoggedIn", "kitchenLoggedIn", "cashierLoggedIn",
             "deliveryLoggedIn", "auth_token"].forEach((k) => localStorage.removeItem(k));
            window.location.href = "../common/login.html";
        });
    }
}