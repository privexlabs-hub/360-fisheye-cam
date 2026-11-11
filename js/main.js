// App wiring: sources, render loop, UI, recording and export.
import { Renderer, RendererError } from './renderer.js';
import { LOOKS, DEFAULT_LOOK, PARAMS, paramsForLook, defaultSettings, validateSettings, validateParam,
  resetLook, resolveUniforms, outputSize } from './effects.js';
import { Tracker } from './tracking.js';
import { Camera, CameraError } from './camera.js';
import { CanvasRecorder, extensionFor, pickRecordingType, cleanupTempRecordings } from './recorder.js';
import { classifyFile, loadImage, loadVideo, videoDetails, prepareBackground, canExportWithWebCodecs,
  exportVideoWebCodecs, deliver, stampedName, MediaError } from './media.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = '360cam.settings.v1';
const MAX_LIVE_RECORDING_S = 600; // 10 minutes

// ------------------------------------------------------------------ state
const state = {
  look: DEFAULT_LOOK,
  settings: defaultSettings(),
  aspect: 'original',
  quality: 1280,
  mirror: true,
  source: null,          // { kind: 'camera'|'video'|'image', el, w, h, name, file? }
  bg: null,              // { latTop, panorama, name }
  comparing: false,
  recorder: null,
  exporting: null,       // AbortController
  result: null,          // { blob, filename, kind }
};

function loadStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!raw) return;
    state.settings = validateSettings(raw.settings);
    if (LOOKS.some((l) => l.id === raw.look)) state.look = raw.look;
    if (['original', '9:16', '1:1', '16:9'].includes(raw.aspect)) state.aspect = raw.aspect;
    if ([1280, 1920].includes(raw.quality)) state.quality = raw.quality;
  } catch { /* storage unavailable: use defaults */ }
}
let saveTimer = 0;
function store() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ settings: state.settings, look: state.look, aspect: state.aspect, quality: state.quality })); } catch { /* ignore */ }
  }, 300);
}

// --------------------------------------------------------------- services
const canvas = $('view');
let renderer;
const tracker = new Tracker();
const camera = new Camera($('camVideo'));
const fileVideo = $('fileVideo');

