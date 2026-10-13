/**
 * Delivery person: report a problem on a delivery in progress.
 *
 * Shared by the delivery dashboard and the full delivery queue so the courier
 * has the same reporting control on whichever page they are on.
 *
 * Design rules that this module must not break:
 *  - The issue type list is fetched from the server (`/delivery-issues/meta/types`)
 *    so it can never drift from the backend's allowed values.
 *  - GPS is taken from the tracker that is already running for this order. If
 *    there is no fix, the report is still sent with `locationAvailable:false` -
 *    never a placeholder coordinate.
 *  - The order/delivery id is only ever taken from the order the courier is
 *    looking at. Ownership is verified server-side against the JWT.
 *  - No hard-coded success claim: the server's own message is what is shown.
 */
import api from "../api.js";
import { gpsTracker } from "./gps.js";
import { esc, tr, apiErrorMessage } from "./shared.js";

/** Server-provided metadata, cached so the modal opens instantly after the first load. */
let metaPromise = null;

export function loadIssueMeta() {
    if (!metaPromise) {
        metaPromise = api.get("/delivery-issues/meta/types").catch((e) => {
            // Do not cache a failure: a transient error must not permanently
            // disable the report button.
            metaPromise = null;
            throw e;
        });
    }
    return metaPromise;
}

