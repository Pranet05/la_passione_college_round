import { FilesetResolver, FaceLandmarker } from '../vendor/vision_bundle.mjs';

const extApi = typeof browser !== 'undefined' ? browser : chrome;

const video = document.getElementById('webcam');
const statusEl = document.getElementById('status');
const camDot = document.getElementById('cam-dot');
const micStatusEl = document.getElementById('mic-status');
const micDot = document.getElementById('mic-dot');
const metricsEl = document.getElementById('metrics');
const ipcStatusEl = document.getElementById('ipc-status');
const micLevelEl = document.getElementById('mic-level');
const recenterBtn = document.getElementById('recenter-btn');
const calibBtn = document.getElementById('calib-btn');
const popoutBtn = document.getElementById('popout-btn');

const sensXSlider = document.getElementById('sens-x');
const sensYSlider = document.getElementById('sens-y');
const smoothSlider = document.getElementById('smooth-factor');
const stickyHoldToggle = document.getElementById('sticky-hold-toggle');
const dwellTimeSlider = document.getElementById('dwell-time');

const sensXVal = document.getElementById('sens-x-val');
const sensYVal = document.getElementById('sens-y-val');
const smoothVal = document.getElementById('smooth-val');
const dwellVal = document.getElementById('dwell-val');

let sensitivityX = parseFloat(sensXSlider?.value || 4.2);
let sensitivityY = parseFloat(sensYSlider?.value || 4.8);
let smoothFactor = parseFloat(smoothSlider?.value || 0.45);
let stickyHoldEnabled = stickyHoldToggle ? stickyHoldToggle.checked : true;
let dwellTimeMs = parseFloat(dwellTimeSlider?.value || 1.0) * 1000;

sensXSlider?.addEventListener('input', (e) => {
  sensitivityX = parseFloat(e.target.value);
  if (sensXVal) sensXVal.innerText = `${sensitivityX.toFixed(1)}x`;
});

sensYSlider?.addEventListener('input', (e) => {
  sensitivityY = parseFloat(e.target.value);
  if (sensYVal) sensYVal.innerText = `${sensitivityY.toFixed(1)}x`;
});

smoothSlider?.addEventListener('input', (e) => {
  smoothFactor = parseFloat(e.target.value);
  if (smoothVal) smoothVal.innerText = smoothFactor.toFixed(2);
});

stickyHoldToggle?.addEventListener('change', (e) => {
  stickyHoldEnabled = e.target.checked;
});

dwellTimeSlider?.addEventListener('input', (e) => {
  const sec = parseFloat(e.target.value);
  dwellTimeMs = sec * 1000;
  if (dwellVal) dwellVal.innerText = `${sec.toFixed(1)}s`;
});

let faceLandmarker = null;
let lastVideoTime = -1;
let cursorPort = null;
let audioPort = null;

let calibratedOriginX = null;
let calibratedOriginY = null;
let smoothX = 0.5;
let smoothY = 0.5;
let lastRawNoseX = 0.5;
let lastRawNoseY = 0.5;
let filteredNoseX = null;
let filteredNoseY = null;

// Face landmarks drift by a few pixels even while the user is still. Ignore
// that noise after projection so the pointer can rest on a target.
const CURSOR_DEAD_ZONE = 0.006;

let lastSend = 0;
const SEND_INTERVAL = 16; // ~60 FPS

// --- 30-Second 5-Point Calibration Wizard Engine ---
let calibrationMode = false;
let calibrationStep = 0;
const calibrationPoints = [
  { name: 'Center', prompt: 'Look directly at the screen center' },
  { name: 'Top-Left', prompt: 'Look at the top-left corner' },
  { name: 'Top-Right', prompt: 'Look at the top-right corner' },
  { name: 'Bottom-Left', prompt: 'Look at the bottom-left corner' },
  { name: 'Bottom-Right', prompt: 'Look at the bottom-right corner' }
];

let calibBounds = {
  minX: 0.38,
  maxX: 0.62,
  minY: 0.38,
  maxY: 0.62,
  calibrated: false
};

function startCalibration() {
  calibrationMode = true;
  calibrationStep = 0;
  updateCalibrationUI();
}

