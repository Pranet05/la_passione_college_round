import { pipeline, env } from './transformers.min.js';

// Use browser internal CacheStorage and Hugging Face remote endpoints on initial load
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let currentMode = 'NAVIGATION';
let audioBufferChunk = [];
let silenceFrames = 0;

// Holds latest normalized nose coordinates streamed from tracker.js
let latestCursor = { x: 0.5, y: 0.5 };
let cursorTrackingPort = null;

// Synchronous active tab cache to eliminate IPC roundtrip lag during cursor streaming
let activeTabId = null;

// High-speed VAD parameters: ~250-300ms pause triggers inference
const SILENCE_RMS_THRESHOLD = 0.003;
const MIN_SPEECH_ZCR = 0.02;
const SILENCE_FRAMES_TO_TRIGGER = 2;

const COMMANDS = {
  // Navigation scrolling
  'scroll down': { action: 'SCROLL', payload: { y: 600 } },
  'scroll up': { action: 'SCROLL', payload: { y: -600 } },
  'down': { action: 'SCROLL', payload: { y: 350 } },
  'up': { action: 'SCROLL', payload: { y: -350 } },
  'page down': { action: 'SCROLL', payload: { y: 600 } },
  'page up': { action: 'SCROLL', payload: { y: -600 } },

  // Tab switching commands
  'next tab': { action: 'NEXT_TAB' },
  'switch tab': { action: 'NEXT_TAB' },
  'previous tab': { action: 'PREV_TAB' },
  'prev tab': { action: 'PREV_TAB' },
  'last tab': { action: 'PREV_TAB' },
  'new tab': { action: 'NEW_TAB' },
  'close tab': { action: 'CLOSE_TAB' },

  // Click & phonetic Whisper variations
  'click': { action: 'CLICK' },
  'quick': { action: 'CLICK' },
  'clique': { action: 'CLICK' },
  'klick': { action: 'CLICK' },
  'tap': { action: 'CLICK' },
  'press': { action: 'CLICK' },
  'select': { action: 'CLICK' },

  // Sticky Hold & Release (Mouse Down / Drag / Drop)
  'sticky hold': { action: 'HOLD' },
  'hold': { action: 'HOLD' },
  'grab': { action: 'HOLD' },
  'release': { action: 'RELEASE' },
  'drop': { action: 'RELEASE' },
  'unhold': { action: 'RELEASE' },

  // Search input focus
  'focus search': { action: 'FOCUS_SEARCH' },
  'search': { action: 'FOCUS_SEARCH' },
  'find': { action: 'FOCUS_SEARCH' },

  // Gaze center recalibration
  'recenter': { action: 'RECENTER' },
  'center': { action: 'RECENTER' },

  // Input reset
  'clear': { action: 'CLEAR' }
};

// --- Tab Navigation Handlers ---

// --- Reliable Multi-Window Tab Navigation Handlers ---

async function getNormalBrowserTabs() {
  // 1. Target the last-focused normal browser window
  let targetWindow = null;
  try {
    targetWindow = await browser.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
  } catch (e) {
    targetWindow = await browser.windows.getCurrent({ populate: true });
  }

  if (!targetWindow || !targetWindow.tabs) return { currentWindow: null, webTabs: [] };

  // 2. Filter out extension utility tabs (tracker, mic permission, devtools)
  const webTabs = targetWindow.tabs.filter(t => 
    t.url && !t.url.startsWith('moz-extension://') && !t.url.startsWith('about:debugging')
  );

  return { currentWindow: targetWindow, webTabs };
}

async function cycleTab(direction = 1) {
  try {
    const { currentWindow, webTabs } = await getNormalBrowserTabs();

    if (webTabs.length <= 1) {
      console.warn('[Handsfree] Not enough web tabs to cycle through.');
      return;
    }

    // Identify which tab is currently active in that window
    const activeTab = currentWindow.tabs.find(t => t.active);
    const currentIndex = webTabs.findIndex(t => t.id === activeTab?.id);

    let nextIndex;
    if (currentIndex === -1) {
      nextIndex = 0;
    } else {
      nextIndex = (currentIndex + direction + webTabs.length) % webTabs.length;
    }

    const targetTab = webTabs[nextIndex];
    if (targetTab?.id) {
      // 1. Activate tab
      await browser.tabs.update(targetTab.id, { active: true });
      // 2. Ensure its parent window is brought to the foreground
      await browser.windows.update(targetTab.windowId, { focused: true });

      activeTabId = targetTab.id;
      console.log(`[Handsfree] Switched to tab: ${targetTab.title || targetTab.id}`);
    }
  } catch (err) {
    console.error('[Handsfree] Failed to cycle tab:', err);
  }
}

