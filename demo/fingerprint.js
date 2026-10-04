/* Demo fingerprint provider: loads the vendored chromaprint build
   (vendor/chromaprint-glue.js + chromaprint.wasm, from @unimusic/chromaprint,
   MIT) and computes an AcoustID fingerprint on-device. Only the
   fingerprint + duration leave the device (to api.acoustid.org).
   compute(file, {maxSeconds}) -> Promise<{fingerprint, duration}> */

let modulePromise = null;

function loadModule() {
  if (!modulePromise) {
    const url = new URL('../vendor/chromaprint-glue.js', import.meta.url).href;
    modulePromise = import(url).then(m => m.default());
  }
  return modulePromise;
}

async function decode(blob) {
  const ab = await blob.arrayBuffer();
  const copy = ab.slice(0); // decodeAudioData detaches its input
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (OC) {
    const oc = new OC(1, 1, 44100);
    return oc.decodeAudioData(copy);
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  try { return await ac.decodeAudioData(copy); }
  finally { try { ac.close(); } catch (e) {} }
}

export async function compute(blob, opts) {
  opts = opts || {};
  const maxSec = opts.maxSeconds || 60;
  const mod = await loadModule();
  const audioBuf = await decode(blob);
  const sr = audioBuf.sampleRate;
  const n = Math.min(audioBuf.length, Math.max(1, Math.floor(maxSec * sr)));
  const ch = audioBuf.numberOfChannels || 1;
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = audioBuf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
  }
  const pcm = new Int16Array(n);
  for (let j = 0; j < n; j++) {
    const s = mono[j] < -1 ? -1 : mono[j] > 1 ? 1 : mono[j];
    pcm[j] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  // CHROMAPRINT_ALGORITHM_DEFAULT (fpcalc's default). The engine resamples
  // to its internal 11025 Hz from whatever the decoder produced.
  const ctx = mod._chromaprint_new(1);
  if (!ctx) throw new Error('chromaprint init failed');
  try {
    if (!mod._chromaprint_start(ctx, sr, 1)) throw new Error('chromaprint start failed');
    const ptr = mod._malloc(pcm.length * 2);
    try {
      mod.HEAP16.set(pcm, ptr >> 1);
      if (!mod._chromaprint_feed(ctx, ptr, pcm.length)) throw new Error('chromaprint feed failed');
      if (!mod._chromaprint_finish(ctx)) throw new Error('chromaprint finish failed');
      const fpPtr = mod._malloc(4);
      try {
        if (!mod._chromaprint_get_fingerprint(ctx, fpPtr)) throw new Error('chromaprint fingerprint failed');
        const cstr = mod.HEAP32[fpPtr >> 2];
        const fp = mod.UTF8ToString(cstr);
        mod._free(cstr);
        return { fingerprint: fp, duration: audioBuf.duration };
      } finally { mod._free(fpPtr); }
    } finally { mod._free(ptr); }
  } finally { mod._chromaprint_free(ctx); }
}
