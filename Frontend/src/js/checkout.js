import api from "./api.js";
import { validateName, validatePhone, validateRequired } from "./utils/validators.js";
import { groupCitiesByRegion, citySubcities, getCityLandmarks, searchLandmarkSuggestions } from "./utils/ethiopia-places.js";
import { createSearchableDropdown } from "./utils/searchable-dropdown.js";
import { composeSubCity, composeDeliveryAddress, buildStructuredDeliveryAddress } from "./utils/delivery-address.js";

function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}


function getLang() {
  try {
    return (window.getCurrentLanguage && window.getCurrentLanguage()) || localStorage.getItem("scos_language") || localStorage.getItem("cafeteria_language") || "en";
  } catch (e) { return "en"; }
}


// Check authentication before loading checkout
const authToken = localStorage.getItem("auth_token");
if (!authToken && localStorage.getItem("isLoggedIn") !== "true") {
    alert(ct("checkout_login_required", getLang() === "am" ? "እባክዎ ለመዘዝ ይግቡ።" : "Please log in to place an order."));
    window.location.href = "../common/login.html";
}

function ct(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}


document.addEventListener("DOMContentLoaded", () => {

    const CART_KEY = "smart_cafeteria_cart";
    const TABLE_SELECTION_KEY = "scos_table_selection";

    const checkoutItemsContainer =
        document.getElementById("checkout-items-list");

    const subtotalElement =
        document.getElementById("checkout-subtotal");

    const serviceFeeElement =
        document.getElementById("checkout-service-fee");

    const totalElement =
        document.getElementById("checkout-total");

    const checkoutForm =
        document.getElementById("checkout-form");

    const orderTypeRadios =
        document.querySelectorAll('input[name="orderType"]');

    const tableNumberGroup =
        document.getElementById("table-number-group");

    const tableNumberInput =
        document.getElementById("table-number");

    function normalizeTableSelection(table) {
        if (!table) return null;
        const tableId = String(table.tableId || table.id || "").trim();
        const tableNumber = String(table.tableNumber || table.table || "").trim();
        if (!tableId && !tableNumber) return null;
        return { tableId, tableNumber };
    }

    function tableSelectionFromParams(tableId, tableNumber) {
        const id = String(tableId || "").trim();
        const number = String(tableNumber || "").trim();
        return normalizeTableSelection({
            tableId: id,
            tableNumber: number || (!/^[a-f\d]{24}$/i.test(id) ? id : "")
        });
    }

    function getTableSelection() {
        try {
            const params = new URLSearchParams(window.location.search);
            const urlTable = tableSelectionFromParams(
                params.get("tableId") || params.get("tid"),
                params.get("table")
            );
            if (urlTable) return urlTable;
        } catch (e) {}
        try {
            const stored = localStorage.getItem(TABLE_SELECTION_KEY) || sessionStorage.getItem(TABLE_SELECTION_KEY);
            const selection = normalizeTableSelection(JSON.parse(stored || "null"));
            if (selection) return selection;
        } catch (e) {}
        try {
            return normalizeTableSelection({ tableNumber: localStorage.getItem("scos_table_number") });
        } catch (e) {
            return null;
        }
    }

    function persistTableSelection(table) {
        const selection = normalizeTableSelection(table);
        if (!selection || !selection.tableId || !selection.tableNumber || selection.tableNumber === "N/A") return;
        const value = JSON.stringify(selection);
        try { localStorage.setItem(TABLE_SELECTION_KEY, value); } catch (e) {}
        try { sessionStorage.setItem(TABLE_SELECTION_KEY, value); } catch (e) {}
        try { localStorage.setItem("scos_table_number", selection.tableNumber); } catch (e) {}
    }

    function updateCheckoutTableBadge(tableNumber) {
        const badge = document.getElementById("checkout-table-badge");
        const number = document.getElementById("checkout-table-number");
        if (!badge || !number || !tableNumber) return;
        number.textContent = "Table " + tableNumber;
        badge.style.display = "flex";
    }

    const initialTableSelection = getTableSelection();
    let verifiedTableSelection = null;
    if (initialTableSelection && tableNumberInput) {
        tableNumberInput.value = initialTableSelection.tableNumber || "";
    }
    if (initialTableSelection && initialTableSelection.tableNumber) {
        updateCheckoutTableBadge(initialTableSelection.tableNumber);
    }


    const deliveryInfoGroup =
        document.getElementById("delivery-info-group");

    const deliveryFeeRow =
        document.getElementById("checkout-delivery-fee-row");

    const deliveryFeeElement =
        document.getElementById("checkout-delivery-fee");

    const paymentCards =
        document.querySelectorAll(".payment-card");

    const radioCards =
        document.querySelectorAll(".radio-card");

    const SERVICE_FEE_DEFAULT = 20;
    let SERVICE_FEE_ETB = SERVICE_FEE_DEFAULT;
    let DELIVERY_FEE_ETB = 30;
    let DELIVERY_ENABLED = true;

    // Live quote from the server. The backend prices the fee from the REAL
    // destination, so whatever it returns is what the customer is charged. The
    // flat setting is only a display fallback while a quote is in flight.
    let deliveryQuote = null;
    let deliveryQuoteInFlight = false;
    let deliveryQuoteToken = 0;
    // Bumped on every cart/order-type change so stale in-flight quotes are ignored.
    function invalidateQuote() {
        deliveryQuoteToken += 1;
        deliveryQuote = null;
    }

    async function loadPublicSettings() {
        try {
            const settingsRes = await api.get("/settings/public");
            const settings = settingsRes.settings || settingsRes || {};
            if (typeof settings.deliveryFee === "number") {
                DELIVERY_FEE_ETB = settings.deliveryFee;
            }
            if (typeof settings.serviceFee === "number") {
                SERVICE_FEE_ETB = settings.serviceFee;
            }
            DELIVERY_ENABLED = settings.deliveryEnabled !== false;
        } catch (error) {
            console.warn("Could not load public settings:", error.message);
        }
    }

    /** The fee to display: the server quote when we have one, else the flat setting. */
    function getDeliveryFee() {
        if (deliveryQuote && typeof deliveryQuote.fee === "number") {
            return deliveryQuote.fee;
        }
        return DELIVERY_FEE_ETB;
    }

    function getDeliveryCoords() {
        const latEl = document.getElementById("delivery-lat");
        const lngEl = document.getElementById("delivery-lng");
        const lat = Number(latEl && latEl.value);
        const lng = Number(lngEl && lngEl.value);
        const valid =
            latEl && lngEl &&
            String(latEl.value).trim() !== "" &&
            String(lngEl.value).trim() !== "" &&
            Number.isFinite(lat) && Number.isFinite(lng) &&
            lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
        return valid ? { latitude: lat, longitude: lng } : null;
    }

    /**
     * Haversine distance in kilometres.
     *
     * Deliberately identical to Backend/src/services/delivery.service.js
     * (haversineKm): same Earth radius, same formula, same lat/lng order. The
     * frontend uses this only to show the customer an immediate figure and to
     * re-quote when the location changes; the backend remains the authority on
     * whether the address is deliverable.
     */
    const EARTH_RADIUS_KM = 6371;
    function haversineKm(a, b) {
        const lat1 = a && Number(a.latitude);
        const lng1 = a && Number(a.longitude);
        const lat2 = b && Number(b.latitude);
        const lng2 = b && Number(b.longitude);
        if (![lat1, lng1, lat2, lng2].every((n) => Number.isFinite(n))) return null;
        if (Math.abs(lat1) > 90 || Math.abs(lat2) > 90 || Math.abs(lng1) > 180 || Math.abs(lng2) > 180) return null;
        const toRad = (deg) => (deg * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const h =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /**
     * The cafeteria the order will be fulfilled from, as reported by the last
     * quote. Falls back to null (address-only) when the quote has no pickup
     * coordinates - never to a hard-coded position.
     */
    function getCafeteriaCoords() {
        const pickup = deliveryQuote && deliveryQuote.pickupLocation;
        const lat = pickup && Number(pickup.latitude);
        const lng = pickup && Number(pickup.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { latitude: lat, longitude: lng };
    }

    /** Straight-line distance cafeteria -> customer, or null when either end is unknown. */
    function getDeliveryDistanceKm() {
        const cafeteria = getCafeteriaCoords();
        const customer = getDeliveryCoords();
        if (!cafeteria || !customer) return null;
        return haversineKm(cafeteria, customer);
    }

    /** Render the live distance line, and flag when it exceeds the allowed range. */
    function renderDeliveryDistance() {
        const el = document.getElementById("delivery-distance");
        if (!el) return;
        const km = getDeliveryDistanceKm();
        const maxKm = deliveryQuote && deliveryQuote.maxDistanceKm;
        if (km == null) {
            el.textContent = "";
            el.style.display = "none";
            return;
        }
        const within = !(maxKm > 0) || km <= maxKm;
        el.style.display = "block";
        el.className = "form-hint delivery-distance " + (within ? "ok" : "bad");
        el.innerHTML =
            `<i class="fa-solid ${within ? "fa-circle-check" : "fa-triangle-exclamation"}"></i> ` +
            `${km.toFixed(2)} km from the cafeteria` +
            (maxKm > 0 ? ` (limit ${maxKm} km)` : "") +
            (within ? "" : " - outside the delivery area");
    }

    /** The current cart subtotal, needed to price free delivery correctly. */
    function getCartSubtotal() {
        const cart = JSON.parse(localStorage.getItem("cart") || "[]");
        return cart.reduce((sum, item) => {
            const qty = Number(item.quantity) || 0;
            const price = Number(item.price) || 0;
            return sum + qty * price;
        }, 0);
    }

    /**
     * Ask the server what this delivery actually costs. Called whenever the
     * destination or cart changes. Never trusted blindly: the response is only
     * used if it is still the newest request.
     */
    async function refreshDeliveryQuote() {
        if (getSelectedOrderType() !== "delivery" || !DELIVERY_ENABLED) {
            invalidateQuote();
            renderOrderReview();
            return;
        }
        const coords = getDeliveryCoords();
        const token = (deliveryQuoteToken += 1);
        const subtotal = getCartSubtotal();
        deliveryQuoteInFlight = true;
        try {
            const res = await api.post("/deliveries/quote", {
                ...(coords || {}),
                subtotal,
            });
            if (token !== deliveryQuoteToken) return; // a newer request won
            deliveryQuote = res;
        } catch (error) {
            if (token !== deliveryQuoteToken) return;
            // Fall back to the flat fee; checkout still works address-only.
            deliveryQuote = null;
            console.warn("Delivery quote unavailable:", error.message);
        } finally {
            if (token === deliveryQuoteToken) {
                deliveryQuoteInFlight = false;
                renderOrderReview();
                renderDeliveryDistance();
            }
        }
    }

    /** True when the server says this destination is too far to deliver to. */
    function isOutOfRange() {
        return !!(deliveryQuote && deliveryQuote.withinRange === false);
    }

    function getSelectedOrderType() {
        const radio = document.querySelector('input[name="orderType"]:checked');
        return radio ? radio.value : "dine-in";
    }

    function updateDeliveryUI() {
        const isDelivery = getSelectedOrderType() === "delivery";
        if (deliveryInfoGroup) {
            deliveryInfoGroup.style.display = isDelivery ? "block" : "none";
        }
        if (deliveryFeeRow) {
            deliveryFeeRow.style.display = isDelivery ? "flex" : "none";
        }
        if (deliveryFeeElement) {
            deliveryFeeElement.textContent = (isDelivery ? getDeliveryFee() : 0).toFixed(2);
        }
        renderOrderReview();
        if (isDelivery) {
            refreshDeliveryQuote();
        } else {
            invalidateQuote();
        }
    }

    // ---- Explicit customer opt-in for sharing their current GPS location ----
    // The browser's location prompt appears AT MOST ONCE, and only because the
    // customer pressed this button. Nothing here runs on page load: viewing or
    // re-viewing the checkout form never asks for location.
    //
    // The four browser outcomes are reported distinctly instead of collapsing
    // into one "error":
    //   1 PERMISSION_DENIED    -> blocked; needs browser site settings + Retry
    //   2 POSITION_UNAVAILABLE -> GPS off / no signal
    //   3 TIMEOUT              -> took too long
    //   (0/other)              -> generic
    // A refused permission is treated as terminal: the button becomes "Try
    // again", the status explains how to allow location in site settings, and
    // the browser is never asked a second time from this page.
    const LOCATION_STATUS = {
        using: (lang) => ct("location_using", lang === "am" ? "በመስጠት ላይ ተጠቀማል። ይህ ለማድረስ ብቻ ይጠቀማል።" : "✓ Using your current location. This is used only for delivery."),
        blocked: (lang) => ct("location_blocked", lang === "am" ? "የአካባቢው ፍቃድ ተከልክሏል። አሳሽዎ በራሱ አይጠይቅም።" : "Location permission denied. Your browser will not ask again on its own."),
        unavailable: (lang) => ct("location_unavailable", lang === "am" ? "ቦታዎን መለየት አልተቻለም። GPS ያለመብት ይሆን ይችላል።" : "Unable to determine your current location. Make sure GPS / location services are switched on."),
        timeout: (lang) => ct("location_timeout", lang === "am" ? "የቦታ ጥያቄው ጊዜው አልፏል። እንደገና ይሞክሩ።" : "Getting your location took too long. Please try again."),
        error: (lang) => ct("location_error", lang === "am" ? "ቦታዎን መለየት አልተቻለም። አድራሻዎን በእጅ ይጻፉ።" : "Could not get your location. Please enter your address manually."),
    };

    // Per-browser "where do I change this" guidance, so a denied customer knows
    // what to actually do instead of being told "permission denied" and nothing
    // else. Derived from the user agent - never from a stored value.
    function permissionSteps() {
        const ua = (navigator && navigator.userAgent) || "";
        let steps;
        if (/Edg\//.test(ua)) {
            steps = "Edge: click the padlock in the address bar → Site permissions → Location → Allow, then Reload.";
        } else if (/OPR\//.test(ua)) {
            steps = "Opera: click the padlock in the address bar → Site settings → Location → Allow, then Reload.";
        } else if (/Firefox\//.test(ua)) {
            steps = "Firefox: click the padlock in the address bar → Clear permission for Location, then Reload.";
        } else if (/Chrome\//.test(ua)) {
            steps = "Chrome: click the lock icon in the address bar → Site settings → Location → Allow, then Reload.";
        } else if (/Safari\//.test(ua)) {
            steps = "Safari: Settings for This Website → Location → Allow, then Reload.";
        } else {
            steps = "Open your browser's site settings for this page, set Location to Allow, then Reload.";
        }
        return ct("location_blocked_steps", steps);
    }

    function setLocationStatus(text, tone) {
        const el = document.getElementById("location-status");
        if (!el) return;
        el.style.display = "block";
        el.textContent = text;
        el.className = "location-status location-status-" + (tone || "err");
    }

    function clearLocationStatus() {
        const el = document.getElementById("location-status");
        if (el) {
            el.style.display = "none";
            el.textContent = "";
        }
    }

    function initLocationPermission() {
        const btnUse = document.getElementById("btn-use-location");
        const btnClear = document.getElementById("btn-clear-location");
        if (!btnUse || !btnClear) return;

        // ---- Permission bookkeeping ----------------------------------------
        // The browser prompt must appear at most once, and only because the
        // customer pressed this button. Two guards:
        //   busy  - a request is already in flight (double tap / slow GPS)
        //   asked - the browser already showed its prompt this page session;
        //            after that we READ the permission instead of asking again
        let busy = false;
        let asked = false;

        // The button's label lives in a nested [data-i18n] span, so only that
        // span's text and the icon's class are touched. Rewriting innerHTML
        // would delete the span and break the Amharic translation.
        const labelEl = btnUse.querySelector("[data-i18n]") || btnUse;
        const iconEl = btnUse.querySelector("i");
        function setButton(mode) {
            if (iconEl) {
                iconEl.className =
                    mode === "busy" ? "fa-solid fa-spinner fa-spin"
                        : mode === "retry" ? "fa-solid fa-rotate-right"
                            : "fa-solid fa-location-crosshairs";
            }
            if (mode === "busy") {
                labelEl.textContent = ct("location_locating", "Locating…");
            } else if (mode === "retry") {
                labelEl.textContent = ct("location_retry", "Try again");
            } else {
                labelEl.textContent = ct("checkout_use_my_location", "Use My Current Location");
            }
        }

        // Querying the permission NEVER shows a prompt.
        async function readPermission() {
            if (typeof navigator === "undefined" || !navigator.permissions ||
                typeof navigator.permissions.query !== "function") {
                return { state: "unknown", known: false };
            }
            try {
                const status = await navigator.permissions.query({ name: "geolocation" });
                return { state: status.state, known: true, status };
            } catch (e) {
                return { state: "unknown", known: false };
            }
        }

        function applyFix(latitude, longitude) {
            const latEl = document.getElementById("delivery-lat");
            const lngEl = document.getElementById("delivery-lng");
            if (latEl) latEl.value = Math.round(latitude * 1e6) / 1e6;
            if (lngEl) lngEl.value = Math.round(longitude * 1e6) / 1e6;
            btnUse.style.display = "none";
            btnClear.style.display = "inline-flex";
            // Real coordinates change the distance-based fee.
            invalidateQuote();
            refreshDeliveryQuote();
            renderDeliveryDistance();
        }

        // A refusal is terminal until the customer changes the site setting.
        // Say so, and never ask the browser again from this page.
        function showBlocked(lang) {
            asked = true;
            setLocationStatus(LOCATION_STATUS.blocked(lang) + " " + permissionSteps(), "err");
            btnUse.style.display = "inline-flex";
            setButton("retry");
        }

        btnUse.addEventListener("click", async () => {
            const lang = getLang();
            // Never fire a second request while one is in flight.
            if (busy) return;
            if (typeof navigator === "undefined" || !navigator.geolocation) {
                setLocationStatus(LOCATION_STATUS.error(lang), "err");
                return;
            }

            // Already asked once this page session and still not granted -> do NOT
            // ask the browser again. Read the permission and explain instead.
            if (asked) {
                const permission = await readPermission();
                if (permission.state === "denied") {
                    showBlocked(lang);
                    return;
                }
            }

            busy = true;
            btnUse.disabled = true;
            setButton("busy");
            try {
                await new Promise((resolve) => {
                    navigator.geolocation.getCurrentPosition(
                        (pos) => {
                            const { latitude, longitude } = pos.coords;
                            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                                setLocationStatus(LOCATION_STATUS.error(lang), "err");
                            } else {
                                setLocationStatus(LOCATION_STATUS.using(lang), "ok");
                                applyFix(latitude, longitude);
                            }
                            resolve();
                        },
                        (err) => {
                            // Exact browser error semantics - no more "generic error":
                            //   1 PERMISSION_DENIED    -> blocked, needs site settings
                            //   2 POSITION_UNAVAILABLE -> GPS off / no signal
                            //   3 TIMEOUT              -> took too long
                            const code = err && err.code;
                            if (code === 1) showBlocked(lang);
                            else if (code === 3) setLocationStatus(LOCATION_STATUS.timeout(lang), "err");
                            else setLocationStatus(LOCATION_STATUS.unavailable(lang), "err");
                            resolve();
                        },
                        // One-shot fix only: the customer is not being tracked.
                        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
                    );
                });
            } catch (e) {
                setLocationStatus(LOCATION_STATUS.error(lang), "err");
            } finally {
                busy = false;
                btnUse.disabled = false;
                asked = true;
                // A success hides the button; a failure leaves it in whatever
                // state showBlocked() set (Try again) or restores the label.
                if (btnUse.style.display !== "none") setButton("default");
            }
        });

        btnClear.addEventListener("click", () => {
            const latEl = document.getElementById("delivery-lat");
            const lngEl = document.getElementById("delivery-lng");
            if (latEl) latEl.value = "";
            if (lngEl) lngEl.value = "";
            btnUse.style.display = "inline-flex";
            btnUse.disabled = false;
            setButton("default");
            btnClear.style.display = "none";
            clearLocationStatus();
            invalidateQuote();
            refreshDeliveryQuote();
            renderDeliveryDistance();
        });
    }

    initLocationPermission();


    function getCart() {

        try {

            const savedCart =
                localStorage.getItem(CART_KEY);

            if (!savedCart) {
                return [];
            }

            const cart =
                JSON.parse(savedCart);

            return Array.isArray(cart)
                ? cart
                : [];

        } catch (error) {

            console.error(
                "Error reading cart:",
                error
            );

            return [];
        }
    }


    // Resolve a cart item's display name preferring, in order:
    // name object { [lang] } -> { en } -> { am } -> plain string -> name_en / name_am.
    function localItemName(item) {
        if (!item) return "";
        const lang = getLang();
        const value = item.name;
        if (value && typeof value === "object") {
            return value[lang] || value.en || value.am || "";
        }
        if (value) {
            return String(value);
        }
        return item.name_en || item.name_am || "";
    }


    function renderOrderReview() {

        const cart = getCart();

        console.log(
            "Checkout cart:",
            cart
        );


        if (!cart.length) {

            alert(
                ct("checkout_cart_empty_return", getLang() === "am" ? "ካርትዎ ባዶ ነው! ወደ ማውጫ በመመለስ ላይ።" : "Your cart is empty! Returning to menu.")
            );

            try {
                var emptyQ = new URLSearchParams();
                if (initialTableSelection && initialTableSelection.tableId) emptyQ.set("tableId", initialTableSelection.tableId);
                if (initialTableSelection && initialTableSelection.tableNumber) emptyQ.set("table", initialTableSelection.tableNumber);
                var emptyQs = emptyQ.toString();
                window.location.href = "menu.html" + (emptyQs ? "?" + emptyQs : "");
            } catch (e) {
                window.location.href = "menu.html";
            }

            return;
        }


        let itemsHTML = "";
        let subtotal = 0;


        cart.forEach((item) => {

            const itemPrice =
                Number(item.price) || 0;

            const quantity =
                Number(item.quantity) || 1;

            const itemTotal =
                itemPrice * quantity;

            subtotal += itemTotal;


            itemsHTML += `
                <div
                    class="checkout-item-row"
                    style="
                        display:flex;
                        justify-content:space-between;
                        margin-bottom:10px;
                        font-size:0.9rem;
                    "
                >

                    <span>
                        <strong>
                            ${quantity}x
                        </strong>

                        ${escapeHTML(localItemName(item))}
                    </span>

                    <span>
                        <strong>
                            ${itemTotal.toFixed(2)}
                        </strong>
                        ETB
                    </span>

                </div>
            `;

        });


        if (checkoutItemsContainer) {

            checkoutItemsContainer.innerHTML =
                itemsHTML;
        }


        const isDelivery =
            getSelectedOrderType() === "delivery";

        const deliveryFee =
            isDelivery ? getDeliveryFee() : 0;

        const total =
            subtotal + SERVICE_FEE_ETB + deliveryFee;


        if (subtotalElement) {

            subtotalElement.textContent =
                subtotal.toFixed(2);
        }


        if (serviceFeeElement) {

            serviceFeeElement.textContent =
                SERVICE_FEE_ETB.toFixed(2);
        }


        if (deliveryFeeElement) {

            deliveryFeeElement.textContent =
                deliveryFee.toFixed(2);
        }


        if (deliveryFeeRow) {

            deliveryFeeRow.style.display =
                isDelivery ? "flex" : "none";
        }


        if (totalElement) {

            totalElement.textContent =
                total.toFixed(2);
        }

    }


    function escapeHTML(value) {

        const div =
            document.createElement("div");

        div.textContent =
            value || "";

        return div.innerHTML;
    }


    orderTypeRadios.forEach((radio) => {

        radio.addEventListener(
            "change",
            async (event) => {

                radioCards.forEach((card) => {
                    card.classList.remove("active");
                });


                const selectedCard =
                    event.target.closest(".radio-card");


                if (selectedCard) {

                    selectedCard.classList.add(
                        "active"
                    );
                }


                if (
                    event.target.value ===
                    "dine-in"
                ) {

                    if (tableNumberGroup) {
                        tableNumberGroup.style.display =
                            "block";
                    }

                    if (tableNumberInput) {
                        tableNumberInput.required =
                            true;
                    }

                } else {

                    if (tableNumberGroup) {
                        tableNumberGroup.style.display =
                            "none";
                    }

                    if (tableNumberInput) {

                        tableNumberInput.required =
                            false;
                    }
                }

                if (
                    event.target.value ===
                    "delivery"
                ) {

                    if (deliveryInfoGroup) {
                        deliveryInfoGroup.style.display =
                            "block";
                    }

                } else {

                    if (deliveryInfoGroup) {
                        deliveryInfoGroup.style.display =
                            "none";
                    }
                }

                updateDeliveryUI();

            }
        );

    });


    const paymentRadios =
        document.querySelectorAll(
            'input[name="paymentMethod"]'
        );


    paymentRadios.forEach((radio) => {

        radio.addEventListener(
            "change",
            async (event) => {

                paymentCards.forEach((card) => {
                    card.classList.remove("active");
                });


                const selectedCard =
                    event.target.closest(
                        ".payment-card"
                    );


                if (selectedCard) {

                    selectedCard.classList.add(
                        "active"
                    );
                }

                // Show Chapa test-mode instructions only when Chapa is selected.
                const chapaTestInfo =
                    document.getElementById(
                        "chapa-test-info"
                    );

                if (chapaTestInfo) {

                    chapaTestInfo.style.display =
                        event.target.value === "CHAPA"
                            ? "block"
                            : "none";
                }

            }
        );

    });


    const placeOrderButton =
        document.getElementById("place-order-btn");

    const mobileOrderButton =
        document.querySelector(".mobile-only-btn");

    // Full-screen processing state shown from the moment Confirm Order is
    // clicked until the app navigates. Guarantees the customer always sees
    // feedback, even when Atlas/Chapa are slow.
    function showProcessingOverlay(orderRef) {
        let overlay = document.getElementById("checkout-processing-overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "checkout-processing-overlay";
            overlay.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,0.78);padding:16px;";
            overlay.innerHTML =
                '<div style="background:#ffffff;color:#0f172a;border-radius:20px;max-width:min(420px,100%);width:100%;padding:36px 30px;text-align:center;box-shadow:0 25px 70px rgba(0,0,0,0.45);">' +
                '<div style="width:72px;height:72px;margin:0 auto 18px;border-radius:50%;background:rgba(37,99,235,0.12);display:flex;align-items:center;justify-content:center;">' +
                '<i class="fa-solid fa-spinner fa-spin" style="color:#2563eb;font-size:2rem;"></i></div>' +
                '<h2 id="cpo-title" style="margin:0 0 8px;font-size:1.35rem;font-weight:700;"></h2>' +
                '<p id="cpo-sub" style="margin:0 0 6px;font-size:0.92rem;color:#475569;line-height:1.6;"></p>' +
                '<p id="cpo-count" style="margin:0 0 10px;font-size:0.85rem;color:#b45309;font-weight:600;line-height:1.5;"></p>' +
                '<p id="cpo-ref" style="margin:0 0 12px;font-size:0.8rem;color:#94a3b8;font-weight:600;"></p>' +
                '<button id="cpo-stay" type="button" style="display:none;margin:0 auto;background:#0f172a;color:#ffffff;border:0;border-radius:10px;padding:10px 18px;font-size:0.85rem;font-weight:600;cursor:pointer;">' +
                "Keep waiting" +
                "</button>" +
                "</div>";
            document.body.appendChild(overlay);
        }
        const isAm = getLang() === "am";
        const title = overlay.querySelector("#cpo-title");
        const sub = overlay.querySelector("#cpo-sub");
        const ref = overlay.querySelector("#cpo-ref");
        if (title) title.textContent = ct("checkout_processing_title", isAm ? "ትዕዛዝዎን በመገንባት ላይ..." : "Placing your order...");
        if (sub) sub.textContent = ct("checkout_processing_sub", isAm ? "እባክዎ ይጠብቁ — ይህን ገጽ አይዝጉ።" : "Please wait — do not close this page.");
        if (ref) ref.textContent = orderRef || "";
        overlay.style.display = "flex";
    }

    function hideProcessingOverlay() {
        const overlay = document.getElementById("checkout-processing-overlay");
        if (overlay) overlay.style.display = "none";
    }

    function savePendingSubmission(record) {
        try {
            localStorage.setItem("scos_pending_order", JSON.stringify({ ...record, submittedAt: Date.now() }));
        } catch (e) {}
    }

    function clearPendingSubmission(clientOrderId) {
        try {
            const raw = localStorage.getItem("scos_pending_order");
            if (!raw) return;
            if (!clientOrderId) {
                localStorage.removeItem("scos_pending_order");
                return;
            }
            const pending = JSON.parse(raw);
            if (pending && pending.clientOrderId === clientOrderId) {
                localStorage.removeItem("scos_pending_order");
            }
        } catch (e) {}
    }

    function requestCheckoutSubmit() {

        if (checkoutForm) {

            if (typeof checkoutForm.requestSubmit === "function") {

                checkoutForm.requestSubmit();

            } else {

                checkoutForm.dispatchEvent(
                    new Event("submit", { cancelable: true })
                );
            }
        }
    }

    [placeOrderButton, mobileOrderButton].forEach((btn) => {

        if (btn) {

            btn.addEventListener("click", function (event) {

                event.preventDefault();

                requestCheckoutSubmit();
            });
        }
    });


    if (checkoutForm) {

        // Guard against a double submit. `POST /orders` performs several
        // sequential database round trips (table lookup, per-item stock
        // reservation, order save, audit log) against a remote MongoDB, so it
        // can take several seconds. Without this guard a customer who clicks
        // "Confirm Order" again while waiting would silently place a SECOND
        // order.
        let isSubmittingOrder = false;
        const submitButtons = Array.from(
            document.querySelectorAll('button[type="submit"]')
        );
        const setSubmitting = (submitting) => {
            isSubmittingOrder = submitting;
            submitButtons.forEach((button) => {
                if (submitting) {
                    button.dataset.originalHtml = button.innerHTML;
                    button.innerHTML =
                        '<i class="fa-solid fa-spinner fa-spin"></i> ' +
                        ct(
                            "checkout_placing_order",
                            getLang() === "am"
                                ? "ትዕዛዝ በመገንባት ላይ..."
                                : "Placing order..."
                        );
                    button.disabled = true;
                } else {
                    if (button.dataset.originalHtml) {
                        button.innerHTML = button.dataset.originalHtml;
                    }
                    button.disabled = false;
                }
            });
        };

        checkoutForm.addEventListener(
            "submit",
            async (event) => {

                event.preventDefault();

                // 5-second navigation budget starts the moment Confirm Order
                // is clicked (covers validation + order + payment phases).
                const submitStart = Date.now();

                if (isSubmittingOrder) return;


                const cart =
                    getCart();


                if (!cart.length) {

                    alert(
                        ct("checkout_cart_empty", getLang() === "am" ? "ካርትዎ ባዶ ነው።" : "Your cart is empty.")
                    );

                    try {
                        var submitQ = new URLSearchParams();
                        if (initialTableSelection && initialTableSelection.tableId) submitQ.set("tableId", initialTableSelection.tableId);
                        if (initialTableSelection && initialTableSelection.tableNumber) submitQ.set("table", initialTableSelection.tableNumber);
                        var submitQs = submitQ.toString();
                        window.location.href = "menu.html" + (submitQs ? "?" + submitQs : "");
                    } catch (e) {
                        window.location.href = "menu.html";
                    }

                    return;
                }


                const selectedOrderType =
                    document.querySelector(
                        'input[name="orderType"]:checked'
                    );


                const selectedPaymentMethod =
                    document.querySelector(
                        'input[name="paymentMethod"]:checked'
                    );


                if (!selectedOrderType) {

                    alert(
                        ct("checkout_select_order_type", getLang() === "am" ? "እባክዎ የትዕዛዝ ዓይነት ይምረጡ።" : "Please select an order type.")
                    );

                    return;
                }


                if (!selectedPaymentMethod) {

                    alert(
                        ct("checkout_select_payment", getLang() === "am" ? "እባክዎ የክፍያ ዘዴ ይምረጡ።" : "Please select a payment method.")
                    );

                    return;
                }


                const orderType =
                    selectedOrderType.value;


                const isDelivery =
                    orderType === "delivery";


                let tableId = null;
                let tableNumber =
                    orderType === "dine-in"
                        ? (tableNumberInput ? tableNumberInput.value.trim() : "")
                        : isDelivery
                            ? "N/A (Delivery)"
                            : "N/A (Takeaway)";


                if (
                    orderType === "dine-in" &&
                    !tableNumber &&
                    !(initialTableSelection && initialTableSelection.tableId)
                ) {

                    alert(
                        ct("checkout_enter_table", getLang() === "am" ? "እባክዎ የጠረጴዛ ቁጥርዎን ያስገቡ።" : "Please enter your table number.")
                    );

                    if (tableNumberInput) {
                        tableNumberInput.focus();
                    }

                    return;
                }

                if (orderType === "dine-in") {
                    const typedTable = tableNumberInput ? tableNumberInput.value.trim() : "";
                    // Skip the server round trip when the typed number matches
                    // a table already verified this session. The backend
                    // re-validates authoritatively at order creation, so a
                    // stale selection can only fail fast with a clear error.
                    const alreadyVerified = [verifiedTableSelection, initialTableSelection].find((sel) =>
                        sel && sel.tableId && sel.tableNumber &&
                        sel.tableNumber.toLowerCase() === typedTable.toLowerCase()
                    );
                    if (alreadyVerified) {
                        tableId = alreadyVerified.tableId;
                        tableNumber = alreadyVerified.tableNumber;
                        if (tableNumberInput) tableNumberInput.value = tableNumber;
                        updateCheckoutTableBadge(tableNumber);
                    } else {
                        // No pre-flight lookup: the backend resolves and
                        // validates the table authoritatively when the order is
                        // created, and its error is surfaced to the customer.
                        tableId = "";
                        tableNumber = typedTable;
                        if (tableNumberInput) tableNumberInput.value = tableNumber;
                        updateCheckoutTableBadge(tableNumber);
                    }
                }


                const customerNameElement =
                    document.getElementById(
                        "customer-name"
                    );


                const customerPhoneElement =
                    document.getElementById(
                        "customer-phone"
                    );


                const customerName =
                    customerNameElement
                        ? customerNameElement.value.trim()
                        : "";


                const customerPhone =
                    customerPhoneElement
                        ? customerPhoneElement.value.trim()
                        : "";

                // Validate name
                const nameValidation = validateName(customerName);
                if (!nameValidation.valid) {
                    alert(nameValidation.error);
                    if (customerNameElement) customerNameElement.focus();
                    return;
                }

                // Validate phone
                const phoneValidation = validatePhone(customerPhone);
                if (!phoneValidation.valid) {
                    alert(phoneValidation.error);
                    if (customerPhoneElement) customerPhoneElement.focus();
                    return;
                }


                let deliveryInfo = null;

                if (isDelivery) {

                    const deliveryHouseNumberElement =
                        document.getElementById("delivery-house-number");

                    const deliveryLocationElement =
                        document.getElementById("delivery-location");

                    const deliveryCity = readCity();
                    const deliveryArea = readArea();

                    const deliveryHouseNumber =
                        deliveryHouseNumberElement
                            ? deliveryHouseNumberElement.value.trim()
                            : "";

                    const deliveryLocation =
                        deliveryLocationElement
                            ? deliveryLocationElement.value.trim()
                            : "";

                    const deliveryLandmarkElement =
                        document.getElementById("delivery-landmark");

                    const deliveryLandmark =
                        deliveryLandmarkElement
                            ? deliveryLandmarkElement.value.trim()
                            : "";

                    if (!deliveryCity) {
                        alert(ct("checkout_select_city", getLang() === "am" ? "ለማድረስ እባክዎ ከተማዎን ይምረጡ።" : "Please select your city for delivery."));
                        focusCityControl();
                        return;
                    }

                    if (!deliveryArea) {
                        alert(ct("checkout_select_area", getLang() === "am" ? "ለማድረስ እባክዎ አካባቢ/ቀበሌዎን ይምረጡ።" : "Please select your area / kebele for delivery."));
                        focusAreaControl();
                        return;
                    }

                    if (!deliveryHouseNumber) {
                        alert(ct("checkout_enter_house", getLang() === "am" ? "እባክዎ የቤት ቁጥርዎን ያስገቡ።" : "Please enter your house number."));
                        if (deliveryHouseNumberElement) deliveryHouseNumberElement.focus();
                        return;
                    }

                    if (!deliveryLocation) {
                        alert(ct("checkout_enter_street", getLang() === "am" ? "እባክዎ የመንገድ/አካባቢ ስምዎን ያስገቡ።" : "Please enter your street / area name."));
                        focusStreetControl();
                        return;
                    }

                    // Only attach coordinates the customer explicitly chose to
                    // share; otherwise delivery is still address-only.
                    //
                    // This MUST match getDeliveryCoords() above. A bare
                    // Number(el.value) is not enough: Number('') === 0, so an
                    // empty field would silently become (0, 0) - a "valid"
                    // coordinate 4,400 km away in the Gulf of Guinea - and the
                    // order would be rejected as out of range even though the
                    // customer never shared a location.
                    const coords = getDeliveryCoords();
                    const hasValidCoords = !!coords;

                    // Stop an order the kitchen cannot actually reach, instead of
                    // accepting it and failing delivery later. The distance is
                    // only known server-side, so this depends on a fresh quote.
                    if (hasValidCoords) {
                        await refreshDeliveryQuote();
                    }
                    if (isOutOfRange()) {
                        const maxKm = deliveryQuote.maxDistanceKm;
                        const km = getDeliveryDistanceKm();
                        const detail = km != null ? ` (${km.toFixed(2)} km away)` : "";
                        alert(
                            ct(
                                "checkout_out_of_range",
                                getLang() === "am"
                                    ? "የአድራሻዎ ቦታ ከ" + maxKm + " ኪሜትር የላይ ነው። እባክዎ በተራችን ውስጥ ያለ አድራሻ ይሞክሩ።"
                                    : "Your location is beyond our " +
                                      maxKm +
                                      " km delivery range. Please choose an address within the delivery area." +
                                      detail
                            )
                        );
                        return;
                    }

                    const structured = buildStructuredDeliveryAddress({
                        city: deliveryCity,
                        area: deliveryArea,
                        streetArea: deliveryLocation,
                        landmark: deliveryLandmark,
                        houseNumber: deliveryHouseNumber,
                    });
                    deliveryInfo = {
                        // Separate structured values (city / area / kebele /
                        // streetArea / landmark) for the backend - never one
                        // combined string - plus the legacy display strings
                        // every existing screen already reads.
                        city: structured.city,
                        area: structured.area,
                        kebele: structured.kebele,
                        streetArea: structured.streetArea,
                        landmark: structured.landmark,
                        houseNumber: structured.houseNumber,
                        subCity: composeSubCity(deliveryArea, deliveryCity),
                        location: structured.location,
                        deliveryAddress: composeDeliveryAddress({
                            houseNumber: deliveryHouseNumber ? "House Number: " + deliveryHouseNumber : "",
                            location: [deliveryLocation, deliveryLandmark].filter(Boolean).join(", "),
                            area: deliveryArea,
                            city: deliveryCity
                        }),
                        phone: customerPhone || "",
                        ...(coords ? { latitude: coords.latitude, longitude: coords.longitude } : {})
                    };
                }


                const paymentMethod =
                    selectedPaymentMethod.value;


                const subtotal =
                    cart.reduce(
                        (sum, item) => {

                            const price =
                                Number(item.price) || 0;

                            const quantity =
                                Number(item.quantity) || 0;

                            return (
                                sum +
                                price * quantity
                            );

                        },
                        0
                    );


                // The backend re-prices the delivery fee from the real
                // destination and recomputes the total, so this local figure is
                // display-only. It still uses the live quote so the number the
                // customer approves matches what the server will charge.
                const totalAmount =
                    subtotal + SERVICE_FEE_ETB + (isDelivery ? getDeliveryFee() : 0);

                // Map cart items to backend expected format
                const orderItems = cart.map(item => ({
                    id: item.menuItemId || item.id,
                    name: item.name,
                    quantity: Number(item.quantity) || 1,
                    price: Number(item.price) || 0
                }));

                const orderId =
                    "ET-" +
                    Math.floor(
                        1000 +
                        Math.random() * 9000
                    );

                // Idempotency key for this submission attempt. Sent to the
                // backend (which replays instead of duplicating) and used by
                // the order-tracking page to reconcile when navigation wins
                // the race against a slow network.
                const clientOrderId =
                    orderId + "-" + Date.now().toString(36).toUpperCase();


                const newOrder = {

                    orderId: orderId,

                    orderDate:
                        new Date().toLocaleString(),

                    orderType:
                        orderType,

                    tableId:
                        tableId,

                    tableNumber:
                        tableNumber,

                    customerName:
                        customerName,

                    customerPhone:
                        customerPhone,

                    paymentMethod:
                        paymentMethod,

                    items:
                        orderItems,

                    subtotal:
                        subtotal,

                    serviceFee:
                        SERVICE_FEE_ETB,

                    deliveryFee:
                        isDelivery ? getDeliveryFee() : 0,

                    deliveryInfo:
                        deliveryInfo,

                    totalAmount:
                        totalAmount,

                    status:
                        "pending",

                    clientOrderId:
                        clientOrderId
                };


                // Ceiling on how long Confirm Order may stay on screen.
                // It used to be 5000ms, which yanked the customer to the
                // tracking page while the request was still in flight and read
                // as a random jump. The only job of this ceiling is to stop the
                // page hanging forever, so it is now generous, counted down
                // visibly, and the customer can cancel it with "Keep waiting".
                const SUBMIT_DEADLINE_MS = 30000;
                // Stay quiet for the first few seconds so a normal confirm
                // never shows a countdown at all.
                const COUNTDOWN_AFTER_MS = 5000;
                let submitServerOrderId = null;
                let submitPhase = "order";
                let submitFinished = false;
                let lastSubmitError = null;
                // Set by every terminal step of the flow below (reset the
                // button, or hand the page to another URL). The `finally`
                // safety net uses it to tell "we finished cleanly" from "we
                // blew up before reaching an exit".
                let submitUiSettled = false;
                const handOff = (url) => {
                    submitUiSettled = true;
                    window.location.href = url;
                };
                let deadlineCancelled = false;
                const pendingTrackingUrl = () => {
                    const q = new URLSearchParams();
                    if (submitServerOrderId) q.set("orderId", submitServerOrderId);
                    q.set("clientOrderId", clientOrderId);
                    q.set("pending", "1");
                    return "order-tracking.html?" + q.toString();
                };
                let submitDeadlineId = null;
                let deadlineTickId = null;
                const msLeft = () => Math.max(0, SUBMIT_DEADLINE_MS - (Date.now() - submitStart));
                const clearDeadline = () => {
                    try { clearTimeout(submitDeadlineId); } catch (e) {}
                    try { clearInterval(deadlineTickId); } catch (e) {}
                    submitDeadlineId = null;
                    deadlineTickId = null;
                };
                const paintCountdown = () => {
                    const el = document.getElementById("cpo-count");
                    if (!el) return;
                    const left = msLeft();
                    const stayBtn = document.getElementById("cpo-stay");
                    if (left > SUBMIT_DEADLINE_MS - COUNTDOWN_AFTER_MS) {
                        el.textContent = "";
                        if (stayBtn) stayBtn.style.display = "none";
                        return;
                    }
                    if (stayBtn) stayBtn.style.display = "inline-block";
                    const isAm = getLang() === "am";
                    el.textContent = ct(
                        "checkout_deadline_count",
                        isAm
                            ? "በጣም የቀለበ ጊዜ እየለቀ ነው። በ" + Math.ceil(left / 1000) + " ሰከንድ ውስጥ ወደ ኦርደር ክትትል እንሄዳለን።"
                            : "This is taking longer than expected. Moving to order tracking in " +
                              Math.ceil(left / 1000) +
                              "s."
                    );
                };
                const armSubmitDeadline = () => {
                    if (submitDeadlineId) return;
                    deadlineCancelled = false;
                    const stayBtn = document.getElementById("cpo-stay");
                    if (stayBtn) {
                        stayBtn.style.display = "none";
                        if (stayBtn.dataset.bound !== "1") {
                            stayBtn.dataset.bound = "1";
                            stayBtn.addEventListener("click", () => {
                                deadlineCancelled = true;
                                clearDeadline();
                                const el = document.getElementById("cpo-count");
                                if (el) {
                                    el.textContent = ct(
                                        "checkout_deadline_hold",
                                        getLang() === "am"
                                            ? "እስከ ማረጋገጫው እስኪጠናቀቅ እዚህ ገጽ ላይ ቆይነን።"
                                            : "Staying here until the order is confirmed."
                                    );
                                }
                            });
                        }
                    }
                    submitDeadlineId = setTimeout(() => {
                        if (submitFinished || deadlineCancelled) return;
                        clearDeadline();
                        window.location.href = pendingTrackingUrl();
                    }, msLeft());
                    paintCountdown();
                    deadlineTickId = setInterval(paintCountdown, 1000);
                };

                try {
                    setSubmitting(true);
                    showProcessingOverlay(clientOrderId);
                    // Remember this attempt BEFORE the request: if the page
                    // navigates on the deadline, tracking resumes from this.
                    savePendingSubmission(newOrder);
                    // Armed only after sync validation passed: a form error
                    // must never yank the customer away mid-correction.
                    // The budget is still measured from the click (submitStart).
                    armSubmitDeadline();
                    // `POST /orders` legitimately performs a number of
                    // sequential round trips to a remote MongoDB (table lookup,
                    // one stock reservation per item, order save, audit log), so
                    // it needs more headroom than the 15s API default. Without
                    // this the request was aborted client-side while the backend
                    // was still creating the order, and the customer saw
                    // "Request timed out" for an order that did exist.
                    const orderResponse = await api.post("/orders", newOrder, {
                        timeout: 60000,
                        keepalive: true
                    });
                    const createdOrderId = orderResponse.order?.orderId || orderId;
                    submitServerOrderId = createdOrderId;
                    submitPhase = "payment";
                    
                    // Try real payment first, fallback to simulation if not configured
                    let checkoutUrl = null;
                    let paymentSuccess = false;
                    
                    const paymentEndpoint = "/payments/chapa/initialize";
                    
                    try {
                        // Fail fast: the backend caps Chapa at ~10s, so a
                        // 12s client timeout guarantees a quick fallback to
                        // simulated payment instead of a long stall.
                        const paymentResponse = await api.post(paymentEndpoint, {
                            orderId: createdOrderId,
                            returnUrl: `${window.location.origin}/src/pages/customer/order-tracking.html?orderId=${encodeURIComponent(createdOrderId)}`
                        }, { timeout: 12000 });
                        
                        checkoutUrl = paymentResponse.data?.checkoutUrl || paymentResponse.checkoutUrl;

                        if (!checkoutUrl) {
                            throw new Error("Provider did not return a checkout URL");
                        }

                        // Remember the Chapa transaction reference so the
                        // order-tracking page can verify payment after the
                        // user completes checkout on Chapa's hosted page.
                        if (paymentMethod === "CHAPA") {
                            const txRef =
                                paymentResponse.transactionReference ||
                                paymentResponse.data?.transactionReference ||
                                paymentResponse.data?.tx_ref ||
                                "";
                            if (txRef) {
                                try {
                                    localStorage.setItem(
                                        "chapa_pending_payment",
                                        JSON.stringify({
                                            orderId: createdOrderId,
                                            txRef,
                                            paymentId:
                                                paymentResponse.data?.paymentId ||
                                                paymentResponse.data?.id ||
                                                ""
                                        })
                                    );
                                } catch (e) {
                                    console.warn("Could not save pending Chapa payment:", e);
                                }
                            }
                        }
                    } catch (paymentError) {
                        console.log('Real payment failed, trying simulation:', paymentError.message);
                        // Fallback to simulation payment with checkout URL
                        try {
                            const simResponse = await api.post("/payments/simulate", {
                                orderId: createdOrderId,
                                method: paymentMethod,
                                phone: customerPhone,
                                simulationMode: 'checkout',
                                returnUrl: `${window.location.origin}/src/pages/customer/order-tracking.html?orderId=${encodeURIComponent(createdOrderId)}`
                            });
                            
                            checkoutUrl = simResponse.data?.checkoutUrl || simResponse.checkoutUrl;
                        } catch (simError) {
                            console.error('Simulation payment also failed:', simError);
                            throw new Error(ct("checkout_payment_init_failed", getLang() === "am" ? "የክፍያ ማስጀመሪያ አልተሳካም። እባክዎ እንደገና ይሞክሩ።" : "Payment initialization failed. Please try again."));
                        }
                    }
                    
                    if (!checkoutUrl) {
                        throw new Error(`${paymentMethod} did not return a checkout URL.`);
                    }

                    // Persist the order locally so the receipt / order-tracking
                    // page can render it immediately after payment, even when
                    // no backend order-history page is open.
                    const orderRecord = {
                        ...newOrder,
                        orderId: createdOrderId,
                        paymentMethod: paymentMethod,
                        paymentStatus: "PENDING",
                        status: "pending"
                    };
                    try {
                        localStorage.setItem("latestOrder", JSON.stringify(orderRecord));
                        let history = JSON.parse(localStorage.getItem("orderHistory")) || [];
                        let exists = false;
                        history = history.map((o) => {
                            if ((o.orderId || o.id) === createdOrderId) {
                                exists = true;
                                return orderRecord;
                            }
                            return o;
                        });
                        if (!exists) {
                            history.unshift(orderRecord);
                        }
                        localStorage.setItem("orderHistory", JSON.stringify(history));
                    } catch (e) {
                        console.warn("Could not save order locally:", e);
                    }

                    clearPendingSubmission(clientOrderId);
                    localStorage.removeItem(CART_KEY);
                    localStorage.removeItem("checkoutCart");
                    window.dispatchEvent(new CustomEvent("cart:updated"));
                    submitFinished = true;
                    clearDeadline();
                    handOff(checkoutUrl);
                } catch (error) {
                    lastSubmitError = error;
                    clearDeadline();
                    submitFinished = true;
                    const status = error && error.status;
                    const definitive = typeof status === "number" && status >= 400 && status < 500 &&
                        submitPhase === "order" && !submitServerOrderId;
                    if (definitive) {
                        // Fast, authoritative rejection (bad input, unknown
                        // table, out of stock, auth): nothing was persisted,
                        // so stay and let the customer fix + retry.
                        clearPendingSubmission(clientOrderId);
                        hideProcessingOverlay();
                        // Re-enable Confirm Order so the customer can retry instead
                        // of being left with a permanently disabled button.
                        setSubmitting(false);
                        submitUiSettled = true;

                        // A delivery-range rejection is the one authoritative
                        // "nothing was persisted" outcome the customer can act on
                        // immediately: move the pin and retry. Surface the
                        // machine-readable code so this is not a generic failure.
                        if (error && error.code === "DELIVERY_OUT_OF_RANGE") {
                            const maxKm = (error.data && error.data.maxDistanceKm) ||
                                error.maxDistanceKm ||
                                (deliveryQuote && deliveryQuote.maxDistanceKm) || "";
                            const km = getDeliveryDistanceKm();
                            const detail = km != null ? ` (${km.toFixed(2)} km away)` : "";
                            alert(
                                ct(
                                    "checkout_out_of_range",
                                    getLang() === "am"
                                        ? "የአድራሻዎ ቦታ ከ" + maxKm + " ኪሜትር የላይ ነው። እባክዎ በተራችን ውስጥ ያለ አድራሻ ይሞክሩ።"
                                        : "Your location is beyond our " +
                                          maxKm +
                                          " km delivery range. Please choose an address within the delivery area." +
                                          detail
                                )
                            );
                            return;
                        }

                        alert(error.rawMessage || error.message || ct("checkout_unable_pay", getLang() === "am" ? "ክፍያ መጀመር አልተቻለም።" : "Unable to start payment."));
                        return;
                    }
                    // Ambiguous failure (timeout, network drop, 5xx) or a
                    // payment-phase failure after the order exists: the order
                    // may already be persisted, so reconcile on the tracking
                    // page instead of risking a duplicate resubmission here.
                    savePendingSubmission(newOrder);
                    handOff(pendingTrackingUrl());
                } finally {
                    // Safety net. Every path above either resets the button
                    // itself or hands the page to another URL, and marks
                    // `submitUiSettled` when it does. If we reach here without
                    // that marker it means something unexpected (e.g. an error
                    // thrown by the error handler itself) short-circuited the
                    // flow, and leaving `isSubmittingOrder` true would freeze
                    // the button on "Placing order..." forever. Always release
                    // it here so the customer gets a message and can retry.
                    if (!submitUiSettled && isSubmittingOrder) {
                        console.error("Checkout submission ended unexpectedly:", lastSubmitError);
                        clearPendingSubmission(clientOrderId);
                        setSubmitting(false);
                        hideProcessingOverlay();
                        alert(
                            (lastSubmitError && (lastSubmitError.rawMessage || lastSubmitError.message)) ||
                            ct("checkout_unable_pay", getLang() === "am" ? "ክፍያ መጀመር አልተቻለም።" : "Unable to start payment.")
                        );
                    }
                }

            }
        );

    }


    renderOrderReview();

    // Re-render the order review instantly when the language changes.
    __registerLangChange(() => {
        try {
            const cart = getCart();
            if (Array.isArray(cart) && cart.length > 0) renderOrderReview();
        } catch (e) {}
    });

    loadPublicSettings().then(() => {

        if (!DELIVERY_ENABLED) {

            const deliveryCard =
                document.getElementById("delivery-radio-card");

            if (deliveryCard) {

                deliveryCard.style.display = "none";
            }
        }

        updateDeliveryUI();
    });

    // --- Ethiopia address selectors -----------------------------------------
    // Every Ethiopian city is a choice (grouped by region), and the area list
    // follows the city: the official subcities for Addis Ababa, the kebeles
    // for Debre Berhan, a typed area everywhere else. "Other ..." always falls
    // back to a text field, so no address in Ethiopia is unreachable.
    //
    // The selected values are read through readCity()/readArea() and stored via
    // composeSubCity()/composeDeliveryAddress(), which keep the city inside the
    // address every card, ticket and Google Maps navigation later displays.
    const ADDRESS_OTHER = "__other";

    const citySelect = document.getElementById("delivery-city");
    const cityOtherGroup = document.getElementById("delivery-city-other-group");
    const cityOtherInput = document.getElementById("delivery-city-other");
    const subcityGroup = document.getElementById("delivery-subcity-group");
    const subcitySelect = document.getElementById("delivery-subcity");
    const areaTextGroup = document.getElementById("delivery-area-text-group");
    const areaTextInput = document.getElementById("delivery-area-text");

    function buildCityOptions() {
        if (!citySelect) return;
        const keep = citySelect.value;
        citySelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.setAttribute("data-i18n", "select_city");
        placeholder.textContent = ct("select_city", getLang() === "am" ? "ከተማ ይምረጡ" : "Select city");
        citySelect.appendChild(placeholder);
        groupCitiesByRegion().forEach((group) => {
            const optgroup = document.createElement("optgroup");
            optgroup.label = group.region;
            group.cities.forEach((city) => {
                const option = document.createElement("option");
                option.value = city.name;
                option.textContent = city.name;
                optgroup.appendChild(option);
            });
            citySelect.appendChild(optgroup);
        });
        const other = document.createElement("option");
        other.value = ADDRESS_OTHER;
        other.textContent = ct("checkout_other_city", getLang() === "am" ? "ሌላ ከተማ…" : "Other city…");
        citySelect.appendChild(other);
        if (keep) citySelect.value = keep;
    }

    function buildAreaOptions(cityName) {
        if (!subcitySelect) return;
        const keep = subcitySelect.value;
        subcitySelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.setAttribute("data-i18n", "select_area");
        placeholder.textContent = ct("select_area", getLang() === "am" ? "አካባቢ ይምረጡ" : "Select area");
        subcitySelect.appendChild(placeholder);
        const subcities = citySubcities(cityName);
        subcities.forEach((name) => {
            const option = document.createElement("option");
            option.value = name;
            option.textContent = name;
            subcitySelect.appendChild(option);
        });
        if (subcities.length) {
            const other = document.createElement("option");
            other.value = ADDRESS_OTHER;
            other.textContent = ct("checkout_other_area", getLang() === "am" ? "ሌላ አካባቢ…" : "Other area…");
            subcitySelect.appendChild(other);
        }
        let restored = false;
        if (keep) {
            for (let i = 0; i < subcitySelect.options.length; i++) {
                if (subcitySelect.options[i].value === keep) {
                    subcitySelect.value = keep;
                    restored = true;
                    break;
                }
            }
        }
        if (!restored) subcitySelect.value = "";
    }

    /** The area picker is a select only while the city offers a known list. */
    function areaUsesText() {
        if (!citySelect || !subcitySelect) return true;
        const chosen = citySelect.value;
        if (!chosen) return false;
        if (chosen === ADDRESS_OTHER) return true;
        if (!citySubcities(chosen).length) return true;
        return subcitySelect.value === ADDRESS_OTHER;
    }

    function syncAddressControls() {
        const cityIsOther = !!citySelect && citySelect.value === ADDRESS_OTHER;
        if (cityOtherGroup) cityOtherGroup.style.display = cityIsOther ? "block" : "none";
        const useText = areaUsesText();
        if (subcityGroup) subcityGroup.style.display = useText ? "none" : "block";
        if (areaTextGroup) areaTextGroup.style.display = useText ? "block" : "none";
    }

    function readCity() {
        if (!citySelect) return "";
        if (citySelect.value === ADDRESS_OTHER) {
            return (cityOtherInput && cityOtherInput.value.trim()) || "";
        }
        return String(citySelect.value || "").trim();
    }

    function readArea() {
        if (!subcitySelect) return (areaTextInput && areaTextInput.value.trim()) || "";
        if (areaUsesText()) return (areaTextInput && areaTextInput.value.trim()) || "";
        return String(subcitySelect.value || "").trim();
    }

    function focusCityControl() {
        // The visible control is the searchable dropdown; the native select
        // stays hidden as the submitted value holder.
        if (typeof cityDD !== "undefined" && cityDD && cityDD.open) {
            cityDD.open();
            return;
        }
        if (!citySelect) return;
        if (citySelect.value === ADDRESS_OTHER) {
            if (cityOtherInput && cityOtherInput.focus) cityOtherInput.focus();
        } else if (citySelect.focus) {
            citySelect.focus();
        }
    }

    function focusAreaControl() {
        if (typeof areaDD !== "undefined" && areaDD && areaDD.open) {
            if (!areaUsesText()) {
                areaDD.open();
                return;
            }
        }
        if (areaUsesText()) {
            if (areaTextInput && areaTextInput.focus) areaTextInput.focus();
        } else if (subcitySelect && subcitySelect.focus) {
            subcitySelect.focus();
        }
    }

    function focusStreetControl() {
        if (typeof streetDD !== "undefined" && streetDD && streetDD.open) {
            streetDD.open();
            return;
        }
        var streetInput = document.getElementById("delivery-location");
        if (streetInput && streetInput.focus) streetInput.focus();
    }

    // Dropdown handles (created in initAddressSelectors). Declared up-front
    // so focusCityControl()/focusAreaControl()/focusStreetControl() - which
    // run at submit-validation time - can always reach them.
    var cityDD = null;
    var areaDD = null;
    var streetDD = null;
    var landmarkDD = null;

    /** All Ethiopian cities, grouped by region, for the city dropdown. */
    function cityDropdownOptions() {
        return groupCitiesByRegion().map(function (group) {
            return {
                group: group.region,
                items: group.cities.map(function (city) {
                    return { value: city.name, label: city.name };
                }),
            };
        });
    }

    /** Area / subcity / kebele choices for ONE city - never a shared list. */
    function areaDropdownOptions(cityName) {
        return citySubcities(cityName).map(function (name) {
            return { value: name, label: name };
        });
    }

    /** Famous-place choices for ONE city (street AND landmark dropdowns). */
    function placesDropdownOptions(cityName) {
        var places = [];
        try {
            places = searchLandmarkSuggestions(cityName, "", 200) || [];
            if (!places.length) places = getCityLandmarks(cityName) || [];
        } catch (e) {
            places = [];
        }
        return places.map(function (name) {
            return { value: name, label: name };
        });
    }

    function ddText(key, fallback) {
        return ct(key, fallback);
    }

    /**
     * City change resets ONLY the dependent area/kebele selection and reloads
     * every choice list below it. Street/landmark VALUES are preserved - only
     * their suggestion lists refresh for the new city.
     */
    function onCityChanged(cityName) {
        buildAreaOptions(cityName);
        // Force-clear the area even if the old name exists in the new city.
        if (subcitySelect) subcitySelect.value = "";
        if (areaTextInput) areaTextInput.value = "";
        if (areaDD) {
            areaDD.setOptions(areaDropdownOptions(cityName));
            areaDD.clear(true);
        }
        syncAddressControls();
        if (streetDD) streetDD.setOptions(placesDropdownOptions(cityName));
        if (landmarkDD) landmarkDD.setOptions(placesDropdownOptions(cityName));
    }

    function handleCityPick(value, meta) {
        if (meta && meta.custom) {
            if (citySelect) citySelect.value = ADDRESS_OTHER;
            if (cityOtherInput) cityOtherInput.value = value;
        } else {
            if (citySelect) citySelect.value = value;
            if (cityOtherInput) cityOtherInput.value = "";
        }
        syncAddressControls();
        onCityChanged(value);
    }

    function handleAreaPick(value, meta) {
        if (meta && meta.custom) {
            if (subcitySelect) subcitySelect.value = ADDRESS_OTHER;
            if (areaTextInput) areaTextInput.value = value;
        } else {
            if (subcitySelect) subcitySelect.value = value;
            if (areaTextInput) areaTextInput.value = "";
        }
        syncAddressControls();
    }

    function handleStreetPick(value) {
        var hidden = document.getElementById("delivery-location");
        if (hidden) hidden.value = value;
    }

    function handleLandmarkPick(value) {
        var hidden = document.getElementById("delivery-landmark");
        if (hidden) hidden.value = value;
    }

    function initAddressSelectors() {
        if (!citySelect) return;
        buildCityOptions();
        buildAreaOptions("");
        syncAddressControls();

        // A missing container must never break the whole address step: the
        // hidden native controls keep working as plain inputs.
        var cityBox = document.getElementById("delivery-city-dropdown");
        var areaBox = document.getElementById("delivery-area-dropdown");
        var streetBox = document.getElementById("delivery-street-dropdown");
        var landmarkBox = document.getElementById("delivery-landmark-dropdown");
        if (cityBox) {
        cityDD = createSearchableDropdown({
            container: cityBox,
            placeholder: function () { return ddText("delivery_dd_select_city", getLang() === "am" ? "ከተማ ይምረጡ" : "Select city"); },
            searchPlaceholder: function () { return ddText("delivery_dd_search_cities", getLang() === "am" ? "ከተሞችን ይፈልጉ..." : "Search cities..."); },
            customLabel: function () { return ddText("delivery_dd_other", getLang() === "am" ? "ሌላ / በእጅ ያስገቡ" : "Other / Enter manually"); },
            useTypedLabel: function (text) { return ddText("delivery_dd_use_typed", 'Use "{x}"').replace("{x}", text); },
            noResultsLabel: function () { return ddText("delivery_dd_no_results", getLang() === "am" ? "ምንም አልተገኘም — ከታች “ሌላ / በእጅ ያስገቡ” ይምረጡ።" : 'No matches — choose "Other / Enter manually" below.'); },
            popularLabel: function () { return ddText("delivery_dd_popular", getLang() === "am" ? "ታዋቂ ቦታዎች" : "Popular places"); },
            clearLabel: function () { return ddText("delivery_dd_clear", getLang() === "am" ? "ምርጫን ያጽዱ" : "Clear selection"); },
            initialOptions: cityDropdownOptions(),
            onChange: handleCityPick,
        });
        }

        if (areaBox) {
        areaDD = createSearchableDropdown({
            container: areaBox,
            placeholder: function () { return ddText("delivery_dd_select_area", getLang() === "am" ? "አካባቢ ይምረጡ" : "Select area"); },
            searchPlaceholder: function () { return ddText("delivery_dd_search_areas", getLang() === "am" ? "አካባቢዎችን ይፈልጉ..." : "Search areas..."); },
            customLabel: function () { return ddText("delivery_dd_other", getLang() === "am" ? "ሌላ / በእጅ ያስገቡ" : "Other / Enter manually"); },
            useTypedLabel: function (text) { return ddText("delivery_dd_use_typed", 'Use "{x}"').replace("{x}", text); },
            noResultsLabel: function () { return ddText("delivery_dd_no_results", getLang() === "am" ? "ምንም አልተገኘም — ከታች “ሌላ / በእጅ ያስገቡ” ይምረጡ።" : 'No matches — choose "Other / Enter manually" below.'); },
            popularLabel: function () { return ddText("delivery_dd_popular", getLang() === "am" ? "ታዋቂ ቦታዎች" : "Popular places"); },
            clearLabel: function () { return ddText("delivery_dd_clear", getLang() === "am" ? "ምርጫን ያጽዱ" : "Clear selection"); },
            initialOptions: areaDropdownOptions(""),
            onChange: handleAreaPick,
        });
        }

        if (streetBox) {
        streetDD = createSearchableDropdown({
            container: streetBox,
            placeholder: function () { return ddText("delivery_dd_select_street", getLang() === "am" ? "መንገድ / አካባቢ ይምረጡ" : "Select street / area"); },
            searchPlaceholder: function () { return ddText("delivery_dd_search_places", getLang() === "am" ? "ታዋቂ ቦታዎችን ይፈልጉ..." : "Search famous places..."); },
            customLabel: function () { return ddText("delivery_dd_other", getLang() === "am" ? "ሌላ / በእጅ ያስገቡ" : "Other / Enter manually"); },
            useTypedLabel: function (text) { return ddText("delivery_dd_use_typed", 'Use "{x}"').replace("{x}", text); },
            noResultsLabel: function () { return ddText("delivery_dd_no_results", getLang() === "am" ? "ምንም አልተገኘም — ከታች “ሌላ / በእጅ ያስገቡ” ይምረጡ።" : 'No matches — choose "Other / Enter manually" below.'); },
            popularLabel: function () { return ddText("delivery_dd_popular", getLang() === "am" ? "ታዋቂ ቦታዎች" : "Popular places"); },
            clearLabel: function () { return ddText("delivery_dd_clear", getLang() === "am" ? "ምርጫን ያጽዱ" : "Clear selection"); },
            initialOptions: placesDropdownOptions(""),
            onChange: handleStreetPick,
        });
        }

        if (landmarkBox) {
        landmarkDD = createSearchableDropdown({
            container: landmarkBox,
            placeholder: function () { return ddText("delivery_dd_select_landmark", getLang() === "am" ? "መለያ ይምረጡ (አማራጭ)" : "Select landmark (optional)"); },
            searchPlaceholder: function () { return ddText("delivery_dd_search_places", getLang() === "am" ? "ታዋቂ ቦታዎችን ይፈልጉ..." : "Search famous places..."); },
            customLabel: function () { return ddText("delivery_dd_other", getLang() === "am" ? "ሌላ / በእጅ ያስገቡ" : "Other / Enter manually"); },
            useTypedLabel: function (text) { return ddText("delivery_dd_use_typed", 'Use "{x}"').replace("{x}", text); },
            noResultsLabel: function () { return ddText("delivery_dd_no_results", getLang() === "am" ? "ምንም አልተገኘም — ከታች “ሌላ / በእጅ ያስገቡ” ይምረጡ።" : 'No matches — choose "Other / Enter manually" below.'); },
            popularLabel: function () { return ddText("delivery_dd_popular", getLang() === "am" ? "ታዋቂ ቦታዎች" : "Popular places"); },
            clearLabel: function () { return ddText("delivery_dd_clear", getLang() === "am" ? "ምርጫን ያጽዱ" : "Clear selection"); },
            initialOptions: placesDropdownOptions(""),
            onChange: handleLandmarkPick,
        });
        }

        // Free-text editors stay in sync with their dropdown display, both
        // directions, without ever firing change loops (setCustomValue is
        // silent by design).
        if (cityOtherInput) cityOtherInput.addEventListener("input", function () {
            if (cityDD) cityDD.setCustomValue(cityOtherInput.value.trim());
            syncAddressControls();
        });
        if (areaTextInput) areaTextInput.addEventListener("input", function () {
            if (areaDD) areaDD.setCustomValue(areaTextInput.value.trim());
        });
        wireCustomBackButtons();

        // Placeholder labels are language-dependent; rebuild them without
        // losing what the customer already picked.
        __registerLangChange(function () {
            var city = readCity();
            buildCityOptions();
            if (citySelect) citySelect.value = city && findCityOption(city) ? city : (city ? ADDRESS_OTHER : "");
            buildAreaOptions(citySelect && citySelect.value === ADDRESS_OTHER ? "" : (citySelect ? citySelect.value : ""));
            if (cityDD) {
                cityDD.setOptions(cityDropdownOptions());
                cityDD.refresh();
            }
            if (areaDD) {
                areaDD.setOptions(areaDropdownOptions(readCity()));
                areaDD.refresh();
            }
            if (streetDD) {
                streetDD.setOptions(placesDropdownOptions(readCity()));
                streetDD.refresh();
            }
            if (landmarkDD) {
                landmarkDD.setOptions(placesDropdownOptions(readCity()));
                landmarkDD.refresh();
            }
            syncAddressControls();
        });
    }

    /** True when a city name exists as a predefined dropdown option. */
    function findCityOption(cityName) {
        if (!citySelect || !cityName) return false;
        var q = String(cityName).trim().toLowerCase();
        for (var i = 0; i < citySelect.options.length; i++) {
            if (String(citySelect.options[i].value).toLowerCase() === q) return true;
        }
        return false;
    }

    /** "Back to list" buttons inside the free-text editor groups. */
    function wireCustomBackButtons() {
        var cityBack = document.getElementById("delivery-city-back");
        if (cityBack && !cityBack.dataset.bound) {
            cityBack.dataset.bound = "1";
            cityBack.addEventListener("click", function () {
                if (citySelect) citySelect.value = "";
                if (cityOtherInput) cityOtherInput.value = "";
                if (cityDD) cityDD.clear(true);
                syncAddressControls();
                onCityChanged("");
                if (cityDD) cityDD.open();
            });
        }
        var areaBack = document.getElementById("delivery-area-back");
        if (areaBack && !areaBack.dataset.bound) {
            areaBack.dataset.bound = "1";
            areaBack.addEventListener("click", function () {
                if (subcitySelect) subcitySelect.value = "";
                if (areaTextInput) areaTextInput.value = "";
                if (areaDD) areaDD.clear(true);
                syncAddressControls();
                if (areaDD) areaDD.open();
            });
        }
    }

    // --- Searchable dropdowns (City / Area / Street / Landmark) ------------
    // Each visible field is a click-to-open searchable choice list built by
    // utils/searchable-dropdown.js: search box, filterable choices, clear
    // button, and an "Other / Enter manually" row so custom text always
    // works. The dropdown writes into the hidden native control with the
    // same id (delivery-city, delivery-subcity, delivery-location,
    // delivery-landmark), which stays the single source of truth that
    // readCity()/readArea(), validation, and order submission read.
    //
    // Dependency: City -> Area -> Street -> Landmark. Picking a city reloads
    // every list below it and clears the area; street/landmark values are
    // preserved while their suggestion lists refresh.

    initAddressSelectors();

    // Manual coordinate entry: re-price as soon as the customer stops typing,
    // so the displayed fee always reflects the destination being ordered to.
    (function initManualCoordQuoteing() {
        const latEl = document.getElementById("delivery-lat");
        const lngEl = document.getElementById("delivery-lng");
        if (!latEl || !lngEl) return;
        let debounce = null;
        const onEdit = () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                invalidateQuote();
                refreshDeliveryQuote();
            }, 600);
        };
        latEl.addEventListener("input", onEdit);
        lngEl.addEventListener("input", onEdit);
        latEl.addEventListener("change", onEdit);
        lngEl.addEventListener("change", onEdit);
    })();

    // The free-delivery threshold and the cart subtotal both change the fee, so
    // a cart change must invalidate the current quote.
    window.addEventListener("cart:updated", () => {
        invalidateQuote();
        refreshDeliveryQuote();
    });
    window.addEventListener("storage", (event) => {
        if (event.key === "cart") {
            invalidateQuote();
            refreshDeliveryQuote();
        }
    });

});
