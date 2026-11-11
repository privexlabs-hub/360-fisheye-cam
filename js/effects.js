// Effect definitions: the looks, their adjustable parameters, defaults and
// validation, and the conversion from settings + face position to shader
// uniforms. No DOM or WebGL here, so it can be unit-tested in Node.
import { MODE, LENS } from './shaders.js';

const DEG = Math.PI / 180;

/** The four looks, in the order shown to the user. */
export const LOOKS = [
  { id: 'cover', label: 'Tiny planet', hint: 'You in front of a built-in tiny-planet scene (default).', mode: MODE.COVER_PLANET, bgKind: 0, needsMask: true },
  { id: 'image', label: 'My planet image', hint: 'You in front of a planet made from your own picture.', mode: MODE.COVER_PLANET, bgKind: 1, needsMask: true },
  { id: 'real-planet', label: 'Real background · planet', hint: 'Your real background curled into a planet. Areas the camera could not see are filled by mirroring and blending its edges.', mode: MODE.REAL_PLANET, bgKind: 0, needsMask: false },
  { id: 'fisheye', label: 'Real background · fisheye', hint: 'Your real background through an extreme fisheye lens.', mode: MODE.FISHEYE, bgKind: 0, needsMask: false },
];
export const DEFAULT_LOOK = 'cover';

const COVER = ['cover', 'image'];
const LENS_LOOKS = ['cover', 'image', 'fisheye'];
const ALL = ['cover', 'image', 'real-planet', 'fisheye'];

/**
 * Adjustable parameters. `looks` lists where each is shown. Values are in
 * user-facing units; resolveUniforms() converts them.
 */
export const PARAMS = [
  // Planet (cover looks)
  { key: 'scene', label: 'Planet scene', group: 'Planet', looks: ['cover'], type: 'select', def: 0,
    options: [[0, 'Sunny street'], [1, 'Beach'], [2, 'Night city']],
    help: 'Built-in illustrated scenes. Use "My planet image" for your own.' },
  { key: 'planetSize', label: 'Planet size', group: 'Planet', looks: COVER, min: 0.12, max: 0.7, step: 0.01, def: 0.4, help: 'How big the tiny planet is.' },
  { key: 'planetY', label: 'Planet height', group: 'Planet', looks: COVER, min: -1.4, max: 0.8, step: 0.01, def: -0.7, help: 'Moves the planet up or down behind you.' },
  { key: 'planetRot', label: 'Planet rotation', group: 'Planet', looks: COVER, min: -180, max: 180, step: 1, def: 0, unit: '°', help: 'Spins the planet.' },
  // Planet (real background)
  { key: 'globeSize', label: 'Planet size', group: 'Planet', looks: ['real-planet'], min: 0.4, max: 1.6, step: 0.01, def: 0.85, help: 'Size of the planet made from your real background.' },
  { key: 'wrap', label: 'Edge wrap', group: 'Planet', looks: ['real-planet'], min: 0.6, max: 1.6, step: 0.01, def: 1.1, help: 'Higher values pull more of the surroundings around the planet; anything past the camera\'s view is mirrored and blended.' },
  { key: 'globeY', label: 'Planet height', group: 'Planet', looks: ['real-planet'], min: -0.8, max: 0.8, step: 0.01, def: -0.15, help: 'Moves the planet up or down.' },
  { key: 'anchor', label: 'Face above centre', group: 'Planet', looks: ['real-planet'], min: -0.8, max: 0.8, step: 0.01, def: 0.25, help: 'How far above the planet centre your face sits.' },
  // Lens (subject)
  { key: 'zoom', label: 'Subject size', group: 'Lens', looks: ['fisheye'], min: 0.5, max: 2.5, step: 0.01, def: 1.15, help: 'Makes you bigger or smaller in the frame.' },
  { key: 'personSize', label: 'Subject size', group: 'Lens', looks: COVER, min: 0.4, max: 2.5, step: 0.01, def: 0.9, help: 'Makes you bigger or smaller in front of the planet.' },
  { key: 'personY', label: 'Subject height', group: 'Lens', looks: COVER, min: -0.9, max: 1.2, step: 0.01, def: 0.5, help: 'Where your face sits; higher keeps your head above the planet.' },
  { key: 'subjectY', label: 'Subject height', group: 'Lens', looks: ['fisheye'], min: -0.9, max: 0.9, step: 0.01, def: 0.25, help: 'Where your face sits vertically.' },
  { key: 'strength', label: 'Fisheye strength', group: 'Lens', looks: LENS_LOOKS, min: 30, max: 89, step: 1, def: 82, unit: '°', help: 'How far the virtual lens bends the edges.' },
  { key: 'lens', label: 'Lens type', group: 'Lens', looks: LENS_LOOKS, type: 'select', def: LENS.EQUISOLID,
    options: [[LENS.EQUISOLID, 'Fisheye (equisolid)'], [LENS.ORTHOGRAPHIC, 'Extreme (orthographic)'], [LENS.EQUIDISTANT, 'Even (equidistant)'], [LENS.STEREOGRAPHIC, 'Soft (stereographic)']],
    help: 'Projection model of the virtual lens.' },
  { key: 'roll', label: 'Tilt', group: 'Lens', looks: ALL, min: -180, max: 180, step: 1, def: 0, unit: '°', help: 'Rotates the view.' },
  // Face
  { key: 'facePop', label: 'Face pop', group: 'Face', looks: ALL, min: 0, max: 0.85, step: 0.01, def: 0.45, help: 'Enlarges the nose and mouth area like a lens right at your face.' },
  { key: 'facePopSize', label: 'Face pop size', group: 'Face', looks: ALL, min: 0.6, max: 3, step: 0.01, def: 1.5, help: 'Size of the enlarged area, relative to your face.' },
  { key: 'followFace', label: 'Follow my face', group: 'Face', looks: ALL, type: 'toggle', def: true, help: 'Keeps the effect centred on your face automatically.' },
  { key: 'offsetX', label: 'Position left/right', group: 'Face', looks: ALL, min: -1, max: 1, step: 0.01, def: 0, help: 'Manual centre (or nudge when following your face).' },
  { key: 'offsetY', label: 'Position up/down', group: 'Face', looks: ALL, min: -1, max: 1, step: 0.01, def: 0, help: 'Manual centre (or nudge when following your face).' },
  // Camera
  { key: 'camFov', label: 'Camera angle', group: 'Camera', looks: ALL, min: 30, max: 100, step: 1, def: 52, unit: '°', help: 'Field of view of your camera across its short side. Raise it for wide cameras.' },
];

