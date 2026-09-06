/**
 * Smart Cafeteria Ordering System
 * File: Frontend/src/js/customer-menu.js
 *
 * Loads menu items from the backend API (/api/v1/menu) and renders
 * them into the customer menu page from the backend database.
 */

import api from "./api.js";

const CUSTOMER_MENU = {

    CART_KEY: "smart_cafeteria_cart",

    // Database category values mapped onto the static filter pills
    CATEGORY_ALIASES: {
        "mains": "main-meals",
        "main-meals": "main-meals",
        "lunch": "main-meals",
        "dinner": "main-meals",
        "breakfast": "breakfast",
        "fasting": "fasting",
        "beverages": "beverages",
        "drinks": "beverages",
        "snacks": "snacks"
    },

    PLACEHOLDER_IMAGE:
        "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='100%' height='100%' fill='%23f1f5f9'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='%2364748b' font-size='16'>Food Item</text></svg>"

};


document.addEventListener("DOMContentLoaded", function () {

    const grid =
        document.getElementById("food-grid-container");

    const resultsCount =
        document.getElementById("results-count");

    const noResults =
        document.getElementById("no-results");


    // =========================================================
    // HELPERS
    // =========================================================

    function escapeHTML(value) {

        if (value === null || value === undefined) {
            return "";
        }

        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }


    function resolveImage(image) {

        if (!image) {
            return "";
        }

        const value = String(image);

        if (
            value.startsWith("http://") ||
            value.startsWith("https://") ||
            value.startsWith("data:")
        ) {
            return value;
        }

        // Backend upload paths (e.g., "/uploads/menu/...") - serve from backend
        if (value.startsWith("/uploads/")) {
            return window.__API_BASE + value;
        }

        // Local folder images: map "/assets/..." to "/public/assets/..."
        // so they always load from the frontend folder (no backend needed).
        if (value.startsWith("/assets/")) {
            return "/public" + value;
        }

        // Relative paths ("assets/..." or plain paths) also point to the folder
        if (value.startsWith("/") === false) {
            return "/public/" + value.replace(/^\.?\//, "");
        }

        return value;
    }


    function mapCategory(category) {

        const key = String(category || "")
            .toLowerCase()
            .trim();

        return CUSTOMER_MENU.CATEGORY_ALIASES[key] || key;
    }


    function isUnavailable(item) {

        return item.availability === false ||
            item.isAvailable === false;
    }

    function getLang() {
        try { return localStorage.getItem("scos_language") || localStorage.getItem("cafeteria_language") || "en"; } catch(e){ return "en"; }
    }
    function t(key) {
        const L = {
            en: { available: "Available", notAvailable: "Not Available", unavailable: "Unavailable", add: "Add", viewDetails: "View Details", browse: "Browse" },
            am: { available: "ይገኛል", notAvailable: "አይገኝም", unavailable: "አይገኝም", add: "ጨምር", viewDetails: "ዝርዝር ይመልከቱ", browse: "ምግቦችን ይመልከቱ" }
        };
        const lang = getLang();
        return (L[lang] && L[lang][key]) || (L.en[key] || key);
    }

    function isUserLoggedIn() {
        return localStorage.getItem("isLoggedIn") === "true" ||
            Boolean(localStorage.getItem("auth_token"));
    }

    function showLoginRequiredModal() {
        if (document.getElementById("login-required-modal")) return;

        // Preserve the page the user was on so they can return to order after
        // registering/logging in.
        try {
            localStorage.setItem("redirect_after_auth", window.location.pathname + window.location.search);
        } catch (e) {}

        const lang = getLang();
        const isAm = lang === "am";
        const title = isAm ? "እባክዎ ይመዝገቡ ወይም ይግቡ" : "Please register or log in to order";
        const message = isAm ? "እቃ ለማዘዝ መግባት ያስፈልግዎታል።" : "You need to log in to add items to your cart and place orders.";
        const loginText = isAm ? "ግባ" : "Login";
        const registerText = isAm ? "ተመዝገብ" : "Register";

        const modal = document.createElement("div");
        modal.id = "login-required-modal";
        modal.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;";
        modal.innerHTML = `
            <div style="background:#ffffff;color:#0f172a;border-radius:16px;max-width:420px;width:100%;padding:32px 28px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:'Poppins',sans-serif;">
                <div style="font-size:3rem;margin-bottom:12px;">🔒</div>
                <h3 style="margin:0 0 10px;font-size:1.35rem;font-weight:700;color:#0f172a;">${title}</h3>
                <p style="margin:0 0 24px;font-size:0.95rem;color:#475569;line-height:1.5;">${message}</p>
                <div style="display:flex;flex-direction:column;gap:10px;">
                    <a href="../common/register.html" id="login-required-register-btn" style="display:block;width:100%;padding:12px;border-radius:10px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#ffffff;text-decoration:none;font-weight:600;font-size:0.95rem;text-align:center;">${registerText} →</a>
                    <a href="../common/login.html" style="display:block;width:100%;padding:12px;border-radius:10px;background:transparent;color:#2563eb;border:2px solid #2563eb;text-decoration:none;font-weight:600;font-size:0.95rem;text-align:center;box-sizing:border-box;">${loginText}</a>
                    <button type="button" id="login-required-close" style="margin-top:6px;border:none;background:none;color:#64748b;cursor:pointer;font-size:0.85rem;text-decoration:underline;padding:6px;">Close</button>
                </div>
            </div>`;

        document.body.appendChild(modal);

        const close = document.getElementById("login-required-close");
        if (close) {
            close.addEventListener("click", function () {
                modal.remove();
            });
        }
        modal.addEventListener("click", function (e) {
            if (e.target === modal) modal.remove();
        });
    }


    // =========================================================
    // RENDER
    // =========================================================

    function renderMenu(items) {

        if (!grid) {
            return;
        }

        if (!items.length) {

            grid.innerHTML = "";

            if (noResults) {
                noResults.classList.remove("hidden");
            }

            triggerAllFilter();

            return;
        }


        const cardsHTML = items.map(function (item) {

            const id =
                escapeHTML(item.id);

            const lang = getLang();
            const name =
                escapeHTML(item.name?.[lang] || item.name?.en || item.name?.am || "");

            const description =
                escapeHTML(item.description?.[lang] || item.description?.en || "");

            const price =
                Number(item.price) || 0;

            const category =
                mapCategory(item.category);

            const image =
                escapeHTML(resolveImage(item.image));

            const displayTitle = name;

            const unavailable =
                isUnavailable(item);

            const cardClass =
                unavailable
                    ? "food-card is-unavailable"
                    : "food-card";

            const statusHTML =
                unavailable
                    ? `
                    <span class="status-stock out-of-stock">
                        <i class="fa-solid fa-circle-xmark"></i>
                        ${t("notAvailable")}
                    </span>`
                    : `
                    <span class="status-stock in-stock">
                        <i class="fa-solid fa-circle-check"></i>
                        ${t("available")}
                    </span>`;

            const addButtonHTML =
                unavailable
                    ? `
                        <button
                            type="button"
                            class="btn btn-primary add-to-cart-btn"
                            disabled
                            aria-disabled="true"
                            aria-label="Currently unavailable"
                            title="Currently unavailable">

                            <i class="fa-solid fa-circle-minus"></i>
                            ${t("unavailable")}

                        </button>`
                    : `
                        <button
                            type="button"
                            class="btn btn-primary add-to-cart-btn"
                            data-id="${id}"
                            data-name="${name}"
                            data-price="${price}"
                            data-image="${image}">

                            <i class="fa-solid fa-plus"></i>
                            ${t("add")}

                        </button>`;

            return `
            <article class="${cardClass}"
                     data-category="${category}"
                     data-id="${id}">

                <div class="food-card-image">

                    <img
                        src="${image || CUSTOMER_MENU.PLACEHOLDER_IMAGE}"
                        alt="${name}"
                        loading="lazy"
                        onerror="this.onerror=null;this.src='${CUSTOMER_MENU.PLACEHOLDER_IMAGE}'"
                    >

                </div>

                <div class="food-card-body">

                    <div class="food-header">

                        <h3 class="food-title">
                            ${displayTitle}
                        </h3>

                        <span class="food-price">
                            ${price} <small>ብር</small>
                        </span>

                    </div>

                    <p class="food-description">
                        ${description || "Delicious item from our kitchen."}
                    </p>

                    <div class="food-card-footer">

                        ${statusHTML}

                        <div class="card-actions">

                            <a href="food-details.html?id=${id}"
                               class="btn btn-icon-secondary"
                               title="View Details">

                                <i class="fa-solid fa-eye"></i>

                            </a>

                            ${addButtonHTML}

                        </div>

                    </div>

                </div>

            </article>`;

        }).join("");


        grid.innerHTML = cardsHTML;

        if (noResults) {
            noResults.classList.add("hidden");
        }

        triggerAllFilter();
    }


    function triggerAllFilter() {

        const allButton =
            document.querySelector(
                '.category-pill[data-category="all"]'
            );

        // Re-runs menu.js filterMenu() against the now-rendered
        // cards so results count + empty state stay in sync.
        if (allButton) {
            allButton.click();
        }
    }


    // =========================================================
    // LOADING / ERROR STATES
    // =========================================================

    function renderError() {

        if (!grid) {
            return;
        }

        grid.innerHTML = `

            <div class="menu-state menu-error" id="menu-error">

                <i class="fa-solid fa-circle-exclamation"></i>

                <h3>
                    Unable to Load Menu
                </h3>

                <p>
                    We couldn't reach the menu right now.
                    Please check your connection and try again.
                </p>

                <button
                    type="button"
                    class="btn btn-primary"
                    id="menu-retry-btn">

                    <i class="fa-solid fa-rotate-right"></i>
                    Try Again

                </button>

            </div>`;

        if (resultsCount) {
            resultsCount.textContent =
                "Menu unavailable";
        }

        if (noResults) {
            noResults.classList.add("hidden");
        }
    }


    function showLoading() {

        if (resultsCount) {
            resultsCount.textContent =
                "Loading menu...";
        }
    }


    // =========================================================
    // DATA LOADING
    // =========================================================

    async function loadMenu() {

        showLoading();

        // Try to fetch from backend API first
        try {
            const response = await api.get("/menu?limit=100");
            const items = response?.items || response || [];
            if (items.length > 0) {
                renderMenu(items);
                return;
            }
        } catch (apiError) {
            console.warn("Backend API unavailable, trying static fallback:", apiError.message);
        }

        renderError();
    }

    async function loadActiveCategoryFilters() {
        try {
            const response = await api.get("/categories");
            const categories = response.categories || [];
            const activeCategories = categories.filter(category => category.isActive !== false);

            const lang = getLang();

            // Expose category names so menu.js can show the real category name
            // in the results label for admin-created categories.
            const names = {};
            activeCategories.forEach(category => {
                const id = String(category.id).toLowerCase();
                const raw = category.name;
                names[id] = (raw && (raw[lang] || raw.en)) || category.id;
            });
            window.__CUSTOMER_CATEGORY_NAMES = names;

            const container = document.getElementById("category-tabs-container");
            if (!container) return;

            const activeButton = container.querySelector(".category-pill.active");
            const currentActiveId = (activeButton && activeButton.dataset.category) || "all";

            // Remove every pre-rendered pill except the permanent "All" tab,
            // then rebuild all category pills directly from the backend so any
            // category added by an admin automatically shows up here.
            [].slice.call(container.querySelectorAll(".category-pill[data-category]")).forEach(button => {
                if (button.dataset.category === "all") return;
                button.remove();
            });

            activeCategories.forEach(category => {
                const id = String(category.id).toLowerCase();
                const label = names[id] || category.id;
                const icon = category.icon || "🍽️";
                const iconHTML = typeof icon === "string" && (icon.indexOf("fa-") === 0 || icon.indexOf("<") === 0)
                    ? `<i class="${escapeHTML(icon)}"></i>`
                    : `<span>${escapeHTML(icon)}</span>`;

                const button = document.createElement("button");
                button.type = "button";
                button.className = "category-pill";
                button.dataset.category = id;
                button.title = label;
                button.innerHTML = `${iconHTML} ${escapeHTML(label)}`;
                container.appendChild(button);
            });

            // Re-apply the previously selected category (defaults to "All") so
            // the active state and results count stay consistent after rebuild.
            const target = container.querySelector('.category-pill[data-category="' + currentActiveId + '"]') ||
                container.querySelector('.category-pill[data-category="all"]');
            if (target) {
                container.querySelectorAll(".category-pill").forEach(btn => btn.classList.remove("active"));
                target.classList.add("active");
            }
        } catch (error) {
            console.warn("Unable to load category visibility:", error.message);
        }
    }


    // =========================================================
    // EVENTS
    // =========================================================

    document.addEventListener(
        "click",
        function (event) {

            const addButton = event.target.closest(".add-to-cart-btn");
            if (addButton && !addButton.disabled) {
                event.preventDefault();
                // Only this module handles add-to-cart; menu.js also binds a
                // document-level add-to-cart listener, so stop it from firing
                // a second (duplicate) cart insertion.
                event.stopImmediatePropagation();

                if (!isUserLoggedIn()) {
                    try {
                        const pending = {
                            menuItemId: addButton.dataset.id,
                            name: addButton.dataset.name,
                            price: Number(addButton.dataset.price) || 0,
                            image: addButton.dataset.image || "",
                            quantity: 1
                        };
                        localStorage.setItem("pending_order_item", JSON.stringify(pending));
                        localStorage.setItem("redirect_after_auth", window.location.pathname + window.location.search);
                    } catch (e) {}

                    event.preventDefault();
                    window.location.href = "../common/register.html";
                    return;
                }

                const itemId = addButton.dataset.id;
                let cart = [];
                try { cart = JSON.parse(localStorage.getItem(CUSTOMER_MENU.CART_KEY) || "[]"); } catch (e) { cart = []; }
                const existing = cart.find(item => String(item.menuItemId || item.id) === String(itemId));
                if (existing) existing.quantity = Number(existing.quantity || 0) + 1;
                else cart.push({ menuItemId: itemId, name: addButton.dataset.name, price: Number(addButton.dataset.price), image: addButton.dataset.image || "", quantity: 1 });
                localStorage.setItem(CUSTOMER_MENU.CART_KEY, JSON.stringify(cart));
                document.querySelectorAll("#cart-badge-count, #mobile-cart-badge").forEach(badge => {
                    badge.textContent = cart.reduce((total, item) => total + Number(item.quantity || 0), 0);
                });
                const original = addButton.innerHTML;
                addButton.innerHTML = '<i class="fa-solid fa-check"></i> Added';
                addButton.disabled = true;
                setTimeout(() => { addButton.innerHTML = original; addButton.disabled = false; }, 700);
                return;
            }

            const retryButton =
                event.target.closest("#menu-retry-btn");

            if (retryButton) {
                loadMenu();
            }
        }
    );


    // =========================================================
    // INITIAL LOAD + LANGUAGE LISTENER
    // =========================================================

    function updateCartBadges() {
        try {
            const cart = JSON.parse(localStorage.getItem(CUSTOMER_MENU.CART_KEY) || "[]");
            const count = cart.reduce((total, item) => total + Number(item.quantity || 0), 0);
            document.querySelectorAll("#cart-badge-count, #mobile-cart-badge, #navbar-cart-count").forEach(badge => {
                badge.textContent = count;
            });
        } catch (e) {}
    }

    // After a guest clicks "Add" and is sent to register, then logs in, add the
    // item they wanted to the cart automatically so they can complete ordering.
    function processPendingOrderItem() {
        try {
            const pending = JSON.parse(localStorage.getItem("pending_order_item") || "null");
            if (!pending || !isUserLoggedIn()) return;

            let cart = JSON.parse(localStorage.getItem(CUSTOMER_MENU.CART_KEY) || "[]");
            const existing = cart.find(item => String(item.menuItemId || item.id) === String(pending.menuItemId));
            if (existing) {
                existing.quantity = Number(existing.quantity || 0) + Number(pending.quantity || 1);
            } else {
                cart.push(pending);
            }
            localStorage.setItem(CUSTOMER_MENU.CART_KEY, JSON.stringify(cart));
            localStorage.removeItem("pending_order_item");
            localStorage.removeItem("redirect_after_auth");
            document.querySelectorAll("#cart-badge-count, #mobile-cart-badge, #navbar-cart-count").forEach(badge => {
                badge.textContent = cart.reduce((total, item) => total + Number(item.quantity || 0), 0);
            });
        } catch (e) {}
    }

    // Keep the menu header honest for public browsing. Guests see a simple
    // public menu (no fake customer profile / logout). Logged-in customers
    // keep the full header.
    function adaptCustomerHeader() {
        const loggedIn = isUserLoggedIn();

        const profileMenu = document.querySelector(".user-profile-menu");
        const logoutLink = document.querySelector(".nav-logout, .logout-link, a[title='Logout']");

        if (!loggedIn) {
            if (profileMenu) profileMenu.style.display = "none";
            if (logoutLink) logoutLink.style.display = "none";

            // Add Login / Register buttons for guests.
            if (!document.getElementById("guest-auth-links") && document.querySelector(".header-actions")) {
                const guestLinks = document.createElement("div");
                guestLinks.id = "guest-auth-links";
                guestLinks.style.cssText = "display:flex;align-items:center;gap:8px;";
                guestLinks.innerHTML = `
                    <a href="../common/register.html" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;text-decoration:none;font-size:0.85rem;font-weight:600;">Register</a>
                    <a href="../common/login.html" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;border:2px solid #2563eb;color:#2563eb;text-decoration:none;font-size:0.85rem;font-weight:600;">Login</a>`;
                document.querySelector(".header-actions").insertBefore(guestLinks, document.querySelector(".header-actions").firstChild);
            }
        } else {
            if (profileMenu) profileMenu.style.display = "";
            if (logoutLink) logoutLink.style.display = "";
            const guestLinks = document.getElementById("guest-auth-links");
            if (guestLinks) guestLinks.remove();

            // Show the real name instead of the hardcoded placeholder.
            const nameEl = document.querySelector(".user-name");
            const savedName = localStorage.getItem("name") ||
                localStorage.getItem("userName") || "";
            if (nameEl && savedName) {
                nameEl.textContent = savedName;
            }
        }
    }

    loadActiveCategoryFilters();
    loadMenu();
    updateCartBadges();
    processPendingOrderItem();
    adaptCustomerHeader();

    window.addEventListener("language:changed", loadMenu);
    window.addEventListener("languageChanged", loadMenu);
    window.addEventListener("language:changed", loadActiveCategoryFilters);
    window.addEventListener("languageChanged", loadActiveCategoryFilters);
    // Also re-apply cart badge translation after render
    window.addEventListener("language:changed", () => { if (window.applyTranslations) window.applyTranslations(); });

});