#!/usr/bin/env python3
"""The newest upstream release of every source sources.env pins, and its digests.

    python3 distribution/sources-next.py distribution/sources.env [OUT]

For each component it reads its makers' own listing (their download directory, release feed or tags), picks
the newest release by the rule written beside it, downloads the archive over HTTPS and takes the digests
sources.env pins it by (SHA-256, SHA-512 or both). It prints the table (what is pinned, what is newest) and
writes OUT (default: sources.next.env), sources.env as it would be with every newer release in it. Nothing is
changed in the tree: a person reads the table, then moves OUT over sources.env (the builders check every
archive against it, as before).

Rules beyond "the newest release, not a candidate":
  BusyBox            only a release its makers call stable (1.37 and 1.38 have been called unstable).
  GMP, MPFR, MPC,    the versions the newest GCC's contrib/download_prerequisites names: GCC is tested with
  gettext            those, and sources.env takes them from gcc.gnu.org's infrastructure directory.
  OpenSSL            the newest patch release of the long-term-support line pinned (3.5 is supported to 2030).
  Linux              kernel.org's latest stable.
Runs where every maker's site can be reached (GitHub Actions: .github/workflows/sources-next.yml).
"""
import hashlib
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

AGENT = 'os-length3-sources-next (+https://github.com/elysia090/os-length3)'


def get(url, binary=False):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': AGENT}), timeout=120) as r:
        data = r.read()
    return data if binary else data.decode('utf-8', 'replace')


def key(v):
    return [(0, int(p)) if p.isdigit() else (1, p) for p in re.split(r'[._-]|(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)', v) if p]


def newest(url, pattern, skip=r'(rc|alpha|beta|pre)\d*'):
    found = {v for v in re.findall(pattern, get(url)) if not re.search(skip, v)}
    if not found:
        raise RuntimeError(f'no release named at {url}')
    return max(found, key=key)


def github(repo, prefix='v', line=''):
    """The newest release tag of a GitHub repository (its tags, so a release not marked latest is seen too)."""
    tags = re.findall(r'refs/tags/' + re.escape(prefix) + r'(' + re.escape(line) + r'[0-9][0-9.]*)$',
                      get(f'https://github.com/{repo}.git/info/refs?service=git-upload-pack'), re.M)
    if not tags:
        raise RuntimeError(f'no tags of {repo}')
    return max(tags, key=key)


def busybox():
    stable = re.findall(r'BusyBox (\d+\.\d+\.\d+) \(stable\)', get('https://busybox.net/'))
    return max(stable, key=key)


def gcc_prerequisite(name):
    gcc = newest('https://gcc.gnu.org/ftp/gcc/releases/', r'gcc-(\d+\.\d+\.\d+)/')
    text = get(f'https://gcc.gnu.org/git/?p=gcc.git;a=blob_plain;f=contrib/download_prerequisites;hb=refs/tags/releases/gcc-{gcc}')
    return re.search(name + r"='" + name + r"-([0-9.]+)\.tar", text).group(1)


def util_linux():
    line = newest('https://mirrors.edge.kernel.org/pub/linux/utils/util-linux/', r'v(\d+\.\d+)/')
    return newest(f'https://mirrors.edge.kernel.org/pub/linux/utils/util-linux/v{line}/', r'util-linux-(\d+\.\d+(?:\.\d+)?)\.tar\.xz')


