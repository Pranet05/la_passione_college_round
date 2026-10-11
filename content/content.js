// content.js - Virtual Pointer Overlay, DOM Actions, Dictation Engine & Speech Indicator

// --- 1. Mount Hardware-Accelerated Virtual Cursor with Sticky Hold Ring ---
let cursorEl = document.getElementById('handsfree-virtual-pointer');
let holdRingProgress = null;
let pointerDot = null;

if (!cursorEl) {
  cursorEl = document.createElement('div');
  cursorEl.id = 'handsfree-virtual-pointer';
  Object.assign(cursorEl.style, {
    position: 'fixed',
    top: '0px',
    left: '0px',
    width: '36px',
    height: '36px',
    pointerEvents: 'none',
    zIndex: '2147483647',
    transform: 'translate3d(-50%, -50%, 0)',
    willChange: 'transform',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'opacity 0.15s ease'
  });

  // SVG circular progress ring for Sticky Hold Dwell
  cursorEl.innerHTML = `
    <svg style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible;" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2" />
      <circle id="handsfree-hold-progress" cx="18" cy="18" r="14" fill="none" stroke="#38bdf8" stroke-width="2.5"
        stroke-dasharray="87.96" stroke-dashoffset="87.96" stroke-linecap="round" style="transition: stroke-dashoffset 0.05s linear;" />
    </svg>
    <div id="handsfree-pointer-dot" style="
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background-color: rgba(239, 68, 68, 0.95);
      border: 2px solid #ffffff;
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.8), 0 0 3px rgba(0,0,0,0.5);
      transition: transform 0.12s ease, background-color 0.15s ease, box-shadow 0.15s ease;
    "></div>
  `;

  const mount = () => {
    if (!document.getElementById('handsfree-virtual-pointer')) {
      const parent = document.body || document.documentElement;
      if (parent) {
        parent.appendChild(cursorEl);
        holdRingProgress = document.getElementById('handsfree-hold-progress');
        pointerDot = document.getElementById('handsfree-pointer-dot');
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
}

// --- 2. Microphone Overlay Indicator (bottom-right, appears during speech) ---
let micOverlay = null;
let micToast = null;

function createMicOverlay() {
  if (micOverlay) return;

  micOverlay = document.createElement('div');
  micOverlay.id = 'handsfree-mic-overlay';
  micOverlay.innerHTML = `
    <style>
      @keyframes handsfree-mic-pulse {
        0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
        50% { transform: scale(1.08); box-shadow: 0 0 0 12px rgba(239, 68, 68, 0); }
      }
      @keyframes handsfree-ripple-ring {
        0% { transform: translate(-50%, -50%) scale(0.6); opacity: 1; }
        100% { transform: translate(-50%, -50%) scale(2.2); opacity: 0; }
      }
      @keyframes handsfree-bar-dance {
        0%, 100% { transform: scaleY(0.3); }
        50% { transform: scaleY(1.0); }
      }
      @keyframes handsfree-toast-in {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes handsfree-toast-out {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(8px); }
      }
      #handsfree-mic-overlay {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483646;
        pointer-events: none;
        user-select: none;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .handsfree-mic-badge {
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: linear-gradient(135deg, #dc2626, #ef4444);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 20px rgba(239, 68, 68, 0.5), 0 0 0 3px rgba(239, 68, 68, 0.2);
        animation: handsfree-mic-pulse 1.4s ease-in-out infinite;
        position: relative;
        opacity: 0;
        transition: opacity 0.25s ease;
      }
      .handsfree-mic-badge.active {
        opacity: 1;
      }
      .handsfree-mic-badge svg {
        width: 24px;
        height: 24px;
        fill: white;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
      }
      .handsfree-mic-bars {
        display: flex;
        align-items: center;
        gap: 3px;
        position: absolute;
        bottom: -8px;
        left: 50%;
        transform: translateX(-50%);
      }
      .handsfree-mic-bar {
        width: 3px;
        height: 14px;
        border-radius: 2px;
        background: white;
        transform-origin: bottom;
        animation: handsfree-bar-dance 0.6s ease-in-out infinite;
      }
      .handsfree-mic-bar:nth-child(1) { animation-delay: 0s; height: 10px; }
      .handsfree-mic-bar:nth-child(2) { animation-delay: 0.15s; height: 14px; }
      .handsfree-mic-bar:nth-child(3) { animation-delay: 0.3s; height: 8px; }
      .handsfree-mic-bar:nth-child(4) { animation-delay: 0.1s; height: 12px; }
      .handsfree-mic-bar:nth-child(5) { animation-delay: 0.25s; height: 10px; }
      .handsfree-ripple {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        border: 2px solid rgba(239, 68, 68, 0.5);
        transform: translate(-50%, -50%) scale(0.6);
        animation: handsfree-ripple-ring 1.6s ease-out infinite;
        pointer-events: none;
      }
      .handsfree-ripple:nth-child(2) { animation-delay: 0.4s; }
      .handsfree-ripple:nth-child(3) { animation-delay: 0.8s; }
      .handsfree-mic-toast {
        background: rgba(15, 23, 42, 0.95);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: #f1f5f9;
        padding: 10px 16px;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.2);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        font-size: 13px;
        font-weight: 500;
        max-width: 300px;
        word-break: break-word;
        opacity: 0;
        transform: translateY(8px);
        pointer-events: none;
      }
      .handsfree-mic-toast.show {
        animation: handsfree-toast-in 0.25s ease forwards;
      }
      .handsfree-mic-toast.hide {
        animation: handsfree-toast-out 0.25s ease forwards;
      }
    </style>
    <div class="handsfree-mic-toast" id="handsfree-mic-toast"></div>
    <div class="handsfree-mic-badge" id="handsfree-mic-badge">
      <div class="handsfree-ripple"></div>
      <div class="handsfree-ripple"></div>
      <div class="handsfree-ripple"></div>
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
      </svg>
      <div class="handsfree-mic-bars">
        <div class="handsfree-mic-bar"></div>
        <div class="handsfree-mic-bar"></div>
        <div class="handsfree-mic-bar"></div>
        <div class="handsfree-mic-bar"></div>
        <div class="handsfree-mic-bar"></div>
      </div>
    </div>
  `;

  const mountOverlay = () => {
    const parent = document.body || document.documentElement;
    if (parent && !document.getElementById('handsfree-mic-overlay')) {
      parent.appendChild(micOverlay);
      micToast = document.getElementById('handsfree-mic-toast');
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountOverlay);
  } else {
    mountOverlay();
  }
}

// Initialize the mic overlay immediately
createMicOverlay();

// --- Speech State Management ---
let speechFrozen = false;
let frozenX = 0;
let frozenY = 0;
let toastHideTimeout = null;

function showMicActive() {
  const badge = document.getElementById('handsfree-mic-badge');
  if (badge) badge.classList.add('active');
  
  // Freeze the cursor at its current position
  speechFrozen = true;
  frozenX = currentScreenX;
  frozenY = currentScreenY;
  
  // Add speech-detected ripple effect around the frozen cursor
  if (pointerDot) {
    pointerDot.style.backgroundColor = '#f59e0b';
    pointerDot.style.boxShadow = '0 0 16px rgba(245, 158, 11, 0.9), 0 0 32px rgba(245, 158, 11, 0.4)';
  }
}

function hideMicActive() {
  const badge = document.getElementById('handsfree-mic-badge');
  if (badge) badge.classList.remove('active');
  
  // Unfreeze cursor
  speechFrozen = false;
  
  // Restore cursor appearance
  if (pointerDot && !isHoldingDrag) {
    pointerDot.style.backgroundColor = 'rgba(239, 68, 68, 0.95)';
    pointerDot.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.8), 0 0 3px rgba(0,0,0,0.5)';
  }
}

function showCommandToast(text, duration = 3000) {
  if (!micToast) micToast = document.getElementById('handsfree-mic-toast');
  if (!micToast) return;
  
  clearTimeout(toastHideTimeout);
  micToast.textContent = text;
  micToast.className = 'handsfree-mic-toast show';
  
  toastHideTimeout = setTimeout(() => {
    micToast.className = 'handsfree-mic-toast hide';
  }, duration);
}

// Coordinate state
let currentScreenX = window.innerWidth / 2;
let currentScreenY = window.innerHeight / 2;
let targetScreenX = currentScreenX;
let targetScreenY = currentScreenY;
let lastHoveredElement = null;
let rafScheduled = false;

// Sticky Hold State
let stickyHoldEnabled = true;
let dwellDurationMs = 1000;
let dwellStartTime = null;
let dwellTargetElement = null;
let dwellAnchorX = 0;
let dwellAnchorY = 0;
let dwellCooldownUntil = 0;
let isHoldingDrag = false;
let holdDragTarget = null;
let clickableOverlay = null;
let numberedClickTargets = [];

// Zoom state
let currentZoomLevel = 1.0;

// Track mouse position if physical mouse is used
document.addEventListener('mousemove', (e) => {
  lastHoveredElement = e.target;
}, { passive: true });

// --- 3. Focus Monitoring for Automatic Mode Switching ---
function isTextInput(el) {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return (
    tag === 'textarea' ||
    (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(el.type)) ||
    el.isContentEditable ||
    el.getAttribute?.('role') === 'textbox' ||
    Boolean(el.closest?.('[contenteditable="true"]'))
  );
}

document.addEventListener('focusin', (e) => {
  if (isTextInput(e.target)) {
    browser.runtime.sendMessage({ type: 'SET_MODE', mode: 'DICTATION' });
  }
});

document.addEventListener('focusout', (e) => {
  if (isTextInput(e.target)) {
    browser.runtime.sendMessage({ type: 'SET_MODE', mode: 'NAVIGATION' });
  }
});

// Helper: Find closest scrollable ancestor
function findScrollableElement(startX, startY) {
  let el = document.elementFromPoint(startX, startY);
  while (el && el !== document.body && el !== document.documentElement) {
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const canScroll = (overflowY === 'auto' || overflowY === 'scroll') && (el.scrollHeight > el.clientHeight);
    if (canScroll) {
      return el;
    }
    el = el.parentElement;
  }
  return document.scrollingElement || document.documentElement || window;
}

// Helper: Locate interactive clickable element
function getClickableAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || el === document.body || el === document.documentElement) return null;
  return el.closest('a, button, [role="button"], input, select, textarea, [tabindex], label');
}

