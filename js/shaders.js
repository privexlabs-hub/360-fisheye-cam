// GLSL for every look in the app. One full-screen pass; uMode picks the look.
//
// Coordinate conventions (shared by the shader and js/geometry.js):
//   Output space p: origin at the output centre, +y up, half of the output's
//   SHORT side = 1.
//   Source space q: origin at the source frame centre, +y up, half of the
//   source's SHORT side = 1. The source is treated as an ordinary
//   (rectilinear) camera whose half field of view across the short side is
//   uCamHalf.
//   Textures are uploaded unflipped, so v = 0 is the top row.

export const MODE = Object.freeze({
  ORIGINAL: 0,      // untouched source (before/after view)
  FISHEYE: 1,       // Reference B: extreme fisheye on the real background
  REAL_PLANET: 2,   // Reference A from the real background (globe + mirrored fill)
  COVER_PLANET: 3,  // person cut out over a tiny-planet background
});

export const LENS = Object.freeze({ EQUIDISTANT: 0, EQUISOLID: 1, ORTHOGRAPHIC: 2, STEREOGRAPHIC: 3 });

export const VERTEX_SHADER = `#version 300 es
void main() {
  // Full-screen triangle, no vertex buffer needed.
  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uCam;
uniform sampler2D uMask;
uniform sampler2D uBg;

uniform vec2  uRes;        // output size in pixels
uniform vec2  uSrcRes;     // source size in pixels
uniform int   uMode;
uniform int   uBgKind;     // 0 = built-in scene, 1 = image
uniform int   uScene;      // built-in scene: 0 street, 1 beach, 2 night city
uniform float uMirror;     // -1 mirrors the output horizontally
uniform float uZoom;       // subject size
uniform float uRoll;       // radians
uniform float uSubjectY;   // where the subject sits in the output (p units)
uniform vec2  uCenter;     // source point placed at the lens centre (q units)
uniform vec3  uBulgeC;     // xy = face-pop centre (q), z = radius (q)
uniform float uBulge;      // 0..1
uniform float uCamHalf;    // camera half FOV across the short side (rad)
uniform int   uLens;
uniform float uFov;        // virtual half FOV at the output corners (rad)
uniform float uGlobeR;     // real planet: globe radius (p units)
uniform float uWrap;       // real planet: how far past the frame edge the rim reaches
uniform float uPlanetY;    // planet centre height (p units)
uniform float uPlanetS;    // cover planet: stereographic scale (horizon radius = 2*s)
uniform float uPlanetRot;  // cover planet: rotation (rad)
uniform float uBgLatTop;   // image background: latitude of the image's top row (rad)
uniform float uHasMask;
uniform vec2  uMaskRes;    // person mask size in texels
uniform float uCamMaxLod;

out vec4 outColor;
const float PI = 3.14159265359;

vec2 srcHalf() { return uSrcRes / min(uSrcRes.x, uSrcRes.y); }
vec2 qToUv(vec2 q) { return 0.5 + vec2(q.x, -q.y) * 0.5 / srcHalf(); }
float mirror1(float x) { return 1.0 - abs(mod(x, 2.0) - 1.0); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// Camera sample with a natural fill for areas the camera never saw:
// mirror the frame across its edge, blur more the further out we go, and fade
// towards a heavily averaged colour of the nearest border region.
vec3 sampleCam(vec2 uv) {
  vec2 ov = max(vec2(0.0), max(-uv, uv - 1.0)) * srcHalf() * 2.0; // short-side units
  float o = length(ov);
  if (o <= 0.0) return texture(uCam, uv).rgb;
  vec2 m = vec2(mirror1(uv.x), mirror1(uv.y));
  float lod = clamp(log2(1.0 + o * 40.0), 0.0, uCamMaxLod);
  vec3 near = textureLod(uCam, m, lod).rgb;
  vec3 surround = textureLod(uCam, clamp(uv, 0.0, 1.0), max(uCamMaxLod - 3.0, 0.0)).rgb;
  return mix(near, surround, smoothstep(0.05, 0.7, o));
}

float cornerAngle() { return atan(tan(uCamHalf) * length(srcHalf())); }

// Source angle -> source point along a direction.
vec2 angleToQ(vec2 dir, float srcAngle) {
  float rho = tan(min(srcAngle, 1.45)) / tan(uCamHalf);
  return uCenter + dir * rho;
}

// Reference B: virtual fisheye lens. Output corners map to the source corners;
// the lens model decides how strongly the centre is enlarged and the edges
// compressed.
vec2 fisheyeToQ(vec2 p) {
  float rn = length(p) / length(uRes / min(uRes.x, uRes.y));
  float T = uFov;
  float th;
  if (uLens == 0) {
    th = rn * T;
  } else if (uLens == 1) {
    float a = rn * sin(T * 0.5);
    th = 2.0 * asin(min(a, 1.0)) + max(a - 1.0, 0.0) * 2.0;
  } else if (uLens == 2) {
    float a = rn * sin(T);
    th = asin(min(a, 1.0)) + max(a - 1.0, 0.0) * 1.5;
  } else {
    th = 2.0 * atan(rn * tan(T * 0.5));
  }
  vec2 dir = length(p) > 1e-6 ? normalize(p) : vec2(0.0);
  return angleToQ(dir, th * cornerAngle() / T);
}

// Reference A from the real background: the frame is wrapped onto a globe
// (orthographic view of a hemisphere). Past the rim the mapping keeps going,
// so the surroundings continue as mirrored, blurred camera pixels.
vec2 globeToQ(vec2 p) {
  float r = length(p);
  float rim = cornerAngle() * uWrap;
  float a = r < uGlobeR ? asin(r / uGlobeR) / (0.5 * PI) * rim
                        : rim * (1.0 + 0.9 * (r - uGlobeR) / uGlobeR);
  vec2 dir = r > 1e-6 ? p / r : vec2(0.0);
  return angleToQ(dir, a);
}

// Face pop: local magnification around the nose, C1-continuous at the edge.
vec2 facePop(vec2 q) {
  if (uBulge <= 0.0) return q;
  vec2 d = q - uBulgeC.xy;
  float r = length(d);
  if (r >= uBulgeC.z) return q;
  float k = mix(1.0 - uBulge, 1.0, smoothstep(0.0, 1.0, r / uBulgeC.z));
  return uBulgeC.xy + d * k;
}

// ---------------------------------------------------------------- scene ---
// Built-in illustrated scene (sunny street with railings and buildings),
// defined on a sphere so it has no seams. Not a capture of anywhere.
float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x),
                 mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
                 mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * noise3(p); p *= 2.03; a *= 0.5; }
  return s;
}
float band(float x, float lo, float hi, float w) {
  return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
}

vec3 sceneStreet(float lat, float lon, float aaLat, float aaLon) {
  vec3 dir = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  float u = lon / (2.0 * PI) + 0.5;

  // Sky with soft clouds.
  vec3 col = mix(vec3(0.74, 0.86, 0.97), vec3(0.17, 0.45, 0.88),
                 pow(clamp(max(lat, 0.0) / 1.3, 0.0, 1.0), 0.6));
  float cl = fbm(dir * 2.6 + vec3(3.1, 0.0, 1.7));
  float cloud = smoothstep(0.48, 0.72, cl) * smoothstep(0.03, 0.3, lat);
  col = mix(col, mix(vec3(0.86, 0.9, 0.95), vec3(1.0), smoothstep(0.55, 0.8, cl)), cloud);

  // Buildings along the horizon.
  float n = 64.0;
  float x = u * n;
  float id = floor(x);
  float fx = fract(x);
  float h = 0.05 + 0.24 * pow(hash1(id + 3.0), 1.6);
  float wx = aaLon * n / (2.0 * PI) + 1e-4;
  float inB = band(fx, 0.06, 0.94, wx) * (1.0 - smoothstep(h - aaLat, h + aaLat, lat)) * step(-0.01, lat);
  vec3 bcol = mix(vec3(0.93, 0.9, 0.82), vec3(0.62, 0.66, 0.72), hash1(id + 11.0));
  bcol = mix(bcol, vec3(0.86, 0.36, 0.3), step(0.86, hash1(id + 5.0)));
  float win = band(fract(fx * 5.0), 0.25, 0.75, wx * 5.0) * band(fract(lat * 70.0), 0.3, 0.7, aaLat * 70.0);
  bcol = mix(bcol, vec3(0.35, 0.45, 0.55), win * 0.6 * step(0.015, lat) * step(lat, h - 0.01));
  col = mix(col, bcol, inB);

  // Trees between some buildings.
  float tn = 23.0;
  float tx = u * tn;
  float tid = floor(tx);
  float tr = 0.035 + 0.03 * hash1(tid + 7.0);
  vec2 tc = vec2((fract(tx) - 0.5) * 2.0 * PI / tn, lat - tr * 0.9);
  float tree = 1.0 - smoothstep(tr - aaLat, tr + aaLat, length(tc * vec2(cos(lat), 1.0)));
  col = mix(col, mix(vec3(0.2, 0.48, 0.22), vec3(0.32, 0.6, 0.26), noise3(dir * 60.0)), tree * step(0.5, hash1(tid)));

  // Railings in front.
  float rn = 360.0;
  float bar = band(fract(u * rn), 0.0, 0.18, aaLon * rn / (2.0 * PI) + 1e-4) * band(lat, 0.0, 0.075, aaLat);
  float rail = band(lat, 0.07, 0.085, aaLat) + band(lat, 0.035, 0.043, aaLat);
  col = mix(col, vec3(0.78, 0.8, 0.82), clamp(bar + rail, 0.0, 1.0));

  // Ground: kerb, pavement, darker centre.
  if (lat < 0.0) {
    float tiles = noise3(dir * 40.0) * 0.08 + noise3(dir * 9.0) * 0.06;
    vec3 g = mix(vec3(0.78, 0.74, 0.66), vec3(0.62, 0.6, 0.57), smoothstep(-0.25, -1.2, lat)) - tiles;
    float kerb = band(lat, -0.06, 0.0, aaLat);
    float stripe = step(0.5, fract(u * 90.0));
    g = mix(g, mix(vec3(0.95, 0.8, 0.15), vec3(0.15), stripe), kerb);
    col = mix(col, g, 1.0 - smoothstep(-aaLat, aaLat, lat));
  }
  return col;
}

// Beach: sea horizon, sun, palm trees, sand.
vec3 sceneBeach(float lat, float lon, float aaLat, float aaLon) {
  vec3 dir = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  float u = lon / (2.0 * PI) + 0.5;
  vec3 col = mix(vec3(0.82, 0.92, 0.98), vec3(0.12, 0.5, 0.92), pow(clamp(max(lat, 0.0) / 1.2, 0.0, 1.0), 0.55));
  vec3 sunDir = normalize(vec3(0.55, 0.45, 0.7));
  float sd = dot(dir, sunDir);
  col += vec3(1.0, 0.9, 0.6) * (smoothstep(0.9990, 0.9995, sd) + 0.25 * pow(max(sd, 0.0), 40.0));
  float cl = fbm(dir * 3.2 + vec3(7.0, 1.0, 2.0));
  col = mix(col, vec3(1.0), smoothstep(0.58, 0.8, cl) * smoothstep(0.05, 0.35, lat) * 0.85);

  // Distant islands.
  float isl = 0.025 * smoothstep(0.45, 0.8, noise3(vec3(u * 18.0, 0.0, 3.0)));
  col = mix(col, vec3(0.32, 0.5, 0.42), (1.0 - smoothstep(isl - aaLat, isl + aaLat, lat)) * step(0.0, lat));

  // Sea and sand.
  if (lat < 0.0) {
    float waves = 0.5 + 0.5 * sin(lat * 260.0 + noise3(dir * 30.0) * 6.0);
    vec3 sea = mix(vec3(0.1, 0.55, 0.72), vec3(0.03, 0.4, 0.6), smoothstep(-0.01, -0.07, lat));
    sea = mix(sea, vec3(0.85, 0.95, 1.0), waves * 0.12);
    vec3 sand = mix(vec3(0.93, 0.84, 0.66), vec3(0.85, 0.74, 0.55), noise3(dir * 50.0)) - 0.05 * noise3(dir * 12.0);
    float shore = -0.07 + 0.015 * sin(u * 2.0 * PI * 7.0);
    vec3 foam = vec3(0.97);
    vec3 g = lat > shore ? sea : sand;
    g = mix(g, foam, band(lat, shore - 0.004, shore + 0.012, aaLat) * 0.9);
    g = mix(g, vec3(0.78, 0.68, 0.5), band(lat, shore - 0.05, shore - 0.004, aaLat) * 0.5);
    col = mix(col, g, 1.0 - smoothstep(-aaLat, aaLat, lat));
  }

  // Palm trees standing on the sand.
  float n = 14.0;
  float x = u * n;
  float id = floor(x);
  if (hash1(id + 2.0) > 0.2) {
    float base = -0.16 - 0.06 * hash1(id + 6.0);
    float top = 0.22 + 0.16 * hash1(id + 9.0);
    float lean = (hash1(id + 4.0) - 0.5) * 0.25;
    float t = clamp((lat - base) / (top - base), 0.0, 1.0);
    float cx = (0.5 + lean * t * t) * 2.0 * PI / n;
    float dx = (fract(x) * 2.0 * PI / n - cx) * cos(lat);
    float trunk = (1.0 - smoothstep(0.011 - aaLon, 0.011 + aaLon, abs(dx))) * band(lat, base, top, aaLat);
    vec3 bark = mix(vec3(0.45, 0.32, 0.2), vec3(0.35, 0.24, 0.15), step(0.5, fract(lat * 90.0)));
    col = mix(col, bark, trunk);
    vec2 c = vec2(dx, lat - top);
    float fr = 0.0;
    for (int k = 0; k < 5; k++) {
      float a = float(k) * 1.25 + hash1(id + float(k)) * 0.4;
      vec2 d = vec2(cos(a), sin(a) * 0.55 - 0.15);
      vec2 rel = c - d * 0.07;
      fr = max(fr, 1.0 - smoothstep(0.045 - aaLat, 0.045 + aaLat, length(rel * vec2(0.6, 2.0))));
    }
    col = mix(col, mix(vec3(0.12, 0.45, 0.2), vec3(0.25, 0.6, 0.25), noise3(dir * 80.0)), fr);
  }
  return col;
}

// Night city: stars and moon, lit windows, street lights.
vec3 sceneNight(float lat, float lon, float aaLat, float aaLon) {
  vec3 dir = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  float u = lon / (2.0 * PI) + 0.5;
  vec3 col = mix(vec3(0.16, 0.14, 0.32), vec3(0.02, 0.03, 0.1), pow(clamp(max(lat, 0.0) / 1.0, 0.0, 1.0), 0.6));
  vec3 cell = floor(dir * 140.0);
  float st = hash3(cell);
  col += vec3(0.9, 0.92, 1.0) * step(0.992, st) * smoothstep(0.15, 0.4, lat) * (0.4 + 0.6 * hash3(cell + 3.0));
  vec3 moonDir = normalize(vec3(-0.5, 0.55, 0.65));
  float md = dot(dir, moonDir);
  col = mix(col, vec3(0.95, 0.93, 0.82), smoothstep(0.9985, 0.9992, md));
  col += vec3(0.25, 0.25, 0.35) * pow(max(md, 0.0), 60.0);

  float n = 54.0;
  float x = u * n;
  float id = floor(x);
  float fx = fract(x);
  float h = 0.1 + 0.32 * pow(hash1(id + 21.0), 1.4);
  float wx = aaLon * n / (2.0 * PI) + 1e-4;
  float inB = band(fx, 0.04, 0.96, wx) * (1.0 - smoothstep(h - aaLat, h + aaLat, lat)) * step(-0.01, lat);
  vec3 bcol = mix(vec3(0.07, 0.08, 0.13), vec3(0.13, 0.12, 0.18), hash1(id + 13.0));
  vec2 wc = vec2(floor(fx * 6.0), floor(lat * 80.0));
  float lit = step(0.55, hash1(wc.x * 17.0 + wc.y * 131.0 + id * 7.0));
  float win = band(fract(fx * 6.0), 0.25, 0.75, wx * 6.0) * band(fract(lat * 80.0), 0.3, 0.7, aaLat * 80.0);
  vec3 wcol = mix(vec3(1.0, 0.82, 0.45), vec3(0.7, 0.85, 1.0), step(0.8, hash1(wc.y + id)));
  bcol = mix(bcol, wcol, win * lit * step(0.012, lat) * step(lat, h - 0.01));
  col = mix(col, bcol, inB);

  if (lat < 0.0) {
    vec3 g = vec3(0.09, 0.09, 0.11) + 0.04 * noise3(dir * 40.0);
    float lane = band(lat, -0.12, -0.11, aaLat) * step(0.5, fract(u * 60.0));
    g = mix(g, vec3(0.9, 0.85, 0.6), lane);
    float lamps = pow(0.5 + 0.5 * cos(u * 2.0 * PI * 16.0), 8.0);
    g += vec3(1.0, 0.75, 0.4) * lamps * smoothstep(-0.25, 0.0, lat) * 0.35;
    g = mix(g, vec3(0.3, 0.3, 0.33), band(lat, -0.035, 0.0, aaLat));
    col = mix(col, g, 1.0 - smoothstep(-aaLat, aaLat, lat));
  }
  // Street-light poles.
  float px = fract(u * 16.0);
  float pole = band(px, 0.497, 0.503, aaLon * 16.0 / (2.0 * PI) + 1e-4) * band(lat, 0.0, 0.07, aaLat);
  col = mix(col, vec3(0.2), pole);
  float bulb = 1.0 - smoothstep(0.006, 0.012, length(vec2((px - 0.5) * 2.0 * PI / 16.0 * cos(lat), lat - 0.07)));
  col += vec3(1.0, 0.8, 0.5) * bulb;
  return col;
}

vec3 sceneColor(float lat, float lon, float aaLat, float aaLon) {
  if (uScene == 1) return sceneBeach(lat, lon, aaLat, aaLon);
  if (uScene == 2) return sceneNight(lat, lon, aaLat, aaLon);
  return sceneStreet(lat, lon, aaLat, aaLon);
}

// Tiny planet background: stereographic projection centred on the ground
// (nadir) with the sky towards the outside.
vec3 planetBackground(vec2 p) {
  p -= vec2(0.0, uPlanetY);
  p = rot(uPlanetRot) * p;
  float r = length(p);
  float lat = 2.0 * atan(r / (2.0 * uPlanetS)) - 0.5 * PI;
  float lon = atan(p.x, p.y);
  float aaLat = fwidth(lat) * 0.75;
  float dl = fwidth(lon);
  float aaLon = (dl > PI ? 2.0 * PI - dl : dl) * 0.75;

  if (uBgKind == 0) return sceneColor(lat, lon, aaLat + 1e-4, aaLon + 1e-4);

  // Image: u wraps around the planet, v runs from the image top (uBgLatTop)
  // to the bottom row at the planet centre.
  float u = fract(lon / (2.0 * PI) + 0.5);
  float v = (uBgLatTop - lat) / (uBgLatTop + 0.5 * PI);
  vec2 gx = vec2(dFdx(u), dFdx(v));
  vec2 gy = vec2(dFdy(u), dFdy(v));
  gx.x -= sign(gx.x) * step(0.5, abs(gx.x));
  gy.x -= sign(gy.x) * step(0.5, abs(gy.x));
  if (v >= 0.0) return textureGrad(uBg, vec2(u, v), gx, gy).rgb;
  // Above the image's top edge: extend its top rows, increasingly blurred.
  float o = -v;
  vec3 c = textureLod(uBg, vec2(u, 0.0), clamp(log2(1.0 + o * 60.0), 0.0, 6.0)).rgb;
  vec3 s = textureLod(uBg, vec2(u, 0.02), 7.0).rgb;
  return mix(c, s, smoothstep(0.0, 0.5, o));
}

// Person cut-out with a clean outline. The segmentation mask is low
// resolution, so near its edge it is re-estimated from nearby mask samples
// weighted by how similar their camera colour is to this pixel's colour
// (joint bilateral upsampling). The edge then follows the real outline of
// the head and shoulders instead of the mask's blocky pixels, and the final
// threshold is anti-aliased for the current magnification.
float personMask(vec2 uv) {
  vec2 tx = 1.0 / uMaskRes;
  float centre = textureLod(uMask, uv, 0.0).r;
  float a = textureLod(uMask, uv + vec2( 2.5,  2.5) * tx, 0.0).r;
  float b = textureLod(uMask, uv + vec2(-2.5,  2.5) * tx, 0.0).r;
  float c = textureLod(uMask, uv + vec2( 2.5, -2.5) * tx, 0.0).r;
  float d = textureLod(uMask, uv + vec2(-2.5, -2.5) * tx, 0.0).r;
  float lo = min(min(min(a, b), min(c, d)), centre);
  float hi = max(max(max(a, b), max(c, d)), centre);
  float m = centre;
  if (hi > 0.04 && lo < 0.96) {
    vec3 c0 = textureLod(uCam, uv, 1.0).rgb;
    float msum = 0.0, wsum = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j)) * tx * 1.6;
        vec3 ci = textureLod(uCam, uv + o, 1.0).rgb - c0;
        float w = exp(-dot(ci, ci) * 40.0 - float(i * i + j * j) * 0.5);
        msum += textureLod(uMask, uv + o, 0.0).r * w;
        wsum += w;
      }
    }
    m = msum / max(wsum, 1e-4);
  }
  return m;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));
  p.x *= uMirror;
  vec3 col;

  if (uMode == 0) {
    col = sampleCam(qToUv(p));
  } else if (uMode == 2) {
    vec2 pg = rot(uRoll) * (p - vec2(0.0, uPlanetY));
    col = sampleCam(qToUv(facePop(globeToQ(pg))));
  } else {
    vec2 ps = rot(uRoll) * (p - vec2(0.0, uSubjectY)) / uZoom;
    vec2 uv = qToUv(facePop(fisheyeToQ(ps)));
    if (uMode == 1) {
      col = sampleCam(uv);
    } else {
      vec3 bg = planetBackground(p);
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      float raw = uHasMask > 0.5 ? personMask(uv) : 0.0;
      // Anti-aliased threshold: about one output pixel wide at any magnification.
      float aa = clamp(fwidth(raw) * 0.75, 0.02, 0.25);
      float m = smoothstep(0.5 - aa, 0.5 + aa, raw) * inside;
      col = mix(bg, texture(uCam, uv).rgb, m);
    }
  }
  outColor = vec4(col, 1.0);
}`;