async function createNewTab() {
  try {
    const { currentWindow } = await getNormalBrowserTabs();
    const windowId = currentWindow ? currentWindow.id : undefined;

    const newTab = await browser.tabs.create({ 
      active: true, 
      windowId: windowId 
    });

    if (newTab.windowId) {
      await browser.windows.update(newTab.windowId, { focused: true });
    }

    activeTabId = newTab.id;
    console.log('[Handsfree] Opened new tab.');
  } catch (err) {
    console.error('[Handsfree] Failed to create tab:', err);
  }
}

async function closeCurrentTab() {
  try {
    const { currentWindow } = await getNormalBrowserTabs();
    if (!currentWindow || !currentWindow.tabs) return;

    const activeTab = currentWindow.tabs.find(t => t.active);
    if (activeTab && !activeTab.url.startsWith('moz-extension://')) {
      await browser.tabs.remove(activeTab.id);
      console.log('[Handsfree] Closed active tab.');
    }
  } catch (err) {
    console.error('[Handsfree] Failed to close tab:', err);
  }
}

// Maintain Active Web Tab Target
async function updateActiveTab() {
  try {
    const focusedTabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const target = focusedTabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
    if (target?.id) {
      activeTabId = target.id;
      return;
    }

    const allTabs = await browser.tabs.query({ active: true });
    const fallback = allTabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
    if (fallback?.id) {
      activeTabId = fallback.id;
    }
  } catch (e) {
    // Fail silently during transitions
  }
}

browser.tabs.onActivated.addListener(() => { updateActiveTab(); });
browser.tabs.onUpdated.addListener(() => { updateActiveTab(); });
if (browser.windows?.onFocusChanged) {
  browser.windows.onFocusChanged.addListener(() => { updateActiveTab(); });
}
updateActiveTab();

// Synchronous, non-blocking message dispatcher
function sendToTab(msg) {
  if (activeTabId) {
    browser.tabs.sendMessage(activeTabId, msg).catch(() => {
      activeTabId = null;
      updateActiveTab();
    });
  } else {
    updateActiveTab();
  }
}

// Initialize Whisper Speech Recognizer
async function initEngine() {
  console.log('[Handsfree] Initializing local speech model...');
  try {
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      quantized: true
    });
    console.log('[Handsfree] Local speech recognizer ready.');
  } catch (err) {
    console.error('[Handsfree] Speech engine init error:', err);
  }
}

initEngine();