# How the newest release of each is found.
NEWEST = {
    'LINUX': lambda: json.loads(get('https://www.kernel.org/releases.json'))['latest_stable']['version'],
    'BUSYBOX': busybox,
    'SKALIBS': lambda: newest('https://skarnet.org/software/skalibs/', r'skalibs-(\d+\.\d+\.\d+\.\d+)\.tar\.gz'),
    'EXECLINE': lambda: newest('https://skarnet.org/software/execline/', r'execline-(\d+\.\d+\.\d+\.\d+)\.tar\.gz'),
    'S6': lambda: newest('https://skarnet.org/software/s6/', r'"s6-(\d+\.\d+\.\d+\.\d+)\.tar\.gz'),
    'S6_RC': lambda: newest('https://skarnet.org/software/s6-rc/', r's6-rc-(\d+\.\d+\.\d+\.\d+)\.tar\.gz'),
    'MDEVD': lambda: newest('https://skarnet.org/software/mdevd/', r'mdevd-(\d+\.\d+\.\d+\.\d+)\.tar\.gz'),
    'UTIL_LINUX': util_linux,
    'KMOD': lambda: newest('https://mirrors.edge.kernel.org/pub/linux/utils/kernel/kmod/', r'kmod-(\d+(?:\.\d+)?)\.tar\.xz'),
    'IPROUTE2': lambda: newest('https://mirrors.edge.kernel.org/pub/linux/utils/net/iproute2/', r'iproute2-(\d+\.\d+\.\d+)\.tar\.xz'),
    'MAKE': lambda: newest('https://ftp.gnu.org/gnu/make/', r'make-(\d+\.\d+(?:\.\d+)?)\.tar\.gz'),
    'MUSL': lambda: newest('https://musl.libc.org/releases/', r'musl-(\d+\.\d+\.\d+)\.tar\.gz'),
    'BINUTILS': lambda: newest('https://ftp.gnu.org/gnu/binutils/', r'binutils-with-gold-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'GCC': lambda: newest('https://gcc.gnu.org/ftp/gcc/releases/', r'gcc-(\d+\.\d+\.\d+)/'),
    'GMP': lambda: gcc_prerequisite('gmp'),
    'MPFR': lambda: gcc_prerequisite('mpfr'),
    'MPC': lambda: gcc_prerequisite('mpc'),
    'GETTEXT': lambda: gcc_prerequisite('gettext'),
    'ZLIB': lambda: newest('https://zlib.net/', r'zlib-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'OPENSSL': lambda: github('openssl/openssl', 'openssl-', '3.5.'),
    'CURL': lambda: newest('https://curl.se/download/', r'curl-(\d+\.\d+\.\d+)\.tar\.xz'),
    'GIT': lambda: newest('https://www.kernel.org/pub/software/scm/git/', r'git-(\d+\.\d+\.\d+)\.tar\.xz'),
    'TAR': lambda: newest('https://ftp.gnu.org/gnu/tar/', r'tar-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'GZIP': lambda: newest('https://ftp.gnu.org/gnu/gzip/', r'gzip-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'XZ': lambda: github('tukaani-project/xz'),
    'BZIP2': lambda: newest('https://sourceware.org/pub/bzip2/', r'bzip2-(\d+\.\d+\.\d+)\.tar\.gz'),
    'PATCH': lambda: newest('https://ftp.gnu.org/gnu/patch/', r'patch-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'FILE': lambda: newest('https://astron.com/pub/file/', r'file-(\d+\.\d+)\.tar\.gz'),
    'PKGCONF': lambda: newest('https://distfiles.ariadne.space/pkgconf/', r'pkgconf-(\d+\.\d+\.\d+)\.tar\.xz'),
    'OPENSSH': lambda: newest('https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/', r'openssh-(\d+\.\d+p\d+)\.tar\.gz'),
    'CA_CERTIFICATES': lambda: newest('https://curl.se/ca/', r'cacert-(\d{4}-\d{2}-\d{2})\.pem'),
    'APK_TOOLS': lambda: max(re.findall(r'"name":"v(\d+\.\d+\.\d+)"', get(
        'https://gitlab.alpinelinux.org/api/v4/projects/alpine%2Fapk-tools/repository/tags?per_page=100')), key=key),
    'DHCPCD': lambda: github('NetworkConfiguration/dhcpcd'),
    'LIBMNL': lambda: newest('https://www.netfilter.org/projects/libmnl/files/', r'libmnl-(\d+\.\d+\.\d+)\.tar'),
    'LIBNFTNL': lambda: newest('https://www.netfilter.org/projects/libnftnl/files/', r'libnftnl-(\d+\.\d+\.\d+)\.tar'),
    'NFTABLES': lambda: newest('https://www.netfilter.org/projects/nftables/files/', r'nftables-(\d+\.\d+\.\d+)\.tar'),
    'CHRONY': lambda: newest('https://chrony-project.org/releases/', r'chrony-(\d+\.\d+(?:\.\d+)?)\.tar\.gz'),
    'E2FSPROGS': lambda: newest('https://www.kernel.org/pub/linux/kernel/people/tytso/e2fsprogs/', r'v(\d+\.\d+\.\d+)/'),
    'SHADOW': lambda: github('shadow-maint/shadow', '', '4.'),
    'LIBCAP': lambda: newest('https://www.kernel.org/pub/linux/libs/security/linux-privs/libcap2/', r'libcap-(\d+\.\d+)\.tar\.xz'),
    'ACL': lambda: newest('https://download-mirror.savannah.gnu.org/releases/acl/', r'acl-(\d+\.\d+\.\d+)\.tar\.xz'),
    'ATTR': lambda: newest('https://download-mirror.savannah.gnu.org/releases/attr/', r'attr-(\d+\.\d+\.\d+)\.tar\.xz'),
    'ZSTD': lambda: github('facebook/zstd'),
    'NCURSES': lambda: newest('https://ftp.gnu.org/gnu/ncurses/', r'ncurses-(\d+\.\d+)\.tar\.gz'),
    'NANO': lambda: newest('https://ftp.gnu.org/gnu/nano/', r'nano-(\d+\.\d+)\.tar\.xz'),
    'TZDATA': lambda: newest('https://ftp.iana.org/tz/releases/', r'tzdata(\d{4}[a-z])\.tar\.gz'),
    'LIBXCRYPT': lambda: github('besser82/libxcrypt'),
}


def moved_url(url, old, new):
    """The URL of the newer release: the version where it stood, and the folders named by part of it."""
    url = url.replace(old, new)
    o, n = old.split('.'), new.split('.')
    if len(o) >= 2 and len(n) >= 2:
        # A folder named by the series (util-linux v2.42/, the kernel's v7.x/).
        url = url.replace(f'/v{o[0]}.{o[1]}/', f'/v{n[0]}.{n[1]}/').replace(f'/v{o[0]}.x/', f'/v{n[0]}.x/')
    return url


def main():
    pinned_path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else 'sources.next.env'
    lines = open(pinned_path).read().splitlines()
    pins = dict(l.split('=', 1) for l in lines if '=' in l and not l.startswith('#'))
    names = [k[:-len('_URL')] for k in pins if k.endswith('_URL')]

    def look(name):
        try:
            return name, NEWEST[name](), None
        except Exception as e:  # said in the table; the pin stays as it is
            return name, None, f'{type(e).__name__}: {e}'

    with ThreadPoolExecutor(12) as pool:
        found = list(pool.map(look, names))

    changed = {}
    rows = []
    for name, latest, why in found:
        was = pins.get(f'{name}_VERSION') or pins.get(f'{name}_DATE')
        if why or latest == was:
            rows.append((name, was, latest or '?', why or ''))
            continue
        url = moved_url(pins[f'{name}_URL'], was, latest)
        try:
            data = get(url, binary=True)
        except Exception as e:
            rows.append((name, was, latest, f'{url}: {e}'))
            continue
        field = f'{name}_VERSION' if f'{name}_VERSION' in pins else f'{name}_DATE'
        changed[field] = latest
        changed[f'{name}_URL'] = url
        for algorithm in ('SHA256', 'SHA512'):
            if f'{name}_{algorithm}' in pins:
                changed[f'{name}_{algorithm}'] = hashlib.new(algorithm.lower(), data).hexdigest()
        rows.append((name, was, latest, f'{len(data)} bytes'))

    with open(out, 'w') as f:
        for l in lines:
            k = l.split('=', 1)[0]
            f.write(f'{k}={changed[k]}\n' if k in changed else l + '\n')

    width = max(len(r[0]) for r in rows)
    print(f'{"":{width}}  pinned        newest        ')
    for name, was, latest, note in rows:
        mark = '  ' if was == latest else '->'
        print(f'{name:{width}}  {was:12}  {mark} {latest:12}  {note}')
    print(f'\n{sum(1 for r in rows if r[1] != r[2] and r[2] != "?")} newer; {out} holds them')


if __name__ == '__main__':
    main()
