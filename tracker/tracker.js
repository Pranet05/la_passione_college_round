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

// Configurable multipliers & smoothing
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

// Gaze calibration: Resting neutral head posture maps to exact center (0.5, 0.5)
let calibratedOriginX = null;
let calibratedOriginY = null;
let smoothX = 0.5;
let smoothY = 0.5;

let lastSend = 0;
const SEND_INTERVAL = 16; // ~60 FPS buttery smooth delivery

// 1. Establish Ports with Background Service
function connectCursorPort() {
  try {
    cursorPort = extApi.runtime.connect({ name: 'cursor-tracking' });
    if (ipcStatusEl) ipcStatusEl.innerText = 'Connected';
    cursorPort.onMessage.addListener((msg) => {
      if (msg?.type === 'CALIBRATE') {
        calibrateCenter();
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

// 2. Center Calibration
let lastRawNoseX = 0.5;
let lastRawNoseY = 0.5;

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
    calibrateCenter();
  }
});

// Popout Window Support
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

// 3. Audio Capture Engine (Unified)
async function initAudio(stream) {
  try {
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);

    // High-pass filter: Cuts low breath pops & desk rumbles (< 120 Hz)
    const highPass = audioContext.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.setValueAtTime(120, audioContext.currentTime);

    // Smaller chunks reduce the time between the end of speech and command dispatch.
    const processor = audioContext.createScriptProcessor(1024, 1, 1);

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);

      // Calculate instantaneous volume for UI meter
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

    source.connect(highPass);
    highPass.connect(processor);
    processor.connect(audioContext.destination);

    if (micStatusEl) micStatusEl.innerText = 'Microphone streaming active';
    if (micDot) { micDot.className = 'dot green'; }
  } catch (err) {
    if (micStatusEl) micStatusEl.innerText = `Mic error: ${err.message}`;
    if (micDot) { micDot.className = 'dot red'; }
    console.error('[Tracker] Audio init error:', err);
  }
}

// 4. Video & Face Mesh Tracker Engine
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

// 5. High-Speed Processing Loop with Adaptive Smoothing
function startProcessingLoop() {
  let frameCounter = 0;

  const processFrame = () => {
    if (video.readyState >= 2 && faceLandmarker) {
      const now = performance.now();

      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const results = faceLandmarker.detectForVideo(video, now);

        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
          // Landmark 1: Nose tip
          const nose = results.faceLandmarks[0][1];

          // Mirror horizontally for natural webcam interaction
          const rawX = 1.0 - nose.x;
          const rawY = nose.y;
          lastRawNoseX = rawX;
          lastRawNoseY = rawY;

          // Auto-calibrate center on first detection so cursor starts EXACTLY at (0.5, 0.5)
          if (calibratedOriginX === null || calibratedOriginY === null) {
            frameCounter++;
            if (frameCounter >= 3) {
              calibrateCenter();
            }
          }

          const originX = calibratedOriginX ?? 0.5;
          const originY = calibratedOriginY ?? 0.5;

          // Project around calibrated neutral head posture
          const targetX = 0.5 + (rawX - originX) * sensitivityX;
          const targetY = 0.5 + (rawY - originY) * sensitivityY;

          // Adaptive dynamic smoothing: fast movements track instantly (0 lag),
          // slow micro-movements stay smooth without jitter
          const deltaDist = Math.hypot(targetX - smoothX, targetY - smoothY);
          const dynamicFactor = Math.min(0.85, smoothFactor + deltaDist * 2.5);

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
              metricsEl.innerText = `Nose: (${clampedX.toFixed(2)}, ${clampedY.toFixed(2)})`;
            }
          }
        }
      }
    }
  };

  // Launch Web Worker timer (immune to Firefox background tab throttling)
  try {
    const worker = new Worker('worker.js');
    worker.onmessage = () => {
      processFrame();
    };
    worker.postMessage('start');
  } catch (e) {
    setInterval(processFrame, 16);
  }
}

initTracker();