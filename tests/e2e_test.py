"""End-to-end test in headless Chrome (Playwright).

Serves the app, feeds a fake camera from a Y4M file, and exercises every look,
photo export, live recording and video-file export. Saves screenshots and
exported files to an output folder for visual review.

Usage:
  python3 tests/e2e_test.py --chrome /path/to/chrome --media <dir with person.jpg,
      grid.png, person.mp4, person.y4m> --out <output dir> [--gpu]
"""
import argparse, base64, functools, http.server, json, os, subprocess, sys, threading, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


def serve(port):
    class Handler(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json'}
        def log_message(self, *a): pass
    handler = functools.partial(Handler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def canvas_stats(page):
    return page.evaluate('''() => {
      window.__app.draw();
      const c = document.getElementById('view');
      const t = document.createElement('canvas'); t.width = 64; t.height = 64;
      const x = t.getContext('2d'); x.drawImage(c, 0, 0, 64, 64);
      const d = x.getImageData(0, 0, 64, 64).data; let s = 0, v = 0, nonBlack = 0;
      for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i+1] + d[i+2]) / 3; s += l; v += l * l; if (l > 8) nonBlack++; }
      const n = d.length / 4, mean = s / n;
      return { w: c.width, h: c.height, mean, std: Math.sqrt(v / n - mean * mean), nonBlack: nonBlack / n };
    }''')


def snap(page, out, name):
    page.locator('#view').screenshot(path=os.path.join(out, name + '.png'))


def save_result(page, out, name):
    b64 = page.evaluate('''async () => {
      const b = window.__app.state.result.blob; const buf = new Uint8Array(await b.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    }''')
    fn = page.evaluate('() => window.__app.state.result.filename')
    path = os.path.join(out, name + os.path.splitext(fn)[1])
    with open(path, 'wb') as f:
        f.write(base64.b64decode(b64))
    return path


def ffprobe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,duration',
                        '-show_entries', 'format=duration', '-of', 'json', path], capture_output=True, text=True)
    return json.loads(r.stdout or '{}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chrome', default='/usr/bin/google-chrome')
    ap.add_argument('--media', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--gpu', action='store_true', help='use the real GPU instead of SwiftShader (canvas capture can be empty under SwiftShader on macOS)')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    port = a.port
    serve(port)
    url = f'http://localhost:{port}/index.html'
    errors = []
    with sync_playwright() as p:
        gl_args = [] if a.gpu else ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
        browser = p.chromium.launch(executable_path=a.chrome, args=gl_args + [
            '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
            f'--use-file-for-fake-video-capture={os.path.join(a.media, "person.y4m")}',
            '--autoplay-policy=no-user-gesture-required'])
        # 1) The real Content-Security-Policy must not block the models.
        cctx = browser.new_context(permissions=['camera', 'microphone'])
        cpage = cctx.new_page()
        csp_errors = []
        cpage.on('console', lambda m: csp_errors.append(m.text) if 'Content Security Policy' in m.text else None)
        cpage.goto(url)
        cpage.click('#btnStartCamera')
        ok = False
        for _ in range(120):
            time.sleep(0.5)
            if cpage.evaluate('() => !!(window.__app && window.__app.tracker.segmenter && window.__app.tracker.faceDetector)'):
                ok = True
                break
        check('models load under the app CSP', ok and not csp_errors, ' | '.join(csp_errors)[:400])
        cctx.close()

        # 2) Everything else (Playwright's waiting helpers need eval, so CSP is bypassed here).
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, permissions=['camera', 'microphone'], bypass_csp=True)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('requestfailed', lambda r: errors.append('request failed: ' + r.url))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        t0 = time.time()
        page.goto(url)
        page.wait_for_function('window.__app')
        check('app loads', True, f'{time.time() - t0:.2f}s')
        check('default look is tiny planet', page.evaluate('window.__app.state.look') == 'cover')

        # ---- live camera
        page.click('#btnStartCamera')
        page.wait_for_function('window.__app.state.source && window.__app.state.source.kind === "camera"', timeout=20000)
        page.wait_for_function('window.__app.tracker.segmenter && window.__app.renderer.mask.ready', timeout=60000)
        page.wait_for_timeout(1500)
        st = canvas_stats(page)
        check('camera renders (cover planet)', st['std'] > 10, json.dumps(st))
        check('face tracked on fake camera', page.evaluate('!!window.__app.tracker.face'))
        snap(page, a.out, 'camera-cover')
        # Effects must not leave unfilled (black) areas: compare with the untouched source,
        # since dark hair or clothes in the footage are legitimately dark.
        page.evaluate('window.__app.state.comparing = true')
        src_non_black = canvas_stats(page)['nonBlack']
        page.evaluate('window.__app.state.comparing = false')
        for look in ['real-planet', 'fisheye']:
            page.click(f'.look[data-id="{look}"]')
            page.wait_for_timeout(800)
            st = canvas_stats(page)
            check(f'camera renders ({look})', st['std'] > 10 and st['nonBlack'] > src_non_black - 0.05, json.dumps(st) + f' source nonBlack {src_non_black:.3f}')
            snap(page, a.out, f'camera-{look}')

        # hold-to-compare shows the original
        page.evaluate('window.__app.state.comparing = true; window.__app.draw()')
        page.wait_for_timeout(200)
        snap(page, a.out, 'camera-original')
        page.evaluate('window.__app.state.comparing = false')

        # live recording
        page.click('.look[data-id="cover"]')
        page.click('#btnRecord')
        page.wait_for_timeout(3500)
        check('output size is locked while recording', page.evaluate('document.getElementById("optAspect").disabled && document.getElementById("optQuality").disabled'))
        storage = page.evaluate('() => window.__app.state.recorder && window.__app.state.recorder.storage')
        check('live recording streams to on-device storage', storage == 'disk', str(storage))
        page.click('#btnRecord')
        page.wait_for_selector('#resultModal:not([hidden])', timeout=15000)
        path = save_result(page, a.out, 'live-recording')
        info = ffprobe(path)
        kinds = [s.get('codec_type') for s in info.get('streams', [])]
        check('live recording has video', 'video' in kinds, json.dumps(info.get('streams')))
        check('live recording has audio', 'audio' in kinds)
        check('output size unlocked after recording', page.evaluate('!document.getElementById("optAspect").disabled'))
        page.click('#btnCloseResult')

        # photo capture from camera
        page.click('#btnPhoto')
        page.wait_for_selector('#resultModal:not([hidden])')
        path = save_result(page, a.out, 'camera-photo')
        check('camera photo saved', os.path.getsize(path) > 10000, f'{os.path.getsize(path)} bytes')
        page.click('#btnCloseResult')

        # ---- photo file
        page.set_input_files('#fileInput', os.path.join(a.media, 'person.jpg'))
        page.wait_for_function('window.__app.state.source && window.__app.state.source.kind === "image"')
        page.wait_for_timeout(800)
        check('photo: face detected', page.evaluate('!!window.__app.tracker.face'))
        for look in ['cover', 'real-planet', 'fisheye']:
            page.click(f'.look[data-id="{look}"]')
            page.wait_for_timeout(500)
            snap(page, a.out, f'photo-{look}')
        page.select_option('#optAspect', '9:16')
        page.wait_for_timeout(300)
        dims = page.evaluate('[document.getElementById("view").width, document.getElementById("view").height]')
        check('9:16 output frame', abs(dims[0] / dims[1] - 9 / 16) < 0.01, str(dims))
        snap(page, a.out, 'photo-fisheye-9x16')
        page.click('.look[data-id="cover"]')
        page.wait_for_timeout(400)
        snap(page, a.out, 'photo-cover-9x16')
        for i, name in enumerate(['street', 'beach', 'night']):
            page.select_option('select[data-key="scene"]', str(i))
            page.wait_for_timeout(300)
            st = canvas_stats(page)
            check(f'built-in scene renders ({name})', st['std'] > 10, json.dumps(st))
            snap(page, a.out, f'scene-{name}')
        page.select_option('select[data-key="scene"]', '0')

        # image planet background (ordinary photo, mirrored) and a 2:1 panorama
        page.set_input_files('#bgInput', os.path.join(a.media, 'person.jpg'))
        page.wait_for_function('window.__app.state.bg')
        page.wait_for_timeout(400)
        check('image planet selected', page.evaluate('window.__app.state.look') == 'image')
        check('ordinary photo marked as not panorama', page.evaluate('window.__app.state.bg.panorama') is False)
        snap(page, a.out, 'photo-image-planet')

        # reset restores defaults
        page.evaluate('window.__app.state.settings.planetSize = 0.6')
        page.click('#btnReset')
        check('reset restores defaults', abs(page.evaluate('window.__app.state.settings.planetSize') - 0.4) < 1e-9)

        page.click('#btnExport')  # "Save photo" for image sources
        page.wait_for_selector('#resultModal:not([hidden])')
        path = save_result(page, a.out, 'photo-export')
        check('photo export', os.path.getsize(path) > 10000, f'{os.path.getsize(path)} bytes')
        page.click('#btnCloseResult')
        page.select_option('#optAspect', 'original')

        # ---- geometry: grid, manual centre, no face pop
        page.set_input_files('#fileInput', os.path.join(a.media, 'grid.png'))
        page.wait_for_function('window.__app.state.source && window.__app.state.source.name === "grid.png"')
        page.evaluate('''() => { const s = window.__app.state.settings; s.followFace = false; s.facePop = 0; s.offsetX = 0; s.offsetY = 0; s.subjectY = 0; s.zoom = 1; s.roll = 0; }''')
        page.click('.look[data-id="fisheye"]')
        page.wait_for_timeout(400)
        centre = page.evaluate('''() => { window.__app.draw(); const c = document.getElementById('view'); const t = document.createElement('canvas');
          t.width = c.width; t.height = c.height; const x = t.getContext('2d'); x.drawImage(c, 0, 0);
          return Array.from(x.getImageData(c.width / 2, c.height / 2, 1, 1).data); }''')
        check('fisheye keeps the source centre at the output centre', centre[0] > 180 and centre[1] < 110, str(centre))
        snap(page, a.out, 'grid-fisheye')
        page.click('.look[data-id="real-planet"]')
        page.wait_for_timeout(400)
        snap(page, a.out, 'grid-real-planet')

        # ---- video file export
        page.set_input_files('#fileInput', os.path.join(a.media, 'person.mp4'))
        page.wait_for_function('window.__app.state.source && window.__app.state.source.kind === "video"', timeout=20000)
        page.evaluate('() => { const s = window.__app.state.settings; s.followFace = true; s.facePop = 0.45; s.subjectY = 0.25; s.zoom = 1.15; }')
        page.click('.look[data-id="cover"]')
        page.wait_for_timeout(1500)
        # A paused video gets the cut-out and face tracking without pressing Play, also after a seek.
        page.evaluate('() => window.__app.renderer.clearMask()')
        page.evaluate('() => { const v = document.getElementById("fileVideo"); v.currentTime = 1; }')
        page.wait_for_timeout(1000)
        check('paused video preview is analysed (cut-out + face)', page.evaluate(
            '() => document.getElementById("fileVideo").paused && window.__app.renderer.mask.ready && !!window.__app.tracker.face'))
        snap(page, a.out, 'video-preview')
        t0 = time.time()
        page.click('#btnExport')
        page.wait_for_selector('#resultModal:not([hidden])', timeout=180000)
        secs = time.time() - t0
        path = save_result(page, a.out, 'video-export')
        info = ffprobe(path)
        streams = info.get('streams', [])
        v = next((s for s in streams if s['codec_type'] == 'video'), {})
        au = next((s for s in streams if s['codec_type'] == 'audio'), None)
        dur = float(info.get('format', {}).get('duration', 0))
        check('video export finished', bool(v), f'{secs:.1f}s for a 4s clip; {json.dumps(streams)}')
        check('video export keeps aspect 720x940', v.get('width') == 720 and v.get('height') == 940)
        check('video export keeps audio', au is not None)
        check('video export keeps duration', abs(dur - 4.0) < 0.2, f'{dur:.2f}s')
        check('video export keeps 30 fps', v.get('avg_frame_rate') in ('30/1', '30000/1001') or abs(eval(v.get('avg_frame_rate', '0/1')) - 30) < 0.5, v.get('avg_frame_rate'))
        page.click('#btnCloseResult')

        # unsupported file
        bad = os.path.join(a.out, 'notes.txt')
        with open(bad, 'w') as f:
            f.write('hello')
        page.set_input_files('#fileInput', bad)
        page.wait_for_selector('#toast:not([hidden])')
        check('unsupported file shows a clear error', 'not a supported' in page.inner_text('#toast'), page.inner_text('#toast'))

        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(a.out, 'mobile-ui.png'))
        page.click('#btnAdjust') if not page.is_visible('#sheet') else None
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(a.out, 'mobile-adjust.png'))

        benign = ('XNNPACK', 'is not a supported photo or video', 'Failed to load resource', 'request failed: blob:')
        real_errors = [e for e in errors if not any(b in e for b in benign)]
        check('no page errors', not real_errors, ' | '.join(real_errors)[:800])
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