export const PARAM_BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.key, p]));

export function defaultSettings() {
  return Object.fromEntries(PARAMS.map((p) => [p.key, p.def]));
}

/** Clamp and type-check one value; returns the default for invalid input. */
export function validateParam(key, value) {
  const def = PARAM_BY_KEY[key];
  if (!def) throw new Error(`Unknown parameter: ${key}`);
  if (def.type === 'toggle') return typeof value === 'boolean' ? value : def.def;
  if (def.type === 'select') {
    const n = Number(value);
    return def.options.some(([v]) => v === n) ? n : def.def;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return def.def;
  return Math.min(def.max, Math.max(def.min, n));
}

export function validateSettings(obj) {
  const out = defaultSettings();
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(out)) if (k in obj) out[k] = validateParam(k, obj[k]);
  }
  return out;
}

/** Reset only the parameters visible for a look. */
export function resetLook(settings, lookId) {
  const out = { ...settings };
  for (const p of PARAMS) if (p.looks.includes(lookId)) out[p.key] = p.def;
  return out;
}

export function paramsForLook(lookId) {
  return PARAMS.filter((p) => p.looks.includes(lookId));
}

/**
 * Convert a point in normalized image coordinates (0..1, y down) into the
 * shader's source space q (short half-side = 1, y up).
 */
export function normToQ(x, y, srcW, srcH) {
  const half = Math.min(srcW, srcH) / 2;
  return [(x - 0.5) * srcW / half, -(y - 0.5) * srcH / half];
}

/**
 * @param {object} s settings
 * @param {string} lookId
 * @param {{w:number,h:number}} src
 * @param {null|{cx:number,cy:number,size:number,nx:number,ny:number}} face normalized
 * @param {{mirror:boolean, original?:boolean, bgLatTop?:number}} opts
 */
export function resolveUniforms(s, lookId, src, face, opts) {
  const look = LOOKS.find((l) => l.id === lookId) ?? LOOKS[0];
  const camHalf = (s.camFov / 2) * DEG;
  const off = [s.offsetX, s.offsetY];
  let center = off;
  let pop = [off[0], off[1] + 0.1, 0.55 * s.facePopSize];
  if (s.followFace && face) {
    const c = normToQ(face.cx, face.cy, src.w, src.h);
    const n = normToQ(face.nx, face.ny, src.w, src.h);
    const size = face.size * Math.max(src.w, src.h) / (Math.min(src.w, src.h) / 2); // q units
    center = [c[0] + off[0], c[1] + off[1]];
    pop = [n[0], n[1], 0.5 * size * s.facePopSize];
  }
  let mode = look.mode;
  if (opts.original) mode = MODE.ORIGINAL;
  if (mode === MODE.REAL_PLANET) center = [center[0], center[1] - s.anchor];
  return {
    uMode: mode,
    uBgKind: look.bgKind,
    uScene: s.scene,
    uMirror: opts.mirror ? -1 : 1,
    uZoom: COVER.includes(look.id) ? s.personSize : s.zoom,
    uRoll: s.roll * DEG,
    uSubjectY: COVER.includes(look.id) ? s.personY : s.subjectY,
    uCenter: center,
    uBulgeC: pop,
    uBulge: s.facePop,
    uCamHalf: camHalf,
    uLens: s.lens,
    uFov: s.strength * DEG,
    uGlobeR: s.globeSize,
    uWrap: s.wrap,
    uPlanetY: lookId === 'real-planet' ? s.globeY : s.planetY,
    uPlanetS: s.planetSize,
    uPlanetRot: s.planetRot * DEG,
    uBgLatTop: opts.bgLatTop ?? Math.PI / 2,
  };
}

/**
 * Output size for a source, an aspect choice and a quality (long side).
 * Never upscales beyond the source's long side; dimensions are even.
 */
export function outputSize(srcW, srcH, aspect, longSide) {
  let ar; // width / height
  if (aspect === '9:16') ar = 9 / 16;
  else if (aspect === '1:1') ar = 1;
  else if (aspect === '16:9') ar = 16 / 9;
  else ar = srcW / srcH;
  const long = Math.min(longSide, Math.max(srcW, srcH));
  let w, h;
  if (ar >= 1) { w = long; h = long / ar; } else { h = long; w = long * ar; }
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return { w: even(w), h: even(h) };
}

/**
 * Background image layout. A 2:1 image is treated as a 360° equirectangular
 * panorama. Any other image is mirrored side by side to close the loop, and
 * its height decides how high up it reaches (the rest is a blended extension).
 */
export function backgroundLayout(w, h) {
  const ar = w / h;
  if (ar > 1.9 && ar < 2.1) return { panorama: true, mirror: false, latTop: Math.PI / 2 };
  const spanDeg = Math.min(180, 180 * h / w); // mirrored pair spans 360° horizontally
  return { panorama: false, mirror: true, latTop: (-90 + spanDeg) * DEG };
}
