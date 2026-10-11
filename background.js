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
  sendTelemetrySummary();
}

function getTelemetryStatusData() {
  const m = telemetrySession.metrics;
  const totalDurationSec = Math.max(0, Math.round((performance.now() - telemetrySession.startTime) / 1000));
  const durationFormatted = totalDurationSec >= 60
    ? `${Math.floor(totalDurationSec / 60)}m ${String(totalDurationSec % 60).padStart(2, '0')}s`
    : `${totalDurationSec}s`;

  const asrLogs = telemetrySession.logs.filter(l => l.category === 'VOICE_ASR' && Number.isFinite(l.latencyMs));
  const avgLatencyMs = asrLogs.length > 0
    ? Math.round(asrLogs.reduce((acc, l) => acc + l.latencyMs, 0) / asrLogs.length)
    : null;
  const responseSpeed = avgLatencyMs !== null ? `${(avgLatencyMs / 1000).toFixed(2)}s` : 'Ready';

  const recognizedCmds = m.recognizedCommands || 0;
  const unrecognized = m.unrecognizedUtterances || 0;
  const totalVoiceAttempts = recognizedCmds + unrecognized;
  const usability = totalVoiceAttempts > 0
    ? Math.round((recognizedCmds / totalVoiceAttempts) * 100)
    : (asrLogs.length > 0 ? 100 : 100);

  let tip = 'Speak commands like "down" or "click" to navigate';
  if (totalVoiceAttempts > 0) {
    if (usability < 60) {
      tip = 'Move closer to mic to reduce ambient noise';
    } else if (usability < 85) {
      tip = 'Speak clearly at conversational volume';
    } else {
      tip = 'Voice recognition performing optimally';
    }
  }

  const actionsCount = telemetrySession.logs.length;
  const statusString = `System Status: ${actionsCount} Actions Logged in ${durationFormatted} • Response Speed: ${responseSpeed} • Usability: ${usability}% (Tip: ${tip})`;

  return {
    statusString,
    actionsCount,
    durationFormatted,
    responseSpeed,
    usability,
    tip
  };
}

function sendTelemetrySummary() {
  if (!cursorTrackingPort) return;
  try {
    const data = getTelemetryStatusData();
    cursorTrackingPort.postMessage({
      type: 'TELEMETRY_STATUS_UPDATE',
      ...data
    });
  } catch (e) {}
}

