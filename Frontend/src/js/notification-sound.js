/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - NOTIFICATION SOUND HELPER
   ==========================================================================
   Classic (non-module) script. Plays a short notification chime for
   realtime events (new orders, deliveries, notifications).

   - Listens for custom events: "scos:notify:order", "scos:notify:delivery",
     "scos:notify:info" (dispatched by socket.js and page scripts).
   - Respects a user toggle stored in localStorage: scos_notify_sound (1/0).
   - Plays the real sound file first (/assets/sounds/new-order.mp3), with a
     WebAudio chime as fallback if the file cannot load.
   - Handles browser autoplay policy: unlocks on first user gesture or via
     ScosNotify.unlock(), and dispatches "scos:sound:blocked" when a play
     attempt is blocked so pages can show an "Enable notification sound" CTA.

   Exposes: window.ScosNotify = {
     play, toggle, enabled, unlock, isUnlocked, isBlocked
   }
   ========================================================================== */
(function (global) {
  'use strict';

  var AUDIO_URL = '/assets/sounds/new-order.wav';
  var AUDIO_URL_MP3 = '/assets/sounds/new-order.mp3';
  // The delivery emergency alarm. Deliberately a different file and a much
  // harsher tone than the order chime: a rider in danger must not be mistaken
  // for a new order arriving.
  var EMERGENCY_URL = '/assets/sounds/emergency.wav';
  var LOCKED_KEY = 'scos_notify_sound_unlocked'; // '1' after user gesture this session intent
  var audioEl = null;
  var audioCtx = null;
  var unlocked = false;
  var gestureBound = false;
  var lastBlockedAt = 0;
  var activeLoops = Object.create(null);
  var toneBusyUntil = 0;
  var LOOP_MIN_INTERVAL_MS = 5000;
  var LOOP_MAX_INTERVAL_MS = 10000;
  var LOOP_DEFAULT_INTERVAL_MS = 7000;
  // Alerts must repeat until the listener acknowledges them, so the safety cap
  // is a long backstop rather than a short 2-minute cutoff that would silence
  // an unacknowledged order.
  var LOOP_MAX_DURATION_MS = 30 * 60 * 1000;

  function enabled() {
    // Delivery pages run silent: dispatching and sound played badly together,
    // so delivery-layout.js sets this flag and no alert chime plays there.
    try {
      if (typeof global !== 'undefined' && global.__scosMuteDeliverySound) return false;
    } catch (e) {}
    try {
      return localStorage.getItem('scos_notify_sound') !== '0';
    } catch (e) { return true; }
  }

  function isUnlocked() {
    return unlocked;
  }

  function isBlocked() {
    if (unlocked) return false;
    if (audioCtx && audioCtx.state === 'running') {
      unlocked = true;
      return false;
    }
    return true;
  }

  function ensureAudioEl() {
    if (audioEl) return audioEl;
    try {
      // Prefer the real PCM chime (WAV); MP3 path is the secondary fallback.
      audioEl = new Audio(AUDIO_URL);
      audioEl.preload = 'auto';
      audioEl.volume = 0.9;
      audioEl.addEventListener('error', function onErr() {
        if (audioEl && audioEl.src.indexOf('new-order.wav') !== -1) {
          try { audioEl.src = AUDIO_URL_MP3; } catch (e) { /* ignore */ }
        }
      });
    } catch (e) {
      audioEl = null;
    }
    return audioEl;
  }

  function ensureContext() {
    try {
      var AudioCtx = global.AudioContext || global.webkitAudioContext;
      if (!AudioCtx) return null;
      if (!audioCtx) audioCtx = new AudioCtx();
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  function markUnlocked(source) {
    if (unlocked) return;
    unlocked = true;
    try {
      localStorage.setItem(LOCKED_KEY, '1');
    } catch (e) { /* ignore */ }
    var ctx = ensureContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(function () {});
    }
    // Silent prime of the HTMLAudio element (gesture-required unlock).
    var el = ensureAudioEl();
    if (el) {
      try {
        var wasMuted = el.muted;
        el.muted = true;
        var p = el.play();
        if (p && typeof p.then === 'function') {
          p.then(function () {
            el.pause();
            el.currentTime = 0;
            el.muted = wasMuted;
          }).catch(function () {
            el.muted = wasMuted;
          });
        } else {
          el.pause();
          el.muted = wasMuted;
        }
      } catch (e) { /* ignore */ }
    }
    try {
      document.dispatchEvent(new CustomEvent('scos:sound:unlocked', {
        detail: { source: source || 'gesture' }
      }));
    } catch (e) { /* ignore */ }
  }

  function noteBlocked() {
    lastBlockedAt = Date.now();
    try {
      document.dispatchEvent(new CustomEvent('scos:sound:blocked', {
        detail: { reason: 'autoplay' }
      }));
    } catch (e) { /* ignore */ }
  }

  function bindGestureUnlock() {
    if (gestureBound || typeof document === 'undefined') return;
    gestureBound = true;
    var onGesture = function () {
      markUnlocked('page-gesture');
    };
    ['pointerdown', 'keydown', 'touchstart', 'click'].forEach(function (evt) {
      document.addEventListener(evt, onGesture, { once: true, passive: true });
    });
    // Keep a persistent path for the explicit CTA as well.
    document.addEventListener('scos:sound:enable', function () {
      markUnlocked('cta');
    });
  }

  function playWebAudioChime(type) {
    var ctx = ensureContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      try {
        var resumed = ctx.resume();
        if (resumed && typeof resumed.then === 'function') {
          resumed.then(function () { scheduleTone(ctx, type); }).catch(function () {});
        }
      } catch (e) { /* ignore */ }
      if (ctx.state !== 'running') return false;
    }
    return scheduleTone(ctx, type);
  }

  function scheduleTone(ctx, type) {
    var stamp = Date.now();
    if (toneBusyUntil > stamp) return true;
    toneBusyUntil = stamp + 700;
    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      var now = ctx.currentTime;
      osc.type = 'sine';
      var base = type === 'delivery' ? 880 : type === 'cancellation' ? 392 : type === 'info' ? 660 : 523.25;
      var second = type === 'cancellation' ? base * 1.5 : base;
      osc.frequency.setValueAtTime(base, now);
      osc.frequency.setValueAtTime(second, now + 0.12);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
      gain.gain.setValueAtTime(0.18, now + 0.22);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + (type === 'cancellation' ? 0.48 : 0.36));
      return true;
    } catch (e) {
      toneBusyUntil = 0;
      return false;
    }
  }

  /**
   * Play the delivery emergency alarm.
   *
   * Uses its own <audio> element so it never fights the order chime for the
   * shared element, and loops until stopLoop is called - an unacknowledged SOS
   * must keep sounding, exactly like an unacknowledged new order.
   */
  var emergencyEl = null;

  function ensureEmergencyEl() {
    if (emergencyEl) return emergencyEl;
    try {
      emergencyEl = new Audio(EMERGENCY_URL);
      emergencyEl.preload = 'auto';
      emergencyEl.volume = 1.0;
      emergencyEl.loop = true;
    } catch (e) {
      emergencyEl = null;
    }
    return emergencyEl;
  }

  function playEmergency(onBlocked) {
    var el = ensureEmergencyEl();
    if (!el) {
      // No WebAudio fallback for an emergency: a silent alarm is worse than
      // no alarm, so surface the CTA instead of faking it.
      noteBlocked();
      if (onBlocked) onBlocked();
      return;
    }
    try {
      el.currentTime = 0;
      var p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          unlocked = true;
          try { localStorage.setItem(LOCKED_KEY, '1'); } catch (e) { /* ignore */ }
        }).catch(function () {
          if (!playWebAudioChime('emergency')) {
            noteBlocked();
            if (onBlocked) onBlocked();
          }
        });
      }
    } catch (e) {
      noteBlocked();
      if (onBlocked) onBlocked();
    }
  }

  function playFile(type, onBlocked) {
    // The emergency alarm has its own file. Everything else keeps using the
    // shared order chime.
    if (type === 'emergency') {
      return playEmergency(onBlocked);
    }

    if (type === 'cancellation' && playWebAudioChime(type)) {
      unlocked = true;
      try { localStorage.setItem(LOCKED_KEY, '1'); } catch (e) { /* ignore */ }
      return;
    }

    var el = ensureAudioEl();
    if (!el) {
      if (!playWebAudioChime(type)) {
        noteBlocked();
        onBlocked && onBlocked();
      }
      return;
    }
    try {
      el.pause();
      el.currentTime = 0;
      // Real mp3 first (new-order.mp3); fall back to WebAudio chime.
      var p = el.play();
      setTimeout(function () {
        if (!anyLooping()) stopPlayback();
      }, 2000);
      if (p && typeof p.then === 'function') {
        p.then(function () {
          unlocked = true;
          try { localStorage.setItem(LOCKED_KEY, '1'); } catch (e) { /* ignore */ }
        }).catch(function () {
          // Autoplay blocked — try WebAudio, else surface the CTA.
          if (!playWebAudioChime(type)) {
            noteBlocked();
            onBlocked && onBlocked();
          } else {
            // WebAudio ran but gesture may still be required for future plays.
            var ctx = ensureContext();
            if (ctx && ctx.state === 'suspended') {
              noteBlocked();
              onBlocked && onBlocked();
            } else {
              unlocked = true;
              try { localStorage.setItem(LOCKED_KEY, '1'); } catch (e) { /* ignore */ }
            }
          }
        });
      }
    } catch (e) {
      if (!playWebAudioChime(type)) {
        noteBlocked();
        onBlocked && onBlocked();
      }
    }
  }

  function play(type) {
    if (!enabled()) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    // Prefer the real sound file (/assets/sounds/new-order.mp3) for every
    // alert type so kitchen staff hear the actual production chime.
    playFile(type || 'order');
  }

  function normalizeLoopInterval(value) {
    var interval = Number(value);
    if (!isFinite(interval) || interval <= 0) return LOOP_DEFAULT_INTERVAL_MS;
    return Math.min(LOOP_MAX_INTERVAL_MS, Math.max(LOOP_MIN_INTERVAL_MS, interval));
  }

  function isLooping(key) {
    return !!(key && activeLoops[key]);
  }

  /**
   * Is ANY alert loop still running?
   *
   * Every loop shares the single `audioEl`, so one loop stopping must NOT pause
   * that element while another loop is still ringing - doing so silences a
   * different, still-unacknowledged order, which is exactly the "the sound cut
   * out on its own" bug. Callers use this to decide whether it is safe to pause.
   */
  function anyLooping() {
    return Object.keys(activeLoops).length > 0;
  }

  function stopPlayback() {
    if (!audioEl) return false;
    try {
      audioEl.pause();
      audioEl.currentTime = 0;
      try { audioEl.load(); } catch (e) { /* ignore */ }
      return true;
    } catch (e) {
      return false;
    }
  }

  function stopLoop(key) {
    var loop = key && activeLoops[key];
    if (!loop) return false;
    if (loop.intervalId) clearInterval(loop.intervalId);
    if (loop.timeoutId) clearTimeout(loop.timeoutId);
    delete activeLoops[key];
    // Only cut the shared element once the LAST loop is gone, so acknowledging
    // one notification never silences another unread one.
    if (!anyLooping()) stopPlayback();
    try {
      document.dispatchEvent(new CustomEvent('scos:sound:loop-stopped', {
        detail: { key: key, type: loop.type, reason: loop.reason || 'stopped' }
      }));
    } catch (e) { /* ignore */ }
    return true;
  }

  function stopAllLoops() {
    var keys = Object.keys(activeLoops);
    keys.forEach(function (key) { stopLoop(key); });
    if (!keys.length) stopPlayback();
    return keys.length;
  }

  function startLoop(key, type, options) {
    if (!key) return false;
    if (!enabled()) return false;
    if (activeLoops[key]) return false;

    var opts = options || {};
    var intervalMs = normalizeLoopInterval(opts.intervalMs);
    var requested = opts.maxDurationMs;
    // `maxDurationMs: Infinity` opts out of the runaway backstop so a loop
    // repeats until it is explicitly stopped. The kitchen new-order alert needs
    // this: it must keep ringing until staff acknowledge the order. Omitting
    // the option keeps the default cap for every other caller.
    var unlimited = requested === Infinity || requested === 'infinite';
    var requestedDuration = Number(requested);
    var maxDurationMs = unlimited
      ? Infinity
      : (isFinite(requestedDuration) && requestedDuration > 0
        ? Math.min(LOOP_MAX_DURATION_MS, requestedDuration)
        : LOOP_MAX_DURATION_MS);
    var startedAt = Date.now();
    var loop = { type: type || 'order', intervalId: null, timeoutId: null, kick: null };
    activeLoops[key] = loop;

    var repeat = function () {
      if (!activeLoops[key]) return;
      if (isFinite(maxDurationMs) && Date.now() - startedAt >= maxDurationMs) {
        loop.reason = 'max-duration';
        stopLoop(key);
        return;
      }
      play(loop.type);
    };
    loop.kick = repeat;

    loop.intervalId = setInterval(repeat, intervalMs);
    if (isFinite(maxDurationMs)) {
      loop.timeoutId = setTimeout(function () {
        if (activeLoops[key]) loop.reason = 'max-duration';
        stopLoop(key);
      }, maxDurationMs);
    }
    repeat();

    try {
      document.dispatchEvent(new CustomEvent('scos:sound:loop-started', {
        detail: { key: key, type: loop.type, intervalMs: intervalMs, maxDurationMs: maxDurationMs }
      }));
    } catch (e) { /* ignore */ }
    return true;
  }

  function unlock(source) {
    markUnlocked(source || 'api');
    return unlocked;
  }

  function toggle(on) {
    try {
      localStorage.setItem('scos_notify_sound', on ? '1' : '0');
    } catch (e) { /* ignore */ }
    if (on) {
      // Turning sound ON is a user gesture — unlock playback.
      markUnlocked('toggle-on');
    }
  }

  var TYPE_MAP = {
    'scos:notify:order': 'order',
    'scos:notify:delivery': 'delivery',
    'scos:notify:cancellation': 'cancellation',
    'scos:notify:emergency': 'emergency',
    'scos:notify:info': 'info'
  };
  // Keys already played this session — avoids replaying the same alert
  // (socket reconnects, polling refreshes, status re-emits).
  var playedKeys = Object.create(null);

  function shouldPlay(detail) {
    if (!detail || !detail.notifyKey) return true;
    if (playedKeys[detail.notifyKey]) return false;
    playedKeys[detail.notifyKey] = true;
    return true;
  }

  function bind() {
    bindGestureUnlock();
    Object.keys(TYPE_MAP).forEach(function (eventName) {
      document.addEventListener(eventName, function (e) {
        var detail = (e && e.detail) || {};
        if (!enabled() || (typeof document !== 'undefined' && document.hidden)) return;
        if (!shouldPlay(detail)) return;
        play(TYPE_MAP[eventName]);
      });
    });
    // Resume context as soon as the page has been interacted with.
    ['pointerdown', 'keydown'].forEach(function (evt) {
      document.addEventListener(evt, function () {
        var ctx = ensureContext();
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
        if (!unlocked) markUnlocked('interaction');
      }, { passive: true });
    });
    // Any still-running alert loop retries its own tone as soon as playback
    // becomes available, so a locked tab is not left silent.
    document.addEventListener('scos:sound:unlocked', function () {
      Object.keys(activeLoops).forEach(function (key) {
        var loop = activeLoops[key];
        if (loop && typeof loop.kick === 'function') loop.kick();
      });
    });
    // A loop that started while the tab was in the background is silent
    // (play() skips hidden tabs), so re-kick it the moment the tab is shown
    // again instead of waiting for the next interval tick.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      Object.keys(activeLoops).forEach(function (key) {
        var loop = activeLoops[key];
        if (loop && typeof loop.kick === 'function') loop.kick();
      });
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bind);
    } else {
      bind();
    }
  }

  // If this browser already unlocked in a prior session, treat as unlocked
  // when the audio context is (or can become) running without a new gesture.
  try {
    if (localStorage.getItem(LOCKED_KEY) === '1') {
      var ctx0 = ensureContext();
      if (ctx0 && ctx0.state === 'running') unlocked = true;
    }
  } catch (e) { /* ignore */ }

  global.ScosNotify = {
    play: play,
    startLoop: startLoop,
    stopLoop: stopLoop,
    stopAllLoops: stopAllLoops,
    stopPlayback: stopPlayback,
    isLooping: isLooping,
    anyLooping: anyLooping,
    /** Re-trigger every running loop immediately (used when restoring state). */
    kickAllLoops: function () {
      Object.keys(activeLoops).forEach(function (key) {
        var loop = activeLoops[key];
        if (loop && typeof loop.kick === 'function') loop.kick();
      });
      return Object.keys(activeLoops).length;
    },
    toggle: toggle,
    enabled: enabled,
    unlock: unlock,
    isUnlocked: isUnlocked,
    isBlocked: isBlocked,
    // Emergency alarm control. The manager dashboard calls stopEmergency() once
    // a manager has acknowledged, which is the only thing that silences it.
    stopEmergency: function () {
      stopLoop('emergency');
      try {
        if (emergencyEl) {
          emergencyEl.pause();
          emergencyEl.currentTime = 0;
          try { emergencyEl.load(); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    },
    isEmergencyLooping: function () { return isLooping('emergency'); },
    LOOP_MIN_INTERVAL_MS: LOOP_MIN_INTERVAL_MS,
    LOOP_MAX_INTERVAL_MS: LOOP_MAX_INTERVAL_MS,
    LOOP_DEFAULT_INTERVAL_MS: LOOP_DEFAULT_INTERVAL_MS,
    LOOP_MAX_DURATION_MS: LOOP_MAX_DURATION_MS,
    AUDIO_URL: AUDIO_URL
  };
})(typeof window !== 'undefined' ? window : globalThis);
