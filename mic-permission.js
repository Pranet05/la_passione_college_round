// mic-permission.js
const extApi = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);

const btn = document.getElementById('request-btn');
const statusEl = document.getElementById('msg');

btn.addEventListener('click', async () => {
  if (!extApi || !extApi.runtime) {
    statusEl.innerText = '❌ Error: Extension context missing. Open via moz-extension://';
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true, // Enables browser-level spectral noise reduction
        autoGainControl: true
      }
    });

    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);

    // 1. High-Pass Filter: Cuts wind rumble and low-end breath pops (< 150 Hz)
    const highPass = audioContext.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.setValueAtTime(150, audioContext.currentTime);
    highPass.Q.setValueAtTime(0.7, audioContext.currentTime);

    // 2. ScriptProcessor for audio chunking
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const port = extApi.runtime.connect({ name: 'audio-stream' });

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      port.postMessage({ audioChunk: Array.from(inputData) });
    };

    // Chain: Source -> HighPass -> Processor -> Destination
    source.connect(highPass);
    highPass.connect(processor);
    processor.connect(audioContext.destination);

    statusEl.innerText = '✅ Filtered audio streaming active! Keep this tab open.';
    btn.disabled = true;
  } catch (err) {
    statusEl.innerText = '❌ Error connecting audio: ' + err.message;
  }
});