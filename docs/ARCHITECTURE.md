# Architecture

## Components

| File | Responsibility |
|---|---|
| `index.html`, `css/app.css` | Layout: preview, looks row, controls, adjustment panel, dialogs. |
| `js/main.js` | App state, source switching, the per-frame pump, UI wiring, recording and export flows. |
| `js/effects.js` | Looks, parameter definitions (ranges, defaults, help), validation, reset, output sizing, background layout, and the conversion from settings + face position to shader uniforms. No DOM; unit-tested in Node. |
| `js/shaders.js` | The GLSL. One full-screen pass with four modes: original, fisheye, real planet, cover planet. |
| `js/renderer.js` | WebGL2 context, the camera/mask/background textures, uniform upload, context-loss handling. |
| `js/tracking.js` | MediaPipe face detector and selfie segmenter (CPU, WebAssembly), frame skipping on slow devices, motion smoothing, mask smoothing. |
| `js/camera.js` | getUserMedia, camera flip, microphone, friendly permission errors. |
| `js/recorder.js` | MediaRecorder on the canvas stream plus microphone, format negotiation (MP4 first, then WebM). Streams chunks to the Origin Private File System when available (memory fallback), cleans up temporary files, reports storage errors. |
| `js/media.js` | File validation and decoding, video metadata, background image preparation, WebCodecs video export (Mediabunny), save/share. |
| `sw.js`, `manifest.webmanifest` | Installable, offline-capable PWA. |

## Data flow (live camera or video preview)

```
<video> frame ─► Tracker.analyze (480 px copy) ─► face box + nose ─► smoothing ─┐
              │                               └► person mask (Uint8) ─► mask texture
              └► camera texture (+ mipmaps) ──────────────────────────────────┤
settings ─► resolveUniforms ◄───────────────────────────────────────────────────┘
          ─► fragment shader ─► canvas ─► screen / MediaRecorder / photo
```

Frames are pulled with `requestVideoFrameCallback`, so work only happens when a new camera frame arrives. Changing a control redraws once.

## Video file export

`exportVideoWebCodecs` opens the file with Mediabunny and runs a `Conversion`:

1. Each decoded frame (rotation already applied) is drawn to a scratch canvas.
2. It is tracked, uploaded and rendered at the export size.
3. The WebGL canvas is captured synchronously into a `VideoFrame` with the source timestamp and duration.
4. Mediabunny encodes H.264 into MP4 when possible, otherwise another codec, or WebM. Audio packets are copied unchanged, or transcoded if the container needs it. Anything that cannot be kept is reported to the user.

Browsers without WebCodecs fall back to playing the file once in real time and recording the canvas plus the element's audio through Web Audio.

## Effect geometry

All effects use inverse mapping: for each output pixel the shader computes which source pixel to read, so there are no holes.

- **Fisheye:** output radius → virtual angle using the chosen lens model (equisolid, orthographic, equidistant or stereographic). That angle is scaled so the output corners reach the source corners, then mapped through the source's rectilinear model (`tan`).
- **Face pop:** a C1-continuous local magnification around the nose, `q' = c + d·mix(1−s, 1, smoothstep(0, 1, |d|/R))`. The centre is enlarged by 1/(1−s) and there is no visible ring at the edge.
- **Real planet:** orthographic globe mapping (`asin(r/R)`) out to the rim; beyond it the angle keeps increasing, so the surroundings continue outward.
- **Cut-out edge:** the low-resolution person mask is refined near its edge by joint bilateral upsampling (3×3 mask samples weighted by camera-colour similarity), so the outline follows the real head and shoulders, then thresholded with an anti-aliased step about one output pixel wide. Only pixels near the edge pay for this.
- **Fill outside the camera's view:** the frame is mirrored across its edge, sampled from a mip level that rises with distance, and blended towards a heavily averaged colour of the nearest border. The result is seamless and colour-matched, and it is temporally stable because coarse mips average out noise.
- **Tiny planet background:** a stereographic projection centred on the ground (nadir), with the sky towards the outside. The built-in scenes (street, beach, night city; `uScene`) are defined procedurally on the sphere, so they have no seam. Image planets use explicit gradients so the wrap-around column doesn't show a mip seam.

## Dependencies

| Dependency | Why | Licence |
|---|---|---|
| @mediapipe/tasks-vision 1.2.2 | Face detection and person segmentation on device. | Apache-2.0 (usage logging patched out) |
| BlazeFace short-range and Selfie Segmentation models (from the @mediapipe/face_detection and @mediapipe/selfie_segmentation npm packages) | Model weights, with MediaPipe Tasks metadata added. | Apache-2.0 |
| Mediabunny 1.65.2 | Reading and writing MP4/MOV/WebM on top of WebCodecs. | MPL-2.0 |

No other runtime dependencies.