function handleCalibrationAdvance() {
  if (!calibrationMode) {
    calibrateCenter();
    return;
  }

  switch (calibrationStep) {
    case 0:
      calibratedOriginX = lastRawNoseX;
      calibratedOriginY = lastRawNoseY;
      break;
    case 1:
      calibBounds.minX = lastRawNoseX;
      calibBounds.minY = lastRawNoseY;
      break;
    case 2:
      calibBounds.maxX = lastRawNoseX;
      calibBounds.minY = Math.min(calibBounds.minY, lastRawNoseY);
      break;
    case 3:
      calibBounds.minX = Math.min(calibBounds.minX, lastRawNoseX);
      calibBounds.maxY = lastRawNoseY;
      break;
    case 4:
      calibBounds.maxX = Math.max(calibBounds.maxX, lastRawNoseX);
      calibBounds.maxY = Math.max(calibBounds.maxY, lastRawNoseY);
      calibBounds.calibrated = true;
      calibrationMode = false;
      if (statusEl) statusEl.innerText = '✅ 5-Point Calibration Complete!';
      if (calibBtn) calibBtn.innerText = '📐 Calibrated!';
      setTimeout(() => { if (calibBtn) calibBtn.innerText = '📐 30s 5-Point Calibration'; }, 2000);
      return;
  }

  calibrationStep++;
  updateCalibrationUI();
}

function updateCalibrationUI() {
  if (statusEl) {
    statusEl.innerText = `🎯 [${calibrationStep + 1}/5]${calibrationPoints[calibrationStep].prompt} (Say "click" / Space)`;
  }
}

calibBtn?.addEventListener('click', () => {
  if (!calibrationMode) startCalibration();
  else handleCalibrationAdvance();
});

// 1. Establish Ports with Background Service
function connectCursorPort() {
  try {
    cursorPort = extApi.runtime.connect({ name: 'cursor-tracking' });
    if (ipcStatusEl) ipcStatusEl.innerText = 'Connected';

    cursorPort.onMessage.addListener((msg) => {
      if (msg?.type === 'CALIBRATE') {
        calibrateCenter();
      } else if (msg?.type === 'START_CALIBRATION') {
        startCalibration();
      } else if (msg?.type === 'NEXT_CALIB_POINT') {
        if (calibrationMode) handleCalibrationAdvance();
      }
    });

    cursorPort.onDisconnect.addListener(() => {
      cursorPort = null;
      if (ipcStatusEl) ipcStatusEl.innerText = 'Reconnecting...';
      setTimeout(connectCursorPort, 1000);
    });
  } catch (e) {
    setTimeout(connectCursorPort, 1000);
  }
}

function connectAudioPort() {
  try {
    audioPort = extApi.runtime.connect({ name: 'audio-stream' });
    audioPort.onDisconnect.addListener(() => {
      audioPort = null;
      setTimeout(connectAudioPort, 1000);
    });
  } catch (e) {
    setTimeout(connectAudioPort, 1000);
  }
}

connectCursorPort();
connectAudioPort();

function calibrateCenter() {
  calibratedOriginX = lastRawNoseX;
  calibratedOriginY = lastRawNoseY;
  smoothX = 0.5;
  smoothY = 0.5;
  if (recenterBtn) {
    const originalText = recenterBtn.innerText;
    recenterBtn.innerText = '✅ Centered!';
    setTimeout(() => { recenterBtn.innerText = originalText; }, 800);
  }
  console.log('[Tracker] Calibrated neutral center to:', calibratedOriginX, calibratedOriginY);
}

recenterBtn?.addEventListener('click', calibrateCenter);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'KeyC') {
    if (calibrationMode) handleCalibrationAdvance();
    else calibrateCenter();
  }
});

popoutBtn?.addEventListener('click', async () => {
  try {
    if (extApi.windows?.create) {
      await extApi.windows.create({
        url: window.location.href,
        type: 'popup',
        width: 520,
        height: 640
      });
    }
  } catch (err) {
    console.warn(err);
  }
});

// 2. Audio Capture Engine (Unified)
async function initAudio(stream) {
  try {
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);

    const highPass = audioContext.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.setValueAtTime(120, audioContext.currentTime);

    const processor = audioContext.createScriptProcessor(2048, 1, 1);

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);

      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sum / inputData.length);
      const levelPercent = Math.min(100, Math.round(rms * 450));
      if (micLevelEl) {
        micLevelEl.style.width = `${levelPercent}%`;
      }

      if (audioPort) {
        audioPort.postMessage({ audioChunk: Array.from(inputData) });
      }
    };

    // Muted GainNode route to eliminate headphone audio playback/echo
    const muteNode = audioContext.createGain();
    muteNode.gain.setValueAtTime(0, audioContext.currentTime);

    source.connect(highPass);
    highPass.connect(processor);
    processor.connect(muteNode);
    muteNode.connect(audioContext.destination);

    if (micStatusEl) micStatusEl.innerText = 'Microphone streaming active';
    if (micDot) { micDot.className = 'dot green'; }
  } catch (err) {
    if (micStatusEl) micStatusEl.innerText = `Mic error: ${err.message}`;
    if (micDot) { micDot.className = 'dot red'; }
    console.error('[Tracker] Audio init error:', err);
  }
}