<<<<<<< Updated upstream
// --- 4. Ultra-Smooth RequestAnimationFrame Cursor Loop with Sticky Snapping ---
=======
function isVisibleElement(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 &&
    style.visibility !== 'hidden' && style.display !== 'none';
}

function getSearchField() {
  const selectors = [
    '#searchInput',
    'input[type="search"]',
    'input[name="q"]',
    'textarea[name="q"]',
    'input[name="search_query"]',
    'input[name="search"]',
    'textarea[name="search"]',
    '[role="searchbox"]',
    'input[aria-label*="search" i]',
    'textarea[aria-label*="search" i]',
    'input[placeholder*="search" i]',
    'textarea[placeholder*="search" i]',
    '.cdx-text-input__input'
  ];

  for (const selector of selectors) {
    const field = document.querySelector(selector);
    if (field && isVisibleElement(field) && !field.disabled && !field.readOnly) return field;
  }

  return [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
    .find((field) => {
      const metadata = [
        field.getAttribute('aria-label'),
        field.getAttribute('placeholder'),
        field.getAttribute('name'),
        field.id
      ].filter(Boolean).join(' ').toLowerCase();
      return isVisibleElement(field) && !field.disabled && !field.readOnly && metadata.includes('search');
    }) || null;
}

function getPageClickables() {
  const candidates = [...document.querySelectorAll(
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
  )];
  const seen = new Set();
  return candidates.filter((el) => {
    if (seen.has(el) || !isVisibleElement(el)) return false;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0 &&
      rect.left < window.innerWidth && rect.right > 0;
  }).slice(0, 100);
}

function removeClickableOverlay() {
  if (clickableOverlay) clickableOverlay.remove();
  clickableOverlay = null;
  numberedClickTargets = [];
}

function showClickableOverlay() {
  removeClickableOverlay();
  numberedClickTargets = getPageClickables();
  if (!numberedClickTargets.length) return;

  clickableOverlay = document.createElement('div');
  clickableOverlay.id = 'handsfree-clickable-overlay';
  Object.assign(clickableOverlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483646',
    pointerEvents: 'none'
  });

  numberedClickTargets.forEach((target, index) => {
    const rect = target.getBoundingClientRect();
    const badge = document.createElement('span');
    badge.textContent = String(index + 1);
    Object.assign(badge.style, {
      position: 'fixed',
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      minWidth: '22px',
      height: '22px',
      padding: '2px 5px',
      border: '2px solid #fff',
      borderRadius: '6px',
      background: '#dc2626',
      color: '#fff',
      font: 'bold 13px/14px sans-serif',
      textAlign: 'center',
      boxShadow: '0 1px 5px rgba(0,0,0,.65)'
    });
    clickableOverlay.appendChild(badge);
  });

  document.documentElement.appendChild(clickableOverlay);
}

