#!/usr/bin/env python3
"""Stage the already qualified native bytes; never sign, rebuild or publish."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

REPO = Path(__file__).resolve().parents[2]
EVIDENCE = REPO / 'releases/native/evidence'
# The qualified 0.1.0 producer source is a fixed archive cut before the
# repository's top level was renamed: names inside it, and the overrides laid
# over it, keep that tree's layout (data/, data/distribution/, src/v2/).
OVERRIDES = {
    'boot': 'data/distribution/boot/boot', 'console': 'data/distribution/boot/console',
    'package-recipes.sh': 'data/distribution/package-recipes.sh', 'build.sh': 'data/build.sh',
    'busybox.fragment': 'data/config/busybox.fragment', 'busybox.config': 'data/config/busybox-1.36.1.config',
    'early-init': 'data/initramfs/init', 'measure-namespace.c': 'src/v2/artifact/cli/measure-namespace.c',
    **{name: 'data/distribution/' + name for name in (
        'prepare-package-payload.sh', 'normalize-initramfs.py', 'check-normalize-initramfs.py',
        'producer-execution.py', 'producer-run.sh', 'build-producer-cut.sh', 'optimize-payload.sh', 'check-postlink-toolchain.sh')},
}

def identity(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with path.open('rb') as stream:
        while block := stream.read(1048576):
            h.update(block)
    return h.hexdigest()

def info(path):
    return {'bytes': path.stat().st_size, 'sha256': identity(path)}

def add(archive, path, name):
    def normalize(member):
        member.uid = member.gid = member.mtime = 0
        member.uname = member.gname = ''
        member.pax_headers = {}
        return member
    archive.add(path, arcname=name, recursive=False, filter=normalize)

def locks(raw):
    result = {}
    for line in raw.decode().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=([^\s]+)', line)
        if not match or match[1] in result:
            raise ValueError('invalid frozen source lock')
        result[match[1]] = match[2]
    return result

def main():
    if len(sys.argv) != 5:
        raise SystemExit('usage: prepare-qualified-native-release.py ARTIFACTS PRODUCER-SOURCE.tar APPLIED-OVERRIDES OUTPUT-DIRECTORY')
    work, source, overrides, out = (Path(x).resolve() for x in sys.argv[1:])
    if out.exists():
        raise ValueError('release staging directory already exists')
    qualification = json.loads((EVIDENCE / '2026-10-13-fixed-producer-and-provider-root.json').read_text())
    expected_source = qualification['nativeProducerCut']['sourceArchiveSha256']
    if identity(source) != expected_source:
        raise ValueError('qualified producer source differs')
    receipt = json.loads((work / 'native-acceptance.json').read_text())
    if set(receipt['results'].values()) != {'passed'}:
        raise ValueError('native extracted-bundle acceptance incomplete')
    for field, name in [('bundle.tar.zst', 'native-bundle.tar.zst'), ('release.inputs', 'release.inputs')]:
        if info(work / name) != receipt['inputs'][field]:
            raise ValueError('extracted runtime receipt differs from product')
    if info(work / 'native-final-reproduced.tar.zst') != info(work / 'native-bundle.tar.zst'):
        raise ValueError('reproducible bundle pair differs')
    values = dict(line.split('=', 1) for line in (work / 'release.inputs').read_text().splitlines())
    with tarfile.open(source) as archive:
        for member in archive.getmembers():
            if member.name.startswith('/') or '..' in Path(member.name).parts or any(x in member.name.lower() for x in ('private.pem', 'test-signing', '.git/', 'qualification-network')):
                raise ValueError('unsafe or secret source member')
        source_raw = archive.extractfile('data/sources.env').read()
        if hashlib.sha256(source_raw).hexdigest() != values['sources.sha256']:
            raise ValueError('native source lock differs')
        declarations = locks(source_raw) | locks(archive.extractfile('data/bootstrap/tzcode.env').read())
    from urllib.parse import urlparse
    upstream = {}
    for key, url in declarations.items():
        if not key.endswith('_URL'):
            continue
        name = Path(urlparse(url).path).name
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name):
            raise ValueError('unsafe upstream filename')
        path = REPO / 'distribution/upstream' / name
        checked = False
        for algorithm in ('sha256', 'sha512'):
            expected = declarations.get(key[:-4] + '_' + algorithm.upper())
            if expected:
                if identity(path, algorithm) != expected:
                    raise ValueError('upstream archive differs: ' + name)
                checked = True
        if not checked:
            raise ValueError('unlocked source: ' + name)
        upstream[name] = path
    # Only the named public PEM is read from the product; no private material.
    tar = str(Path(os.environ['SystemRoot']) / 'System32/tar.exe') if os.name == 'nt' else 'tar'
    public = subprocess.run([tar, '-xOf', str(work / 'native-bundle.tar.zst'), 'root/etc/apk/keys/release.public.pem'], check=True, capture_output=True).stdout
    if b'PRIVATE KEY' in public or hashlib.sha256(public).hexdigest() != values['package.public-key.sha256']:
        raise ValueError('installed package public key differs')
    out.mkdir()
    bundle_name = f"os-length3-linux-0.1.0-x86_64-{values['package.publication.identity']}.tar.zst"
    shutil.copyfile(work / 'native-bundle.tar.zst', out / bundle_name)
    (out / 'package-public.pem').write_bytes(public)
    (out / 'release.inputs').write_bytes((work / 'release.inputs').read_bytes())
    overlay_rows = []
    for name, target in sorted(OVERRIDES.items()):
        overlay_rows.append({'path': target, **info(overrides / name)})
    source_name = 'os-length3-linux-0.1.0-sources.tar'
    source_notes = '\n'.join([
        'format=qualified-native-release-sources-v1',
        'producer-source.sha256=' + expected_source,
        'The producer-source.tar is the exact fixed clean compiler input, including decoder submodules.',
        'Build the qualified producers from this archive first with the recorded toolchain/conditions.',
        'publication-overrides/ contains the actual files applied to the native build driver tree.',
        'Copy these over a separate extracted producer-source tree to reconstruct the root-build inputs.',
        'data/upstream/ contains the original pinned archives; their license notices remain authoritative.',
        'qualified-producer/ records tool binaries, flags and actual execution, not an independent semantic proof.',
        'No signing private key, workspace key, gateway credential or build disk is included.',
        'Supply your own APK signing authority to rebuild; its key changes signed package/root/archive identities.',
        'The recorded bootstrap/compiler population must be provisioned from the recipe locks separately.',
        'Cross-host or freshly signed hash-identical reproduction is not claimed.', '',
    ])
    (out / 'SOURCE-INPUTS.txt').write_text(source_notes, encoding='utf-8', newline='\n')
    with tarfile.open(out / source_name, 'w', format=tarfile.PAX_FORMAT) as archive:
        add(archive, source, 'producer-source.tar')
        for name, target in sorted(OVERRIDES.items()):
            add(archive, overrides / name, 'publication-overrides/' + target)
        for name, path in sorted(upstream.items()):
            add(archive, path, 'data/upstream/' + name)
        for name in ('producer-cut.json', 'producer-execution.jsonl', 'producer-toolchain.json'):
            add(archive, work / name, 'qualified-producer/' + name)
        add(archive, out / 'SOURCE-INPUTS.txt', 'SOURCE-INPUTS.txt')
    evidence_name = 'os-length3-linux-0.1.0-evidence.tar'
    with tarfile.open(out / evidence_name, 'w', format=tarfile.PAX_FORMAT) as archive:
        for name in ('native-acceptance.json', 'producer-cut.json', 'producer-execution.jsonl', 'producer-toolchain.json', 'root-namespace.identity'):
            add(archive, work / name, name)
        for name in ('2026-10-13-fixed-producer-and-provider-root.json', '2026-10-13-fixed-root-common-acceptance.json', '2026-10-13-busybox-runtime-counterexample.json', '2026-10-13-release-qualification.md'):
            add(archive, EVIDENCE / name, name)
    for local, name in [(REPO / 'releases/native/RELEASE-0.1.0.md', 'README.md'), (REPO / 'compiler/docs/DELIVERY.md', 'DELIVERY.md')]:
        shutil.copyfile(local, out / name)
    manifest = {
        'format': 'native-release-publication-v1', 'version': '0.1.0', 'channel': 'stable-native',
        'releaseTag': 'os-length3-linux-v0.1.0',
        'nativePackagePublication': values['package.publication.identity'],
        'nativeNamespace': (work / 'root-namespace.identity').read_text().strip(),
        'webQualificationDescriptor': qualification['candidate'],
        'publisherBootstrap': {'kind': 'authenticated-github-release', 'repository': 'elysia090/libqm-prototype',
            'detachedSignature': False, 'policy': 'Approve this publisher/channel independently; retain the exact version and asset digests before using any mirror.'},
        'packageKey': {'sha256': values['package.public-key.sha256'], 'file': 'package-public.pem',
            'status': 'unchanged local APK signing key authenticated as installed content by the external archive digest; no production repository-key adoption or rotation'},
        'producerSource': {'sha256': expected_source, 'bytes': source.stat().st_size},
        'publicationOverrides': overlay_rows, 'upstreamArchiveCount': len(upstream),
        'qualification': {'nativeRuntimeDevelopmentHttps': 'pass', 'pairedNativeWebOffline': 'pass',
            'completeSemanticEquivalenceChecker': 'not-implemented', 'canonicalReleaseWord75MB': 'not-tested',
            'webThreeSecondColdPrompt': 'fail', 'webReleaseChannel': 'preview',
            'scope': 'operator-approved initial native bundle publication; historical formal-product gates remain separately reported'},
        'assets': {name: info(out / name) for name in (bundle_name, source_name, evidence_name, 'package-public.pem', 'release.inputs', 'SOURCE-INPUTS.txt', 'README.md', 'DELIVERY.md')},
    }
    (out / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    (out / 'SHA256SUMS').write_text(''.join(identity(out / name) + '  ' + name + '\n' for name in sorted([*manifest['assets'], 'release-manifest.json'])), encoding='utf-8', newline='\n')
    print(json.dumps({'staged': str(out), 'bundle': manifest['assets'][bundle_name], 'sources': manifest['assets'][source_name], 'upstream': len(upstream)}))

if __name__ == '__main__':
    main()
