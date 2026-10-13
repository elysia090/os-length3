#!/usr/bin/env python3
"""Package pinned Web code and exactly five qualified immutable role objects."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

REPO = Path(__file__).resolve().parents[2]
ROLES = ('kernel', 'initramfs', 'system', 'vm', 'compiler')

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        while b := f.read(1048576):
            h.update(b)
    return h.hexdigest()

def main():
    if len(sys.argv) != 5:
        raise SystemExit('usage: prepare-web-release.py PROJECTION EXPECTED-RELEASE-SHA256 WEB-SOURCE-COMMIT NEW-STAGE')
    projection = Path(sys.argv[1]).resolve()
    pin, commit = sys.argv[2:4]
    stage = Path(sys.argv[4]).resolve()
    import re
    if not re.fullmatch('[a-f0-9]{64}', pin) or not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('explicit fixed projection and Web source identities required')
    if stage.exists():
        raise ValueError('refusing to replace a Web release stage')
    raw = (projection / 'release.json').read_bytes()
    if len(raw) > 1048576 or hashlib.sha256(raw).hexdigest() != pin:
        raise ValueError('qualified descriptor differs')
    release = json.loads(raw)
    if release['format'] != 'linux-release-v1' or release['cpu'] != 'x86-64-v2' or set(release['objects']) != set(ROLES):
        raise ValueError('exact five-role Linux projection required')
    for role in ROLES:
        row = release['objects'][role]
        if row['file'] != role + '.object' or row['chunkBytes'] != 65536:
            raise ValueError('qualified role coordinate differs')
        file = projection / row['file']
        if file.stat().st_size != row['bytes'] or digest(file) != row['sha256']:
            raise ValueError('qualified role differs: ' + role)
        with file.open('rb') as f:
            chunks = []
            while block := f.read(65536):
                chunks.append(hashlib.sha256(block).hexdigest())
        if chunks != row['chunks']:
            raise ValueError('qualified chunk population differs: ' + role)
    stage.mkdir()
    bundle = stage / 'bundle'
    bundle.mkdir()
    tree = subprocess.check_output(['git', 'ls-tree', '-rz', commit, '--', 'src/v2/web'], cwd=REPO)
    for entry in tree.split(b'\0'):
        if not entry:
            continue
        metadata, name = entry.decode().split('\t', 1)
        mode, kind, blob = metadata.split()
        if kind != 'blob' or mode not in ('100644', '100755') or not name.startswith('src/v2/web/'):
            raise ValueError('plain tracked Web code required')
        relative = name.removeprefix('src/v2/')
        file = bundle / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(subprocess.check_output(['git', 'cat-file', 'blob', blob], cwd=REPO))
    artifact = bundle / 'artifact/release'
    artifact.mkdir(parents=True)
    for name in ['release.json', *(role + '.object' for role in ROLES)]:
        shutil.copyfile(projection / name, artifact / name)
    shutil.copyfile(REPO / 'data/distribution/serve-web-release.mjs', bundle / 'serve.mjs')
    shutil.copyfile(REPO / 'artifact/web/README.md', bundle / 'README.md')
    shutil.copyfile(REPO / 'src/v2/docs/DELIVERY.md', bundle / 'DELIVERY.md')
    files = {p.relative_to(bundle).as_posix(): {'bytes': p.stat().st_size, 'sha256': digest(p)}
             for p in sorted(bundle.rglob('*')) if p.is_file()}
    if files['artifact/release/release.json']['sha256'] != pin:
        raise ValueError('copied descriptor differs')
    for role in ROLES:
        row = release['objects'][role]
        if files['artifact/release/' + row['file']] != {'bytes': row['bytes'], 'sha256': row['sha256']}:
            raise ValueError('copied qualified role differs: ' + role)
    manifest = {'format': 'web-distribution-bundle-v1', 'version': '0.1.0', 'channel': 'web-preview',
        'releaseSha256': pin, 'webSourceCommit': commit, 'nativeNamespace': '13a2b910a90971ed2e4f8d9f1ab3a1edeb1e3fdfaffd1978bb69908ea1f1c8fd',
        'guestRamBytes': release['ramBytes'], 'workspaceBytes': 33554432, 'workspaceRecovery': 'approved-browser-origin-profile',
        'cloudStorageConfigured': False, 'networkGrantIncluded': False, 'files': files,
        'qualification': {'sameNativeWebOfflineWorkload': 'pass', 'currentStorageFaultsAndQuota': 'pass',
            'webThreeSecondColdPrompt': 'fail', 'editorRunFrontend': 'not-connected', 'fullNewRootNetwork': 'not-tested'}}
    (bundle / 'web-bundle.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    name = f'os-length3-linux-0.1.0-web-{pin}.zip'
    with zipfile.ZipFile(stage / name, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for p in sorted(bundle.rglob('*')):
            if not p.is_file():
                continue
            item = zipfile.ZipInfo(p.relative_to(bundle).as_posix(), (1980, 1, 1, 0, 0, 0))
            item.create_system = 3
            item.external_attr = (0o100644 << 16)
            item.compress_type = zipfile.ZIP_DEFLATED
            with p.open('rb') as source, archive.open(item, 'w') as target:
                shutil.copyfileobj(source, target, length=1048576)
    shutil.copyfile(bundle / 'web-bundle.json', stage / 'WEB-MANIFEST.json')
    shutil.copyfile(bundle / 'README.md', stage / 'WEB-README.md')
    (stage / 'WEB-SHA256SUMS').write_text(''.join(digest(stage / n) + '  ' + n + '\n'
        for n in (name, 'WEB-MANIFEST.json', 'WEB-README.md')), encoding='utf-8', newline='\n')
    print(json.dumps({'zip': name, 'bytes': (stage / name).stat().st_size, 'sha256': digest(stage / name),
                      'files': len(files) + 1, 'releaseSha256': pin, 'webSourceCommit': commit}))

if __name__ == '__main__':
    main()