// Helpers for human-friendly formatting in CSV
function escapeCsv(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsvRow(arr) {
  return arr.map(escapeCsv).join(',');
}

function formatTime(ms) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function makeVisualBar(pct, totalBlocks = 10) {
  if (pct === null || isNaN(pct)) return '[No speech recorded]';
  const filled = Math.min(totalBlocks, Math.max(0, Math.round((pct / 100) * totalBlocks)));
  const empty = totalBlocks - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%`;
}

function parseLogForCommoner(log, index) {
  const time = formatTime(log.sessionElapsedMs);
  const cat = log.category;
  const evt = log.eventName;

  let whatYouDid = 'Used handsfree navigation';
  let whatComputerDid = 'Processed page interaction';
  let speedStatus = '✓ Success';
  let laymanExplanation = '';

  if (cat === 'VOICE_ASR' && evt === 'INFERENCE_COMPLETE') {
    const transcript = log.transcript || 'Spoken words';
    whatYouDid = `Spoke: "${transcript}"`;
    whatComputerDid = 'Heard your speech and executed command';
    speedStatus = log.latencyMs ? `⚡ ${log.latencyMs}ms` : '⚡ Fast';
    const latencySec = log.latencyMs ? ` in ${(log.latencyMs / 1000).toFixed(2)}s` : '';
    laymanExplanation = `You said "${transcript}". The voice AI understood you${latencySec} and performed the command completely hands-free.`;
  } else if (cat === 'DOM_INTERACTION' && evt === 'SELECTION_ACTIVATION') {
    const isDwell = log.activationMethod === 'DWELL_CLICK';
    const tag = (log.tagName || 'button').toLowerCase();
    whatYouDid = isDwell ? `Rested gaze on <${tag}> element` : `Looked at <${tag}> and said "click"`;
    whatComputerDid = `Clicked <${tag}> at cursor location`;
    speedStatus = isDwell ? `✓ Dwell Click (${log.acquisitionTimeMs || 1000}ms)` : '✓ Voice Click';
    laymanExplanation = isDwell
      ? `You held your head steady on the ${tag} for 1 second. The system clicked it automatically without touching a mouse.`
      : `You looked at the ${tag} and said "click". The system clicked the exact item you were viewing.`;
  } else if (cat === 'TASK_COMPLETION' && evt === 'SEARCH_SUBMITTED') {
    whatYouDid = 'Finished entering search term';
    whatComputerDid = 'Submitted search query to web page';
    speedStatus = log.taskCompletionTimeMs ? `✓ Done (${(log.taskCompletionTimeMs / 1000).toFixed(1)}s)` : '✓ Done';
    laymanExplanation = `You completed an entire web search hands-free from dictation to submission.`;
  } else if (cat === 'TAB_MANAGEMENT' && evt === 'SWITCH_TAB') {
    whatYouDid = 'Spoke tab navigation command';
    whatComputerDid = 'Switched to next/previous browser tab';
    speedStatus = '✓ Switched Tab';
    laymanExplanation = `The browser switched tabs hands-free based on your voice command.`;
  } else if (evt === 'START_CALIBRATION' || log.action === 'START_CALIBRATION') {
    whatYouDid = 'Started 5-point calibration';
    whatComputerDid = 'Calibrated screen boundaries to head';
    speedStatus = '✓ Calibrating';
    laymanExplanation = `You ran the calibration helper to match the screen corners to your natural head movements.`;
  } else if (evt === 'RECENTER' || log.action === 'RECENTER') {
    whatYouDid = 'Reset resting head position';
    whatComputerDid = 'Aligned cursor with your face angle';
    speedStatus = '✓ Centered';
    laymanExplanation = `You centered the cursor to where your face is comfortably resting.`;
  } else {
    whatYouDid = log.category ? `Performed ${log.category}` : 'Navigation action';
    whatComputerDid = log.eventName ? `Handled ${log.eventName}` : 'Updated page state';
    speedStatus = '✓ OK';
    laymanExplanation = `The handsfree system processed an interaction event on the active page.`;
  }

  return {
    step: index + 1,
    time,
    whatYouDid,
    whatComputerDid,
    speedStatus,
    laymanExplanation
  };
}

function exportEvaluationCSV() {
  const m = telemetrySession.metrics;
  const statusData = getTelemetryStatusData();

  const recognizedCmds = m.recognizedCommands || 0;
  const unrecognized = m.unrecognizedUtterances || 0;
  const totalVoiceAttempts = recognizedCmds + unrecognized;
  const voiceClicks = m.voiceClicks || 0;
  const dwellClicks = m.dwellClicks || 0;
  const totalClicks = m.totalClicks || (voiceClicks + dwellClicks);

  // Determine overall grade
  let letterGrade = 'Grade A (Excellent)';
  let stars = '★★★★★';
  let gradeSummary = 'System performed excellently with high accuracy and fast responsiveness.';

  if (totalVoiceAttempts > 0) {
    if (statusData.usability >= 90) {
      letterGrade = `Grade A (${statusData.usability}%)`;
      stars = '★★★★★';
      gradeSummary = 'System performed excellently with high voice accuracy and fast response.';
    } else if (statusData.usability >= 75) {
      letterGrade = `Grade B (${statusData.usability}%)`;
      stars = '★★★★☆';
      gradeSummary = 'Good performance. Most commands were recognized quickly.';
    } else if (statusData.usability >= 60) {
      letterGrade = `Grade C (${statusData.usability}%)`;
      stars = '★★★☆☆';
      gradeSummary = 'Satisfactory. Consider speaking slightly clearer or moving closer to mic.';
    } else {
      letterGrade = `Grade D (${statusData.usability}%)`;
      stars = '★★☆☆☆';
      gradeSummary = 'Needs adjustment. Move closer to microphone to reduce ambient noise.';
    }
  }

  const lines = [
    '# HANDSFREE ACCESSIBILITY SYSTEM - PERFORMANCE EVALUATION METRICS',
    `# Export Date: ${new Date().toISOString()} | Session ID: ${telemetrySession.sessionId}`,
    '',
    'SECTION 1: SYSTEM USABILITY SUMMARY',
    toCsvRow(['Metric', 'Value', 'Rating', 'Plain English Explanation']),
    toCsvRow(['System Status', statusData.actionsCount + ' Actions', 'Active', statusData.statusString]),
    toCsvRow(['Overall Usability Grade', letterGrade, stars, gradeSummary]),
    toCsvRow(['Session Usage Duration', statusData.durationFormatted, 'Active', 'Total time spent navigating the web hands-free during this session']),
    toCsvRow(['Average Response Speed', statusData.responseSpeed, 'Speed Rating', `Average speech recognition inference latency (${statusData.responseSpeed})`]),
    toCsvRow(['Voice Usability Rate', `${statusData.usability}%`, `${recognizedCmds}/${totalVoiceAttempts || 1} Commands`, `${recognizedCmds} commands recognized out of ${totalVoiceAttempts} voice attempts`]),
    toCsvRow(['Handsfree Clicks', `${totalClicks} Clicks`, 'Interactive', `${voiceClicks} voice clicks by saying "click" and ${dwellClicks} gaze clicks by holding still for 1s`]),
    toCsvRow(['Tab Switches', `${m.tabSwitches || 0} Switches`, 'Navigation', 'Browser tabs navigated hands-free using voice commands']),
    toCsvRow(['Privacy & Security', '100% On-Device', 'Private', 'All speech recognition and camera tracking ran completely on your device without cloud upload']),
    '',
    'SECTION 2: STEP-BY-STEP ACTIVITY LOG',
    toCsvRow(['Step', 'Time (MM:SS)', 'Action Category', 'What You Did', 'What The Computer Did', 'Speed / Status', 'Plain English Explanation'])
  ];

  if (telemetrySession.logs.length === 0) {
    lines.push(toCsvRow([1, '00:00', 'SESSION_START', 'Started handsfree session', 'Initialized speech and gaze tracking', '✓ Ready', 'Handsfree system initialized and waiting for voice commands or gaze.']));
  } else {
    telemetrySession.logs.forEach((log, idx) => {
      const parsed = parseLogForCommoner(log, idx);
      lines.push(toCsvRow([
        parsed.step,
        parsed.time,
        log.category || 'ACTION',
        parsed.whatYouDid,
        parsed.whatComputerDid,
        parsed.speedStatus,
        parsed.laymanExplanation
      ]));
    });
  }

  const csvContent = lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  browser.downloads.download({
    url,
    filename: `handsfree_evaluation_${Date.now()}.csv`,
    saveAs: true
  });
}

