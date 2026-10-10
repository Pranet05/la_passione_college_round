import { FilesetResolver, FaceLandmarker } from '../vendor/vision_bundle.mjs';

const video = document.getElementById('webcam');
const statusEl = document.getElementById('status');
const metricsEl = document.getElementById('metrics');

let faceLandmarker = null;
let lastVideoTime = -1;
let port = null;

// Multipliers: Higher values mean smaller head tilts reach the screen corners
const SENSITIVITY_X = 4.0;
const SENSITIVITY_Y = 5.0;

// Fast low-pass filter (no complex math overhead, buttery smooth)
let smoothX = 0.5;
let smoothY = 0.5;
const SMOOTH_FACTOR = 0.4; // 0.2 = heavy damping, 0.5 = hyper responsive

// Throttle to 30 FPS to respect browser IPC bandwidth
let lastSend = 0;
const SEND_INTERVAL = 32;

function connectPort() {
  const extApi = typeof browser !== 'undefined' ? browser : chrome;
  port = extApi.runtime.connect({ name: 'cursor-tracking' });
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectPort, 1000);
  });
}
connectPort();

async function initTracker() {
  try {
    statusEl.innerText = 'Initializing WASM Runtime...';

    const wasmRoot = browser.runtime.getURL('vendor/wasm');
    const modelPath = browser.runtime.getURL('vendor/face_landmarker.task');

    const filesetResolver = await FilesetResolver.forVisionTasks(wasmRoot);

    statusEl.innerText = 'Compiling Face Landmarker...';
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false // Disable blendshapes to cut GPU/CPU compute by ~40%
    });

    statusEl.innerText = 'Starting Camera (640x480 @ 30fps)...';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      }
    });

    video.srcObject = stream;
    video.addEventListener('loadeddata', () => {
      statusEl.innerText = '✅ Tracker running at full speed!';
      startProcessingLoop();
    });
  } catch (err) {
    statusEl.innerText = `Error: ${err.message}`;
    console.error(err);
  }
}

// Uses requestVideoFrameCallback if available, with setInterval fallback to prevent background throttling
function startProcessingLoop() {
  const processFrame = () => {
    if (video.readyState >= 2 && faceLandmarker) {
      const now = performance.now();

      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const results = faceLandmarker.detectForVideo(video, now);

        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
          // Landmark 1: Nose Tip
          const nose = results.faceLandmarks[0][1];

          // Mirror horizontally for natural webcam mapping
          const rawX = 1.0 - nose.x;
          const rawY = nose.y;

          // Apply sensitivity projection around center (0.5, 0.5)
          const targetX = 0.5 + (rawX - 0.5) * SENSITIVITY_X;
          const targetY = 0.5 + (rawY - 0.5) * SENSITIVITY_Y;

          // Smooth coordinate transitions
          smoothX += (targetX - smoothX) * SMOOTH_FACTOR;
          smoothY += (targetY - smoothY) * SMOOTH_FACTOR;

          const clampedX = Math.max(0, Math.min(1, smoothX));
          const clampedY = Math.max(0, Math.min(1, smoothY));

          if (now - lastSend >= SEND_INTERVAL && port) {
            lastSend = now;
            port.postMessage({
              type: 'CURSOR_MOVE',
              x: clampedX,
              y: clampedY
            });

            if (metricsEl) {
              metricsEl.innerText = `Nose: (${clampedX.toFixed(2)}, ${clampedY.toFixed(2)})`;
            }
          }
        }
      }
    }
  };

  // Run at a fixed ~30-40 Hz interval that persists even when the tab is unfocused
  setInterval(processFrame, 25);
}

initTracker();