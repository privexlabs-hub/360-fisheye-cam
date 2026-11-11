// Loading user files, preparing background images, and exporting results.
import { backgroundLayout } from './effects.js';

const MEDIABUNNY = new URL('../vendor/mediabunny.min.mjs', import.meta.url).href;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;

export class MediaError extends Error {}

export function classifyFile(file) {
  if (!file) throw new MediaError('No file was selected.');
  if (file.size === 0) throw new MediaError(`"${file.name}" is empty.`);
  if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  if (file.type.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
  throw new MediaError(`"${file.name}" is not a supported photo or video. Use JPG, PNG, WebP, MP4, MOV or WebM.`);
}

/** Decode an image, respecting its EXIF orientation. */
export async function loadImage(file, maxSide = 4096) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    const heic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/.test(file.type);
    throw new MediaError(heic
      ? 'This browser cannot open HEIC photos. Export the photo as JPG first, or open the app in Safari.'
      : `"${file.name}" could not be opened. It may be damaged or in an unsupported format.`);
  }
  if (Math.max(bmp.width, bmp.height) <= maxSide) return bmp;
  const s = maxSide / Math.max(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return await createImageBitmap(c);
}

/** Open a video file in a <video> element for preview. */
export function loadVideo(file, videoEl) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const cleanup = () => { videoEl.onloadeddata = null; videoEl.onerror = null; };
    videoEl.onloadeddata = () => {
      cleanup();
      if (!videoEl.videoWidth) { reject(new MediaError(`"${file.name}" has no picture this browser can show.`)); return; }
      resolve({ url, w: videoEl.videoWidth, h: videoEl.videoHeight, duration: videoEl.duration });
    };
    videoEl.onerror = () => {
      cleanup();
      URL.revokeObjectURL(url);
      reject(new MediaError(`"${file.name}" could not be played. It may be damaged, or its format is not supported by this browser.`));
    };
    videoEl.muted = false;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.preload = 'auto';
    videoEl.srcObject = null;
    videoEl.src = url;
    videoEl.load();
  });
}

/** Extra details (frame rate, codecs, audio) when WebCodecs-based parsing is available. */
export async function videoDetails(file) {
  try {
    const MB = await import(MEDIABUNNY);
    const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) });
    const vt = await input.getPrimaryVideoTrack();
    const at = await input.getPrimaryAudioTrack();
    let fps = null;
    if (vt) {
      const stats = await vt.computePacketStats(60);
      fps = stats.averagePacketRate || null;
    }
    return { videoCodec: vt?.codec ?? null, audioCodec: at?.codec ?? null, hasAudio: !!at, fps, rotation: vt?.rotation ?? 0 };
  } catch (e) {
    console.warn('Could not read video details', e);
    return null;
  }
}

/**
 * Turn a user image into a texture-ready background. Ordinary photos are
 * mirrored side by side so the planet closes without a seam.
 */
export function prepareBackground(img, maxWidth = 4096) {
  const layout = backgroundLayout(img.width, img.height);
  const outW = Math.min(maxWidth, layout.mirror ? img.width * 2 : img.width);
  const scale = outW / (layout.mirror ? img.width * 2 : img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(outW);
  c.height = Math.max(2, Math.round(img.height * scale));
  const ctx = c.getContext('2d');
  const w = img.width * scale, h = c.height;
  ctx.drawImage(img, 0, 0, w, h);
  if (layout.mirror) {
    ctx.save();
    ctx.translate(2 * w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, w, h);
    ctx.restore();
  }
  return { canvas: c, ...layout };
}

export function canExportWithWebCodecs() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/**
 * Process a video file frame by frame (faster than real time where the
 * hardware allows), keeping the original timing and passing the audio
 * through unchanged when the output container accepts it.
 *
 * @param {File} file
 * @param {(w:number,h:number)=>{w:number,h:number}} sizeFor output size from display size
 * @param {(src:HTMLCanvasElement, w:number, h:number, tSec:number)=>HTMLCanvasElement} renderFrame
 * @param {(p:number)=>void} onProgress
 * @param {AbortSignal} signal
 */
export async function exportVideoWebCodecs(file, sizeFor, renderFrame, onProgress, signal) {
  const MB = await import(MEDIABUNNY);
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new MediaError('This file has no video track.');
  if (!(await vt.canDecode())) throw new MediaError('This browser cannot decode this video\'s format.');
  const { w, h } = sizeFor(vt.displayWidth, vt.displayHeight);

  const VIDEO = ['avc', 'hevc', 'vp9', 'av1', 'vp8'];
  let format = new MB.Mp4OutputFormat({ fastStart: 'in-memory' });
  let codec = await MB.getFirstEncodableVideoCodec(format.getSupportedCodecs().filter((c) => VIDEO.includes(c)), { width: w, height: h });
  if (!codec) {
    format = new MB.WebMOutputFormat();
    codec = await MB.getFirstEncodableVideoCodec(format.getSupportedCodecs().filter((c) => VIDEO.includes(c)), { width: w, height: h });
  }
  if (!codec) throw new MediaError('This browser has no video encoder available for export.');

  const output = new MB.Output({ format, target: new MB.BufferTarget() });
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d');

  const conversion = await MB.Conversion.init({
    input, output,
    showWarnings: false,
    video: {
      codec,
      forceTranscode: true,
      quality: new MB.Quality('high'),
      processedWidth: w,
      processedHeight: h,
      process: (sample) => {
        const dw = sample.displayWidth, dh = sample.displayHeight;
        if (scratch.width !== dw || scratch.height !== dh) { scratch.width = dw; scratch.height = dh; }
        sample.drawWithFit(sctx, { fit: 'fill' });
        const out = renderFrame(scratch, dw, dh, sample.timestamp);
        // Capture the WebGL canvas synchronously, right after drawing.
        const frame = new VideoFrame(out, { timestamp: Math.round(sample.timestamp * 1e6), duration: Math.round((sample.duration || 0) * 1e6) || undefined });
        return new MB.VideoSample(frame);
      },
    },
  });
  const notes = [];
  for (const d of conversion.discardedTracks) {
    if (d.track.type === 'audio') notes.push(`The sound could not be kept (${d.reason.replaceAll('_', ' ')}).`);
    else if (d.track !== vt) notes.push('An extra video track was left out.');
  }
  if (!conversion.isValid) throw new MediaError('This video cannot be converted in this browser.');
  conversion.onProgress = (p) => onProgress(p);
  const onAbort = () => conversion.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await conversion.execute();
  } catch (e) {
    if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
    throw e;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  const hadAudio = !!(await input.getPrimaryAudioTrack());
  return { blob: new Blob([output.target.buffer], { type: format.mimeType }), mime: format.mimeType, width: w, height: h, codec, notes, hadAudio };
}

/** Save or share a result. Returns how it was delivered. */
export async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      console.warn('Share failed, downloading instead', e);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}

export function stampedName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `360cam-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}
