// Unit tests for CanvasRecorder with mocked browser APIs: node --test tests/recorder.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// --- minimal browser mocks -------------------------------------------------
class FakeMediaRecorder {
  static isTypeSupported(t) { return t === 'video/webm'; }
  constructor(stream, opts) { this.stream = stream; this.mimeType = opts.mimeType; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; FakeMediaRecorder.last = this; } // the test fires events itself
}
globalThis.MediaRecorder = FakeMediaRecorder;
globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } getVideoTracks() { return this.tracks; } };

function fakeDisk() {
  const disk = { written: [], closed: false };
  const writable = {
    async write(data) { if (disk.closed) throw new TypeError('Cannot write to a CLOSED writable stream'); disk.written.push(data); },
    async close() { disk.closed = true; },
  };
  const handle = {
    createWritable: async () => writable,
    getFile: async () => new Blob(disk.written),
  };
  const root = { async getFileHandle() { return handle; }, async removeEntry() {}, async *keys() {} };
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { getDirectory: async () => root, estimate: async () => ({ quota: 1e10, usage: 0 }) } },
    configurable: true,
  });
  return disk;
}
const canvas = { width: 640, height: 480, captureStream: () => ({ getVideoTracks: () => [{ stop() {} }] }) };

const { CanvasRecorder } = await import('../js/recorder.js');

test('a chunk that arrives after the stop timeout is not reported as a storage error', async () => {
  const disk = fakeDisk();
  const rec = await CanvasRecorder.create(canvas, null, 30);
  assert.equal(rec.storage, 'disk');
  const writeErrors = [];
  rec.onWriteError = (e) => writeErrors.push(e);
  rec.start();
  rec.recorder.ondataavailable({ data: new Blob(['a']) });

  // The browser never fires "stop" in time (seen on some iOS versions).
  const blob = await rec.stop();
  assert.equal(await blob.text(), 'a');

  // A late final chunk must not hit the closed file and raise a false "out of space".
  rec.recorder.ondataavailable({ data: new Blob(['late']) });
  await rec.pending;
  assert.deepEqual(writeErrors, []);
  assert.ok(disk.closed);
});
