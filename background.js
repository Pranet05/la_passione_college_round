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

// Active tab cache to eliminate tabs.query IPC lag
let activeTabId = null;

// VAD parameters tuned for earphone microphones
const SILENCE_RMS_THRESHOLD = 0.004;
const MIN_SPEECH_ZCR = 0.04;
const SILENCE_FRAMES_TO_TRIGGER = 3; // ~0.8s pause triggers inference

const COMMANDS = {
  'scroll down': { action: 'SCROLL', payload: { y: 600 } },
  'scroll up': { action: 'SCROLL', payload: { y: -600 } },
  'down': { action: 'SCROLL', payload: { y: 350 } },
  'up': { action: 'SCROLL', payload: { y: -350 } },
  'click': { action: 'CLICK' },
  'focus search': { action: 'FOCUS_SEARCH' },
  'clear': { action: 'CLEAR' }
};

// 1. Maintain Active Web Tab Cache Safely
async function updateActiveTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    let target = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));

    if (!target) {
      const allTabs = await browser.tabs.query({ active: true });
      target = allTabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
    }

    if (target?.id) {
      activeTabId = target.id;
    }
  } catch (e) {
    // Fail silently during browser tab transitions
  }
}

browser.tabs.onActivated.addListener(() => { updateActiveTab(); });
browser.tabs.onUpdated.addListener(() => { updateActiveTab(); });
updateActiveTab();

// Non-blocking fire-and-forget message dispatcher
function sendToTab(msg) {
  if (activeTabId) {
    browser.tabs.sendMessage(activeTabId, msg).catch(() => {
      activeTabId = null;
      updateActiveTab();
    });
  } else {
    updateActiveTab().then(() => {
      if (activeTabId) {
        browser.tabs.sendMessage(activeTabId, msg).catch(() => {});
      }
    });
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

// 3. Port Connections (Audio & Tracker Streams)
browser.runtime.onConnect.addListener((port) => {
  // --- High-Speed Nose Tracking Stream ---
  if (port.name === 'cursor-tracking') {
    console.log('[Handsfree] Cursor tracking port connected.');

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

  // --- Audio Stream from mic-permission tab ---
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

          // Drop noise bursts shorter than 0.4 seconds
          if (fullBuffer.length < 16000 * 0.4) return;

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

                  const payload = (cmd === 'click')
                    ? { x: latestCursor.x, y: latestCursor.y }
                    : config.payload;

                  sendToTab({ type: 'COMMAND', command: config.action, payload });
                  matched = true;
                  break;
                }
              }

              if (!matched) {
                console.log(`[Handsfree] No navigation command matched in: "${lower}"`);
              }
            } else if (currentMode === 'DICTATION') {
              const cleanText = transcript.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').trim();

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
                // 1. Submit search form / press Enter
                sendToTab({ type: 'COMMAND', command: 'SUBMIT_SEARCH' });
                // 2. Return back to NAVIGATION mode
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

// Listen for mode changes triggered by DOM focus in content.js
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'SET_MODE') {
    currentMode = message.mode;
    console.log(`[Handsfree] Switched to mode: ${currentMode}`);
  }
});