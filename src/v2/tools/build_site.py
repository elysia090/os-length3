#!/usr/bin/env python3
"""Assemble the deployable site into `dist/`.

    python3 tools/build_site.py

The page needs three things next to each other, because the worker installs the
Python engine by fetching the files named in `web/qm-manifest.json`:

    dist/index.html      the shell, so the bare domain lands on the tool
    dist/web/            app.js, worker.js, clang.js, styles.css, manifest
    dist/qm/             the engine, fetched at runtime by the worker
    dist/examples/       the kernels the Examples dialog offers

`index.html` is copied to the root with its two asset paths rewritten, so the
same file serves correctly from `/` and from `/web/`.

Used by both `wrangler deploy` and the GitHub Pages workflow, so the two cannot
drift apart.
"""

import argparse
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
TREES = ('qm', 'web', 'examples')


def _ignore(_dir, names):
    return [n for n in names
            if n == '__pycache__' or n.endswith(('.pyc', '.pyo'))]


def build(dist=DIST):
    if os.path.exists(dist):
        shutil.rmtree(dist)
    os.makedirs(dist)

    for tree in TREES:
        shutil.copytree(os.path.join(ROOT, tree), os.path.join(dist, tree),
                        ignore=_ignore)

    with open(os.path.join(ROOT, 'web', 'index.html')) as handle:
        shell = handle.read()
    shell = (shell
             .replace('href="styles.css"', 'href="web/styles.css"')
             .replace('src="app.js"', 'src="web/app.js"'))
    with open(os.path.join(dist, 'index.html'), 'w') as handle:
        handle.write(shell)

    shutil.copy(os.path.join(ROOT, 'web', '_headers'),
                os.path.join(dist, '_headers'))

    with open(os.path.join(ROOT, 'web', 'qm-manifest.json')) as handle:
        manifest = json.load(handle)

    missing = [rel for rel in manifest['files']
               if not os.path.exists(os.path.join(dist, rel))]
    if missing:
        raise SystemExit('manifest lists files the build does not contain: %s'
                         % ', '.join(missing))

    count = sum(len(files) for _r, _d, files in os.walk(dist))
    print('built %s (%d files, %d engine modules)'
          % (dist, count, len(manifest['files'])))
    return dist


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default=DIST)
    args = parser.parse_args()
    build(args.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