// --- Exact Voice Command Mapping ---
const COMMANDS = {
  // 1. Scroll Down
  'page down': { action: 'SCROLL', payload: { y: 550 } },
  'down': { action: 'SCROLL', payload: { y: 550 } },

  // 2. Scroll Up
  'page up': { action: 'SCROLL', payload: { y: -550 } },
  'up': { action: 'SCROLL', payload: { y: -550 } },

  // 3. Jump to Extremes ('title' scrolls to top)
  'head bottom': { action: 'SCROLL_EXTREME', payload: { position: 'BOTTOM' } },
  'bottom': { action: 'SCROLL_EXTREME', payload: { position: 'BOTTOM' } },
  'head top': { action: 'SCROLL_EXTREME', payload: { position: 'TOP' } },
  'title': { action: 'SCROLL_EXTREME', payload: { position: 'TOP' } },
  'top': { action: 'SCROLL_EXTREME', payload: { position: 'TOP' } },

  // 4. Continuous Auto-Scroll ('start reading' down, 'reverse' up)
  // Continuous Auto-Scroll Down
  'start reading': { action: 'AUTO_SCROLL_START', payload: { direction: 1 } },
  'start read': { action: 'AUTO_SCROLL_START', payload: { direction: 1 } },
  'reading down': { action: 'AUTO_SCROLL_START', payload: { direction: 1 } },
  'reading': { action: 'AUTO_SCROLL_START', payload: { direction: 1 } },
  'read down': { action: 'AUTO_SCROLL_START', payload: { direction: 1 } },
  'reverse': { action: 'AUTO_SCROLL_START', payload: { direction: -1 } },
  'read up': { action: 'AUTO_SCROLL_START', payload: { direction: -1 } },

  // 5. Stop Auto-Scroll
  'stop reading': { action: 'AUTO_SCROLL_STOP' },
  'stop': { action: 'AUTO_SCROLL_STOP' },

  // 6. Adjust Speed (Step size 0.25)
  'move fast': { action: 'AUTO_SCROLL_SPEED', payload: { delta: 0.75 } },
  'fast': { action: 'AUTO_SCROLL_SPEED', payload: { delta: 0.75 } },
  'move slow': { action: 'AUTO_SCROLL_SPEED', payload: { delta: -0.75 } },
  'slow': { action: 'AUTO_SCROLL_SPEED', payload: { delta: -0.75 } },

  // 7. Tab Navigation
  'next page': { action: 'NEXT_TAB' },
  'back page': { action: 'PREV_TAB' },
  'new page': { action: 'NEW_TAB' },
  'close page': { action: 'CLOSE_TAB' },

  // 8. Interaction & Selection
  'click': { action: 'CLICK' },

  // 9. Search Bar & Form Focus
  'open search': { action: 'FOCUS_SEARCH' },

  // 10. Clear Field
  'clear': { action: 'CLEAR' },

  // 11. Recenter Gaze
  'center': { action: 'RECENTER' },

  // 12. Evaluation & Telemetry Export
  'export stats': { action: 'EXPORT_METRICS' },
  'export metrics': { action: 'EXPORT_METRICS' }
};