function clickNumber(index) {
  const target = numberedClickTargets[index - 1];
  if (!target || !document.contains(target)) return;
  removeClickableOverlay();
  target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  setTimeout(() => triggerClick(
    target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2,
    target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2,
    target
  ), 80);
}

// --- 3. Ultra-Smooth RequestAnimationFrame Cursor Loop with Sticky Snapping ---
>>>>>>> Stashed changes
function updateCursorRender() {
  rafScheduled = false;

  // If speech is frozen, keep cursor at frozen position
  if (speechFrozen) {
    if (cursorEl) {
      cursorEl.style.transform = `translate3d(${frozenX - 18}px, ${frozenY - 18}px, 0)`;
    }
    // Still schedule next frame for when it unfreezes
    return;
  }

  // Sticky magnetic friction over clickable targets
  const clickable = getClickableAt(targetScreenX, targetScreenY);
  if (clickable) {
    const rect = clickable.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    // Gentle magnetic attraction towards center of button/link
    currentScreenX = currentScreenX + (targetScreenX - currentScreenX) * 0.75 + (centerX - currentScreenX) * 0.08;
    currentScreenY = currentScreenY + (targetScreenY - currentScreenY) * 0.75 + (centerY - currentScreenY) * 0.08;
  } else {
    currentScreenX += (targetScreenX - currentScreenX) * 0.9;
    currentScreenY += (targetScreenY - currentScreenY) * 0.9;
  }

  if (cursorEl) {
    cursorEl.style.transform = `translate3d(${currentScreenX - 18}px, ${currentScreenY - 18}px, 0)`;
  }

  // Update drag event coordinates if in voice HOLD state
  if (isHoldingDrag && holdDragTarget) {
    const mouseInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: currentScreenX,
      clientY: currentScreenY
    };
    holdDragTarget.dispatchEvent(new MouseEvent('mousemove', mouseInit));
  }

  // Handle Sticky Dwell Hold Progress
  checkStickyDwellHold(clickable);
}

