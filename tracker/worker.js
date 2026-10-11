// worker.js - Background timer worker immune to browser tab throttling
let intervalId = null;

self.onmessage = (e) => {
  if (e.data === 'start') {
    if (!intervalId) {
      intervalId = setInterval(() => {
        self.postMessage('tick');
      }, 16);
    }
  } else if (e.data === 'stop') {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }
};
