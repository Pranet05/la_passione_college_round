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

// Speech activity state – broadcasted to content scripts
let isSpeechActive = false;
let speechActivityTimeout = null;

// High-speed VAD parameters: ~250ms pause triggers inference
const SILENCE_RMS_THRESHOLD = 0.003;
const MIN_SPEECH_ZCR = 0.02;
const SILENCE_FRAMES_TO_TRIGGER = 1;

// How long after last speech frame before we consider speech ended (if no command fires)
const SPEECH_COOLDOWN_MS = 600;

const COMMANDS = {
  // Navigation scrolling
  'scroll down': { action: 'SCROLL', payload: { y: 600 } },
  'scroll up': { action: 'SCROLL', payload: { y: -600 } },
  'down': { action: 'SCROLL', payload: { y: 350 } },
  'up': { action: 'SCROLL', payload: { y: -350 } },
  'page down': { action: 'SCROLL', payload: { y: 900 } },
  'page up': { action: 'SCROLL', payload: { y: -900 } },

  // Click & phonetic Whisper variations
  'click': { action: 'CLICK' },
  'quick': { action: 'CLICK' },
  'clique': { action: 'CLICK' },
  'klick': { action: 'CLICK' },
  'tap': { action: 'CLICK' },
  'press': { action: 'CLICK' },
  'select': { action: 'CLICK' },

  // Double Click
  'double click': { action: 'DOUBLE_CLICK' },
  'double tap': { action: 'DOUBLE_CLICK' },

  // Right Click (context menu)
  'right click': { action: 'RIGHT_CLICK' },
  'context menu': { action: 'RIGHT_CLICK' },

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
  'clear': { action: 'CLEAR' },

<<<<<<< Updated upstream
  // Browser navigation
  'go back': { action: 'GO_BACK' },
  'back': { action: 'GO_BACK' },
  'go forward': { action: 'GO_FORWARD' },
  'forward': { action: 'GO_FORWARD' },
  'refresh': { action: 'REFRESH' },
  'reload': { action: 'REFRESH' },

  // Page position
  'go to top': { action: 'SCROLL_TO_TOP' },
  'top': { action: 'SCROLL_TO_TOP' },
  'go to bottom': { action: 'SCROLL_TO_BOTTOM' },
  'bottom': { action: 'SCROLL_TO_BOTTOM' },

  // Tab management
  'new tab': { action: 'NEW_TAB' },
  'close tab': { action: 'CLOSE_TAB' },
  'next tab': { action: 'TAB_RIGHT' },
  'tab right': { action: 'TAB_RIGHT' },
  'previous tab': { action: 'TAB_LEFT' },
  'tab left': { action: 'TAB_LEFT' },

  // Zoom
  'zoom in': { action: 'ZOOM_IN' },
  'zoom out': { action: 'ZOOM_OUT' },
  'reset zoom': { action: 'ZOOM_RESET' },
=======
  // Page-level controls
  'close current tab': { action: 'CLOSE_TAB' },
  'close tab': { action: 'CLOSE_TAB' },
  'show links': { action: 'SHOW_CLICKABLES' },
  'show clickables': { action: 'SHOW_CLICKABLES' },
  'show link numbers': { action: 'SHOW_CLICKABLES' },
  'hide links': { action: 'HIDE_CLICKABLES' }
>>>>>>> Stashed changes
};

const COMMAND_ENTRIES = Object.entries(COMMANDS).sort(([left], [right]) => right.length - left.length);

function normalizeTranscript(transcript) {
  return transcript
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getNumberFromTranscript(text) {
  const numberWords = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20
  };
  const numericMatch = text.match(/\b(?:click|select|press|choose|open)\s+(\d{1,3})\b/);
  if (numericMatch) return Number(numericMatch[1]);

  const wordMatch = text.match(/\b(?:click|select|press|choose|open)\s+([a-z]+)\b/);
  return wordMatch && numberWords[wordMatch[1]] !== undefined
    ? numberWords[wordMatch[1]]
    : null;
}

