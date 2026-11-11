#!/usr/bin/env python3
"""Run 360 Fisheye Cam on this computer.

    python3 serve.py            # picks a free port from 8000 up and opens the browser
    python3 serve.py --port 9000 --no-open

Only Python 3 is needed (no packages). The app is served to this computer only.
To use it on a phone, deploy it to an HTTPS host instead (see docs/INSTALLATION.md).
"""
import argparse, functools, http.server, os, socket, sys, threading, webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json'}

    def end_headers(self):
        # Always serve fresh app files while developing; the app's own service
        # worker still handles offline use.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *args):
        pass


class Server4(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET
    allow_reuse_address = False


class Server6(Server4):
    address_family = socket.AF_INET6


def bind(port):
    """Bind the port on both loopback addresses, so "localhost" can't reach another app."""
    handler = functools.partial(Handler, directory=ROOT)
    servers = []
    try:
        servers.append(Server4(('127.0.0.1', port), handler))
        if socket.has_ipv6:
            try:
                servers.append(Server6(('::1', port), handler))
            except OSError as e:
                if e.errno != 49:  # 49 = IPv6 loopback not available on this machine: IPv4 is enough
                    raise
        return servers
    except OSError:
        for s in servers:
            s.server_close()
        return None


def main():
    ap = argparse.ArgumentParser(description='Run 360 Fisheye Cam locally.')
    ap.add_argument('--port', type=int, default=8000, help='first port to try (default 8000)')
    ap.add_argument('--no-open', action='store_true', help="don't open the browser")
    a = ap.parse_args()

    for port in range(a.port, a.port + 50):
        servers = bind(port)
        if servers:
            break
    else:
        sys.exit(f'No free port between {a.port} and {a.port + 49}. Try: python3 serve.py --port 9000')

    url = f'http://localhost:{port}'
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f'\n  360 Fisheye Cam is running at  {url}\n', flush=True)
    if port != a.port:
        print(f'  (port {a.port} was busy, so {port} is used instead)')
    print('  Use Chrome, Safari, Edge or Firefox. Press Ctrl+C to stop.\n', flush=True)
    if not a.no_open:
        webbrowser.open(url)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print('Stopped.')


if __name__ == '__main__':
    main()