// --- 5. Sticky Dwell Hold Engine (Hold Still to Auto-Click) ---
function checkStickyDwellHold(clickable) {
  const now = performance.now();

  if (!stickyHoldEnabled || isHoldingDrag || now < dwellCooldownUntil || speechFrozen) {
    resetDwellRing();
    return;
  }

  if (clickable) {
    const distFromAnchor = Math.hypot(currentScreenX - dwellAnchorX, currentScreenY - dwellAnchorY);

    if (dwellTargetElement === clickable && distFromAnchor < 24) {
      const elapsed = now - dwellStartTime;
      const progress = Math.min(1.0, elapsed / dwellDurationMs);

      // 87.96 is circle circumference (2 * PI * 14)
      if (holdRingProgress) {
        const offset = 87.96 * (1.0 - progress);
        holdRingProgress.style.strokeDashoffset = `${offset}`;
      }

      if (progress >= 1.0) {
        // Trigger Hold Click!
        triggerClick(currentScreenX, currentScreenY, clickable);
        dwellCooldownUntil = now + 900;
        resetDwellRing();

        // Visual click ripple
        if (pointerDot) {
          pointerDot.style.transform = 'scale(1.8)';
          pointerDot.style.backgroundColor = '#22c55e';
          setTimeout(() => {
            if (pointerDot) {
              pointerDot.style.transform = 'scale(1.0)';
              pointerDot.style.backgroundColor = 'rgba(239, 68, 68, 0.95)';
            }
          }, 200);
        }
      }
    } else {
      // Start dwell on new element or reset anchor
      dwellTargetElement = clickable;
      dwellStartTime = now;
      dwellAnchorX = currentScreenX;
      dwellAnchorY = currentScreenY;
      if (holdRingProgress) {
        holdRingProgress.style.strokeDashoffset = '87.96';
      }
    }
  } else {
    resetDwellRing();
  }
}

