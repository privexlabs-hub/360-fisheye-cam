// On-device face tracking and person cut-out using MediaPipe Tasks (Apache-2.0).
// Models and WebAssembly are served from this site; nothing is uploaded.

const VENDOR = new URL('../vendor/mediapipe/', import.meta.url).href;
const MODELS = new URL('../models/', import.meta.url).href;
const ANALYSIS_LONG_SIDE = 480;

let visionModule = null;
let fileset = null;
async function loadFileset() {
  if (!visionModule) visionModule = await import(VENDOR + 'vision_bundle.mjs');
  if (!fileset) fileset = await visionModule.FilesetResolver.forVisionTasks(VENDOR + 'wasm');
  return fileset;
}

/** Exponential smoothing that reacts faster to big moves than to jitter. */
class Smoother {
  constructor() { this.v = null; }
  update(next, dt) {
    if (!this.v) { this.v = next.slice(); return this.v; }
    const dist = Math.hypot(next[0] - this.v[0], next[1] - this.v[1]);
    const speed = dist / Math.max(dt, 1e-3);
    const tau = 0.12 / (1 + speed * 6); // seconds
    const a = 1 - Math.exp(-dt / tau);
    for (let i = 0; i < next.length; i++) this.v[i] += (next[i] - this.v[i]) * a;
    return this.v;
  }
  reset() { this.v = null; }
}

export class Tracker {
  constructor() {
    this.faceDetector = null;
    this.segmenter = null;
    this.faceError = null;
    this.segError = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    this.smoother = new Smoother();
    this.face = null;          // smoothed face, normalized coordinates
    this.lastSeen = -Infinity; // ms
    this.lastTs = 0;           // MediaPipe needs increasing timestamps
    this.lastT = null;         // caller's clock (ms) at the previous frame
    this.mask = null;          // Uint8Array
    this.maskSize = [0, 0];
    this.frame = 0;
    this.lastCost = 0;
  }

  async loadFace() {
    if (this.faceDetector || this.faceError) return !!this.faceDetector;
    try {
      const fs = await loadFileset();
      this.faceDetector = await visionModule.FaceDetector.createFromOptions(fs, {
        baseOptions: { modelAssetPath: MODELS + 'face_detector.tflite', delegate: 'CPU' },
        runningMode: 'VIDEO', minDetectionConfidence: 0.5,
      });
      return true;
    } catch (e) {
      console.error('Face tracking failed to load', e);
      this.faceError = e;
      return false;
    }
  }

  async loadSegmenter() {
    if (this.segmenter || this.segError) return !!this.segmenter;
    try {
      const fs = await loadFileset();
      this.segmenter = await visionModule.ImageSegmenter.createFromOptions(fs, {
        baseOptions: { modelAssetPath: MODELS + 'selfie_segmenter.tflite', delegate: 'CPU' },
        runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
      });
      return true;
    } catch (e) {
      console.error('Person cut-out failed to load', e);
      this.segError = e;
      return false;
    }
  }

  /** Forget motion history (new source, seek, or export start). */
  reset() {
    this.smoother.reset();
    this.face = null;
    this.mask = null;
    this.lastSeen = -Infinity;
    this.lastT = null;
  }

  /**
   * Analyse one frame.
   * @param source drawable (video, canvas, image)
   * @param {number} w source width  @param {number} h source height
   * @param {{segment:boolean, track:boolean, timeMs:number, every?:boolean}} o
   *   `every` disables frame skipping (used for exports).
   */
  analyze(source, w, h, o) {
    this.frame++;
    const t0 = performance.now();
    // Skip some frames on slow devices during live preview.
    if (!o.every && this.lastCost > 28 && this.frame % 2 === 1) return;
    const scale = Math.min(1, ANALYSIS_LONG_SIDE / Math.max(w, h));
    const aw = Math.max(1, Math.round(w * scale)), ah = Math.max(1, Math.round(h * scale));
    if (this.canvas.width !== aw || this.canvas.height !== ah) { this.canvas.width = aw; this.canvas.height = ah; }
    this.ctx.drawImage(source, 0, 0, aw, ah);
    // MediaPipe needs strictly increasing timestamps across sources, but
    // smoothing and face-lost timing use the caller's clock (wall clock live,
    // media time in exports), which may restart from a lower value.
    const ts = Math.max(this.lastTs + 1, Math.round(o.timeMs));
    this.lastTs = ts;
    const now = o.timeMs;
    const dt = this.lastT != null && now > this.lastT ? Math.min(0.5, (now - this.lastT) / 1000) : 1 / 30;
    this.lastT = now;

    if (o.track && this.faceDetector && (o.every || this.frame % 2 === 0 || !this.face)) {
      const res = this.faceDetector.detectForVideo(this.canvas, ts);
      const best = pickLargest(res.detections);
      if (best) {
        const b = best.boundingBox;
        const kp = best.keypoints;
        const nose = kp && kp[2] ? kp[2] : { x: (b.originX + b.width / 2) / aw, y: (b.originY + b.height * 0.6) / ah };
        const raw = [
          (b.originX + b.width / 2) / aw,
          (b.originY + b.height / 2) / ah,
          Math.hypot(b.width, b.height) / 2 / Math.max(aw, ah),
          nose.x, nose.y,
        ];
        const v = this.smoother.update(raw, dt);
        this.face = { cx: v[0], cy: v[1], size: v[2], nx: v[3], ny: v[4] };
        this.lastSeen = now;
      } else if (now - this.lastSeen > 1200) {
        this.face = null; // lost for over a second: fall back to manual centre
        this.smoother.reset();
      }
    }

    if (o.segment && this.segmenter) {
      const r = this.segmenter.segmentForVideo(this.canvas, ts);
      const masks = r.confidenceMasks;
      if (masks && masks.length) {
        const m = masks[masks.length - 1];
        const f = m.getAsFloat32Array();
        const n = f.length;
        if (!this.mask || this.mask.length !== n || o.fresh) this.mask = new Uint8Array(n);
        const out = this.mask;
        // Light temporal smoothing reduces edge flicker without visible lag.
        const keep = o.every ? 0 : 0.35;
        for (let i = 0; i < n; i++) out[i] = out[i] * keep + f[i] * 255 * (1 - keep);
        this.maskSize = [m.width, m.height];
      }
      r.close?.();
    }
    this.lastCost = this.lastCost * 0.8 + (performance.now() - t0) * 0.2;
  }
}

function pickLargest(dets) {
  let best = null, area = 0;
  for (const d of dets || []) {
    const a = d.boundingBox.width * d.boundingBox.height;
    if (a > area) { area = a; best = d; }
  }
  return best;
}