// Port Connections
browser.runtime.onConnect.addListener((port) => {
  // --- High-Speed Nose Tracking Stream ---
  if (port.name === 'cursor-tracking') {
    console.log('[Handsfree] Cursor tracking port connected.');
    cursorTrackingPort = port;

    port.onDisconnect.addListener(() => {
      if (cursorTrackingPort === port) cursorTrackingPort = null;
    });

    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'CURSOR_MOVE') {
        latestCursor.x = msg.x;
        latestCursor.y = msg.y;

        sendToTab({
          type: 'UPDATE_CURSOR',
          x: msg.x,
          y: msg.y
        });
      }
    });
  }

  // --- Audio Stream ---
  if (port.name === 'audio-stream') {
    console.log('[Handsfree] Audio stream port connected.');

    port.onMessage.addListener(async (msg) => {
      if (!msg.audioChunk || !transcriber) return;

      const chunk = new Float32Array(msg.audioChunk);
      const rms = calculateRMS(chunk);
      const zcr = calculateZCR(chunk);

      const isSpeech = (rms >= SILENCE_RMS_THRESHOLD) && (zcr >= MIN_SPEECH_ZCR);

      if (isSpeech) {
        audioBufferChunk.push(chunk);
        silenceFrames = 0;
      } else if (audioBufferChunk.length > 0) {
        silenceFrames++;
        audioBufferChunk.push(chunk);

        if (silenceFrames >= SILENCE_FRAMES_TO_TRIGGER) {
          const fullBuffer = mergeAudioBuffers(audioBufferChunk);
          audioBufferChunk = [];
          silenceFrames = 0;

          // Drop noise bursts shorter than 0.35 seconds to avoid corrupting speech recognition
          if (fullBuffer.length < 16000 * 0.35) return;

          console.log(`[Handsfree] Processing utterance (${(fullBuffer.length / 16000).toFixed(1)}s)...`);

          try {
            const output = await transcriber(fullBuffer);
            let transcript = '';
            if (typeof output === 'string') transcript = output;
            else if (Array.isArray(output) && output[0]?.text) transcript = output[0].text;
            else if (output?.text) transcript = output.text;

            transcript = transcript.trim();
            console.log(`[Raw Model Output]: "${transcript}"`);

            if (!transcript) return;

            if (currentMode === 'NAVIGATION') {
              const lower = transcript.toLowerCase();
              let matched = false;

              for (const [cmd, config] of Object.entries(COMMANDS)) {
                if (lower.includes(cmd)) {
                  console.log(`[Handsfree Command Triggered]: ${cmd}`);

                  // Handle Browser-Level Operations
                  if (config.action === 'NEXT_TAB') {
                    cycleTab(1);
                  } else if (config.action === 'PREV_TAB') {
                    cycleTab(-1);
                  } else if (config.action === 'NEW_TAB') {
                    createNewTab();
                  } else if (config.action === 'CLOSE_TAB') {
                    closeCurrentTab();
                  } else if (config.action === 'RECENTER') {
                    if (cursorTrackingPort) {
                      cursorTrackingPort.postMessage({ type: 'CALIBRATE' });
                    }
                  } else {
                    // Handle Page-Level DOM Operations
                    const isCoordCommand = ['CLICK', 'HOLD', 'RELEASE'].includes(config.action);
                    const payload = isCoordCommand
                      ? { x: latestCursor.x, y: latestCursor.y }
                      : config.payload;

                    sendToTab({ type: 'COMMAND', command: config.action, payload });
                  }

                  matched = true;
                  break;
                }
              }

              if (!matched) {
                console.log(`[Handsfree] No navigation command matched in: "${lower}"`);
              }
            } else if (currentMode === 'DICTATION') {
              const cleanText = transcript.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').trim();

              if (cleanText === 'stop dictating' || cleanText === 'escape' || cleanText.endsWith(' stop dictating')) {
                currentMode = 'NAVIGATION';
                sendToTab({ type: 'MODE_CHANGE', mode: 'NAVIGATION' });
              } else if (
                cleanText === 'search' ||
                cleanText === 'enter' ||
                cleanText === 'submit' ||
                cleanText === 'press enter' ||
                cleanText === 'press search'
              ) {
                console.log(`[Handsfree] Intercepted SEARCH / SUBMIT command from: "${transcript}"`);
                sendToTab({ type: 'COMMAND', command: 'SUBMIT_SEARCH' });
                currentMode = 'NAVIGATION';
                sendToTab({ type: 'MODE_CHANGE', mode: 'NAVIGATION' });
              } else if (
                cleanText === 'clear' ||
                cleanText === 'clear field' ||
                cleanText === 'clear text' ||
                cleanText === 'delete all' ||
                cleanText.endsWith(' clear')
              ) {
                console.log(`[Handsfree] Intercepted CLEAR command from utterance: "${transcript}"`);
                sendToTab({ type: 'COMMAND', command: 'CLEAR' });
              } else {
                sendToTab({ type: 'INJECT_TEXT', text: transcript + ' ' });
              }
            }
          } catch (err) {
            console.error('[Handsfree] Inference error:', err);
          }
        }
      }
    });
  }
});

// Audio math helpers
function calculateRMS(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function calculateZCR(buffer) {
  let crossings = 0;
  for (let i = 1; i < buffer.length; i++) {
    if ((buffer[i] >= 0 && buffer[i - 1] < 0) || (buffer[i] < 0 && buffer[i - 1] >= 0)) {
      crossings++;
    }
  }
  return crossings / buffer.length;
}

function mergeAudioBuffers(buffers) {
  const totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
}

// Mode changes triggered by DOM focus in content.js
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'SET_MODE') {
    currentMode = message.mode;
    console.log(`[Handsfree] Switched to mode: ${currentMode}`);
  }
});