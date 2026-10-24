// Tråd för ljudanalysen (sonic.js): räknar egenskaperna ur PCM utan att stoppa serverns händelseslinga.
// Meddelanden: { id, pcm: ArrayBuffer (Float32 mono) } → { id, features, ms } eller { id, error }.
import { parentPort } from 'node:worker_threads';
import { analyze, SR } from './sonic-dsp.js';

parentPort.on('message', ({ id, pcm }) => {
  const t0 = performance.now();
  try {
    const features = analyze(new Float32Array(pcm), SR);
    parentPort.postMessage({ id, features, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message || e) });
  }
});
