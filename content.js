// content.js - DOM Execution & Event Dispatching

let lastHoveredElement = null;

// Track whatever element the cursor is currently resting over
document.addEventListener('mousemove', (e) => {
  lastHoveredElement = e.target;
}, { passive: true });

function isTextInput(el) {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return (
    tag === 'textarea' ||
    (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(el.type)) ||
    el.isContentEditable
  );
}

// Track input focus for automatic mode switching
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

// Listener
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'COMMAND') {
    handleNavigationCommand(msg.command, msg.payload);
  } else if (msg.type === 'INJECT_TEXT') {
    injectTextIntoActiveElement(msg.text);
  } else if (msg.type === 'MODE_CHANGE') {
    if (msg.mode === 'NAVIGATION') {
      document.activeElement?.blur();
    }
  }
});

function handleNavigationCommand(command, payload) {
  switch (command) {
    case 'SCROLL':
      window.scrollBy({ top: payload.y, behavior: 'smooth' });
      break;

    case 'CLICK': {
      // 1. Prioritize element under cursor/hover; fallback to focused element
      const target = (lastHoveredElement && lastHoveredElement !== document.body) 
        ? lastHoveredElement 
        : (document.activeElement !== document.body ? document.activeElement : null);

      if (!target) {
        console.warn('[Handsfree] No specific element hovered or focused to click.');
        return;
      }

      console.log('[Handsfree] Clicking element:', target);

      // Dispatch full mouse event lifecycle
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evtType => {
        target.dispatchEvent(new MouseEvent(evtType, {
          bubbles: true,
          cancelable: true,
          view: window
        }));
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
      if (!el || !isTextInput(el)) {
        console.warn('[Handsfree] Cannot clear: no text input actively focused.');
        return;
      }

      console.log('[Handsfree] Clearing focused field:', el);

      // Method 1: ContentEditable elements (e.g. Rich Text Editors, Docs)
      if (el.isContentEditable) {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        el.innerText = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }

      // Method 2: Standard Inputs & Textareas
      el.focus();
      
      // Select all text first so delete commands wipe everything
      if (typeof el.select === 'function') {
        el.select();
      }

      // Execute browser-native delete
      const deleted = document.execCommand('delete', false, null);

      // Method 3: Direct prototype reset for React/Vue if execCommand was blocked
      if (!deleted || el.value !== '') {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        )?.set;

        if (nativeSetter) {
          nativeSetter.call(el, '');
        } else {
          el.value = '';
        }

        // Dispatch full input sequence so UI frameworks detect the change
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      break;
    }
  }
}

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