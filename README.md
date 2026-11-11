# 360 Fisheye Cam

A web app that gives ordinary phone and laptop cameras the "360 camera" look from short-form video: a tiny planet behind you, or an extreme fisheye with an enlarged face. It works live (record through the effect) and on photos and videos you already have. It runs in the browser on phones (iPhone, Android) and computers (macOS, Linux, Windows), and **all processing happens on the device**.

It is a 360-*style* effect. A normal camera only sees what is in front of it, so the app never claims to produce 360° footage.

## The looks

| Look | What it does | Reference |
|---|---|---|
| **Tiny planet** (default) | Cuts you out of the picture and places you, through a fisheye lens with a face pop, in front of a built-in tiny-planet scene: Sunny street, Beach or Night city. | A |
| **My planet image** | Same, but the planet is made from your own picture. A 2:1 360° panorama gives a true tiny planet; other photos are mirrored to close the circle. | A |
| **Real background · planet** | Curls your real surroundings into a planet. The area outside the camera's view is filled by mirroring and blending the picture's edges, blurring more the further out it goes. | A |
| **Real background · fisheye** | Extreme fisheye lens on the real background, with a face pop that follows your face. | B |

Every look has its own controls and a **Reset** button. **Compare** (hold) shows the untouched source.

## Run it

The app is a set of static files with no build step. The only thing you need is Python 3, and only for running it on your own computer.

**On your computer**
- **Mac:** double-click **`Start 360 Cam.command`**. The first time, macOS may block it: right-click it → Open → Open.
- **Windows:** double-click **`Start 360 Cam.bat`**.
- **Any system, from a terminal:** `python3 serve.py` in this folder.

The app opens in your browser at `http://localhost:8000`. If that port is taken, it uses the next free one (8001, 8002, …) and prints the address. Keep the window open while you use the app, and press Ctrl+C (or close the window) to stop it.

**On your phone:** phones only allow the camera over HTTPS, so put the app online (free, about 1 minute):
1. Go to https://app.netlify.com/drop and sign in.
2. Drag this whole folder onto the page.
3. Open the `https://….netlify.app` address it gives you on your phone.

To update it later, drag the folder onto the same site's Deploys page. Other hosts are covered in [docs/INSTALLATION.md](docs/INSTALLATION.md).

**Install as an app:** on iPhone use Share → Add to Home Screen; on Android Chrome use Install app. It then opens full screen and works offline after the first use.

## Technology

- Plain JavaScript modules, HTML and CSS (no framework, no build).
- WebGL2 fragment shader for every effect (`js/shaders.js`).
- MediaPipe Tasks (Apache-2.0) for face detection and the person cut-out, running on the CPU in WebAssembly. Models and WebAssembly are bundled in `vendor/` and `models/`.
- MediaRecorder for live recording; Mediabunny (MPL-2.0) on WebCodecs for exporting uploaded videos with the original timing and sound.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Usage: [docs/USER_GUIDE.md](docs/USER_GUIDE.md). Problems: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Unresolved product questions: [OPEN_DECISIONS.md](OPEN_DECISIONS.md).

## Privacy

Photos, videos and camera frames never leave the device. There are no analytics. The page's Content-Security-Policy only allows connections to its own site, and MediaPipe's built-in usage logging is switched off in the bundled copy (`tools/patch_mediapipe.py`).

## Tests

- `node --test tests/*.test.mjs` runs the unit tests: effect logic (parameters, validation, sizes, coordinate mapping), tracker timing (face smoothing and face-lost timeout after an export), and the recorder's stop handling (with mocked browser APIs).
- `python3 tests/e2e_test.py --media <folder> --out <folder>` runs the end-to-end test in headless Chrome. It drives a fake camera through every look, live recording, photo export, video export (checking resolution, frame rate, duration and sound with ffprobe) and error handling. The media folder needs `person.jpg`, `grid.png`, `person.mp4` (with sound) and `person.y4m`. It requires Playwright for Python, Chrome and ffprobe. On macOS add `--gpu`: under the default SwiftShader software renderer, Chrome's canvas capture can produce empty recordings there.