function resetDwellRing() {
  dwellTargetElement = null;
  dwellStartTime = null;
  if (holdRingProgress) {
    holdRingProgress.style.strokeDashoffset = '87.96';
  }
}

// --- 6. Message Listener ---
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPDATE_CURSOR') {
    // Don't update target when speech is frozen – the background already blocks these,
    // but double-check here for safety
    if (speechFrozen) return;

    targetScreenX = msg.x * window.innerWidth;
    targetScreenY = msg.y * window.innerHeight;

    if (msg.stickyHold !== undefined) stickyHoldEnabled = msg.stickyHold;
    if (msg.dwellDuration !== undefined) dwellDurationMs = msg.dwellDuration;

    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(updateCursorRender);
    }
  } else if (msg.type === 'SPEECH_ACTIVE') {
    showMicActive();
  } else if (msg.type === 'SPEECH_IDLE') {
    hideMicActive();
  } else if (msg.type === 'COMMAND') {
    handleNavigationCommand(msg.command, msg.payload);
  } else if (msg.type === 'COMMAND_FEEDBACK') {
    if (msg.command) {
      const friendlyNames = {
        'SCROLL': '⬇️ Scrolling',
        'CLICK': '👆 Clicked',
        'DOUBLE_CLICK': '👆👆 Double Clicked',
        'RIGHT_CLICK': '🖱️ Right Clicked',
        'HOLD': '✊ Holding',
        'RELEASE': '🖐️ Released',
        'FOCUS_SEARCH': '🔍 Search Focused',
        'RECENTER': '🎯 Recentered',
        'CLEAR': '🧹 Cleared',
        'GO_BACK': '⬅️ Going Back',
        'GO_FORWARD': '➡️ Going Forward',
        'REFRESH': '🔄 Refreshing',
        'SCROLL_TO_TOP': '⬆️ Top of Page',
        'SCROLL_TO_BOTTOM': '⬇️ Bottom of Page',
        'NEW_TAB': '📄 New Tab',
        'CLOSE_TAB': '❌ Tab Closed',
        'TAB_RIGHT': '➡️ Next Tab',
        'TAB_LEFT': '⬅️ Previous Tab',
        'ZOOM_IN': '🔍+ Zoomed In',
        'ZOOM_OUT': '🔍- Zoomed Out',
        'ZOOM_RESET': '🔍 Zoom Reset',
        'SUBMIT_SEARCH': '🔎 Submitted'
      };
      showCommandToast(friendlyNames[msg.command] || `✅ ${msg.command}`);
    } else {
      showCommandToast(`🎤 "${msg.transcript}" — no command matched`, 2000);
    }
  } else if (msg.type === 'INJECT_TEXT') {
    injectTextIntoActiveElement(msg.text);
  } else if (msg.type === 'MODE_CHANGE') {
    if (msg.mode === 'NAVIGATION') {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    }
  }
});

