#!/usr/bin/env python3
"""Assemble the deployable site into `dist/`.

    python3 tools/build_site.py

The page needs four trees next to each other, because workers install the
Python engine by fetching the files named in `web/qm-manifest.json`:

    dist/index.html      the shell, so the bare domain lands on the tool
    dist/web/            app.js, worker.js, clang.js, vm.js, vm.wasm, styles
    dist/qm/             the minimizer, fetched at runtime by workers
    dist/vm/             the machine it normalizes onto
    dist/kernel/         Linux state machine, fetched only by linux-worker
    dist/artifact/       identity-addressed prebuilt execution data
    dist/web/examples.json  the generated kernels the Examples dialog offers

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
REPOSITORY_ROOT = os.path.dirname(os.path.dirname(ROOT))
ARTIFACT_ROOT = os.path.join(REPOSITORY_ROOT, 'artifact')
DIST = os.path.join(ROOT, 'dist')
# Every package the manifest can name has to be here, or the worker
# installs an engine with a hole in it.  The check at the end of `build`
# is what makes that a build failure rather than a runtime one.
TREES = ('qm', 'vm', 'kernel', 'web')


def _ignore(directory, names):
    # `vm/wasm` is the C and its build script.  The compiled module ships as
    # `web/vm.wasm`; the source it came from is not something the page fetches.
    skip = {'__pycache__'}
    if os.path.basename(directory) == 'vm':
        skip.add('wasm')
    if os.path.basename(directory) == 'web':
        # Runtime code is delivered only through repository-level artifact/.
        # Keep the readable build fixture in the source tree for native parity
        # tests, but never deploy a second canonical or delivery URL.
        skip.update({'vm.wasm', 'vm.pages', 'vm-regions.pages',
                     'vm-steps.pages', 'vm.json'})
    if os.path.basename(directory) == 'assets':
        skip.add('compiler')
    return [n for n in names
            if n in skip or n.endswith(('.pyc', '.pyo'))]


def build(dist=DIST):
    if os.path.exists(dist):
        shutil.rmtree(dist)
    os.makedirs(dist)

    for tree in TREES:
        shutil.copytree(os.path.join(ROOT, tree), os.path.join(dist, tree),
                        ignore=_ignore)
    if os.path.isdir(ARTIFACT_ROOT):
        shutil.copytree(ARTIFACT_ROOT, os.path.join(dist, 'artifact'))

    with open(os.path.join(ROOT, 'web', 'index.html')) as handle:
        shell = handle.read()
    shell = (shell
             .replace('href="styles.css"', 'href="web/styles.css"')
             .replace('src="app.js"', 'src="web/app.js"'))
    with open(os.path.join(dist, 'index.html'), 'w') as handle:
        handle.write(shell)

    shutil.copy(os.path.join(ROOT, 'web', '_headers'),
                os.path.join(dist, '_headers'))

    manifests = []
    for name in ('qm-manifest.json', 'kernel-manifest.json'):
        with open(os.path.join(ROOT, 'web', name)) as handle:
            manifests.append(json.load(handle))

    missing = [rel for manifest in manifests for rel in manifest['files']
               if not os.path.exists(os.path.join(dist, rel))]
    if missing:
        raise SystemExit('manifest lists files the build does not contain: %s'
                         % ', '.join(missing))
    if os.path.isdir(ARTIFACT_ROOT) \
            and not os.path.exists(os.path.join(dist, 'artifact', 'index.json')):
        raise SystemExit('artifact catalog is not in the deployable site')

    count = sum(len(files) for _r, _d, files in os.walk(dist))
    print('built %s (%d files, %d ordinary + %d Linux modules)'
          % (dist, count, len(manifests[0]['files']),
             len(manifests[1]['files'])))
    return dist


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default=DIST)
    args = parser.parse_args()
    build(args.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