// 1. Maintain Active Web Tab Target Synchronously
// CRITICAL: Always prefer the last HTTP/HTTPS tab, never target extension pages
async function updateActiveTab() {
  try {
    const focusedTabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const target = focusedTabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
    if (target?.id) {
      activeTabId = target.id;
      return;
    }

    // Fallback: find any active web tab across all windows
    const allTabs = await browser.tabs.query({ active: true });
    const fallback = allTabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
    if (fallback?.id) {
      activeTabId = fallback.id;
      return;
    }

    // Last resort: find ANY web tab (even if not active)
    const webTabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    if (webTabs.length > 0) {
      // Pick the most recently accessed one
      const sorted = webTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      if (sorted[0]?.id) {
        activeTabId = sorted[0].id;
      }
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
  if (activeTabId !== null) {
    browser.tabs.sendMessage(activeTabId, msg).catch(() => {
      activeTabId = null;
      updateActiveTab();
    });
  } else {
    updateActiveTab();
  }
}

// Broadcast to ALL web tabs (for speech state changes that affect all pages)
async function broadcastToAllWebTabs(msg) {
  try {
    const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (tab.id) {
        browser.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    }
  } catch (e) {}
}

// --- Speech Activity State Management ---
function setSpeechActive() {
  if (!isSpeechActive) {
    isSpeechActive = true;
    console.log('[Handsfree] Speech detected – freezing cursor.');
    broadcastToAllWebTabs({ type: 'SPEECH_ACTIVE' });
  }
  // Reset the cooldown timer every time we detect speech
  clearTimeout(speechActivityTimeout);
  speechActivityTimeout = null;
}

function scheduleSpeechIdle() {
  // Don't immediately go idle – wait for SPEECH_COOLDOWN_MS of silence
  if (speechActivityTimeout) return; // Already scheduled
  speechActivityTimeout = setTimeout(() => {
    if (isSpeechActive) {
      isSpeechActive = false;
      console.log('[Handsfree] Speech ended – resuming cursor.');
      broadcastToAllWebTabs({ type: 'SPEECH_IDLE' });
    }
    speechActivityTimeout = null;
  }, SPEECH_COOLDOWN_MS);
}

function forceSpeechIdle() {
  clearTimeout(speechActivityTimeout);
  speechActivityTimeout = null;
  if (isSpeechActive) {
    isSpeechActive = false;
    broadcastToAllWebTabs({ type: 'SPEECH_IDLE' });
  }
}

// 2. Initialize Whisper Speech Recognizer
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

// --- Whisper Transcript Cleaning ---
// Whisper-tiny often hallucinates artifacts like [Music], (silence), Thank you., etc.
function cleanTranscript(raw) {
  let cleaned = raw
    .replace(/\[.*?\]/g, '')           // [Music], [BLANK_AUDIO], etc.
    .replace(/\(.*?\)/g, '')           // (silence), (music), etc.
    .replace(/^[.!?,;:\-–—\s]+/, '')   // Leading punctuation/whitespace
    .replace(/[.!?,;:\-–—\s]+$/, '')   // Trailing punctuation/whitespace
    .trim()
    .toLowerCase();
  
  // Filter known Whisper hallucination phrases
  const hallucinations = [
    'thank you', 'thanks for watching', 'subscribe', 'like and subscribe',
    'you', 'bye', 'okay', 'oh', 'uh', 'um', 'hmm', 'huh',
    'the', 'a', 'i', 'it', 'is', 'so', 'and', 'but',
    'thank you for watching', 'thanks', 'see you'
  ];
  
  if (hallucinations.includes(cleaned)) {
    return '';
  }
  
  return cleaned;
}

// 3. Port Connections (Audio & Tracker Streams)
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

        // Only forward cursor updates if speech is NOT active (cursor frozen during speech)
        if (!isSpeechActive) {
          sendToTab({
            type: 'UPDATE_CURSOR',
            x: msg.x,
            y: msg.y,
            stickyHold: msg.stickyHold,
            dwellDuration: msg.dwellDuration
          });
        }
      }
    });
  }

  // --- Audio Stream from unified tracker tab ---
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

        // Signal speech activity to content scripts IMMEDIATELY
        setSpeechActive();
      } else if (audioBufferChunk.length > 0) {
        silenceFrames++;
        audioBufferChunk.push(chunk);

        if (silenceFrames >= SILENCE_FRAMES_TO_TRIGGER) {
          const fullBuffer = mergeAudioBuffers(audioBufferChunk);
          audioBufferChunk = [];
          silenceFrames = 0;

          // Drop noise bursts shorter than 0.20 seconds
          if (fullBuffer.length < 16000 * 0.20) {
            scheduleSpeechIdle();
            return;
          }

          console.log(`[Handsfree] Processing utterance (${(fullBuffer.length / 16000).toFixed(1)}s)...`);

          try {
            const output = await transcriber(fullBuffer);
            let transcript = '';
            if (typeof output === 'string') transcript = output;
            else if (Array.isArray(output) && output[0]?.text) transcript = output[0].text;
            else if (output?.text) transcript = output.text;

            transcript = transcript.trim();
            console.log(`[Raw Model Output]: "${transcript}"`);

            const cleaned = cleanTranscript(transcript);
            if (!cleaned) {
              console.log('[Handsfree] Filtered hallucination / noise, ignoring.');
              forceSpeechIdle();
              return;
            }

            console.log(`[Cleaned Transcript]: "${cleaned}"`);

            if (currentMode === 'NAVIGATION') {
<<<<<<< Updated upstream
              let matched = false;

              // Sort commands by length (longest first) to match "scroll down" before "down"
              const sortedCommands = Object.entries(COMMANDS).sort((a, b) => b[0].length - a[0].length);

              for (const [cmd, config] of sortedCommands) {
                if (cleaned.includes(cmd)) {
                  console.log(`[Handsfree Command Triggered]: ${cmd} -> ${config.action}`);
=======
              const lower = normalizeTranscript(transcript);
              const clickNumber = getNumberFromTranscript(lower);
              if (clickNumber !== null) {
                sendToTab({ type: 'COMMAND', command: 'CLICK_NUMBER', payload: { index: clickNumber } });
                return;
              }

              let matched = false;

              for (const [cmd, config] of COMMAND_ENTRIES) {
                if (lower.includes(cmd)) {
                  console.log(`[Handsfree Command Triggered]: ${cmd}`);
>>>>>>> Stashed changes

                  if (config.action === 'RECENTER') {
                    if (cursorTrackingPort) {
                      cursorTrackingPort.postMessage({ type: 'CALIBRATE' });
                    }
<<<<<<< Updated upstream
                  } else if (config.action === 'GO_BACK') {
                    sendToTab({ type: 'COMMAND', command: 'GO_BACK' });
                  } else if (config.action === 'GO_FORWARD') {
                    sendToTab({ type: 'COMMAND', command: 'GO_FORWARD' });
                  } else if (config.action === 'REFRESH') {
                    sendToTab({ type: 'COMMAND', command: 'REFRESH' });
                  } else if (config.action === 'SCROLL_TO_TOP') {
                    sendToTab({ type: 'COMMAND', command: 'SCROLL_TO_TOP' });
                  } else if (config.action === 'SCROLL_TO_BOTTOM') {
                    sendToTab({ type: 'COMMAND', command: 'SCROLL_TO_BOTTOM' });
                  } else if (config.action === 'NEW_TAB') {
                    browser.tabs.create({}).catch(() => {});
                  } else if (config.action === 'CLOSE_TAB') {
                    if (activeTabId) {
                      browser.tabs.remove(activeTabId).catch(() => {});
                      activeTabId = null;
                      updateActiveTab();
                    }
                  } else if (config.action === 'TAB_RIGHT' || config.action === 'TAB_LEFT') {
                    switchTab(config.action === 'TAB_RIGHT' ? 1 : -1);
                  } else if (config.action === 'ZOOM_IN') {
                    sendToTab({ type: 'COMMAND', command: 'ZOOM_IN' });
                  } else if (config.action === 'ZOOM_OUT') {
                    sendToTab({ type: 'COMMAND', command: 'ZOOM_OUT' });
                  } else if (config.action === 'ZOOM_RESET') {
                    sendToTab({ type: 'COMMAND', command: 'ZOOM_RESET' });
=======
                  } else if (config.action === 'CLOSE_TAB') {
                    if (activeTabId !== null) {
                      const tabToClose = activeTabId;
                      activeTabId = null;
                      browser.tabs.remove(tabToClose).catch((error) => {
                        console.warn('[Handsfree] Unable to close current tab:', error);
                        updateActiveTab();
                      });
                    }
>>>>>>> Stashed changes
                  } else {
                    const isCoordCommand = ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'HOLD', 'RELEASE'].includes(config.action);
                    const payload = isCoordCommand
                      ? { x: latestCursor.x, y: latestCursor.y }
                      : config.payload;

                    sendToTab({ type: 'COMMAND', command: config.action, payload });
                  }

                  // Show command feedback toast on the content page
                  sendToTab({
                    type: 'COMMAND_FEEDBACK',
                    command: config.action,
                    transcript: cleaned
                  });

                  matched = true;
                  break;
                }
              }

              if (!matched) {
                console.log(`[Handsfree] No navigation command matched in: "${cleaned}"`);
                sendToTab({
                  type: 'COMMAND_FEEDBACK',
                  command: null,
                  transcript: cleaned
                });
              }
            } else if (currentMode === 'DICTATION') {
              const cleanText = cleaned.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').trim();

              if (cleanText.includes('stop dictating') || cleanText.includes('escape')) {
                currentMode = 'NAVIGATION';
                sendToTab({ type: 'MODE_CHANGE', mode: 'NAVIGATION' });
              } else if (
                cleanText === 'search' ||
                cleanText === 'enter' ||
                cleanText === 'submit' ||
                cleanText.endsWith(' search')
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

          // After processing, signal that speech is done
          forceSpeechIdle();
        }
      } else {
        // No speech and no buffered audio — schedule idle if we were active
        if (isSpeechActive) {
          scheduleSpeechIdle();
        }
      }
    });
  }
});

// Tab switching helper
async function switchTab(direction) {
  try {
    const tabs = await browser.tabs.query({ currentWindow: true });
    if (tabs.length < 2) return;
    
    const currentIndex = tabs.findIndex(t => t.active);
    if (currentIndex === -1) return;
    
    let nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
    await browser.tabs.update(tabs[nextIndex].id, { active: true });
  } catch (e) {
    console.warn('[Handsfree] Tab switch error:', e);
  }
}

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

// Listen for mode changes triggered by DOM focus in content.js
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'SET_MODE') {
    currentMode = message.mode;
    console.log(`[Handsfree] Switched to mode: ${currentMode}`);
  }
});