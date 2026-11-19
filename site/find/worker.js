// Preview-only CRAFT text detector. Runs on this device; nothing is uploaded.
importScripts('ort/ort.wasm.min.js');
ort.env.wasm.wasmPaths = new URL('ort/', self.location.href).href;
ort.env.wasm.numThreads = 1; // GitHub Pages cannot enable multi-threaded WebAssembly.
ort.env.wasm.proxy = false;

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
let session = null;

async function downloadModel() {
  const res = await fetch('craft.fp16.onnx');
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) postMessage({ type: 'stage', text: `Downloading model ${Math.round((got / total) * 100)}%` });
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return bytes;
}

async function load() {
  if (session) return 0;
  const t0 = performance.now();
  postMessage({ type: 'stage', text: 'Downloading model' });
  const bytes = await downloadModel();
  postMessage({ type: 'stage', text: 'Starting detector' });
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return performance.now() - t0;
}

onmessage = async ({ data: { id, width, height, rgba } }) => {
  try {
    const loadMs = await load();
    const pixels = new Uint8ClampedArray(rgba);
    const input = new Float32Array(width * height * 3);
    for (let i = 0, n = width * height; i < n; i++) {
      for (let c = 0; c < 3; c++) input[c * n + i] = (pixels[i * 4 + c] / 255 - MEAN[c]) / STD[c];
    }
    postMessage({ type: 'stage', text: 'Looking for text' });
    const t0 = performance.now();
    const tensor = new ort.Tensor('float32', input, [1, 3, height, width]);
    const out = await session.run({ [session.inputNames[0]]: tensor });
    const score = out[session.outputNames[0]];
    const [, mapH, mapW] = score.dims;
    const region = new Float32Array(mapW * mapH);
    const link = new Float32Array(mapW * mapH);
    for (let i = 0, n = mapW * mapH; i < n; i++) {
      region[i] = score.data[i * 2];
      link[i] = score.data[i * 2 + 1];
    }
    tensor.dispose();
    score.dispose();
    postMessage({ type: 'result', id, mapW, mapH, region, link, loadMs, runMs: performance.now() - t0 }, [region.buffer, link.buffer]);
  } catch (e) {
    postMessage({ type: 'error', id, message: String((e && e.message) || e) });
  }
};
