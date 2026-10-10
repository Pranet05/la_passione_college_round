import { pipeline, env } from './transformers.min.js';

// Use browser internal CacheStorage and Hugging Face remote endpoints on initial load
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let currentMode = 'NAVIGATION';
let audioBufferChunk = [];
let silenceFrames = 0;

// Tuned for earphone microphones
const SILENCE_RMS_THRESHOLD = 0.004;
const MIN_SPEECH_ZCR = 0.04; // Wind typically stays below 0.02; human voice is > 0.05
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

// 1. Initialize Speech Recognizer
async function initEngine() {
  console.log('[Handsfree] Initializing local speech model...');
  try {
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      quantized: true
    });
    console.log('[Handsfree] Local speech recognizer ready.');
  } catch (err) {
    console.error('[Handsfree] Failed to load model:', err);
  }
}

initEngine();

// 2. Audio Ingestion via persistent Port from mic-permission tab
browser.runtime.onConnect.addListener((port) => {
  if (port.name === 'audio-stream') {
    console.log('[Handsfree] Audio stream port connected.');

    port.onMessage.addListener(async (msg) => {
      if (!msg.audioChunk || !transcriber) return;

      const chunk = new Float32Array(msg.audioChunk);
      const rms = calculateRMS(chunk);
      const zcr = calculateZCR(chunk);

      // A chunk is only treated as speech if it has both energy AND voice-like frequency
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

          // Discard short bursts or mic clicks (< 0.4s)
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

            // Route recognized text to commands or dictation
            if (currentMode === 'NAVIGATION') {
              const lower = transcript.toLowerCase();
              let matched = false;

              for (const [cmd, config] of Object.entries(COMMANDS)) {
                if (lower.includes(cmd)) {
                  console.log(`[Handsfree Command Triggered]: ${cmd}`);
                  await dispatchToActiveTab({ type: 'COMMAND', command: config.action, payload: config.payload });
                  matched = true;
                  break;
                }
              }

              if (!matched) {
                console.log(`[Handsfree] No navigation command matched in: "${lower}"`);
              }
            } else if (currentMode === 'DICTATION') {
              // Strip punctuation and surrounding spaces
              const cleanText = transcript.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').trim();

              if (cleanText.includes('stop dictating') || cleanText.includes('escape')) {
                currentMode = 'NAVIGATION';
                await dispatchToActiveTab({ type: 'MODE_CHANGE', mode: 'NAVIGATION' });
              } else if (
                cleanText === 'clear' || 
                cleanText === 'clear field' || 
                cleanText === 'clear text' || 
                cleanText === 'delete all' ||
                cleanText.endsWith(' clear')
              ) {
                console.log(`[Handsfree] Intercepted CLEAR command from utterance: "${transcript}"`);
                await dispatchToActiveTab({ type: 'COMMAND', command: 'CLEAR' });
              } else {
                await dispatchToActiveTab({ type: 'INJECT_TEXT', text: transcript + ' ' });
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
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
  }
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

// Tab message dispatcher (robust against DevTools / background window focus)
async function dispatchToActiveTab(message) {
  try {
    const tabs = await browser.tabs.query({ active: true });
    // Pick the visible website tab (ignoring about:* and moz-extension://)
    const targetTab = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));

    if (!targetTab?.id) {
      console.warn('[Handsfree] No active http/https tab found to receive action.');
      return;
    }

    console.log(`[Handsfree] Dispatching ${message.type} to tab ${targetTab.id}`);
    await browser.tabs.sendMessage(targetTab.id, message);
  } catch (err) {
    console.error('[Handsfree] Dispatch failed (refresh the webpage if extension was just reloaded):', err.message);
  }
}

// Listen for mode changes triggered by content.js DOM focus
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'SET_MODE') {
    currentMode = message.mode;
    console.log(`[Handsfree] Switched to mode: ${currentMode}`);
  }
});