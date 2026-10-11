// content.js - Virtual Pointer Overlay, DOM Actions & Dictation Engine

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

// Track mouse position if physical mouse is used
document.addEventListener('mousemove', (e) => {
  lastHoveredElement = e.target;
}, { passive: true });

// --- 2. Focus Monitoring for Automatic Mode Switching ---
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

// --- 3. Ultra-Smooth RequestAnimationFrame Cursor Loop with Sticky Snapping ---
function updateCursorRender() {
  rafScheduled = false;

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

// --- 4. Sticky Dwell Hold Engine (Hold Still to Auto-Click) ---
function checkStickyDwellHold(clickable) {
  const now = performance.now();

  if (!stickyHoldEnabled || isHoldingDrag || now < dwellCooldownUntil) {
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

// --- 5. Message Listener ---
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
        document.activeElement.blur();
      }
    }
  }
});

// --- 6. Command Execution & Click / Hold / Release ---
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
      const searchBox = document.querySelector(
        '#searchInput, input[type="search"], textarea[name="q"], input[name="q"], input[name="search_query"], input[name="search"], textarea[name="search"], input[placeholder*="search" i], textarea[placeholder*="search" i], [role="searchbox"], input[aria-label*="search" i], button[aria-label*="search" i], .cdx-text-input__input'
      );
      if (searchBox) {
        if (typeof searchBox.scrollIntoView === 'function') {
          searchBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        if (searchBox.tagName === 'BUTTON' || searchBox.getAttribute('role') === 'button') {
          searchBox.click();
        } else {
          searchBox.focus();
          if (typeof searchBox.select === 'function') {
            searchBox.select();
          }
        }
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

// --- 7. Dictation Text Injection ---
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