// content.js - Virtual Pointer Overlay, DOM Actions, Auto-Scroll Engine & Evaluation Telemetry

// --- 1. Mount Hardware-Accelerated Virtual Cursor with Sticky Hold Ring ---
let cursorEl = document.getElementById('handsfree-virtual-pointer');
let holdRingProgress = null;
let pointerDot = null;
let scrollHudEl = null;

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

  // HUD badge for Auto-Scroll speed & state indication
  scrollHudEl = document.createElement('div');
  scrollHudEl.id = 'handsfree-scroll-hud';
  Object.assign(scrollHudEl.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    padding: '8px 14px',
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    color: '#38bdf8',
    border: '1.5px solid #0284c7',
    borderRadius: '20px',
    fontSize: '13px',
    fontWeight: '600',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    pointerEvents: 'none',
    zIndex: '2147483647',
    display: 'none',
    backdropFilter: 'blur(4px)'
  });

  const mount = () => {
    const parent = document.body || document.documentElement;
    if (parent) {
      if (!document.getElementById('handsfree-virtual-pointer')) {
        parent.appendChild(cursorEl);
        holdRingProgress = document.getElementById('handsfree-hold-progress');
        pointerDot = document.getElementById('handsfree-pointer-dot');
      }
      if (!document.getElementById('handsfree-scroll-hud')) {
        parent.appendChild(scrollHudEl);
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
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
// The element most recently activated by dwell. It is not re-armed until the
// cursor leaves it, preventing repeated clicks while the user rests in place.
let lastDwellClickedElement = null;
let isHoldingDrag = false;
let holdDragTarget = null;

// Auto-Scroll State Engine (Crawl starts at 0.25 px/frame)
let isAutoScrolling = false;
let autoScrollSpeed = 0.75;
let autoScrollDirection = 1; // 1 = down, -1 = up
let autoScrollRafId = null;

// Telemetry & Task Evaluation Timers
let taskStartTime = performance.now();
let lastTargetHoverTime = performance.now();
// Link hint overlay state. Hints are viewport-relative and are rebuilt after
// scrolling so their numbers always match what is currently visible.
let linkHintOverlay = null;
let linkHintEntries = [];
let selectedLinkHint = null;
let linkHintRefreshTimer = null;
let linkHintOverlayActive = false;

// Elements treated as interactive targets for dwell / voice clicks.
// tabindex="-1" is excluded: it marks programmatically-focusable containers
// (often whole page regions), not things a user intends to click.
const CLICKABLE_SELECTOR = 'a, button, [role="button"], input, select, textarea, [tabindex]:not([tabindex="-1"]), label';

// Track mouse position if physical mouse is used
document.addEventListener('mousemove', (e) => {
  lastHoveredElement = e.target;
}, { passive: true });

// Stop continuous scrolling on manual user interaction
window.addEventListener('wheel', () => {
  if (isAutoScrolling) stopAutoScroll();
}, { passive: true });

// --- 2. Focus Monitoring for Mode Switching & Highlight Styling ---
function getVisibleLinks() {
  return Array.from(document.querySelectorAll('a[href]')).filter((link) => {
    if (link.closest('#handsfree-link-hints')) return false;
    const rect = link.getBoundingClientRect();
    const style = window.getComputedStyle(link);
    return rect.width > 0 && rect.height > 0 &&
      rect.bottom >= 0 && rect.right >= 0 &&
      rect.top <= window.innerHeight && rect.left <= window.innerWidth &&
      style.visibility !== 'hidden' && style.display !== 'none';
  });
}

function ensureLinkHintOverlay() {
  if (linkHintOverlay) return linkHintOverlay;
  linkHintOverlay = document.createElement('div');
  linkHintOverlay.id = 'handsfree-link-hints';
  Object.assign(linkHintOverlay.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '2147483646',
    fontFamily: 'Arial, sans-serif'
  });
  (document.body || document.documentElement).appendChild(linkHintOverlay);
  return linkHintOverlay;
}

function refreshLinkHints() {
  if (!linkHintOverlay || !linkHintOverlayActive) return;
  const links = getVisibleLinks();
  linkHintEntries = links.map((element, index) => ({ number: index + 1, element }));
  linkHintOverlay.textContent = '';

  linkHintEntries.forEach(({ number, element }) => {
    const rect = element.getBoundingClientRect();
    const badge = document.createElement('span');
    badge.textContent = String(number);
    badge.dataset.handsfreeHint = String(number);
    Object.assign(badge.style, {
      position: 'fixed',
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      minWidth: '22px',
      height: '22px',
      padding: '1px 5px',
      boxSizing: 'border-box',
      border: '2px solid #ffffff',
      borderRadius: '5px',
      background: selectedLinkHint?.number === number ? '#4f8f82' : '#6f8792',
      color: '#f7fbfa',
      fontSize: '14px',
      fontWeight: '700',
      lineHeight: '18px',
      textAlign: 'center',
      boxShadow: '0 1px 5px rgba(0, 0, 0, 0.75)'
    });
    linkHintOverlay.appendChild(badge);
  });
}

function scheduleLinkHintRefresh() {
  if (!linkHintOverlayActive || !linkHintOverlay || linkHintRefreshTimer) return;
  linkHintRefreshTimer = setTimeout(() => {
    linkHintRefreshTimer = null;
    refreshLinkHints();
  }, 80);
}

function updateLinkHintOverlay() {
  if (!linkHintOverlayActive) return;
  ensureLinkHintOverlay();
  refreshLinkHints();
}

// The observer is only connected while the overlay is open so pages are not
// monitored for DOM changes when link hints are not in use.
let linkHintObserver = null;

function startLinkHintObserver() {
  if (typeof MutationObserver === 'undefined') return;
  if (!linkHintObserver) {
    linkHintObserver = new MutationObserver((mutations) => {
      // Rebuilding the overlay changes its own children; do not observe those
      // changes or the refresh would continuously schedule itself.
      if (mutations.some(mutation => !linkHintOverlay || !linkHintOverlay.contains(mutation.target))) {
        scheduleLinkHintRefresh();
      }
    });
  }
  linkHintObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function stopLinkHintObserver() {
  if (linkHintObserver) linkHintObserver.disconnect();
  if (linkHintRefreshTimer) {
    clearTimeout(linkHintRefreshTimer);
    linkHintRefreshTimer = null;
  }
}

function closeLinkHintOverlay() {
  stopLinkHintObserver();
  if (linkHintOverlay) {
    linkHintOverlay.remove();
    linkHintOverlay = null;
  }
  linkHintEntries = [];
  selectedLinkHint = null;
  linkHintOverlayActive = false;
}

function openLinkHintOverlay() {
  linkHintOverlayActive = true;
  updateLinkHintOverlay();
  startLinkHintObserver();
}

function selectLinkHint(number) {
  if (!linkHintOverlay) updateLinkHintOverlay();
  const entry = linkHintEntries.find(item => item.number === number);
  if (!entry) {
    console.warn(`[Handsfree] No visible link hint numbered ${number}.`);
    return;
  }

  selectedLinkHint = entry;
  entry.element.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  refreshLinkHints();
}

window.addEventListener('scroll', scheduleLinkHintRefresh, { passive: true });
window.addEventListener('resize', scheduleLinkHintRefresh, { passive: true });

// --- 2. Focus Monitoring for Automatic Mode Switching & Highlight Styling ---
function isTextInput(el) {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return (
    tag === 'textarea' ||
    (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file', 'image'].includes(el.type)) ||
    el.isContentEditable ||
    el.getAttribute?.('role') === 'textbox' ||
    el.getAttribute?.('role') === 'searchbox' ||
    Boolean(el.closest?.('[contenteditable="true"]'))
  );
}

function applyFieldHighlight(el) {
  if (!el) return;
  el.style.outline = '3px solid #38bdf8';
  el.style.outlineOffset = '2px';
  el.style.boxShadow = '0 0 14px rgba(56, 189, 248, 0.65)';
  el.style.transition = 'outline 0.15s ease, box-shadow 0.15s ease';
}

function removeFieldHighlight(el) {
  if (!el) return;
  el.style.outline = '';
  el.style.outlineOffset = '';
  el.style.boxShadow = '';
}

document.addEventListener('focusin', (e) => {
  if (isTextInput(e.target)) {
    applyFieldHighlight(e.target);
    browser.runtime.sendMessage({ type: 'SET_MODE', mode: 'DICTATION' });
  }
});

document.addEventListener('focusout', (e) => {
  if (isTextInput(e.target)) {
    removeFieldHighlight(e.target);
    browser.runtime.sendMessage({ type: 'SET_MODE', mode: 'NAVIGATION' });
  }
});

// Helper: Locate closest scrollable container
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
  return el.closest(CLICKABLE_SELECTOR);
}

// --- 3. Cursor Loop with Sticky Target Snapping ---
function updateCursorRender() {
  rafScheduled = false;

  const clickable = getClickableAt(targetScreenX, targetScreenY);
  if (clickable) {
    const rect = clickable.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    currentScreenX = currentScreenX + (targetScreenX - currentScreenX) * 0.75 + (centerX - currentScreenX) * 0.08;
    currentScreenY = currentScreenY + (targetScreenY - currentScreenY) * 0.75 + (centerY - currentScreenY) * 0.08;
  } else {
    currentScreenX += (targetScreenX - currentScreenX) * 0.9;
    currentScreenY += (targetScreenY - currentScreenY) * 0.9;
  }

  if (cursorEl) {
    cursorEl.style.transform = `translate3d(${currentScreenX - 18}px, ${currentScreenY - 18}px, 0)`;
  }

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

  checkStickyDwellHold(clickable);
}

// --- 4. Sticky Dwell Hold Engine ---
function checkStickyDwellHold(clickable) {
  const now = performance.now();

  // Re-arm dwell only once the cursor has left the last dwell-clicked element
  if (lastDwellClickedElement && clickable !== lastDwellClickedElement) {
    lastDwellClickedElement = null;
  }

  if (!stickyHoldEnabled || isHoldingDrag || now < dwellCooldownUntil ||
      (clickable && clickable === lastDwellClickedElement)) {
    resetDwellRing();
    return;
  }

  if (clickable) {
    const distFromAnchor = Math.hypot(currentScreenX - dwellAnchorX, currentScreenY - dwellAnchorY);

    if (dwellTargetElement === clickable && distFromAnchor < 24) {
      const elapsed = now - dwellStartTime;
      const progress = Math.min(1.0, elapsed / dwellDurationMs);

      if (holdRingProgress) {
        const offset = 87.96 * (1.0 - progress);
        holdRingProgress.style.strokeDashoffset = `${offset}`;
      }

      if (progress >= 1.0) {
        triggerClick(currentScreenX, currentScreenY, clickable, 'DWELL_CLICK');
        lastDwellClickedElement = clickable;
        dwellCooldownUntil = now + 900;
        resetDwellRing();

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
      dwellTargetElement = clickable;
      dwellStartTime = now;
      dwellAnchorX = currentScreenX;
      dwellAnchorY = currentScreenY;
      lastTargetHoverTime = now;
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

// --- 5. Continuous Smooth Auto-Scroll Loop ---
function startAutoScroll(direction = 1) {
  autoScrollDirection = direction;
  autoScrollSpeed = 0.25; // Always resets to slow reading crawl on activation
  isAutoScrolling = true;
  updateScrollHud();

  if (autoScrollRafId) cancelAnimationFrame(autoScrollRafId);

  const scrollStep = () => {
    if (!isAutoScrolling) return;

    const scrollTarget = findScrollableElement(currentScreenX, currentScreenY);
    const delta = autoScrollDirection * autoScrollSpeed;

    if (scrollTarget && typeof scrollTarget.scrollBy === 'function') {
      scrollTarget.scrollBy({ top: delta, behavior: 'auto' });
    } else {
      window.scrollBy({ top: delta, behavior: 'auto' });
    }

    autoScrollRafId = requestAnimationFrame(scrollStep);
  };

  autoScrollRafId = requestAnimationFrame(scrollStep);
}

function stopAutoScroll() {
  isAutoScrolling = false;
  if (autoScrollRafId) {
    cancelAnimationFrame(autoScrollRafId);
    autoScrollRafId = null;
  }
  if (scrollHudEl) {
    scrollHudEl.style.display = 'none';
  }
}

function adjustAutoScrollSpeed(delta) {
  if (!isAutoScrolling) {
    startAutoScroll(1);
    return;
  }
  // Clamp speed from 0.25 px/frame to 8.0 px/frame in precise 0.25 increments
  autoScrollSpeed = Math.max(0.25, Math.min(8.0, Number((autoScrollSpeed + delta).toFixed(2))));
  updateScrollHud();
}

function updateScrollHud() {
  if (!scrollHudEl) return;
  const dirIcon = autoScrollDirection > 0 ? '⬇' : '⬆';
  scrollHudEl.innerText = `${dirIcon} Auto-Scrolling (${autoScrollSpeed.toFixed(2)}x speed)`;
  scrollHudEl.style.display = 'block';
}

// --- 6. Message Listener ---
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPDATE_CURSOR') {
    targetScreenX = msg.x * window.innerWidth;
    targetScreenY = msg.y * window.innerHeight;

    if (msg.stickyHold !== undefined) stickyHoldEnabled = msg.stickyHold;
    if (msg.dwellDuration !== undefined) dwellDurationMs = msg.dwellDuration;

    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(updateCursorRender);
    }
  } else if (msg.type === 'COMMAND') {
    handleNavigationCommand(msg.command, msg.payload);
  } else if (msg.type === 'INJECT_TEXT') {
    injectTextIntoActiveElement(msg.text);
  } else if (msg.type === 'MODE_CHANGE') {
    if (msg.mode === 'NAVIGATION') {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        removeFieldHighlight(document.activeElement);
        document.activeElement.blur();
      }
    }
  }
});

// --- 7. Command Execution ---
function handleNavigationCommand(command, payload) {
  switch (command) {
    case 'OPEN_LINK_OVERLAY': {
      openLinkHintOverlay();
      break;
    }

    case 'SCROLL': {
      stopAutoScroll();
      const scrollTarget = findScrollableElement(currentScreenX, currentScreenY);
      if (scrollTarget && typeof scrollTarget.scrollBy === 'function') {
        scrollTarget.scrollBy({ top: payload.y, behavior: 'smooth' });
      } else {
        window.scrollBy({ top: payload.y, behavior: 'smooth' });
      }
      break;
    }

    case 'SCROLL_EXTREME': {
      stopAutoScroll();
      const targetPos = payload.position;
      const scrollTarget = findScrollableElement(currentScreenX, currentScreenY);

      if (targetPos === 'BOTTOM') {
        const maxScroll = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
          scrollTarget.scrollHeight || 0
        );

        if (scrollTarget && typeof scrollTarget.scrollTo === 'function') {
          scrollTarget.scrollTo({ top: scrollTarget.scrollHeight, behavior: 'smooth' });
        }
        window.scrollTo({ top: maxScroll, behavior: 'smooth' });
      } else if (targetPos === 'TOP') {
        if (scrollTarget && typeof scrollTarget.scrollTo === 'function') {
          scrollTarget.scrollTo({ top: 0, behavior: 'smooth' });
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      break;
    }

    case 'AUTO_SCROLL_START': {
      startAutoScroll(payload?.direction || 1);
      break;
    }

    case 'AUTO_SCROLL_SPEED': {
      adjustAutoScrollSpeed(payload?.delta || 0.25);
      break;
    }

    case 'AUTO_SCROLL_STOP': {
      stopAutoScroll();
      break;
    }

    case 'SUBMIT_SEARCH': {
      stopAutoScroll();
      const el = document.activeElement;
      if (!el) return;

      removeFieldHighlight(el);
      const taskElapsed = Math.round(performance.now() - taskStartTime);

      browser.runtime.sendMessage({
        type: 'TELEMETRY_LOG',
        category: 'TASK_COMPLETION',
        eventName: 'SEARCH_SUBMITTED',
        details: { taskCompletionTimeMs: taskElapsed }
      });

      const enterOptions = {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, view: window
      };
      el.dispatchEvent(new KeyboardEvent('keydown', enterOptions));
      el.dispatchEvent(new KeyboardEvent('keypress', enterOptions));
      el.dispatchEvent(new KeyboardEvent('keyup', enterOptions));

      if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      else if (el.form && typeof el.form.submit === 'function') el.form.submit();

      el.blur();
      break;
    }

    case 'CLICK': {
      stopAutoScroll();
      if (selectedLinkHint?.element?.isConnected) {
        const target = selectedLinkHint.element;
        selectedLinkHint = null;
        const rect = target.getBoundingClientRect();
        triggerClick(rect.left + rect.width / 2, rect.top + rect.height / 2, target);
        if (linkHintOverlay) {
          closeLinkHintOverlay();
        }
        break;
      }
      const clickX = (payload?.x !== undefined) ? (payload.x * window.innerWidth) : currentScreenX;
      const clickY = (payload?.y !== undefined) ? (payload.y * window.innerHeight) : currentScreenY;
      triggerClick(clickX, clickY, null, 'VOICE_CLICK');
      break;
    }

    case 'LINK_NUMBER': {
      selectLinkHint(payload?.number);
      break;
    }

    case 'HOLD': {
      stopAutoScroll();
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

      const mouseInit = { bubbles: true, cancelable: true, view: window, clientX: holdX, clientY: holdY };
      const createEvent = (evtType) => {
        if (typeof PointerEvent !== 'undefined' && evtType.startsWith('pointer')) {
          return new PointerEvent(evtType, { ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true });
        }
        return new MouseEvent(evtType, mouseInit);
      };

      target.dispatchEvent(createEvent('pointerdown'));
      target.dispatchEvent(createEvent('mousedown'));
      if (typeof target.focus === 'function') target.focus();
      break;
    }

    case 'RELEASE': {
      const relX = (payload?.x !== undefined) ? (payload.x * window.innerWidth) : currentScreenX;
      const relY = (payload?.y !== undefined) ? (payload.y * window.innerHeight) : currentScreenY;

      if (cursorEl) cursorEl.style.display = 'none';
      let target = document.elementFromPoint(relX, relY);
      if (cursorEl) cursorEl.style.display = 'flex';

      const releaseTarget = holdDragTarget || target || document.body;
      const mouseInit = { bubbles: true, cancelable: true, view: window, clientX: relX, clientY: relY };

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
      break;
    }

    case 'FOCUS_SEARCH': {
      stopAutoScroll();
      taskStartTime = performance.now();
      const selectors = [
        '#searchInput',
        '.cdx-text-input__input',
        'input[type="search"]',
        'textarea[name="q"]',
        'input[name="q"]',
        'input[name="search_query"]',
        'input[name="search"]',
        'input[title*="search" i]',
        'input[placeholder*="search" i]',
        'textarea[placeholder*="search" i]',
        '[role="searchbox"]',
        'input[aria-label*="search" i]'
      ];

      let targetInput = null;

      for (const sel of selectors) {
        const matches = document.querySelectorAll(sel);
        for (const el of matches) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            targetInput = el;
            break;
          }
        }
        if (targetInput) break;
      }

      if (!targetInput) {
        const retryCount = payload?.searchRetry || 0;
        const triggerBtn = document.querySelector('button[aria-label*="search" i], [role="button"][aria-label*="search" i]');
        // Some sites reveal the search box only after a button is pressed. Retry a
        // bounded number of times so a button that never reveals an input does
        // not cause an endless click loop.
        if (triggerBtn && retryCount < 3) {
          if (retryCount === 0) triggerBtn.click();
          setTimeout(() => {
            handleNavigationCommand('FOCUS_SEARCH', { ...payload, searchRetry: retryCount + 1 });
          }, 150);
          return;
        }
      }

      if (targetInput) {
        if (typeof targetInput.scrollIntoView === 'function') {
          targetInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        const rect = targetInput.getBoundingClientRect();
        targetScreenX = rect.left + rect.width / 2;
        targetScreenY = rect.top + rect.height / 2;
        currentScreenX = targetScreenX;
        currentScreenY = targetScreenY;
        if (cursorEl) {
          cursorEl.style.transform = `translate3d(${currentScreenX - 18}px, ${currentScreenY - 18}px, 0)`;
        }

        const mouseEvt = { bubbles: true, cancelable: true, view: window };
        targetInput.dispatchEvent(new MouseEvent('mousedown', mouseEvt));
        targetInput.dispatchEvent(new MouseEvent('mouseup', mouseEvt));
        targetInput.dispatchEvent(new MouseEvent('click', mouseEvt));

        targetInput.focus({ preventScroll: true });
        if (typeof targetInput.select === 'function') {
          targetInput.select();
        }

        applyFieldHighlight(targetInput);
        browser.runtime.sendMessage({ type: 'SET_MODE', mode: 'DICTATION' });
      } else {
        console.warn('[Handsfree] No search input found on this page.');
      }
      break;
    }

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

// Reusable click performer with telemetry logging
function triggerClick(clickX, clickY, knownTarget = null, activationMethod = 'VOICE_CLICK') {
  if (cursorEl) cursorEl.style.display = 'none';
  let target = knownTarget || document.elementFromPoint(clickX, clickY);
  if (cursorEl) cursorEl.style.display = 'flex';

  if (!target || target === document.body || target === document.documentElement) {
    target = (lastHoveredElement && lastHoveredElement !== document.body)
      ? lastHoveredElement
      : (document.activeElement !== document.body ? document.activeElement : null);
  }

  if (!target) return;

  const clickable = target.closest(CLICKABLE_SELECTOR) || target;
  const isInteractive = Boolean(clickable && clickable !== document.body && clickable !== document.documentElement);
  const acquisitionTimeMs = Math.round(performance.now() - lastTargetHoverTime);

  browser.runtime.sendMessage({
    type: 'TELEMETRY_LOG',
    category: 'DOM_INTERACTION',
    eventName: 'SELECTION_ACTIVATION',
    details: {
      activationMethod,
      tagName: clickable.tagName,
      isInteractiveTarget: isInteractive,
      acquisitionTimeMs
    }
  });

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

  const isAnchor = clickable.tagName === 'A';
  let defaultPrevented = false;

  if (isAnchor) {
    // dispatchEvent returns false when a page handler (e.g. an SPA router)
    // called preventDefault(); we need that to decide on the fallback below.
    defaultPrevented = !clickable.dispatchEvent(createEvent('click'));
  } else if (typeof clickable.click === 'function') {
    clickable.click();
  } else {
    target.dispatchEvent(createEvent('click'));
  }

  // Fallback for pages where the synthetic click did not navigate. Only applies
  // to plain same-tab http(s) links the page did not handle itself.
  const linkTarget = (clickable.getAttribute?.('target') || '').toLowerCase();
  if (
    isAnchor &&
    !defaultPrevented &&
    /^https?:/i.test(clickable.href || '') &&
    !clickable.hasAttribute('download') &&
    (linkTarget === '' || linkTarget === '_self')
  ) {
    const hrefBeforeClick = window.location.href;
    setTimeout(() => {
      if (window.location.href === hrefBeforeClick && clickable.href !== hrefBeforeClick) {
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