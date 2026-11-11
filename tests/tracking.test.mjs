// Unit tests for the tracker's timing logic: node --test tests/tracking.test.mjs
// MediaPipe and the canvas are replaced by small stubs; only the clock,
// smoothing and face-lost handling are exercised.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
};
const { Tracker } = await import('../js/tracking.js');

/** A face detector stub whose answer the test controls. */
function stubDetector() {
  const d = {
    face: { x: 0.5, y: 0.5 }, // normalized centre, or null for "no face"
    timestamps: [],
    detectForVideo(_canvas, ts) {
      d.timestamps.push(ts);
      if (!d.face) return { detections: [] };
      const aw = 480, ah = 270, bw = 60, bh = 60;
      return { detections: [{
        boundingBox: { originX: d.face.x * aw - bw / 2, originY: d.face.y * ah - bh / 2, width: bw, height: bh },
        keypoints: [{}, {}, { x: d.face.x, y: d.face.y }],
      }] };
    },
  };
  return d;
}

const frame = (t, timeMs, every = false) => t.analyze({}, 1280, 720, { track: true, segment: false, timeMs, every });

test('live tracking recovers immediately after an export that ran ahead of the wall clock', () => {
  const t = new Tracker();
  const det = stubDetector();
  t.faceDetector = det;

  // Live preview for 1 s at 30 fps (wall clock 1000..2000 ms).
  let now = 1000;
  for (let i = 0; i < 30; i++, now += 33) frame(t, now);

  // Export a 60 s clip much faster than real time: the export uses media time.
  t.reset();
  const base = t.lastTs + 1000;
  for (let i = 0; i < 1800; i++) frame(t, base + (i / 30) * 1000, true);
  t.reset();

  // Back to live, with the wall clock only ~2 s later.
  now += 2000;
  det.face = { x: 0.5, y: 0.5 };
  for (let i = 0; i < 10; i++, now += 33) frame(t, now);
  // Small jitter is smoothed, not passed straight through.
  det.face = { x: 0.505, y: 0.5 };
  frame(t, now); now += 33; frame(t, now); now += 33;
  assert.ok(t.face.cx < 0.504, `jitter should be smoothed, got cx=${t.face.cx}`);
  // The face jumps; after half a second of live frames the smoothed position should follow.
  det.face = { x: 0.8, y: 0.5 };
  for (let i = 0; i < 16; i++, now += 33) frame(t, now);
  assert.ok(t.face && t.face.cx > 0.75, `smoothed face should follow a move within 0.5 s, got cx=${t.face?.cx}`);

  // The face leaves the frame: after 1.2 s without detections, fall back to manual centre.
  det.face = null;
  for (let i = 0; i < 60; i++, now += 33) frame(t, now);
  assert.equal(t.face, null, 'face should be dropped after being lost for over a second');

  // MediaPipe always gets strictly increasing timestamps.
  for (let i = 1; i < det.timestamps.length; i++) assert.ok(det.timestamps[i] > det.timestamps[i - 1]);
});
