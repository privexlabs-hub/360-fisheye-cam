// Unit tests for the pure effect logic: node --test tests/effects.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOKS, DEFAULT_LOOK, PARAMS, defaultSettings, validateParam, validateSettings, resetLook,
  paramsForLook, normToQ, resolveUniforms, outputSize, backgroundLayout } from '../js/effects.js';
import { MODE } from '../js/shaders.js';

test('tiny planet is the default look and needs the person cut-out', () => {
  assert.equal(DEFAULT_LOOK, 'cover');
  assert.equal(LOOKS.find((l) => l.id === 'cover').needsMask, true);
});

test('every look maps to a distinct, independently selectable mode', () => {
  const modes = LOOKS.map((l) => `${l.mode}:${l.bgKind}`);
  assert.equal(new Set(modes).size, LOOKS.length);
});

test('defaults are within range and valid', () => {
  const s = defaultSettings();
  for (const p of PARAMS) assert.equal(validateParam(p.key, s[p.key]), s[p.key], p.key);
});

test('validation clamps, rejects bad types and unknown keys', () => {
  assert.equal(validateParam('zoom', 99), 2.5);
  assert.equal(validateParam('zoom', -5), 0.5);
  assert.equal(validateParam('zoom', 'abc'), PARAMS.find((p) => p.key === 'zoom').def);
  assert.equal(validateParam('followFace', 'yes'), true);
  assert.equal(validateParam('lens', 42), PARAMS.find((p) => p.key === 'lens').def);
  assert.throws(() => validateParam('nope', 1));
  const s = validateSettings({ zoom: 2, junk: 1 });
  assert.equal(s.zoom, 2);
  assert.ok(!('junk' in s));
});

test('reset only touches the current look', () => {
  const s = { ...defaultSettings(), planetSize: 0.6, globeSize: 1.5 };
  const r = resetLook(s, 'cover');
  assert.equal(r.planetSize, defaultSettings().planetSize);
  assert.equal(r.globeSize, 1.5); // real-planet only
});

test('each look only exposes relevant parameters', () => {
  const keys = (id) => paramsForLook(id).map((p) => p.key);
  assert.ok(keys('fisheye').includes('strength'));
  assert.ok(!keys('fisheye').includes('planetSize'));
  assert.ok(keys('real-planet').includes('wrap'));
  assert.ok(keys('cover').includes('personSize') && !keys('cover').includes('zoom'));
  assert.ok(keys('cover').includes('scene') && !keys('image').includes('scene'));
  assert.ok(!keys('cover').includes('wrap'));
});

test('normToQ: centre is 0, short half side is 1, y is up', () => {
  assert.deepEqual(normToQ(0.5, 0.5, 1280, 720), [0, -0]);
  const [x, y] = normToQ(1, 0, 1280, 720);
  assert.ok(Math.abs(x - 1280 / 720) < 1e-9);
  assert.ok(Math.abs(y - 1) < 1e-9);
});

test('uniforms follow the face when enabled and fall back to manual position', () => {
  const s = defaultSettings();
  const face = { cx: 0.75, cy: 0.5, size: 0.1, nx: 0.75, ny: 0.55 };
  const u = resolveUniforms(s, 'fisheye', { w: 1000, h: 1000 }, face, { mirror: false });
  assert.ok(Math.abs(u.uCenter[0] - 0.5) < 1e-9);
  assert.equal(u.uMode, MODE.FISHEYE);
  const manual = resolveUniforms({ ...s, followFace: false, offsetX: 0.3 }, 'fisheye', { w: 1000, h: 1000 }, face, { mirror: true });
  assert.equal(manual.uCenter[0], 0.3);
  assert.equal(manual.uMirror, -1);
  const cover = resolveUniforms({ ...s, personSize: 0.7, zoom: 2 }, 'cover', { w: 10, h: 10 }, null, { mirror: false });
  assert.equal(cover.uZoom, 0.7);
  assert.equal(cover.uSubjectY, s.personY);
  assert.ok(s.personY > 0 && s.planetY < 0, 'head above the planet by default');
  assert.equal(cover.uScene, s.scene);
  const orig = resolveUniforms(s, 'cover', { w: 10, h: 10 }, null, { mirror: false, original: true });
  assert.equal(orig.uMode, MODE.ORIGINAL);
});

test('output size keeps source aspect by default, never upscales, even dimensions', () => {
  assert.deepEqual(outputSize(720, 940, 'original', 1920), { w: 720, h: 940 });
  assert.deepEqual(outputSize(1920, 1080, 'original', 1280), { w: 1280, h: 720 });
  const p = outputSize(1280, 720, '9:16', 1920);
  assert.equal(p.h, 1280);
  assert.equal(p.w % 2, 0);
  assert.ok(Math.abs(p.w / p.h - 9 / 16) < 0.01);
});

test('background layout: 2:1 is a panorama, other photos are mirrored', () => {
  assert.equal(backgroundLayout(4096, 2048).panorama, true);
  const b = backgroundLayout(4000, 3000);
  assert.equal(b.panorama, false);
  assert.equal(b.mirror, true);
  assert.ok(Math.abs(b.latTop - (45 * Math.PI) / 180) < 1e-9); // 135° span from the ground up
  assert.ok(backgroundLayout(1000, 3000).latTop <= Math.PI / 2 + 1e-9);
});
