import { pipeline, env } from './transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let currentMode = 'NAVIGATION';
let audioBufferChunk = [];
let silenceFrames = 0;

let latestCursor = { x: 0.5, y: 0.5 };
let cursorTrackingPort = null;
let activeTabId = null;

// High-speed VAD parameters: ~250-300ms pause triggers inference
const SILENCE_RMS_THRESHOLD = 0.003;
const MIN_SPEECH_ZCR = 0.02;
const SILENCE_FRAMES_TO_TRIGGER = 2;

// --- Performance Evaluation Telemetry Engine ---
const telemetrySession = {
  sessionId: `session_${Date.now()}`,
  startTime: performance.now(),
  logs: [],
  metrics: {
    totalVoiceCommands: 0,
    recognizedCommands: 0,
    unrecognizedUtterances: 0,
    totalClicks: 0,
    dwellClicks: 0,
    voiceClicks: 0,
    tabSwitches: 0
  }
};

function recordTelemetryEvent(category, eventName, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    sessionElapsedMs: Math.round(performance.now() - telemetrySession.startTime),
    category,
    eventName,
    ...details
  };
  telemetrySession.logs.push(entry);
}

function exportEvaluationCSV() {
  const headers = ['timestamp', 'sessionElapsedMs', 'category', 'eventName', 'details'];
  const rows = telemetrySession.logs.map(log => {
    const { timestamp, sessionElapsedMs, category, eventName, ...rest } = log;
    return [
      timestamp,
      sessionElapsedMs,
      category,
      eventName,
      `"${JSON.stringify(rest).replace(/"/g, '""')}"`
    ].join(',');
  });

  const csvContent = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  browser.downloads.download({
    url,
    filename: `handsfree_evaluation_${Date.now()}.csv`,
    saveAs: true
  });
}

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

  // Click & phonetic variations
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

  // Calibration & Telemetry triggers
  'start calibration': { action: 'START_CALIBRATION' },
  'calibrate': { action: 'START_CALIBRATION' },
  'recenter': { action: 'RECENTER' },
  'center': { action: 'RECENTER' },
  'export metrics': { action: 'EXPORT_METRICS' },
  'download stats': { action: 'EXPORT_METRICS' },

  // Reset
  'clear': { action: 'CLEAR' }
};

// --- Reliable Multi-Window Tab Navigation Handlers ---
async function getNormalBrowserTabs() {
  let targetWindow = null;
  try {
    targetWindow = await browser.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
  } catch (e) {
    targetWindow = await browser.windows.getCurrent({ populate: true });
  }

  if (!targetWindow || !targetWindow.tabs) return { currentWindow: null, webTabs: [] };

  const webTabs = targetWindow.tabs.filter(t => 
    t.url && !t.url.startsWith('moz-extension://') && !t.url.startsWith('about:debugging')
  );

  return { currentWindow: targetWindow, webTabs };
}

async function cycleTab(direction = 1) {
  try {
    const { currentWindow, webTabs } = await getNormalBrowserTabs();
    if (webTabs.length <= 1) return;

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
      await browser.tabs.update(targetTab.id, { active: true });
      await browser.windows.update(targetTab.windowId, { focused: true });
      activeTabId = targetTab.id;
      telemetrySession.metrics.tabSwitches++;
      recordTelemetryEvent('TAB_MANAGEMENT', 'SWITCH_TAB', { toTabId: targetTab.id });
    }
  } catch (err) {
    console.error('[Handsfree] Failed to cycle tab:', err);
  }
}

async function createNewTab() {
  try {
    const { currentWindow } = await getNormalBrowserTabs();
    const newTab = await browser.tabs.create({ 
      active: true, 
      windowId: currentWindow ? currentWindow.id : undefined 
    });

    if (newTab.windowId) {
      await browser.windows.update(newTab.windowId, { focused: true });
    }

    activeTabId = newTab.id;
    recordTelemetryEvent('TAB_MANAGEMENT', 'NEW_TAB', { tabId: newTab.id });
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
      recordTelemetryEvent('TAB_MANAGEMENT', 'CLOSE_TAB', { tabId: activeTab.id });
    }
  } catch (err) {
    console.error('[Handsfree] Failed to close tab:', err);
  }
}

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
  } catch (e) {}
}

