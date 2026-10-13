function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}

document.addEventListener("DOMContentLoaded", () => {
    checkActiveOrder();
});

function aoTr(key, fallback) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback);
  return fallback;
}

function isAmharic() {
    return typeof window.getCurrentLanguage === "function" && window.getCurrentLanguage() === "am";
}

function renderBanner(activeOrder) {
    const existing = document.getElementById("active-order-banner");
    if (existing) existing.remove();

    // Create Banner Container
    const banner = document.createElement("div");
    banner.id = "active-order-banner";
    banner.className = "active-order-banner";

    const am = isAmharic();

    // Inject HTML Content
    banner.innerHTML = `
        <div class="container active-order-container">
            <div class="active-order-info">
                <span class="pulse-dot"></span>
                <i class="fa-solid fa-fire-burner"></i>
                <span>${aoTr('active_order_in_progress', am ? `ትዕዛዝ <strong>#${activeOrder.orderId}</strong> በአሁኑ ጊዜ በመካሄድ ላይ ነው!` : `Order <strong>#${activeOrder.orderId}</strong> is currently in progress!`).replace('{id}', activeOrder.orderId)}</span>
            </div>
            <a href="order-tracking.html?orderId=${activeOrder.orderId}" class="btn-track-order">
                ${aoTr('view_status', am ? 'ሁኔታ አሳይ' : 'View Status')} <i class="fa-solid fa-arrow-right"></i>
            </a>
        </div>
    `;

    // Insert banner at the top of the page (just below navbar or body)
    const navbar = document.querySelector(".navbar");
    if (navbar) {
        navbar.insertAdjacentElement("afterend", banner);
    } else {
        document.body.prepend(banner);
    }
}

function checkActiveOrder() {
    const activeOrder = JSON.parse(localStorage.getItem("latestOrder"));

    // If no order exists or order is marked as completed, do nothing
    if (!activeOrder || activeOrder.status === "Completed") {
        return;
    }

    renderBanner(activeOrder);
    // Re-render the banner text if the language changes.
    __registerLangChange(() => {
        try {
            const latest = JSON.parse(localStorage.getItem("latestOrder"));
            if (!latest || latest.status === "Completed") {
                const b = document.getElementById("active-order-banner");
                if (b) b.remove();
                return;
            }
            renderBanner(latest);
        } catch (e) { /* best-effort re-render */ }
    });
}