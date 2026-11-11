// Recording the processed canvas (live camera, or real-time fallback for
// uploaded videos) with MediaRecorder.
//
// Long recordings (up to 10 minutes) can reach several hundred MB, so where
// the browser supports it the chunks are written straight to the site's
// private storage on the device (Origin Private File System) instead of being
// held in memory. Nothing leaves the device either way.

const CANDIDATES = [
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const TEMP_PREFIX = 'recording-';

export function pickRecordingType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

export function extensionFor(mime) {
  return mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/** Delete temporary recording files left from earlier recordings. */
export async function cleanupTempRecordings() {
  try {
    if (!navigator.storage?.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) if (name.startsWith(TEMP_PREFIX)) names.push(name);
    await Promise.all(names.map((n) => root.removeEntry(n).catch(() => {})));
  } catch { /* listing unsupported: nothing to clean */ }
}

/** Open a fresh temporary file in private storage, or null if unsupported. */
async function openDiskFile() {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    // Earlier results are no longer shown, so their files can go.
    await cleanupTempRecordings();
    const name = TEMP_PREFIX + Date.now();
    const handle = await root.getFileHandle(name, { create: true });
    if (typeof handle.createWritable !== 'function') {
      await root.removeEntry(name).catch(() => {});
      return null;
    }
    const writable = await handle.createWritable();
    return { root, name, handle, writable };
  } catch (e) {
    console.warn('Private storage unavailable; recording in memory', e);
    return null;
  }
}

async function freeSpace() {
  try {
    const est = await navigator.storage?.estimate?.();
    return est && est.quota ? est.quota - (est.usage || 0) : null;
  } catch { return null; }
}

export class CanvasRecorder {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {MediaStreamTrack|null} audioTrack
   * @param {number} fps
   */
  static async create(canvas, audioTrack, fps = 30) {
    const type = pickRecordingType();
    if (type === null) throw new Error('This browser cannot record video.');
    const disk = await openDiskFile();
    const rec = new CanvasRecorder(canvas, audioTrack, fps, type, disk);
    rec.freeBytes = await freeSpace();
    return rec;
  }

  constructor(canvas, audioTrack, fps, type, disk) {
    const videoTrack = canvas.captureStream(fps).getVideoTracks()[0];
    // A fresh stream with both tracks (canvas streams carry video only).
    this.stream = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
    const hd = canvas.width * canvas.height > 1280 * 720;
    // Lower bitrate when the whole recording has to stay in memory.
    this.bitsPerSecond = disk ? (hd ? 10_000_000 : 6_000_000) : (hd ? 6_000_000 : 4_000_000);
    const opts = { videoBitsPerSecond: this.bitsPerSecond, ...(type ? { mimeType: type } : {}) };
    this.recorder = new MediaRecorder(this.stream, opts);
    this.disk = disk;
    this.storage = disk ? 'disk' : 'memory';
    this.chunks = [];
    this.bytes = 0;
    this.pending = Promise.resolve();
    this.writeError = null;
    this.onWriteError = null;
    this.hasAudio = !!audioTrack;
    this.startedAt = 0;
    this.finished = false;
    this.recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      if (this.finished) return; // arrived after stop() gave up waiting
      this.bytes += e.data.size;
      if (!this.disk) { this.chunks.push(e.data); return; }
      this.pending = this.pending.then(async () => {
        if (this.writeError) return;
        try {
          await this.disk.writable.write(e.data);
        } catch (err) {
          this.writeError = err;
          this.onWriteError?.(err);
        }
      });
    };
  }

  get mimeType() { return this.recorder.mimeType || pickRecordingType() || 'video/webm'; }

  start() {
    this.recorder.start(1000); // a chunk every second
    this.startedAt = performance.now();
  }

  get elapsed() { return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0; }

  stop() {
    const type = this.mimeType.split(';')[0];
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = async () => {
        if (done) return;
        done = true;
        this.finished = true;
        clearTimeout(timer);
        this.stream.getVideoTracks().forEach((t) => t.stop());
        try {
          if (this.disk) {
            await this.pending;
            try {
              await this.disk.writable.close();
            } catch (e) {
              throw new Error('The recording could not be finished because the device is out of space.');
            }
            const file = await this.disk.handle.getFile();
            if (!file.size) throw new Error('The recording came out empty. Please try again.');
            // A typed view of the stored file; it stays on disk, not in memory.
            resolve(file.slice(0, file.size, type));
          } else {
            if (!this.chunks.length) throw new Error('The recording came out empty. Please try again.');
            resolve(new Blob(this.chunks, { type }));
          }
        } catch (e) {
          reject(e);
        }
      };
      // Some iOS versions occasionally never fire onstop; don't hang.
      const timer = setTimeout(finish, 3000);
      this.recorder.onstop = finish;
      this.recorder.onerror = (e) => { clearTimeout(timer); done = true; this.finished = true; reject(e.error || new Error('Recording failed.')); };
      if (this.recorder.state !== 'inactive') this.recorder.stop(); else finish();
    });
  }
}