browser.tabs.onActivated.addListener(() => { updateActiveTab(); });
browser.tabs.onUpdated.addListener(() => { updateActiveTab(); });
if (browser.windows?.onFocusChanged) {
  browser.windows.onFocusChanged.addListener(() => { updateActiveTab(); });
}
updateActiveTab();

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

async function initEngine() {
  console.log('[Handsfree] Initializing Whisper model...');
  try {
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      quantized: true
    });
    console.log('[Handsfree] Speech recognizer ready.');
  } catch (err) {
    console.error('[Handsfree] Speech engine init error:', err);
  }
}
initEngine();

browser.runtime.onConnect.addListener((port) => {
  if (port.name === 'cursor-tracking') {
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
          y: msg.y,
          stickyHold: msg.stickyHold,
          dwellDuration: msg.dwellDuration
        });
      }
    });
  }

  if (port.name === 'audio-stream') {
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

          if (fullBuffer.length < 16000 * 0.35) return;

          try {
            telemetrySession.metrics.totalVoiceCommands++;
            const t0 = performance.now();
            const output = await transcriber(fullBuffer);
            const inferenceMs = Math.round(performance.now() - t0);

            let transcript = '';
            if (typeof output === 'string') transcript = output;
            else if (Array.isArray(output) && output[0]?.text) transcript = output[0].text;
            else if (output?.text) transcript = output.text;

            transcript = transcript.trim();
            if (!transcript) return;

            recordTelemetryEvent('VOICE_ASR', 'INFERENCE_COMPLETE', {
              transcript,
              latencyMs: inferenceMs,
              mode: currentMode
            });

            if (currentMode === 'NAVIGATION') {
              const lower = transcript.toLowerCase();
              let matched = false;

              for (const [cmd, config] of Object.entries(COMMANDS)) {
                if (lower.includes(cmd)) {
                  telemetrySession.metrics.recognizedCommands++;

                  if (config.action === 'NEXT_TAB') {
                    cycleTab(1);
                  } else if (config.action === 'PREV_TAB') {
                    cycleTab(-1);
                  } else if (config.action === 'NEW_TAB') {
                    createNewTab();
                  } else if (config.action === 'CLOSE_TAB') {
                    closeCurrentTab();
                  } else if (config.action === 'START_CALIBRATION') {
                    if (cursorTrackingPort) cursorTrackingPort.postMessage({ type: 'START_CALIBRATION' });
                  } else if (config.action === 'RECENTER') {
                    if (cursorTrackingPort) cursorTrackingPort.postMessage({ type: 'CALIBRATE' });
                  } else if (config.action === 'EXPORT_METRICS') {
                    exportEvaluationCSV();
                  } else {
                    const isCoordCommand = ['CLICK', 'HOLD', 'RELEASE'].includes(config.action);
                    const payload = isCoordCommand
                      ? { x: latestCursor.x, y: latestCursor.y }
                      : config.payload;

                    sendToTab({ type: 'COMMAND', command: config.action, payload });

                    if (config.action === 'CLICK' && cursorTrackingPort) {
                      cursorTrackingPort.postMessage({ type: 'NEXT_CALIB_POINT' });
                    }
                  }

                  matched = true;
                  break;
                }
              }

              if (!matched) {
                telemetrySession.metrics.unrecognizedUtterances++;
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

function calculateRMS(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function calculateZCR(buffer) {
  let crossings = 0;
  for (let i = 1; i < buffer.length; i++) {
    if ((buffer[i] >= 0 && buffer[i - 1] < 0) || (buffer[i] < 0 && buffer[i - 1] >= 0)) crossings++;
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

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'SET_MODE') {
    currentMode = message.mode;
  } else if (message.type === 'TELEMETRY_LOG') {
    recordTelemetryEvent(message.category, message.eventName, message.details);
    if (message.eventName === 'SELECTION_ACTIVATION') {
      telemetrySession.metrics.totalClicks++;
      if (message.details?.activationMethod === 'DWELL_CLICK') telemetrySession.metrics.dwellClicks++;
      if (message.details?.activationMethod === 'VOICE_CLICK') telemetrySession.metrics.voiceClicks++;
    }
  }
});