// --------------------------------------------------------------- UI utils
let toastTimer = 0;
function toast(msg, isError = false, ms = 4500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function showError(e, fallback = 'Something went wrong.') {
  console.error(e);
  const friendly = e instanceof CameraError || e instanceof MediaError || e instanceof RendererError;
  toast(friendly ? e.message : `${fallback}${e?.message ? ' (' + e.message + ')' : ''}`, true, 7000);
}
function setStatus(msg) {
  const s = $('status');
  s.textContent = msg || '';
  s.hidden = !msg;
}
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const currentLook = () => LOOKS.find((l) => l.id === state.look);
const isDesktop = () => matchMedia('(min-width: 900px)').matches;

// ------------------------------------------------------------- rendering
/** Which look can actually be drawn right now (falls back while models load). */
function effectiveLook() {
  const look = currentLook();
  if (look.needsMask && !renderer.mask.ready) return 'real-planet';
  return look.id;
}

function bgLatTop() {
  return state.look === 'image' && state.bg ? state.bg.latTop : Math.PI / 2;
}

function draw() {
  const src = state.source;
  if (!src || !renderer || !renderer.src.w) return;
  if (!state.exporting || state.exporting.realtime) {
    const { w, h } = outputSize(src.w, src.h, state.aspect, state.quality);
    renderer.setOutputSize(w, h);
  }
  const lookId = effectiveLook();
  const u = resolveUniforms(state.settings, lookId, renderer.src, tracker.face, {
    mirror: state.mirror, original: state.comparing, bgLatTop: bgLatTop(),
  });
  if (state.look === 'image' && !state.bg) u.uBgKind = 0;
  renderer.render(u);
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function analyzeAndUpload(el, w, h, timeMs, every = false) {
  const look = currentLook();
  tracker.analyze(el, w, h, { segment: look.needsMask && !!tracker.segmenter, track: state.settings.followFace && !!tracker.faceDetector, timeMs, every });
  if (look.needsMask && tracker.mask) renderer.uploadMask(tracker.mask, tracker.maskSize[0], tracker.maskSize[1]);
  renderer.uploadSource(el, w, h);
}

// Per-frame pump for live camera and video preview.
let frameLoopId = 0;
function startFrameLoop(video) {
  const id = ++frameLoopId;
  const onFrame = () => {
    if (id !== frameLoopId || !state.source || state.source.el !== video) return;
    if (video.readyState >= 2 && !(state.exporting && !state.exporting.realtime)) {
      analyzeAndUpload(video, video.videoWidth, video.videoHeight, performance.now());
      state.source.w = video.videoWidth; state.source.h = video.videoHeight;
      draw();
      if (state.source.kind === 'video') updateTime();
    }
    schedule();
  };
  const schedule = () => {
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame(onFrame);
  };
  schedule();
}
function stopFrameLoop() { frameLoopId++; }

// --------------------------------------------------------------- models
async function ensureModels() {
  const needMask = currentLook().needsMask;
  if (state.settings.followFace && !tracker.faceDetector && !tracker.faceError) {
    setStatus('Getting face tracking ready…');
    const ok = await tracker.loadFace();
    if (!ok) toast('Face tracking is unavailable on this device. Use the position sliders in Adjust instead.', true);
  }
  if (needMask && !tracker.segmenter && !tracker.segError) {
    setStatus('Getting the person cut-out ready…');
    const ok = await tracker.loadSegmenter();
    if (!ok) toast('The person cut-out could not start on this device, so the real background is shown instead.', true, 7000);
  }
  setStatus('');
  reprocessStill();
  requestDraw();
}

// --------------------------------------------------------------- sources
function setSourceUI(kind) {
  $('welcome').hidden = !!kind;
  $('controls').hidden = !kind;
  $('badge').hidden = !kind;
  $('btnCompare').hidden = !kind;
  $('btnSource').hidden = !kind;
  $('cameraCtl').hidden = kind !== 'camera';
  $('fileCtl').hidden = kind === 'camera' || !kind;
  $('btnPlay').hidden = kind !== 'video';
  $('seek').hidden = kind !== 'video';
  $('time').hidden = kind !== 'video';
  $('btnExport').textContent = kind === 'image' ? 'Save photo' : 'Export video';
  $('switchLabel').textContent = kind === 'camera' ? 'Files' : 'Camera';
  if (isDesktop()) $('sheet').hidden = !kind;
  renderSourceInfo();
}

function releaseSource() {
  stopFrameLoop();
  if (state.recorder) stopRecording(true);
  camera.stop();
  if (state.source?.kind === 'video') {
    fileVideo.pause();
    if (state.source.url) URL.revokeObjectURL(state.source.url);
    fileVideo.removeAttribute('src');
    fileVideo.load();
  }
  if (state.source?.kind === 'image') state.source.el.close?.();
  state.source = null;
  tracker.reset();
  renderer.clearMask();
}

async function startCamera(facing) {
  try {
    if (state.source?.kind !== 'camera') releaseSource();
    setStatus('Starting camera…');
    const { w, h } = await camera.start(facing);
    state.source = { kind: 'camera', el: camera.video, w, h, name: camera.facing === 'user' ? 'Front camera' : 'Back camera' };
    state.mirror = camera.facing === 'user';
    $('optMirror').checked = state.mirror;
    tracker.reset();
    setSourceUI('camera');
    setStatus('');
    startFrameLoop(camera.video);
    $('btnFlip').hidden = !(await camera.hasMultipleCameras());
    ensureModels();
  } catch (e) {
    setStatus('');
    showError(e, 'The camera could not be started.');
  }
}

async function openFile(file) {
  let kind;
  try { kind = classifyFile(file); } catch (e) { showError(e); return; }
  try {
    releaseSource();
    state.mirror = false;
    $('optMirror').checked = false;
    if (kind === 'image') {
      setStatus('Opening photo…');
      const bmp = await loadImage(file, Math.min(4096, renderer.maxTextureSize));
      state.source = { kind: 'image', el: bmp, w: bmp.width, h: bmp.height, name: file.name, file };
      setSourceUI('image');
      tracker.reset();
      reprocessStill();
    } else {
      setStatus('Opening video…');
      const info = await loadVideo(file, fileVideo);
      state.source = { kind: 'video', el: fileVideo, w: info.w, h: info.h, name: file.name, url: info.url, duration: info.duration, file };
      setSourceUI('video');
      startFrameLoop(fileVideo);
      // Show the first frame.
      fileVideo.currentTime = 0;
      videoDetails(file).then((d) => { if (state.source?.file === file) { state.source.details = d; renderSourceInfo(); } });
    }
    setStatus('');
    await ensureModels();
  } catch (e) {
    setStatus('');
    showError(e, 'The file could not be opened.');
    if (!state.source) setSourceUI(null);
  }
}

/**
 * Re-run tracking + draw for a still picture: a photo, or a paused video
 * frame (no new frames arrive to refresh it). Used after loading, model
 * start-up, seeking and settings changes.
 */
function reprocessStill() {
  const src = state.source;
  if (!src || state.exporting) return;
  if (src.kind === 'video' && (!fileVideo.paused || fileVideo.readyState < 2)) return;
  if (src.kind !== 'image' && src.kind !== 'video') return;
  tracker.reset();
  if (src.kind === 'image') analyzeAndUpload(src.el, src.w, src.h, performance.now(), true);
  else analyzeAndUpload(fileVideo, fileVideo.videoWidth, fileVideo.videoHeight, performance.now(), true);
  draw();
}

function renderSourceInfo() {
  const s = state.source;
  const el = $('sourceInfo');
  if (!s) { el.textContent = ''; return; }
  const parts = [`${s.name}: ${s.w}×${s.h}`];
  if (s.kind === 'video' && Number.isFinite(s.duration)) parts.push(fmtTime(s.duration));
  const d = s.details;
  if (d) {
    if (d.fps) parts.push(`${Math.round(d.fps * 100) / 100} fps`);
    parts.push(d.hasAudio ? `sound: ${d.audioCodec || 'yes'}` : 'no sound');
  }
  const out = outputSize(s.w, s.h, state.aspect, state.quality);
  parts.push(`output ${out.w}×${out.h}`);
  el.textContent = parts.join(' · ');
}

// ------------------------------------------------------------- looks UI
function buildLooks() {
  const row = $('looks');
  row.innerHTML = '';
  for (const l of LOOKS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'look';
    b.textContent = l.label;
    b.setAttribute('role', 'radio');
    b.dataset.id = l.id;
    b.addEventListener('click', () => selectLook(l.id));
    row.appendChild(b);
  }
  refreshLooks();
}

function refreshLooks() {
  for (const b of $('looks').children) b.setAttribute('aria-checked', String(b.dataset.id === state.look));
  let hint = currentLook().hint;
  if (state.look === 'image' && state.bg) {
    hint = state.bg.panorama ? `Using your 360° panorama "${state.bg.name}".`
      : `Using "${state.bg.name}", mirrored to close the circle (a regular photo, not a 360° capture).`;
  }
  $('lookHint').textContent = hint;
}

function selectLook(id) {
  state.look = id;
  refreshLooks();
  buildParamFields();
  store();
  if (id === 'image' && !state.bg) $('bgInput').click();
  if (state.source) ensureModels();
  reprocessStill();
  requestDraw();
}

// -------------------------------------------------------- adjustments UI
function formatValue(p, v) {
  if (p.type === 'toggle') return '';
  if (p.type === 'select') return '';
  const digits = p.step >= 1 ? 0 : 2;
  return `${Number(v).toFixed(digits)}${p.unit || ''}`;
}

function buildParamFields() {
  const host = $('paramFields');
  host.innerHTML = '';
  let group = '';
  for (const p of paramsForLook(state.look)) {
    if (p.group !== group) {
      group = p.group;
      const h = document.createElement('h3');
      h.className = 'group-title';
      h.textContent = group;
      host.appendChild(h);
    }
    const label = document.createElement('label');
    label.className = 'field' + (p.type === 'toggle' ? ' toggle' : '');
    const name = document.createElement('span');
    name.className = 'field-label';
    name.textContent = p.label;
    label.appendChild(name);
    let input;
    const value = document.createElement('span');
    value.className = 'field-value';
    if (p.type === 'toggle') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.settings[p.key];
    } else if (p.type === 'select') {
      input = document.createElement('select');
      for (const [v, text] of p.options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = text;
        input.appendChild(o);
      }
      input.value = state.settings[p.key];
    } else {
      label.appendChild(value);
      input = document.createElement('input');
      input.type = 'range';
      input.min = p.min; input.max = p.max; input.step = p.step;
      input.value = state.settings[p.key];
      value.textContent = formatValue(p, state.settings[p.key]);
    }
    input.dataset.key = p.key;
    input.addEventListener('input', () => {
      const raw = p.type === 'toggle' ? input.checked : input.value;
      state.settings[p.key] = validateParam(p.key, raw);
      value.textContent = formatValue(p, state.settings[p.key]);
      onSettingsChanged(p.key);
    });
    label.appendChild(input);
    const help = document.createElement('span');
    help.className = 'field-help';
    help.textContent = p.help;
    label.appendChild(help);
    host.appendChild(label);
  }
  $('bgImageRow').hidden = state.look !== 'image';
  $('bgImageNote').textContent = state.bg ? state.bg.name : 'None chosen (built-in scene shown)';
}

function onSettingsChanged(key) {
  store();
  if (key === 'followFace' && state.settings.followFace) ensureModels();
  if (key === 'followFace') reprocessStill();
  requestDraw();
}

// --------------------------------------------------------- background img
async function chooseBackground(file) {
  if (!file) return;
  try {
    classifyFile(file);
    const bmp = await loadImage(file, 4096);
    const prepared = prepareBackground(bmp, Math.min(4096, renderer.maxTextureSize));
    renderer.uploadBackground(prepared.canvas, prepared.canvas.width, prepared.canvas.height);
    state.bg = { latTop: prepared.latTop, panorama: prepared.panorama, name: file.name };
    bmp.close?.();
    if (state.look !== 'image') selectLook('image');
    refreshLooks();
    buildParamFields();
    requestDraw();
  } catch (e) {
    showError(e, 'That image could not be used.');
  }
}

// ---------------------------------------------------------------- capture
function capturePhoto() {
  draw();
  canvas.toBlob((blob) => {
    if (!blob) { toast('The photo could not be created.', true); return; }
    showResult(blob, stampedName('jpg'), 'image');
  }, 'image/jpeg', 0.92);
}

async function startRecording() {
  if (pickRecordingType() === null || !canvas.captureStream) { toast('This browser cannot record video. Try Chrome or Safari.', true); return; }
  $('btnRecord').disabled = true;
  const mic = await camera.microphone();
  if (!mic) toast('No microphone access: recording without sound.');
  try {
    const rec = await CanvasRecorder.create(canvas, mic, 30);
    rec.mic = mic;
    rec.onWriteError = (err) => {
      console.error('Recording storage error', err);
      toast('Your device ran out of space, so the recording was stopped.', true, 8000);
      stopRecording();
    };
    const needed = (rec.bitsPerSecond / 8) * MAX_LIVE_RECORDING_S * 1.1;
    if (rec.freeBytes != null && rec.freeBytes < needed) {
      toast(`Your device has about ${Math.max(0, Math.round(rec.freeBytes / 1e6))} MB free, so long recordings may stop early.`, false, 6000);
    }
    rec.start();
    state.recorder = rec;
    setOutputLocked(true); // a size change mid-recording would be stretched to the first size
    $('btnRecord').classList.add('recording');
    $('recTimer').hidden = false;
    const tick = () => {
      if (state.recorder !== rec) return;
      $('recTime').textContent = fmtTime(rec.elapsed);
      if (rec.elapsed >= MAX_LIVE_RECORDING_S) { toast(`Recordings stop at ${MAX_LIVE_RECORDING_S / 60} minutes.`); stopRecording(); return; }
      setTimeout(tick, 250);
    };
    tick();
  } catch (e) {
    mic?.stop();
    showError(e, 'Recording could not start.');
  } finally {
    $('btnRecord').disabled = false;
  }
}

function setOutputLocked(locked) {
  $('optAspect').disabled = locked;
  $('optQuality').disabled = locked;
}

async function stopRecording(discard = false) {
  const rec = state.recorder;
  if (!rec) return;
  state.recorder = null;
  setOutputLocked(false);
  $('btnRecord').classList.remove('recording');
  $('recTimer').hidden = true;
  try {
    const blob = await rec.stop();
    rec.mic?.stop();
    if (!discard) showResult(blob, stampedName(extensionFor(rec.mimeType)), 'video', rec.hasAudio ? '' : 'Recorded without sound.');
  } catch (e) {
    rec.mic?.stop();
    if (!discard) showError(e, 'The recording could not be saved.');
  }
}

// ------------------------------------------------------------ file export
function showProgress(title, note) {
  $('progressTitle').textContent = title;
  $('progressNote').textContent = note || '';
  $('progressBar').style.width = '0%';
  $('progressModal').hidden = false;
}
function setProgress(p) { $('progressBar').style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`; }

async function exportCurrentFile() {
  const src = state.source;
  if (!src) return;
  if (src.kind === 'image') { capturePhoto(); return; }
  fileVideo.pause();
  if (canExportWithWebCodecs()) return exportFast(src);
  return exportRealtime(src);
}

async function exportFast(src) {
  const ac = new AbortController();
  state.exporting = ac;
  ac.realtime = false;
  showProgress('Exporting video…', 'Keep this page open until it finishes.');
  tracker.reset();
  const t0 = performance.now();
  const base = tracker.lastTs + 1000;
  try {
    const res = await exportVideoWebCodecs(
      src.file,
      (w, h) => outputSize(w, h, state.aspect, state.quality),
      (scratch, w, h, tSec) => {
        analyzeAndUpload(scratch, w, h, base + tSec * 1000, true);
        const out = outputSize(w, h, state.aspect, state.quality);
        renderer.setOutputSize(out.w, out.h);
        const u = resolveUniforms(state.settings, effectiveLook(), renderer.src, tracker.face, { mirror: state.mirror, bgLatTop: bgLatTop() });
        if (state.look === 'image' && !state.bg) u.uBgKind = 0;
        renderer.render(u);
        return canvas;
      },
      setProgress,
      ac.signal,
    );
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    console.info(`Export finished in ${secs}s: ${res.width}x${res.height} ${res.codec}`);
    const notes = [...res.notes];
    if (!res.hadAudio) notes.push('The original video had no sound.');
    showResult(res.blob, stampedName(res.mime.includes('mp4') ? 'mp4' : 'webm'), 'video', notes.join(' '));
  } catch (e) {
    if (e?.name !== 'AbortError') showError(e, 'The export failed.');
    else toast('Export cancelled.');
  } finally {
    state.exporting = null;
    $('progressModal').hidden = true;
    tracker.reset();
    requestDraw();
  }
}

/** Fallback for browsers without WebCodecs: play the video once and record it. */
let audioRoute = null;
async function exportRealtime(src) {
  if (pickRecordingType() === null || !canvas.captureStream) { toast('This browser cannot export video. Try an up-to-date Chrome or Safari.', true); return; }
  const ac = new AbortController();
  ac.realtime = true;
  state.exporting = ac;
  showProgress('Exporting video in real time…', 'This browser exports at playback speed, so it takes as long as the video. Frames may be dropped on slow devices.');
  let audioTrack = null;
  try {
    if (!audioRoute) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const node = ctx.createMediaElementSource(fileVideo);
      const dest = ctx.createMediaStreamDestination();
      const gain = ctx.createGain();
      node.connect(dest);
      node.connect(gain).connect(ctx.destination);
      audioRoute = { ctx, dest, gain };
    }
    await audioRoute.ctx.resume();
    audioRoute.gain.gain.value = 0; // silent while exporting
    audioTrack = audioRoute.dest.stream.getAudioTracks()[0] || null;
  } catch (e) { console.warn('Audio capture unavailable', e); }

  // Cancel can be pressed at any point, including while still preparing.
  const aborted = new Promise((_, reject) => ac.signal.addEventListener('abort',
    () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
  aborted.catch(() => {});
  const checkAbort = () => { if (ac.signal.aborted) throw new DOMException('cancelled', 'AbortError'); };
  let rec = null;
  try {
    fileVideo.currentTime = 0;
    await Promise.race([new Promise((r) => fileVideo.addEventListener('seeked', r, { once: true })), aborted]);
    tracker.reset();
    rec = await CanvasRecorder.create(canvas, audioTrack, 30);
    checkAbort();
    rec.start();
    const done = Promise.race([new Promise((r) => fileVideo.addEventListener('ended', r, { once: true })), aborted]);
    const progress = setInterval(() => setProgress(fileVideo.currentTime / (fileVideo.duration || 1)), 250);
    fileVideo.muted = false;
    try {
      await fileVideo.play();
      await done;
    } finally { clearInterval(progress); fileVideo.pause(); }
    const finished = rec;
    rec = null;
    const blob = await finished.stop();
    showResult(blob, stampedName(extensionFor(finished.mimeType)), 'video', audioTrack ? '' : 'The sound could not be captured in this browser.');
  } catch (e) {
    if (e?.name !== 'AbortError') showError(e, 'The export failed.');
    else toast('Export cancelled.');
  } finally {
    rec?.stop().catch(() => {}); // cancelled or failed: stop recording and discard
    if (audioRoute) audioRoute.gain.gain.value = 1;
    state.exporting = null;
    $('progressModal').hidden = true;
    updatePlayButton();
  }
}

// ---------------------------------------------------------------- results
function showResult(blob, filename, kind, note = '') {
  state.result = { blob, filename, kind };
  const media = $('resultMedia');
  media.innerHTML = '';
  const url = URL.createObjectURL(blob);
  state.result.url = url;
  const el = document.createElement(kind === 'image' ? 'img' : 'video');
  el.src = url;
  if (kind === 'video') { el.controls = true; el.playsInline = true; el.setAttribute('playsinline', ''); }
  media.appendChild(el);
  const size = blob.size > 1e6 ? `${(blob.size / 1e6).toFixed(1)} MB` : `${Math.round(blob.size / 1e3)} KB`;
  let n = `${filename} · ${size}`;
  if (kind === 'video' && filename.endsWith('.webm')) n += ' · WebM files may not open in iPhone Photos.';
  $('resultNote').textContent = note ? `${n} · ${note}` : n;
  $('resultModal').hidden = false;
}

function closeResult() {
  $('resultModal').hidden = true;
  const v = $('resultMedia').querySelector('video');
  v?.pause();
  if (state.result?.url) URL.revokeObjectURL(state.result.url);
  $('resultMedia').innerHTML = '';
  state.result = null;
}

// ----------------------------------------------------------- video player
function updateTime() {
  const d = fileVideo.duration || 0;
  $('time').textContent = fmtTime(fileVideo.currentTime || 0);
  if (!seeking && d) $('seek').value = String(Math.round((fileVideo.currentTime / d) * 1000));
}
function updatePlayButton() {
  const playing = !fileVideo.paused && !fileVideo.ended;
  $('playIco').textContent = playing ? '❚❚' : '▶';
  $('playLabel').textContent = playing ? 'Pause' : 'Play';
}
let seeking = false;

// ------------------------------------------------------------------ init
function bind() {
  $('btnStartCamera').addEventListener('click', () => startCamera('user'));
  $('btnOpenFile').addEventListener('click', () => $('fileInput').click());
  $('btnSource').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); });
  $('bgInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; chooseBackground(f); });
  $('btnBgImage').addEventListener('click', () => $('bgInput').click());
  $('btnCamera').addEventListener('click', () => {
    if (state.source?.kind === 'camera') $('fileInput').click();
    else startCamera('user');
  });
  $('btnFlip').addEventListener('click', () => startCamera(camera.facing === 'user' ? 'environment' : 'user'));
  $('btnPhoto').addEventListener('click', capturePhoto);
  $('btnRecord').addEventListener('click', () => (state.recorder ? stopRecording() : startRecording()));
  $('btnExport').addEventListener('click', exportCurrentFile);
  $('btnCancelExport').addEventListener('click', () => state.exporting?.abort());
  $('btnSave').addEventListener('click', async () => {
    if (!state.result) return;
    try {
      const how = await deliver(state.result.blob, state.result.filename);
      if (how === 'downloaded') toast('Saved to your downloads.');
    } catch (e) { showError(e, 'The file could not be saved. Your device may be out of space.'); }
  });
  $('btnCloseResult').addEventListener('click', closeResult);
  $('btnHelp').addEventListener('click', () => { $('helpModal').hidden = false; });
  $('btnCloseHelp').addEventListener('click', () => { $('helpModal').hidden = true; });

  $('btnAdjust').addEventListener('click', () => { $('sheet').hidden = !$('sheet').hidden; });
  $('btnCloseSheet').addEventListener('click', () => { $('sheet').hidden = true; });
  $('btnReset').addEventListener('click', () => {
    state.settings = resetLook(state.settings, state.look);
    buildParamFields();
    onSettingsChanged('reset');
    toast(`${currentLook().label} settings restored.`, false, 2000);
  });
  $('optAspect').addEventListener('change', (e) => { state.aspect = e.target.value; store(); renderSourceInfo(); requestDraw(); });
  $('optQuality').addEventListener('change', (e) => { state.quality = Number(e.target.value); store(); renderSourceInfo(); requestDraw(); });
  $('optMirror').addEventListener('change', (e) => { state.mirror = e.target.checked; requestDraw(); });

  // Hold to compare with the original.
  const cmp = $('btnCompare');
  const on = (e) => { e.preventDefault(); state.comparing = true; requestDraw(); };
  const off = () => { if (!state.comparing) return; state.comparing = false; requestDraw(); };
  cmp.addEventListener('pointerdown', on);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => cmp.addEventListener(ev, off));

  // Video transport.
  $('btnPlay').addEventListener('click', () => { if (fileVideo.paused || fileVideo.ended) fileVideo.play(); else fileVideo.pause(); });
  fileVideo.addEventListener('play', updatePlayButton);
  fileVideo.addEventListener('pause', updatePlayButton);
  fileVideo.addEventListener('ended', updatePlayButton);
  fileVideo.addEventListener('seeked', () => { updateTime(); reprocessStill(); });
  const seek = $('seek');
  seek.addEventListener('input', () => {
    seeking = true;
    if (fileVideo.duration) fileVideo.currentTime = (Number(seek.value) / 1000) * fileVideo.duration;
  });
  seek.addEventListener('change', () => { seeking = false; });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.recorder) { stopRecording(); }
  });
  matchMedia('(min-width: 900px)').addEventListener('change', () => { if (state.source) $('sheet').hidden = !isDesktop(); });
}

function init() {
  loadStored();
  try {
    renderer = new Renderer(canvas);
    renderer.onRestored = () => { state.bg = null; refreshLooks(); requestDraw(); };
  } catch (e) {
    showError(e);
    $('btnStartCamera').disabled = true;
    $('btnOpenFile').disabled = true;
    return;
  }
  $('optAspect').value = state.aspect;
  $('optQuality').value = String(state.quality);
  $('optMirror').checked = state.mirror;
  if (/FBAN|FBAV|Instagram|TikTok|musical_ly|Line\/|Snapchat/i.test(navigator.userAgent)) $('inAppWarn').hidden = false;
  buildLooks();
  buildParamFields();
  bind();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Offline support unavailable', e));
  }
  cleanupTempRecordings(); // free space from recordings of earlier visits
  // Exposed for automated tests only.
  window.__app = { state, renderer, tracker, openFile, selectLook, draw, chooseBackground, exportCurrentFile };
}

init();
