#!/usr/bin/env python3
"""Serve the interactive product locally.

    python3 tools/serve.py            # http://localhost:8000/

Serves `src/v2` so that `web/index.html` can fetch `../qm/*.py` through the
manifest. The repository-level `artifact/` tree is mounted at `/artifact/`.
Cross-origin isolation headers are set because a future
SharedArrayBuffer-based Clang bundle needs them, and adding them now costs
nothing.
"""

import argparse
import http.server
import os
import posixpath
import socketserver
from urllib.parse import unquote, urlsplit
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPOSITORY_ROOT = os.path.dirname(os.path.dirname(ROOT))
ARTIFACT_ROOT = os.path.realpath(os.path.join(REPOSITORY_ROOT, 'artifact'))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.wasm': 'application/wasm',
        '.json': 'application/json',
        '.pages': 'application/octet-stream',
    })

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        """Mount immutable artifacts without changing the application root."""
        parsed = unquote(urlsplit(path).path)
        if parsed == '/artifact' or parsed.startswith('/artifact/'):
            relative = posixpath.normpath(parsed[len('/artifact'):])
            parts = [part for part in relative.split('/')
                     if part not in ('', '.', '..')]
            selected = os.path.realpath(os.path.join(ARTIFACT_ROOT, *parts))
            if os.path.commonpath((ARTIFACT_ROOT, selected)) \
                    != ARTIFACT_ROOT:
                return os.path.join(ARTIFACT_ROOT, '__invalid__')
            return selected
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '404' in (fmt % args):
            super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('', args.port), Handler) as httpd:
        url = 'http://localhost:%d/web/index.html' % args.port
        print('Quotient Minimizer: %s' % url)
        print('serving %s (Ctrl-C to stop)' % ROOT)
        if not args.no_open:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == '__main__':
    main()