// --- 7. Command Execution & Click / Hold / Release ---
function handleNavigationCommand(command, payload) {
  switch (command) {
    case 'SCROLL': {
      const scrollTarget = findScrollableElement(currentScreenX, currentScreenY);
      if (scrollTarget && typeof scrollTarget.scrollBy === 'function') {
        scrollTarget.scrollBy({ top: payload.y, behavior: 'smooth' });
      } else {
        window.scrollBy({ top: payload.y, behavior: 'smooth' });
      }
      break;
    }

    case 'SCROLL_TO_TOP': {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      break;
    }

    case 'SCROLL_TO_BOTTOM': {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      break;
    }

    case 'GO_BACK': {
      window.history.back();
      break;
    }

    case 'GO_FORWARD': {
      window.history.forward();
      break;
    }

    case 'REFRESH': {
      window.location.reload();
      break;
    }

    case 'ZOOM_IN': {
      currentZoomLevel = Math.min(3.0, currentZoomLevel + 0.2);
      document.body.style.zoom = currentZoomLevel;
      break;
    }

    case 'ZOOM_OUT': {
      currentZoomLevel = Math.max(0.4, currentZoomLevel - 0.2);
      document.body.style.zoom = currentZoomLevel;
      break;
    }

    case 'ZOOM_RESET': {
      currentZoomLevel = 1.0;
      document.body.style.zoom = 1.0;
      break;
    }

    case 'SUBMIT_SEARCH': {
      const el = document.activeElement;
      if (!el) return;

      console.log('[Handsfree] Submitting search / pressing Enter on:', el);

      const enterOptions = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        view: window
      };

      el.dispatchEvent(new KeyboardEvent('keydown', enterOptions));
      el.dispatchEvent(new KeyboardEvent('keypress', enterOptions));
      el.dispatchEvent(new KeyboardEvent('keyup', enterOptions));

      if (el.form && typeof el.form.requestSubmit === 'function') {
        el.form.requestSubmit();
      } else if (el.form && typeof el.form.submit === 'function') {
        el.form.submit();
      }

      el.blur();
      break;
    }

    case 'CLICK': {
      const clickX = (payload?.x !== undefined) ? (payload.x * window.innerWidth) : currentScreenX;
      const clickY = (payload?.y !== undefined) ? (payload.y * window.innerHeight) : currentScreenY;
      triggerClick(clickX, clickY);
      break;
    }

    case 'DOUBLE_CLICK': {
      const dblX = (payload?.x !== undefined) ? (payload.x * window.innerWidth) : currentScreenX;
      const dblY = (payload?.y !== undefined) ? (payload.y * window.innerHeight) : currentScreenY;
      triggerClick(dblX, dblY);
      setTimeout(() => triggerClick(dblX, dblY), 80);
      break;
    }

    case 'RIGHT_CLICK': {
      const rcX = (payload?.x !== undefined) ? (payload.x * window.innerWidth) : currentScreenX;
      const rcY = (payload?.y !== undefined) ? (payload.y * window.innerHeight) : currentScreenY;
      
      if (cursorEl) cursorEl.style.display = 'none';
      let rcTarget = document.elementFromPoint(rcX, rcY);
      if (cursorEl) cursorEl.style.display = 'flex';

      if (rcTarget) {
        rcTarget.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rcX,
          clientY: rcY,
          button: 2
        }));
      }
      break;
    }

    case 'HOLD': {
      // Sticky Voice Hold (Mouse Down / Drag initiate)
      const holdX = (payload?.x !== undefined) ? (payload.x * window.innerWidth) : currentScreenX;
      const holdY = (payload?.y !== undefined) ? (payload.y * window.innerHeight) : currentScreenY;

      if (cursorEl) cursorEl.style.display = 'none';
      let target = document.elementFromPoint(holdX, holdY);
      if (cursorEl) cursorEl.style.display = 'flex';

      if (!target || target === document.body) target = document.activeElement || document.body;

      isHoldingDrag = true;
      holdDragTarget = target;

      if (pointerDot) {
        pointerDot.style.backgroundColor = '#06b6d4';
        pointerDot.style.boxShadow = '0 0 16px #06b6d4, 0 0 4px #ffffff';
        pointerDot.style.transform = 'scale(1.4)';
      }

      const mouseInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: holdX,
        clientY: holdY
      };

      const createEvent = (evtType) => {
        if (typeof PointerEvent !== 'undefined' && evtType.startsWith('pointer')) {
          return new PointerEvent(evtType, { ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true });
        }
        return new MouseEvent(evtType, mouseInit);
      };

      target.dispatchEvent(createEvent('pointerdown'));
      target.dispatchEvent(createEvent('mousedown'));
      if (typeof target.focus === 'function') target.focus();
      console.log('[Handsfree] Sticky HOLD active on:', target);
      break;
    }

    case 'RELEASE': {
      // Sticky Voice Release (Mouse Up / Drop)
      const relX = (payload?.x !== undefined) ? (payload.x * window.innerWidth) : currentScreenX;
      const relY = (payload?.y !== undefined) ? (payload.y * window.innerHeight) : currentScreenY;

      if (cursorEl) cursorEl.style.display = 'none';
      let target = document.elementFromPoint(relX, relY);
      if (cursorEl) cursorEl.style.display = 'flex';

      const releaseTarget = holdDragTarget || target || document.body;

      const mouseInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: relX,
        clientY: relY
      };

      const createEvent = (evtType) => {
        if (typeof PointerEvent !== 'undefined' && evtType.startsWith('pointer')) {
          return new PointerEvent(evtType, { ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true });
        }
        return new MouseEvent(evtType, mouseInit);
      };

      releaseTarget.dispatchEvent(createEvent('pointerup'));
      releaseTarget.dispatchEvent(createEvent('mouseup'));
      releaseTarget.dispatchEvent(createEvent('click'));

      isHoldingDrag = false;
      holdDragTarget = null;

      if (pointerDot) {
        pointerDot.style.backgroundColor = 'rgba(239, 68, 68, 0.95)';
        pointerDot.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.8)';
        pointerDot.style.transform = 'scale(1.0)';
      }
      console.log('[Handsfree] Sticky RELEASE triggered on:', releaseTarget);
      break;
    }

    case 'FOCUS_SEARCH': {
      const searchBox = getSearchField();
      if (searchBox) {
        if (typeof searchBox.scrollIntoView === 'function') {
          searchBox.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
        searchBox.focus({ preventScroll: true });
        if (typeof searchBox.select === 'function') searchBox.select();
      }
      break;
    }

    case 'SHOW_CLICKABLES':
      showClickableOverlay();
      break;

    case 'HIDE_CLICKABLES':
      removeClickableOverlay();
      break;

    case 'CLICK_NUMBER':
      clickNumber(payload?.index);
      break;

    case 'CLEAR': {
      const el = document.activeElement;
      if (!el || !isTextInput(el)) return;

      if (el.isContentEditable) {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        el.innerText = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }

      el.focus();
      if (typeof el.select === 'function') el.select();
      const deleted = document.execCommand('delete', false, null);

      if (!deleted || el.value !== '') {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set;

        if (nativeSetter) {
          nativeSetter.call(el, '');
        } else {
          el.value = '';
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      break;
    }
  }
}

// Reusable click performer
function triggerClick(clickX, clickY, knownTarget = null) {
  if (cursorEl) cursorEl.style.display = 'none';
  let target = knownTarget || document.elementFromPoint(clickX, clickY);
  if (cursorEl) cursorEl.style.display = 'flex';

  if (!target || target === document.body || target === document.documentElement) {
    target = (lastHoveredElement && lastHoveredElement !== document.body)
      ? lastHoveredElement
      : (document.activeElement !== document.body ? document.activeElement : null);
  }

  if (!target) return;

  const clickable = target.closest('a, button, [role="button"], input, select, textarea, [tabindex], label') || target;

  if (pointerDot) {
    pointerDot.style.transform = 'scale(1.6)';
    setTimeout(() => {
      if (pointerDot) pointerDot.style.transform = 'scale(1.0)';
    }, 140);
  }

  if (typeof clickable.focus === 'function') {
    clickable.focus();
  } else if (typeof target.focus === 'function') {
    target.focus();
  }

  const mouseInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: clickX,
    clientY: clickY
  };

  const createEvent = (evtType) => {
    if (typeof PointerEvent !== 'undefined' && evtType.startsWith('pointer')) {
      return new PointerEvent(evtType, { ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true });
    }
    return new MouseEvent(evtType, mouseInit);
  };

  ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(evtType => {
    target.dispatchEvent(createEvent(evtType));
  });

  if (typeof clickable.click === 'function') {
    clickable.click();
  } else {
    target.dispatchEvent(createEvent('click'));
  }

  // Anchor fallback
  if (clickable.tagName === 'A' && clickable.href && !clickable.href.startsWith('javascript:')) {
    setTimeout(() => {
      if (window.location.href !== clickable.href && !clickable.href.startsWith('#')) {
        window.location.href = clickable.href;
      }
    }, 120);
  }
}

// --- 8. Dictation Text Injection ---
function injectTextIntoActiveElement(text) {
  const el = document.activeElement;
  if (!el || !isTextInput(el)) return;

  const success = document.execCommand('insertText', false, text);
  if (!success && typeof el.value !== 'undefined') {
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    const nextVal = el.value.substring(0, start) + text + el.value.substring(end);

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(el, nextVal);
    } else {
      el.value = nextVal;
    }
    el.selectionStart = el.selectionEnd = start + text.length;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

console.log('[Handsfree Content Script] Active on:', window.location.href);