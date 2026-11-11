# Installation and hosting

The app is static files. "Installing" means putting the folder on a web host, or serving it locally. There is nothing to build.

## Requirements

- **HTTPS** (or `localhost`). Browsers only allow camera access on secure pages.
- The host must serve `.wasm` as `application/wasm` and `.mjs` as `text/javascript`. Netlify, GitHub Pages, Cloudflare Pages and Vercel all do this by default.
- About 16 MB of files. Phones download the face and cut-out components (about 14 MB) the first time they are needed, then keep them for offline use.

## Option 1: Netlify Drop (no account setup beyond sign-in)

1. Unzip the project.
2. Open https://app.netlify.com/drop and drag the `360-fisheye-cam` folder onto the page.
3. Open the `https://….netlify.app` address on your phone.

## Option 2: GitHub Pages

1. Create a repository and upload the folder's contents (the folder that contains `index.html`).
2. Settings → Pages → Deploy from a branch → `main` / root.
3. Open `https://<user>.github.io/<repo>/`.

## Option 3: Cloudflare Pages

Workers & Pages → Create → Pages → Upload assets → upload the folder.

## Running on your own computer

Double-click `Start 360 Cam.command` (Mac) or `Start 360 Cam.bat` (Windows), or run:

```bash
python3 serve.py              # opens the browser; picks a free port from 8000 up
python3 serve.py --port 9000  # start from another port
python3 serve.py --no-open    # don't open the browser
```

`serve.py` needs only Python 3 and serves the app to this computer only. It also binds both the IPv4 and IPv6 loopback addresses, so `localhost` can't end up at another program using the same port (Docker Desktop, for example). Avoid plain `python3 -m http.server`: it fails with "Address already in use" when another program holds the port.

To try it on a phone you need HTTPS, so use one of the hosting options above, or a tunnel such as `cloudflared tunnel --url http://localhost:8000`.

## Deploying from the command line

If you prefer a terminal over Netlify Drop, run either of these from this folder (each asks you to log in the first time):

```bash
npx netlify-cli deploy --prod --dir .
npx vercel deploy --prod
```

## Rebuilding the bundled libraries

`vendor/` and `models/` are included. To rebuild them from npm (Node.js 18+ and Python 3 with `pip install mediapipe`):

```bash
bash tools/setup_vendor.sh
```

This also re-applies the patch that turns off MediaPipe's usage logging, and adds the metadata MediaPipe Tasks needs to the two Apache-2.0 models.

## Supported browsers

Checked in this build (automated tests on macOS, 11 Nov 2026): Chrome 157 with the real GPU (all features), and the Playwright builds of WebKit (Safari's engine) and Firefox (photos, looks, video export, error handling). **Not yet tested on real devices**: Safari on iOS 16.4+, Chrome on Android, and the camera in desktop Safari and Firefox. See OPEN_DECISIONS.md for the device test plan.
