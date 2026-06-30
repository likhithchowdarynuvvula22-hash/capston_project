/**
 * EduStar Client API — edustar-client-api.js
 *
 * Purpose:
 * ────────
 * This module is a lightweight browser-side REST client that wraps all
 * fetch() calls to the EduStar backend. It is loaded as a plain <script>
 * tag and exposes a single global object: window.EduStarAPI.
 *
 * Design Decisions:
 * ─────────────────
 * • IIFE (Immediately Invoked Function Expression) — wraps all code in a
 *   local scope to avoid polluting the global namespace, except for the
 *   intentional window.EduStarAPI export at the end.
 * • Device-ID identity model — no login or account is required. Each browser
 *   generates a unique opaque ID stored in localStorage. All data on the
 *   server is keyed to this ID. Clearing localStorage effectively "resets"
 *   the learner's device identity.
 * • Local-first caching — the user's display name is also saved to localStorage
 *   so pages render correctly even before the server responds.
 *
 * Agent / Tool-Use Notes:
 * ───────────────────────
 * The initNameModal() function acts as an onboarding agent step — it
 * detects first-time visitors (no stored name), presents a UI prompt,
 * collects the learner's name, and persists it both locally and to the
 * server. This is the "input collection" tool in the broader EduStar
 * agent pipeline.
 *
 * Security:
 * ─────────
 * ⚠️  No API keys, secrets, or credentials are stored or transmitted here.
 *     All requests are relative-path fetches to the same origin.
 */

