// content.js - DOM Execution and Input Focus Tracking

// Add to the top of content.js
console.log('[Handsfree Content Script] Injected and active on:', window.location.href);

// 1. Automatic Dictation vs. Navigation Mode Switching
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

// In the browser.runtime.onMessage listener in content.js, update to send an acknowledgment:
browser.runtime.onMessage.addListener((msg) => {
  console.log('[Handsfree Content Script] Received message:', msg);

  if (msg.type === 'COMMAND') {
    handleNavigationCommand(msg.command, msg.payload);
    return Promise.resolve({ status: 'command_executed', command: msg.command });
  } else if (msg.type === 'INJECT_TEXT') {
    injectTextIntoActiveElement(msg.text);
    return Promise.resolve({ status: 'text_injected' });
  } else if (msg.type === 'MODE_CHANGE') {
    if (msg.mode === 'NAVIGATION') {
      document.activeElement?.blur();
    }
    return Promise.resolve({ status: 'mode_changed' });
  }
});

function handleNavigationCommand(command, payload) {
  switch (command) {
    case 'SCROLL':
      window.scrollBy({ top: payload.y, behavior: 'smooth' });
      break;

    case 'CLICK':
      if (document.activeElement) {
        document.activeElement.click();
      }
      break;

    case 'FOCUS_SEARCH':
      const searchBox = document.querySelector('input[type="search"], input[name="q"], input[title*="Search" i], input[type="text"]');
      if (searchBox) {
        searchBox.focus();
      }
      break;

    case 'CLEAR':
      if (isTextInput(document.activeElement)) {
        document.activeElement.value = '';
      }
      break;
  }
}

function injectTextIntoActiveElement(text) {
  const el = document.activeElement;
  if (!el || !isTextInput(el)) return;

  // Use execCommand to preserve browser Undo/Redo history and dispatch input events
  const success = document.execCommand('insertText', false, text);
  if (!success && typeof el.value !== 'undefined') {
    // Fallback if execCommand is restricted
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    el.value = el.value.substring(0, start) + text + el.value.substring(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}