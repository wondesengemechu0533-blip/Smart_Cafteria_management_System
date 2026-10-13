/**
 * Delivery Safety & Proof of Delivery - delivery staff side.
 *
 * Two responsibilities, both rider-facing and both deliberately NOT routed
 * through the "Report Problem" modal:
 *
 *   1. SOS / emergency. A rider in danger needs one tap that reaches a manager
 *      immediately. A modal with a dropdown is the wrong shape for that.
 *
 *   2. Proof of delivery. Marking a delivery DELIVERED requires evidence: a
 *      proof photo, a verified customer OTP, or a manager override. This module
 *      collects that evidence and hands it to PATCH /deliveries/:id/delivered.
 *
 * GPS is captured fresh at the moment of the press via a one-shot
 * `getCurrentPosition`, not reused from the tracking watch, because an
 * emergency fix must be as current as the device can give. A denied permission
 * is reported to the rider but never blocks the SOS: the emergency is still
 * raised with locationAvailable false.
 */
import api from "../api.js";
import { esc, tr } from "./shared.js";

const ACTIVE_WATCH_STATUSES = ["picked_up", "out_for_delivery", "arrived"];

function normalizeStatus(status) {
  return String(status || "")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function isActiveForDelivery(order) {
  return ACTIVE_WATCH_STATUSES.includes(normalizeStatus(order && order.status));
}

/**
 * The SOS button.
 *
 * Shown only on the rider's OWN active deliveries - never on someone else's
 * run, and never once the delivery is finished. Styled to be unmistakable: it
 * is the one control on the card that must be findable under stress.
 */
export function sosButtonHtml(order, isMine) {
  if (!isMine || !isActiveForDelivery(order)) return "";
  return `
    <button type="button" class="btn-action btn-sos" data-action="sos" data-order="${esc(order.orderId)}"
            title="${esc(tr("delivery_sos_title", "Emergency: press if you are in danger"))}">
      <i class="fa-solid fa-tower-broadcast"></i>
      <span class="btn-sos-label">${esc(tr("delivery_sos", "SOS"))}</span>
    </button>`;
}

/**
 * Ask the device for the single most current fix it can produce.
 *
 * @returns {Promise<{latitude:number, longitude:number, accuracy:number}|null>}
 *          null when permission is denied or no fix could be obtained. The
 *          SOS flow treats null as "proceed without a fix", never as fatal.
 */
function captureGpsFix(timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    // NEVER prompt for this.
    //
    // SOS must not be the thing that puts a permission dialog on a rider's
    // screen: a rider in trouble cannot be asked to allow location, and a prompt
    // would block the emergency flow. So the fix is only attempted when the
    // permission has ALREADY been granted (i.e. the rider opted in earlier via
    // "Start Delivery"). Reading the permission is a query, not a request.
    if (!navigator.permissions || typeof navigator.permissions.query !== "function") {
      // No Permissions API: we cannot tell, and prompting here is unacceptable.
      resolve(null);
      return;
    }
    navigator.permissions
      .query({ name: "geolocation" })
      .then((status) => {
        if (!status || status.state !== "granted") {
          resolve(null);
          return;
        }
        requestOneShotFix(resolve, timeoutMs);
      })
      .catch(() => resolve(null));
  });
}

/** getCurrentPosition for an ALREADY-granted permission. */
function requestOneShotFix(resolve, timeoutMs) {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  try {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos && pos.coords ? pos.coords.latitude : NaN;
        const lng = pos && pos.coords ? pos.coords.longitude : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return finish(null);
        finish({
          latitude: lat,
          longitude: lng,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        });
      },
      () => finish(null),
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs }
    );
  } catch (e) {
    finish(null);
  }
}

/**
 * Raise a delivery emergency for one of the rider's own orders.
 *
 * @param {string} orderId
 * @param {Object} [hooks] - { onLocationUnavailable(), onRaised(payload), onError(message) }
 */
export async function triggerSos(orderId, hooks = {}) {
  const id = String(orderId || "");
  if (!id) throw new Error("orderId is required");

  // Capture the fix first, so the rider gets immediate feedback about whether
  // the location was available rather than finding out after the POST.
  const fix = await captureGpsFix();

  if (!fix && typeof hooks.onLocationUnavailable === "function") {
    hooks.onLocationUnavailable();
  }

  const body = fix
    ? { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy }
    : {};

  const res = await api.post(`/deliveries/${encodeURIComponent(id)}/emergency`, body);
  if (typeof hooks.onRaised === "function") hooks.onRaised(res);
  return res;
}