(() => {
  // ── Storage keys ──────────────────────────────────────────────────────────
  // Centralised constants prevent key-name typos across pages.
  const STORAGE_KEY = 'edustar-device-id';
  const NAME_KEY    = 'edustar-user-name';

  /* ── Device ID ─────────────────────────────────────────────── */

  /**
   * Generates a new unique device ID.
   * Format: "edustar-{timestamp}-{8 random hex chars}"
   * Collision probability is negligible for a single-user browser context.
   *
   * @returns {string} A new opaque device identifier.
   */
  function createDeviceId() {
    return `edustar-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  /**
   * Returns the current device's ID, creating and persisting one if it
   * doesn't exist yet. This is the primary identity mechanism — no login needed.
   *
   * Behaviour: idempotent. Calling getDeviceId() multiple times always
   * returns the same value for a given browser session/localStorage.
   *
   * @returns {string} The device's persistent identifier.
   */
  function getDeviceId() {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) {
      return existing;
    }
    const created = createDeviceId();
    window.localStorage.setItem(STORAGE_KEY, created);
    return created;
  }

  /* ── User Name ──────────────────────────────────────────────── */

  /**
   * Returns the learner's display name from localStorage.
   * Returns '' (empty string) if no name has been set yet.
   *
   * Design: name is stored locally for instant access without a server
   * round-trip, then synced to the backend for persistence across devices.
   *
   * @returns {string} The learner's display name, or ''.
   */
  function getUserName() {
    return window.localStorage.getItem(NAME_KEY) || '';
  }

  /**
   * Saves the learner's display name locally and asynchronously persists it
   * to the backend via POST /api/name.
   *
   * Design: "fire and forget" server sync — the local save is synchronous
   * and immediate; the server call failure is caught and logged without
   * blocking or alerting the learner (non-critical path).
   *
   * @param {string} name - Raw name input from the learner.
   * @returns {string} The trimmed, saved name (may be '' if input was blank).
   */
  function saveUserName(name) {
    const trimmed = String(name || '').trim().slice(0, 40);
    if (trimmed) {
      window.localStorage.setItem(NAME_KEY, trimmed);
      // Persist to server silently — failure doesn't break the UX
      const deviceId = getDeviceId();
      requestJson('/api/name', {
        method: 'POST',
        body: JSON.stringify({ deviceId, userName: trimmed }),
      }).catch((err) => {
        console.error('[EduStar] name persistence failed:', err.message);
      });
    }
    return trimmed;
  }

  /* ── Name Modal (Onboarding Agent Step) ─────────────────────── */

  /**
   * Onboarding modal — collects the learner's display name on first visit.
   *
   * Agent Behaviour:
   * ────────────────
   * This function implements the "input collection" step of the EduStar
   * onboarding agent:
   *   1. Check if a name already exists (short-circuit if so).
   *   2. Inject a blocking modal overlay into the DOM.
   *   3. Wait for a valid name input (≥ 2 characters).
   *   4. Save locally + sync to server via saveUserName().
   *   5. Dismiss the modal and resolve the promise.
   *
   * UI Details:
   * ───────────
   * • CSS is injected programmatically (no external stylesheet dependency).
   * • The modal is accessible: role="dialog", aria-modal, aria-labelledby.
   * • The input receives focus after the open animation to support keyboard
   *   users without jarring visual jumps.
   * • Error messages use aria-live="polite" so screen readers announce them.
   * • Pressing Enter submits the form (matches natural keyboard behaviour).
   *
   * @returns {Promise<string>} Resolves with the learner's saved display name.
   */
  function initNameModal() {
    return new Promise((resolve) => {
      const existingName = getUserName();
      // Already named — resolve immediately without showing the modal
      if (existingName) {
        resolve(existingName);
        return;
      }

      // ── Inject modal CSS (once only — guarded by ID check) ────────────
      const styleId = 'es-name-modal-style';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
          .es-name-modal-overlay {
            position: fixed;
            inset: 0;
            z-index: 9999;
            display: grid;
            place-items: center;
            background: rgba(10, 14, 39, .95);
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            animation: es-nm-fade-in .4s ease;
          }
          .es-name-modal-overlay.is-hidden { display: none; }
          @keyframes es-nm-fade-in {
            from { opacity: 0; }
            to   { opacity: 1; }
          }
          .es-name-modal-card {
            background: linear-gradient(135deg, rgba(26,35,90,.97), rgba(10,14,39,.99));
            border: 1px solid rgba(255,215,0,.22);
            border-radius: 28px;
            padding: 2.8rem 2.2rem 2.4rem;
            text-align: center;
            max-width: 440px;
            width: 90%;
            box-shadow: 0 12px 60px rgba(0,0,0,.6), 0 0 80px rgba(255,215,0,.07);
            animation: es-nm-pop .45s cubic-bezier(.2,.9,.2,1.15) both;
          }
          @keyframes es-nm-pop {
            from { transform: scale(.88) translateY(24px); opacity: 0; }
            to   { transform: scale(1)  translateY(0);    opacity: 1; }
          }
          .es-name-modal-rocket {
            font-size: 3rem;
            margin-bottom: .6rem;
            display: block;
            animation: es-nm-wobble 2s ease-in-out infinite;
          }
          @keyframes es-nm-wobble {
            0%, 100% { transform: translateY(0) rotate(-4deg); }
            50%       { transform: translateY(-8px) rotate(4deg); }
          }
          .es-name-modal-title {
            font-family: 'Poppins', 'Outfit', system-ui, sans-serif;
            font-size: 1.75rem;
            font-weight: 800;
            color: #FFD700;
            margin: 0 0 .3rem;
            text-shadow: 0 0 20px rgba(255,215,0,.25);
          }
          .es-name-modal-sub {
            color: rgba(245,247,255,.65);
            font-size: .95rem;
            margin: 0 0 1.5rem;
          }
          .es-name-modal-input {
            width: 100%;
            padding: .85rem 1.3rem;
            border-radius: 999px;
            border: 1.5px solid rgba(255,215,0,.28);
            background: rgba(255,255,255,.07);
            color: #f5f7ff;
            font-size: 1.08rem;
            font-weight: 600;
            text-align: center;
            outline: none;
            box-sizing: border-box;
            transition: border-color .2s, box-shadow .2s;
            caret-color: #FFD700;
          }
          .es-name-modal-input::placeholder { color: rgba(255,255,255,.3); }
          .es-name-modal-input:focus {
            border-color: #FFD700;
            box-shadow: 0 0 0 3px rgba(255,215,0,.18), 0 0 20px rgba(255,215,0,.15);
          }
          .es-name-modal-error {
            color: #ff6b6b;
            font-size: .84rem;
            margin-top: .45rem;
            min-height: 1.1rem;
            transition: opacity .2s;
          }
          .es-name-modal-btn {
            display: block;
            width: 100%;
            margin-top: 1.3rem;
            padding: .85rem 2rem;
            border-radius: 999px;
            border: none;
            background: linear-gradient(135deg, #FFD700, #F0A500);
            color: #1a1200;
            font-weight: 800;
            font-size: 1.05rem;
            cursor: pointer;
            transition: transform .15s, box-shadow .15s;
            letter-spacing: .02em;
          }
          .es-name-modal-btn:hover {
            transform: scale(1.04);
            box-shadow: 0 6px 28px rgba(255,215,0,.45);
          }
          .es-name-modal-btn:active { transform: scale(.98); }
          .es-name-modal-hint {
            margin-top: .8rem;
            font-size: .8rem;
            color: rgba(245,247,255,.35);
          }
        `;
        document.head.appendChild(style);
      }

      // ── Inject modal HTML ──────────────────────────────────────────────
      const overlay = document.createElement('div');
      overlay.className = 'es-name-modal-overlay';
      overlay.id = 'es-name-modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'es-nm-title');
      overlay.innerHTML = `
        <div class="es-name-modal-card">
          <span class="es-name-modal-rocket" aria-hidden="true">🚀</span>
          <h2 class="es-name-modal-title" id="es-nm-title">Welcome to EduStar!</h2>
          <p class="es-name-modal-sub">What is your name, Explorer?</p>
          <input class="es-name-modal-input" id="es-nm-input" type="text"
            placeholder="Enter your name…" maxlength="40" autocomplete="off" spellcheck="false">
          <div class="es-name-modal-error" id="es-nm-error" aria-live="polite"></div>
          <button class="es-name-modal-btn" id="es-nm-btn">Let's Go! 🚀</button>
          <p class="es-name-modal-hint">Your progress will be saved automatically.</p>
        </div>
      `;
      document.body.appendChild(overlay);

      const input   = overlay.querySelector('#es-nm-input');
      const errorEl = overlay.querySelector('#es-nm-error');
      const btn     = overlay.querySelector('#es-nm-btn');

      // Focus with short delay to allow animation to settle (avoids
      // layout shifts that can confuse screen readers during animation).
      requestAnimationFrame(() => setTimeout(() => input.focus(), 120));

      /**
       * Validates the input and saves the name if valid.
       * Shows inline error messages for invalid inputs instead of alerting.
       */
      function attemptSave() {
        const raw = input.value.trim();
        if (!raw) {
          errorEl.textContent = 'Please enter your name to continue.';
          input.focus();
          return;
        }
        if (raw.length < 2) {
          errorEl.textContent = 'Name must be at least 2 characters.';
          input.focus();
          return;
        }
        const name = saveUserName(raw);
        overlay.classList.add('is-hidden'); // hide without destroying the DOM node
        resolve(name);
      }

      // ── Event listeners ────────────────────────────────────────────────
      btn.addEventListener('click', attemptSave);
      // Enter key support for keyboard-first users
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptSave(); });
      // Clear error on new input so old messages don't persist confusingly
      input.addEventListener('input',   () => { errorEl.textContent = ''; });
    });
  }

  /* ── HTTP helper ────────────────────────────────────────────── */

  /**
   * Wraps fetch() with JSON Content-Type defaults and error normalisation.
   *
   * Design: all API calls in EduStar go through this helper so that:
   *   • Content-Type is always set correctly for JSON payloads.
   *   • Non-2xx responses are converted to thrown Errors (not silently ignored).
   *   • Response body is always parsed as JSON for callers.
   *
   * @param {string} path - Relative URL path (e.g. '/api/progress').
   * @param {RequestInit} [options={}] - Standard fetch() options.
   * @returns {Promise<any>} Parsed JSON response body.
   * @throws {Error} On network failure or non-2xx HTTP status.
   */
  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || `Request failed: ${response.status}`);
    }
    return response.json();
  }

  // ── Public API export ──────────────────────────────────────────────────────
  // Only the functions that page scripts need are exported.
  // Internal helpers (createDeviceId, attemptSave) remain private to the IIFE.
  window.EduStarAPI = {
    getDeviceId,    // Get or create the device's persistent ID
    getUserName,    // Get the learner's display name from localStorage
    saveUserName,   // Save name locally + sync to server
    initNameModal,  // Show onboarding name-collection modal (first visit only)
    requestJson,    // Fetch wrapper for all backend API calls
  };
})();