// 3. Video & Face Mesh Tracker Engine
async function initTracker() {
  try {
    if (statusEl) statusEl.innerText = 'Initializing WASM Runtime...';

    const wasmRoot = extApi.runtime.getURL('vendor/wasm');
    const modelPath = extApi.runtime.getURL('vendor/face_landmarker.task');

    const filesetResolver = await FilesetResolver.forVisionTasks(wasmRoot);

    if (statusEl) statusEl.innerText = 'Loading Face Landmarker...';
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false
    });

    if (statusEl) statusEl.innerText = 'Requesting Camera & Mic...';

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      },
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    initAudio(mediaStream);

    video.srcObject = mediaStream;
    video.addEventListener('loadeddata', () => {
      if (statusEl) statusEl.innerText = 'Gaze tracking active';
      if (camDot) { camDot.className = 'dot green'; }
      startProcessingLoop();
    });
  } catch (err) {
    if (statusEl) statusEl.innerText = `Error: ${err.message}`;
    if (camDot) { camDot.className = 'dot red'; }
    console.error(err);
  }
}

// 4. High-Speed Processing Loop with Adaptive Smoothing
function startProcessingLoop() {
  let frameCounter = 0;

  const processFrame = () => {
    if (video.readyState >= 2 && faceLandmarker) {
      const now = performance.now();

      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const results = faceLandmarker.detectForVideo(video, now);

        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
          const nose = results.faceLandmarks[0][1];

          const rawX = 1.0 - nose.x;
          const rawY = nose.y;

          if (filteredNoseX === null || filteredNoseY === null) {
            filteredNoseX = rawX;
            filteredNoseY = rawY;
          } else {
            // Filter landmark noise at rest and respond faster when the head
            // moves a meaningful distance.
            const rawDistance = Math.hypot(rawX - filteredNoseX, rawY - filteredNoseY);
            const landmarkFactor = Math.min(0.58, 0.18 + rawDistance * 7);
            filteredNoseX += (rawX - filteredNoseX) * landmarkFactor;
            filteredNoseY += (rawY - filteredNoseY) * landmarkFactor;
          }

          lastRawNoseX = filteredNoseX;
          lastRawNoseY = filteredNoseY;

          if (calibratedOriginX === null || calibratedOriginY === null) {
            frameCounter++;
            if (frameCounter >= 3) {
              calibrateCenter();
            }
          }

          let targetX, targetY;

          if (calibBounds.calibrated) {
            const spanX = (calibBounds.maxX - calibBounds.minX) || 0.25;
            const spanY = (calibBounds.maxY - calibBounds.minY) || 0.25;
            targetX = (rawX - calibBounds.minX) / spanX;
            targetY = (rawY - calibBounds.minY) / spanY;
          } else {
            const originX = calibratedOriginX ?? 0.5;
            const originY = calibratedOriginY ?? 0.5;
            targetX = 0.5 + (rawX - originX) * sensitivityX;
            targetY = 0.5 + (rawY - originY) * sensitivityY;
          }

          const originX = calibratedOriginX ?? 0.5;
          const originY = calibratedOriginY ?? 0.5;

          // Project around calibrated neutral head posture
          let targetX = 0.5 + (filteredNoseX - originX) * sensitivityX;
          let targetY = 0.5 + (filteredNoseY - originY) * sensitivityY;

          // Suppress sub-pixel camera wobble before it reaches the cursor.
          if (Math.abs(targetX - smoothX) < CURSOR_DEAD_ZONE) targetX = smoothX;
          if (Math.abs(targetY - smoothY) < CURSOR_DEAD_ZONE) targetY = smoothY;

          // Damp small movements while allowing deliberate movement to catch up.
          const deltaDist = Math.hypot(targetX - smoothX, targetY - smoothY);
          const baseFactor = 0.08 + smoothFactor * 0.28;
          const dynamicFactor = Math.min(0.62, baseFactor + deltaDist * 2.2);

          smoothX += (targetX - smoothX) * dynamicFactor;
          smoothY += (targetY - smoothY) * dynamicFactor;

          const clampedX = Math.max(0, Math.min(1, smoothX));
          const clampedY = Math.max(0, Math.min(1, smoothY));

          if (now - lastSend >= SEND_INTERVAL && cursorPort) {
            lastSend = now;
            cursorPort.postMessage({
              type: 'CURSOR_MOVE',
              x: clampedX,
              y: clampedY,
              stickyHold: stickyHoldEnabled,
              dwellDuration: dwellTimeMs
            });

            if (metricsEl) {
              metricsEl.innerText = `Nose: (${clampedX.toFixed(2)}, ${clampedY.toFixed(2)}) \vert{} Calibrated:${calibBounds.calibrated}`;
            }
          }
        }
      }
    }
  };

  try {
    const worker = new Worker('worker.js');
    worker.onmessage = () => { processFrame(); };
    worker.postMessage('start');
  } catch (e) {
    setInterval(processFrame, 16);
  }
}

initTracker();
