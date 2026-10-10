// content.js - Virtual Pointer Overlay, DOM Actions & Dictation Engine

// --- 1. Mount Hardware-Accelerated Virtual Cursor ---
let cursorEl = document.getElementById('handsfree-virtual-pointer');

if (!cursorEl) {
  cursorEl = document.createElement('div');
  cursorEl.id = 'handsfree-virtual-pointer';
  Object.assign(cursorEl.style, {
    position: 'fixed',
    top: '0px',
    left: '0px',
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    backgroundColor: 'rgba(239, 68, 68, 0.95)',
    border: '2.5px solid #ffffff',
    boxShadow: '0 0 12px rgba(239, 68, 68, 0.8), 0 0 4px rgba(0, 0, 0, 0.5)',
    pointerEvents: 'none', // Lets clicks pass through to elements underneath
    zIndex: '2147483647',
    transform: 'translate3d(-50%, -50%, 0)',
    willChange: 'transform',
    display: 'block'
  });

  const mount = () => {
    if (!document.getElementById('handsfree-virtual-pointer')) {
      const parent = document.body || document.documentElement;
      if (parent) parent.appendChild(cursorEl);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
}

// Current screen coordinates (starts in center)
let currentScreenX = window.innerWidth / 2;
let currentScreenY = window.innerHeight / 2;
let lastHoveredElement = null;

// Track mouse position if a physical mouse is used simultaneously
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
    el.isContentEditable
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

// --- 3. Message Listener ---
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPDATE_CURSOR') {
    currentScreenX = msg.x * window.innerWidth;
    currentScreenY = msg.y * window.innerHeight;

    if (cursorEl) {
      cursorEl.style.transform = `translate3d(${currentScreenX - 10}px, ${currentScreenY - 10}px, 0)`;
    }
  } else if (msg.type === 'COMMAND') {
    handleNavigationCommand(msg.command, msg.payload);
  } else if (msg.type === 'INJECT_TEXT') {
    injectTextIntoActiveElement(msg.text);
  } else if (msg.type === 'MODE_CHANGE') {
    if (msg.mode === 'NAVIGATION') {
      // Unfocus input to break out of text fields
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    }
  }
});

// --- 4. Command & Point-and-Click Execution ---
function handleNavigationCommand(command, payload) {
  switch (command) {
    case 'SCROLL':
      window.scrollBy({ top: payload.y, behavior: 'smooth' });
      break;

    case 'SUBMIT_SEARCH': {
      const el = document.activeElement;
      if (!el) return;

      console.log('[Handsfree] Submitting search / pressing Enter on:', el);

      // 1. Dispatch authentic KeyboardEvent sequence for Enter (key code 13)
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

      // 2. Fallback: if the input belongs to a <form>, submit it directly
      if (el.form && typeof el.form.requestSubmit === 'function') {
        el.form.requestSubmit();
      } else if (el.form && typeof el.form.submit === 'function') {
        el.form.submit();
      }

      // 3. Blur the element to drop cursor focus
      el.blur();
      break;
    }

    case 'CLICK': {
      const clickX = (payload?.x !== undefined) ? (payload.x * window.innerWidth) : currentScreenX;
      const clickY = (payload?.y !== undefined) ? (payload.y * window.innerHeight) : currentScreenY;

      if (cursorEl) cursorEl.style.display = 'none';
      let target = document.elementFromPoint(clickX, clickY);
      if (cursorEl) cursorEl.style.display = 'block';

      if (!target || target === document.body || target === document.documentElement) {
        target = (lastHoveredElement && lastHoveredElement !== document.body)
          ? lastHoveredElement
          : (document.activeElement !== document.body ? document.activeElement : null);
      }

      if (!target) return;

      if (cursorEl) {
        cursorEl.style.transform = `translate3d(${clickX - 10}px, ${clickY - 10}px, 0) scale(1.6)`;
        setTimeout(() => {
          if (cursorEl) {
            cursorEl.style.transform = `translate3d(${currentScreenX - 10}px, ${currentScreenY - 10}px, 0) scale(1.0)`;
          }
        }, 140);
      }

      if (typeof target.focus === 'function') {
        target.focus();
      }

      const mouseInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: clickX,
        clientY: clickY
      };

      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evtType => {
        target.dispatchEvent(new MouseEvent(evtType, mouseInit));
      });

      if (typeof target.click === 'function') {
        target.click();
      }
      break;
    }

    case 'FOCUS_SEARCH': {
      const searchBox = document.querySelector(
        'input[type="search"], input[name="q"], input[name="search"], input[title*="Search" i], [role="searchbox"]'
      );
      if (searchBox) {
        searchBox.focus();
        searchBox.select();
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

// --- 5. Dictation Text Injection ---
function injectTextIntoActiveElement(text) {
  const el = document.activeElement;
  if (!el || !isTextInput(el)) return;

  const success = document.execCommand('insertText', false, text);
  if (!success && typeof el.value !== 'undefined') {
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    el.value = el.value.substring(0, start) + text + el.value.substring(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

console.log('[Handsfree Content Script] Active on:', window.location.href);