/** The courier's own last real fix for this order, or null. Never invents one. */
function currentFix(orderId) {
    if (!gpsTracker || typeof gpsTracker.getState !== "function") return null;
    const state = gpsTracker.getState(orderId);
    const fix = state && state.lastFix;
    if (!fix) return null;
    const lat = Number(fix.latitude);
    const lng = Number(fix.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { latitude: lat, longitude: lng, accuracy: fix.accuracy };
}

const MODAL_ID = "reportIssueModal";

function injectStyles() {
    if (document.getElementById("reportIssueStyles")) return;
    const style = document.createElement("style");
    style.id = "reportIssueStyles";
    style.textContent = `
        .ri-overlay{position:fixed;inset:0;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}
        .ri-modal{background:#fff;width:100%;max-width:520px;border-radius:14px;box-shadow:0 20px 45px rgba(0,0,0,.3);max-height:90vh;overflow:auto}
        .ri-head{padding:16px 18px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;gap:10px}
        .ri-head h3{margin:0;font-size:1.05rem}
        .ri-body{padding:18px;display:flex;flex-direction:column;gap:14px}
        .ri-field label{display:block;font-weight:600;margin-bottom:6px;font-size:.85rem}
        .ri-field select,.ri-field textarea,.ri-field input[type=file]{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;box-sizing:border-box}
        .ri-field textarea{min-height:96px;resize:vertical}
        .ri-hint{font-size:.78rem;color:#64748b;margin-top:6px}
        .ri-gps{margin:0;padding:8px 10px;border-radius:8px;font-size:.8rem;display:flex;align-items:center;gap:8px}
        .ri-gps.ok{background:#ecfdf5;color:#047857}
        .ri-gps.missing{background:#fff7ed;color:#b45309}
        .ri-err{display:none;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:10px;font-size:.85rem}
        .ri-err.show{display:block}
        .ri-foot{padding:14px 18px;border-top:1px solid #e2e8f0;display:flex;gap:10px;justify-content:flex-end}
        .ri-btn{padding:10px 16px;border-radius:8px;border:1px solid transparent;font:inherit;font-weight:600;cursor:pointer}
        .ri-btn-primary{background:#f97316;color:#fff}
        .ri-btn-primary:disabled{opacity:.6;cursor:not-allowed}
        .ri-btn-ghost{background:#fff;border-color:#cbd5e1;color:#334155}
        .ri-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:.75rem;font-weight:600}
        .ri-badge.open{background:#fef3c7;color:#92400e}
        .ri-badge.hold{background:#fee2e2;color:#991b1b}
        .ri-badge.resolved{background:#dcfce7;color:#166534}
        body.dark-theme .ri-modal{background:#1e293b;color:#e2e8f0}
        body.dark-theme .ri-field select,body.dark-theme .ri-field textarea{background:#0f172a;color:#e2e8f0;border-color:#334155}
        body.dark-theme .ri-foot{border-color:#334155}
        body.dark-theme .ri-btn-ghost{background:#0f172a;color:#e2e8f0;border-color:#334155}
    `;
    document.head.appendChild(style);
}

/** Human label for an enum value, falling back to a readable form. */
function humanize(value) {
    return String(value || "")
        .split("_")
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(" ");
}

/**
 * Open the report dialog for one order.
 * @param {object} order  the order the courier is looking at
 * @param {Function} onReported  called after a successful report
 */
export async function openReportIssue(order, onReported) {
    if (!order || !order.orderId) return;
    injectStyles();

    let meta;
    try {
        meta = await loadIssueMeta();
    } catch (e) {
        alert(apiErrorMessage(e, tr("delivery_issue_types_failed", "Could not load problem types. Please try again.")));
        return;
    }

    // The server sends `{ value, label }` pairs, so the wording and the allowed
    // values can never drift from the backend. No local copy of the list.
    const types = (meta && Array.isArray(meta.types) ? meta.types : []).map((t) =>
        t && typeof t === "object" ? t : { value: t, label: humanize(t) }
    );
    const close = () => {
        const el = document.getElementById(MODAL_ID);
        if (el) el.remove();
    };

    if (!types.length) {
        alert(tr("delivery_issue_types_empty", "No problem types are available right now."));
        return;
    }

    const options = types
        .map((t) => `<option value="${esc(t.value)}">${esc(t.label || humanize(t.value))}</option>`)
        .join("");

    const overlay = document.createElement("div");
    overlay.className = "ri-overlay";
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
        <div class="ri-modal" role="dialog" aria-modal="true" aria-labelledby="riTitle">
            <div class="ri-head">
                <h3 id="riTitle"><i class="fa-solid fa-triangle-exclamation" style="color:#f97316;"></i>
                    ${esc(tr("delivery_issue_report_title", "Report a problem"))}
                </h3>
                <button type="button" class="ri-btn ri-btn-ghost" data-ri-close>${esc(tr("common_close", "Close"))}</button>
            </div>
            <div class="ri-body">
                <div class="ri-err" data-ri-err></div>
                <div class="ri-field">
                    <label for="riType">${esc(tr("delivery_issue_type", "What happened?"))}</label>
                    <select id="riType">${options}</select>
                </div>
                <div class="ri-field">
                    <label for="riDesc">${esc(tr("delivery_issue_desc", "Describe the problem"))}</label>
                    <textarea id="riDesc" maxlength="1000"
                        placeholder="${esc(tr("delivery_issue_desc_placeholder", "Explain what is blocking you, so your manager can help."))}"></textarea>
                    <div class="ri-hint">${esc(tr("delivery_issue_desc_hint", "The customer is never shown this text."))}</div>
                </div>
                <div class="ri-field">
                    <label for="riPhoto">${esc(tr("delivery_issue_photo", "Photo (optional)"))}</label>
                    <input type="file" id="riPhoto" accept="image/jpeg,image/png,image/webp">
                </div>
                <div class="ri-gps" data-ri-gps></div>
            </div>
            <div class="ri-foot">
                <button type="button" class="ri-btn ri-btn-ghost" data-ri-close>${esc(tr("common_cancel", "Cancel"))}</button>
                <button type="button" class="ri-btn ri-btn-primary" data-ri-submit>${esc(tr("delivery_issue_submit", "Send to manager"))}</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    // Reflect the real GPS state instead of implying we always know where we are.
    const gpsBox = overlay.querySelector("[data-ri-gps]");
    const paintGps = () => {
        const fix = currentFix(order.orderId);
        gpsBox.className = `ri-gps ${fix ? "ok" : "missing"}`;
        gpsBox.innerHTML = fix
            ? `<i class="fa-solid fa-location-crosshairs"></i> ${esc(tr("delivery_issue_gps_ok", "Your current GPS position will be sent with this report."))}`
            : `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(tr("delivery_issue_gps_missing", "No GPS fix available. The report is still sent - the manager will see there is no location."))}`;
    };
    paintGps();
    const gpsTimer = setInterval(paintGps, 2000);

    const errBox = overlay.querySelector("[data-ri-err]");
    const submitBtn = overlay.querySelector("[data-ri-submit]");

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay || e.target.closest("[data-ri-close]")) {
            clearInterval(gpsTimer);
            close();
        }
    });

    submitBtn.addEventListener("click", async () => {
        const issueType = overlay.querySelector("#riType").value;
        const description = overlay.querySelector("#riDesc").value.trim();
        const photoFile = overlay.querySelector("#riPhoto").files[0];

        if (!description) {
            errBox.textContent = tr("delivery_issue_desc_required", "Please describe the problem.");
            errBox.classList.add("show");
            return;
        }

        submitBtn.disabled = true;
        errBox.classList.remove("show");
        try {
            // FormData so the optional photo rides along in the same request.
            const form = new FormData();
            form.append("orderId", order.orderId);
            form.append("issueType", issueType);
            form.append("description", description);
            const fix = currentFix(order.orderId);
            if (fix) {
                form.append("latitude", String(fix.latitude));
                form.append("longitude", String(fix.longitude));
                if (fix.accuracy !== undefined && fix.accuracy !== null) {
                    form.append("accuracy", String(fix.accuracy));
                }
            }
            if (photoFile) form.append("photo", photoFile);

            const res = await api.request("/delivery-issues", { method: "POST", body: form });
            clearInterval(gpsTimer);
            close();
            alert(res.message || tr("delivery_issue_sent", "Problem reported. Your manager has been notified."));
            if (typeof onReported === "function") onReported(res);
        } catch (e) {
            errBox.textContent = apiErrorMessage(e, tr("delivery_issue_send_failed", "Failed to report the problem."));
            errBox.classList.add("show");
            submitBtn.disabled = false;
        }
    });
}

/**
 * The small status line shown on a delivery card.
 * Renders nothing when the delivery has no issue, so a clean card stays clean.
 */
export function issueBadge(issue) {
    if (!issue) return "";
    const status = String(issue.status || "").toUpperCase();
    let cls = "open";
    let icon = "fa-triangle-exclamation";
    let text = humanize(status);
    if (issue.deliveryOnHold) {
        cls = "hold";
        icon = "fa-pause";
        text = tr("delivery_issue_hold", "On hold by manager");
    } else if (status === "RESOLVED") {
        cls = "resolved";
        icon = "fa-circle-check";
        text = tr("delivery_issue_resolved", "Problem resolved");
    } else if (status === "CANCELLED") {
        cls = "resolved";
        icon = "fa-circle-xmark";
        text = tr("delivery_issue_closed", "Problem closed");
    }
    const type = humanize(issue.issueType);
    return `<div style="margin-top:8px;"><span class="ri-badge ${cls}"><i class="fa-solid ${icon}"></i> ${esc(text)}${type ? " · " + esc(type) : ""}</span></div>`;
}