// Sort longest phrase first so multi-word commands take priority over standalone keywords
const SORTED_COMMAND_KEYS = Object.keys(COMMANDS).sort((a, b) => b.length - a.length);

// --- Tab Management Handlers ---
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

// --- Port Streams & Audio Inference ---
browser.runtime.onConnect.addListener((port) => {
  if (port.name === 'cursor-tracking') {
    cursorTrackingPort = port;
    sendTelemetrySummary();

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
      } else if (msg && msg.type === 'GET_TELEMETRY_STATUS') {
        sendTelemetrySummary();
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

            // 1. Navigation Mode Command Resolution
            if (currentMode === 'NAVIGATION') {
              // Strip all punctuation and normalize multiple spaces to a single space
              const lower = transcript
                .toLowerCase()
                .replace(/[.,/#!$%^&*;:{}=\-_`~()?]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

              console.log(`[Handsfree Cleaned Utterance]: "${lower}"`);
              const lower = transcript.toLowerCase();
              const linkNumber = parseLinkNumber(lower);

              // Link hints are handled before the normal command table so
              // utterances such as "click three" can still select hint 3.
              if (linkNumber !== null) {
                console.log(`[Handsfree] Link hint selected: ${linkNumber}`);
                sendToTab({
                  type: 'COMMAND',
                  command: 'LINK_NUMBER',
                  payload: { number: linkNumber }
                });
                return;
              }

              let matched = false;

              for (const cmd of SORTED_COMMAND_KEYS) {
                // Check both boundary-isolated match and substring inclusion
                const regex = new RegExp(`(^|\\s)${cmd}(\\s|$)`, 'i');
                if (regex.test(lower) || lower.includes(cmd)) {
                  const config = COMMANDS[cmd];
                  console.log(`[Handsfree Command Triggered]: "${cmd}"`);
                  telemetrySession.metrics.recognizedCommands++;
                  sendTelemetrySummary();

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
                sendTelemetrySummary();
                console.log(`[Handsfree] No command matched in: "${lower}"`);
              }
            } else if (currentMode === 'DICTATION') {
              const cleanText = transcript.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '').trim();

              if (cleanText === 'stop dictating' || cleanText === 'exit input' || cleanText === 'escape') {
                currentMode = 'NAVIGATION';
                sendToTab({ type: 'MODE_CHANGE', mode: 'NAVIGATION' });
              } else if (
                cleanText === 'enter' ||
                cleanText === 'submit' ||
                cleanText === 'press enter'
              ) {
                sendToTab({ type: 'COMMAND', command: 'SUBMIT_SEARCH' });
                currentMode = 'NAVIGATION';
                sendToTab({ type: 'MODE_CHANGE', mode: 'NAVIGATION' });
              } else if (
                cleanText === 'clear' ||
                cleanText === 'clear all' ||
                cleanText === 'erase'
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