/**
 * The proof-of-delivery modal.
 *
 * Collects whatever the courier has - a customer OTP and/or a proof photo - and
 * only submits once at least one is in hand. The backend makes the final
 * decision; this UI just stops the courier discovering "PROOF_REQUIRED" from
 * an alert box.
 *
 * @param {Object} order
 * @param {Function} onDone called after a successful delivery
 */
export function openProofModal(order, onDone) {
  const orderId = order.orderId;
  const existing = document.getElementById("proof-modal");
  if (existing) existing.remove();

  const wrap = document.createElement("div");
  wrap.className = "modal-overlay proof-modal-overlay";
  wrap.id = "proof-modal";
  wrap.innerHTML = `
    <div class="proof-modal" role="dialog" aria-modal="true" aria-labelledby="proof-modal-title">
      <div class="proof-head">
        <h3 id="proof-modal-title"><i class="fa-solid fa-shield-halved"></i> ${esc(tr("proof_title", "Proof of Delivery"))}</h3>
        <p class="proof-sub">${esc(tr("proof_sub", "This order must be proven delivered before it can be completed."))}</p>
        <button type="button" class="modal-close" data-proof="close" aria-label="Close">&times;</button>
      </div>

      <div class="proof-body">
        <div class="proof-row">
          <label class="proof-label">${esc(tr("proof_otp_label", "Customer delivery code"))}</label>
          <p class="proof-hint">${esc(tr("proof_otp_hint", "Ask the customer for the code sent to them, or send a new one."))}</p>
          <div class="proof-inline">
            <input type="text" inputmode="numeric" id="proof-otp" maxlength="8"
                   placeholder="${esc(tr("proof_otp_placeholder", "e.g. 483920"))}" />
            <button type="button" class="btn-action" id="proof-send-otp">
              <i class="fa-solid fa-paper-plane"></i> ${esc(tr("proof_send_code", "Send code"))}
            </button>
            <button type="button" class="btn-action" id="proof-verify-otp">
              <i class="fa-solid fa-check"></i> ${esc(tr("proof_verify", "Verify"))}
            </button>
          </div>
          <div class="proof-status" id="proof-otp-status"></div>
        </div>

        <div class="proof-divider">${esc(tr("proof_or", "or"))}</div>

        <div class="proof-row">
          <label class="proof-label">${esc(tr("proof_photo_label", "Proof photo"))}</label>
          <p class="proof-hint">${esc(tr("proof_photo_hint", "A photo of the order at the customer's door."))}</p>
          <div class="proof-inline">
            <input type="file" id="proof-photo" accept="image/jpeg,image/png,image/webp" />
          </div>
          <div class="proof-status" id="proof-photo-status"></div>
        </div>

        <div class="proof-divider">${esc(tr("proof_optional", "optional"))}</div>

        <div class="proof-row">
          <label class="proof-label" for="proof-note">${esc(tr("proof_note_label", "Note"))}</label>
          <input type="text" id="proof-note" maxlength="200" placeholder="${esc(tr("proof_note_placeholder", "e.g. left with the guard at the gate"))}" />
        </div>
      </div>

      <div class="proof-foot">
        <button type="button" class="btn-action btn-disabled-soft" data-proof="close">
          ${esc(tr("proof_cancel", "Cancel"))}
        </button>
        <button type="button" class="btn-action btn-done" id="proof-submit" disabled>
          <i class="fa-solid fa-circle-check"></i> ${esc(tr("proof_confirm_delivered", "Confirm Delivered"))}
        </button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const $ = (sel) => wrap.querySelector(sel);
  const otpStatus = $("#proof-otp-status");
  const photoStatus = $("#proof-photo-status");
  const submitBtn = $("#proof-submit");
  const otpInput = $("#proof-otp");
  const photoInput = $("#proof-photo");
  const noteInput = $("#proof-note");

  let verifiedOtp = false;
  let photoUrl = null;

  const refreshSubmit = () => {
    const can = verifiedOtp || Boolean(photoUrl);
    submitBtn.disabled = !can;
    submitBtn.classList.toggle("btn-disabled-soft", !can);
  };

  const setStatus = (el, ok, text) => {
    el.innerHTML = `<span class="proof-status-line ${ok ? "ok" : "bad"}">${esc(text)}</span>`;
  };

  wrap.addEventListener("click", (e) => {
    if (e.target.closest('[data-proof="close"]')) {
      wrap.remove();
      return;
    }
    if (e.target === wrap) wrap.remove();
  });

  $("#proof-send-otp").addEventListener("click", async () => {
    try {
      setStatus(otpStatus, true, tr("proof_sending", "Sending code to the customer…"));
      const res = await api.post(`/deliveries/${encodeURIComponent(orderId)}/otp/generate`, {});
      setStatus(otpStatus, true, res.message || tr("proof_sent", "Code sent. Ask the customer for it."));
    } catch (err) {
      setStatus(otpStatus, false, err.message || tr("proof_send_failed", "Could not send the code."));
    }
  });

  $("#proof-verify-otp").addEventListener("click", async () => {
    const code = String(otpInput.value || "").trim();
    if (!code) {
      setStatus(otpStatus, false, tr("proof_enter_code", "Enter the code first."));
      return;
    }
    try {
      const res = await api.post(`/deliveries/${encodeURIComponent(orderId)}/otp/verify`, { otp: code });
      if (res.verified) {
        verifiedOtp = true;
        otpInput.disabled = true;
        setStatus(otpStatus, true, tr("proof_verified", "Customer confirmed the handover."));
      } else {
        setStatus(otpStatus, false, res.message || tr("proof_wrong", "That code is not correct."));
      }
      refreshSubmit();
    } catch (err) {
      const expired = err && (err.code === "OTP_EXPIRED" || err.code === "OTP_LOCKED");
      setStatus(otpStatus, false, expired
        ? (err.message || tr("proof_expired", "That code is no longer valid. Send a new one."))
        : (err.message || tr("proof_verify_failed", "Could not verify the code.")));
    }
  });

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files && photoInput.files[0];
    if (!file) {
      photoUrl = null;
      refreshSubmit();
      return;
    }
    const fd = new FormData();
    fd.append("photo", file);
    try {
      setStatus(photoStatus, true, tr("proof_uploading", "Uploading proof photo…"));
      const res = await api.upload(`/deliveries/${encodeURIComponent(orderId)}/proof/photo`, fd);
      photoUrl = res.proofPhoto;
      setStatus(photoStatus, true, tr("proof_uploaded", "Proof photo attached."));
    } catch (err) {
      photoUrl = null;
      setStatus(photoStatus, false, err.message || tr("proof_upload_failed", "Could not upload the photo."));
    }
    refreshSubmit();
  });

  submitBtn.addEventListener("click", async () => {
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    try {
      const res = await api.patch(`/deliveries/${encodeURIComponent(orderId)}/delivered`, {
        proofPhoto: photoUrl || undefined,
        proofNote: String(noteInput.value || "").trim() || undefined,
      });
      wrap.remove();
      if (typeof onDone === "function") onDone(res);
    } catch (err) {
      submitBtn.disabled = false;
      // PROOF_REQUIRED means the backend did not accept what we sent - surface
      // it in the modal rather than closing and losing the photo.
      const bad = wrap.querySelector(".proof-sub");
      if (bad) {
        bad.innerHTML = `<strong class="proof-error">${esc(err.message || tr("proof_failed", "Could not confirm delivery."))}</strong>`;
      }
    }
  });

  refreshSubmit();
}

/**
 * Let the rider resolve their own emergency once they are safe.
 */
export async function resolveOwnEmergency(orderId) {
  const id = String(orderId || "");
  if (!id) throw new Error("orderId is required");
  return api.patch(`/deliveries/${encodeURIComponent(id)}/emergency/resolve`, {
    note: "Resolved by the delivery person",
  });
}

/**
 * Render the SOS button onto a card and wire its handler.
 *
 * Kept separate from the card template so both the full queue page and the
 * rider's own dashboard can call it without duplicating the markup.
 */
export function bindSos(rootEl, getOrder, onRaised) {
  if (!rootEl) return;
  rootEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action='sos']");
    if (!btn) return;
    const orderId = btn.getAttribute("data-order");
    if (!orderId) return;

    e.preventDefault();
    e.stopPropagation();

    // One tap must never be able to spawn several emergencies.
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("btn-sos-pending");

    try {
      await triggerSos(orderId, {
        onLocationUnavailable() {
          // Warn, then continue: an SOS without a fix is still an SOS.
          const label = btn.querySelector(".btn-sos-label");
          if (label) label.textContent = tr("sos_no_gps", "SOS (no GPS)");
        },
        onRaised() {
          const label = btn.querySelector(".btn-sos-label");
          if (label) label.textContent = tr("sos_sent", "SOS sent");
          if (typeof onRaised === "function") onRaised(orderId);
        },
        onError(message) {
          btn.disabled = false;
          btn.classList.remove("btn-sos-pending");
          alert(message || tr("sos_failed", "Could not raise the emergency. Call the cafeteria."));
        },
      });
    } catch (err) {
      btn.disabled = false;
      btn.classList.remove("btn-sos-pending");
      alert(err.message || tr("sos_failed", "Could not raise the emergency. Call the cafeteria."));
    }
  });
}
