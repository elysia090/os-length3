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
import re
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
        self._byte_range = None
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

    def send_head(self):
        """Serve one explicit byte range so page bundles stay page-lazy."""
        requested = self.headers.get('Range')
        path = self.translate_path(self.path)
        if requested and os.path.isfile(path):
            match = re.fullmatch(r'bytes=(\d+)-(\d*)', requested.strip())
            size = os.path.getsize(path)
            if match is None:
                self.send_error(416, 'invalid byte range')
                return None
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else size - 1
            if start >= size or end < start:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % size)
                self.end_headers()
                return None
            end = min(end, size - 1)
            try:
                source = open(path, 'rb')
            except OSError:
                self.send_error(404, 'file not found')
                return None
            self._byte_range = start, end
            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Length', str(end - start + 1))
            self.send_header('Content-Range',
                             'bytes %d-%d/%d' % (start, end, size))
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            source.seek(start)
            return source
        self._byte_range = None
        return super().send_head()

    def copyfile(self, source, output):
        if self._byte_range is None:
            return super().copyfile(source, output)
        remaining = self._byte_range[1] - self._byte_range[0] + 1
        while remaining:
            block = source.read(min(64 * 1024, remaining))
            if not block:
                break
            output.write(block)
            remaining -= len(block)

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

    http.server.ThreadingHTTPServer.allow_reuse_address = True
    # Page fabrics deliberately fetch independent ranges concurrently. A
    # single-request server serializes compiler, VM, and Linux chunks and can
    # make the local cold profile several times slower than deployment.
    with http.server.ThreadingHTTPServer(('', args.port), Handler) as httpd:
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
