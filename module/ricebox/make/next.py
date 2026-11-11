#!/usr/bin/env python3
"""The newest upstream release of every source the root is built from, and its digests; and every pin checked.

    python3 module/ricebox/make/next.py module/ricebox/pins/sources.env

For each component a file pins it reads its makers' own listing (their download directory, release feed or tags),
picks the newest release by the rule written beside it, downloads the archive over HTTPS and takes the digests it
is pinned by (SHA-256, SHA-512 or both). A component with no newer release is downloaded from its pin and checked
against it: a maker that moved a file, or a pin no longer reachable, is said. It prints the table and writes,
in the current folder, NAME.next: the file as it would be with every newer release in it.
Nothing in the tree is changed: a person reads the table and moves the file over (module/ricebox/make/build.sh checks every
archive against it, as before).

Rules beyond "the newest release, not a candidate":
  BusyBox            only a release its makers call stable (1.37 and 1.38 have been called unstable).
  GMP, MPFR, MPC     the versions the newest GCC's contrib/download_prerequisites names: GCC is tested with
                     those, and sources.env takes them from gcc.gnu.org's infrastructure directory.
  OpenSSL            the newest patch release of the long-term-support line pinned (3.5 is supported to 2030).
  Linux              kernel.org's latest stable.
  tzcode             the release of tzdata (the build checks they are the same).
  less               the version its maker recommends (the download page lists betas beside it).
  ncdu               its C line (1.x, its maker's long-term one): 2.x is written in a Zig the build machine has
                     not (2.9 takes 0.14 or 0.15; Alpine 3.24 has 0.16).
  libevent           its stable releases (X.Y.Z-stable); zip, Info-ZIP's last (3.0).
  tldr-pages         the release before the newest: its makers build the newest release's files again with each
                     change to the pages (v2.3's of 2 November 2026), so only an older one's stay the file pinned.
  Rust's and Go's    their crates.io and module-proxy releases: what those name is immutable and checked (crates.io's
                     index holds each crate's digest; Go's checksum database each module's); the newest the
                     builder's Rust or Go (Alpine's, as its index has it) builds, by the version each asks for.
  bash               its release; its makers' patches to it are module/ricebox/packages/bash/ (each checked by its signature
                     when it is taken), and a patch past them is said (bash-X.Y-patches/).
  getconf, iconv     Alpine's musl-utils for the builder's Alpine: its version is the musl it is built with, and a
                     newer one is taken from the head of that Alpine's stable branch of aports.
Runs where every maker's site can be reached (GitHub Actions: .github/workflows/upstream.yml).
"""
import functools
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
from concurrent.futures import ThreadPoolExecutor


def get(url, binary=False):
    """What `url` holds, fetched with curl (a site that turns away scripts by their name answers curl)."""
    r = subprocess.run(['curl', '-fsSL', '--retry', '3', '--retry-delay', '5', '--max-time', '600', url], capture_output=True)
    if r.returncode:
        raise RuntimeError(f'{url}: {r.stderr.decode(errors="replace").strip()}')
    return r.stdout if binary else r.stdout.decode('utf-8', 'replace')


def key(v):
    return [(0, int(p)) if p.isdigit() else (1, p) for p in re.split(r'[._-]|(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)', v) if p]


def newest(url, pattern, skip=r'(rc|alpha|beta|pre)\d*'):
    found = {v for v in re.findall(pattern, get(url)) if not re.search(skip, v)}
    if not found:
        raise RuntimeError(f'no release named at {url}')
    return max(found, key=key)


def github(repo, prefix='v', line='', back=0):
    """The newest release tag of a GitHub repository (its tags, so a release not marked latest is seen too); `back`
    releases before it."""
    tags = re.findall(r'refs/tags/' + re.escape(prefix) + r'(' + re.escape(line) + r'[0-9][0-9.]*)$',
                      get(f'https://github.com/{repo}.git/info/refs?service=git-upload-pack'), re.M)
    if len(set(tags)) <= back:
        raise RuntimeError(f'no tags of {repo}')
    return sorted(set(tags), key=key)[-1 - back]


@functools.lru_cache(maxsize=None)
def alpine(package, repo):
    """The version of an Alpine package the builder installs: its Alpine (module/ricebox/make/build.sh's), the repository's index."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build.sh')) as f:
        release = '.'.join(re.search(r"grep -q '\^(\d+)\\\.(\d+)\\\.' /etc/alpine-release", f.read()).groups())
    index = get(f'https://dl-cdn.alpinelinux.org/alpine/v{release}/{repo}/x86_64/APKINDEX.tar.gz', binary=True)
    with tarfile.open(fileobj=io.BytesIO(index)) as t:
        text = t.extractfile('APKINDEX').read().decode()
    for block in text.split('\n\n'):
        fields = dict(l.split(':', 1) for l in block.splitlines() if ':' in l)
        if fields.get('P') == package:
            return fields['V'].split('-r')[0]
    raise RuntimeError(f'no {package} in Alpine {release} {repo}')


def aports(path):
    """A file of Alpine's musl-utils (aports' main/musl/) as the builder's Alpine has it: (its package's version, the
    file at the head of that Alpine's stable branch)."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build.sh')) as f:
        release = '.'.join(re.search(r"grep -q '\^(\d+)\\\.(\d+)\\\.' /etc/alpine-release", f.read()).groups())
    refs = get('https://git.alpinelinux.org/aports/info/refs?service=git-upload-pack')
    commit = re.search(rf'([0-9a-f]{{40}}) refs/heads/{re.escape(release)}-stable$', refs, re.M).group(1)
    # (Read from Alpine's own git, by its commit: GitLab's raw files answer a script with 418, a page for browsers.)
    return alpine('musl-utils', 'main'), f'https://git.alpinelinux.org/aports/plain/main/musl/{path}?id={commit}'


def crate(name):
    """The newest release of a crate on crates.io the builder's Rust (Alpine's) can build: from its index (not
    yanked, not a pre-release), its rust-version no newer than that Rust."""
    rust = key(alpine('rust', 'main'))
    p = name if len(name) <= 2 else f'3/{name[0]}' if len(name) == 3 else f'{name[:2]}/{name[2:4]}'
    found = [json.loads(l) for l in get(f'https://index.crates.io/{p}/{name}').splitlines() if l.strip()]
    vers = [e['vers'] for e in found if not e.get('yanked') and re.fullmatch(r'\d+\.\d+\.\d+', e['vers'])
            and key(e.get('rust_version') or '0') <= rust]
    if not vers:
        raise RuntimeError(f'no release of {name} on crates.io that Rust {alpine("rust", "main")} builds')
    return max(vers, key=key)


def gomod(path):
    """The newest release of a Go module, as Go's module proxy has it (without its v), whose go.mod asks for no
    newer Go than the builder's (Alpine's; it builds with GOTOOLCHAIN=local, so takes no other)."""
    go = key(alpine('go', 'community'))
    vers = [v for v in get(f'https://proxy.golang.org/{path}/@v/list').split() if re.fullmatch(r'v\d+\.\d+\.\d+', v)]
    for v in sorted(vers, key=key, reverse=True):
        wants = re.search(r'^go (\S+)', get(f'https://proxy.golang.org/{path}/@v/{v}.mod'), re.M)
        if key(wants.group(1) if wants else '0') <= go:
            return v.removeprefix('v')
    raise RuntimeError(f'no release of {path} that Go {alpine("go", "community")} builds')


def sqlite():
    """sqlite's newest release and where it is (its download page names the year's folder it is in)."""
    at = re.findall(r'(\d{4})/sqlite-autoconf-(\d{7})\.tar\.gz', get('https://sqlite.org/download.html'))
    year, v = max(at, key=lambda a: a[1])
    return v, f'https://sqlite.org/{year}/sqlite-autoconf-{v}.tar.gz'


def busybox():
    stable = re.findall(r'BusyBox (\d+\.\d+\.\d+) \(stable\)', get('https://busybox.net/'))
    return max(stable, key=key)


@functools.lru_cache(maxsize=None)
def gcc_prerequisites():
    """The newest GCC's contrib/download_prerequisites, asked for once (its server limits how often it is asked)."""
    gcc = newest('https://gcc.gnu.org/ftp/gcc/releases/', r'gcc-(\d+\.\d+\.\d+)/')
    return get(f'https://gcc.gnu.org/git/?p=gcc.git;a=blob_plain;f=contrib/download_prerequisites;hb=refs/tags/releases/gcc-{gcc}')


def gcc_prerequisite(name):
    return re.search(name + r"='" + name + r"-([0-9.]+)\.tar", gcc_prerequisites()).group(1)


def util_linux():
    line = newest('https://mirrors.edge.kernel.org/pub/linux/utils/util-linux/', r'v(\d+\.\d+)/')
    return newest(f'https://mirrors.edge.kernel.org/pub/linux/utils/util-linux/v{line}/', r'util-linux-(\d+\.\d+(?:\.\d+)?)\.tar\.xz')


# How the newest release of each is found.
NEWEST = {
    'LINUX': lambda: json.loads(get('https://www.kernel.org/releases.json'))['latest_stable']['version'],
    'BUSYBOX': busybox,
    'UTIL_LINUX': util_linux,
    'IPROUTE2': lambda: newest('https://mirrors.edge.kernel.org/pub/linux/utils/net/iproute2/', r'iproute2-(\d+\.\d+\.\d+)\.tar\.xz'),
    'MAKE': lambda: newest('https://ftp.gnu.org/gnu/make/', r'make-(\d+\.\d+(?:\.\d+)?)\.tar\.gz'),
    'MUSL': lambda: newest('https://musl.libc.org/releases.html', r'musl-(\d+\.\d+\.\d+)\.tar\.gz'),
    'MUSL_GETCONF': lambda: aports('getconf.c'),
    'MUSL_ICONV': lambda: aports('iconv.c'),
    'FORTIFY_HEADERS': lambda: github('jvoisin/fortify-headers', prefix=''),
    # binutils itself; gold, which every build here leaves out, was a separate archive (binutils-with-gold) until 2.47.
    'BINUTILS': lambda: newest('https://ftp.gnu.org/gnu/binutils/', r'binutils-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'GCC': lambda: newest('https://gcc.gnu.org/ftp/gcc/releases/', r'gcc-(\d+\.\d+\.\d+)/'),
    'GMP': lambda: gcc_prerequisite('gmp'),
    'MPFR': lambda: gcc_prerequisite('mpfr'),
    'MPC': lambda: gcc_prerequisite('mpc'),
    'ZLIB': lambda: newest('https://zlib.net/', r'zlib-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'OPENSSL': lambda: github('openssl/openssl', 'openssl-', '3.5.'),
    'CURL': lambda: newest('https://curl.se/download/', r'curl-(\d+\.\d+\.\d+)\.tar\.xz'),
    'GIT': lambda: newest('https://www.kernel.org/pub/software/scm/git/', r'git-(\d+\.\d+\.\d+)\.tar\.xz'),
    'TAR': lambda: newest('https://ftp.gnu.org/gnu/tar/', r'tar-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'COREUTILS': lambda: newest('https://ftp.gnu.org/gnu/coreutils/', r'coreutils-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'GZIP': lambda: newest('https://ftp.gnu.org/gnu/gzip/', r'gzip-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'XZ': lambda: github('tukaani-project/xz'),
    'BZIP2': lambda: newest('https://sourceware.org/pub/bzip2/', r'bzip2-(\d+\.\d+\.\d+)\.tar\.gz'),
    'PATCH': lambda: newest('https://ftp.gnu.org/gnu/patch/', r'patch-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'GREP': lambda: newest('https://ftp.gnu.org/gnu/grep/', r'grep-(\d+\.\d+(?:\.\d+)?)\.tar\.xz'),
    'LESS': lambda: newest('https://www.greenwoodsoftware.com/less/download.html', r'RECOMMENDED</strong> version (\d+)'),
    'GNU_BASH': lambda: newest('https://ftp.gnu.org/gnu/bash/', r'bash-(\d+\.\d+)\.tar\.gz'),
    'ONIGURUMA': lambda: github('kkos/oniguruma', 'v'),
    'JQ': lambda: github('jqlang/jq', 'jq-'),
    'STRACE': lambda: github('strace/strace', 'v'),
    'FILE': lambda: newest('https://astron.com/pub/file/', r'file-(\d+\.\d+)\.tar\.gz'),
    'PKGCONF': lambda: newest('https://distfiles.ariadne.space/pkgconf/', r'pkgconf-(\d+\.\d+\.\d+)\.tar\.xz'),
    'OPENSSH': lambda: newest('https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/', r'openssh-(\d+\.\d+p\d+)\.tar\.gz'),
    'CA_CERTIFICATES': lambda: newest('https://curl.se/docs/caextract.html', r'cacert-(\d{4}-\d{2}-\d{2})\.pem'),
    'APK_TOOLS': lambda: max(re.findall(r'"name":"v(\d+\.\d+\.\d+)"', get(
        'https://gitlab.alpinelinux.org/api/v4/projects/alpine%2Fapk-tools/repository/tags?per_page=100')), key=key),
    'LIBCAP': lambda: newest('https://www.kernel.org/pub/linux/libs/security/linux-privs/libcap2/', r'libcap-(\d+\.\d+)\.tar\.xz'),
    'ACL': lambda: newest('https://download-mirror.savannah.gnu.org/releases/acl/', r'acl-(\d+\.\d+\.\d+)\.tar\.xz'),
    'ATTR': lambda: newest('https://download-mirror.savannah.gnu.org/releases/attr/', r'attr-(\d+\.\d+\.\d+)\.tar\.xz'),
    'ZSTD': lambda: github('facebook/zstd'),
    'NCURSES': lambda: newest('https://ftp.gnu.org/gnu/ncurses/', r'ncurses-(\d+\.\d+)\.tar\.gz'),
    'NANO': lambda: newest('https://ftp.gnu.org/gnu/nano/', r'nano-(\d+\.\d+)\.tar\.xz'),
    'TZDATA': lambda: newest('https://ftp.iana.org/tz/releases/', r'tzdata(\d{4}[a-z])\.tar\.gz'),
    'TZCODE': lambda: newest('https://ftp.iana.org/tz/releases/', r'tzcode(\d{4}[a-z])\.tar\.gz'),
    'RIPGREP': lambda: crate('ripgrep'),
    'FD': lambda: crate('fd-find'),
    'BAT': lambda: crate('bat'),
    'DELTA': lambda: crate('git-delta'),
    'JUST': lambda: crate('just'),
    'HYPERFINE': lambda: crate('hyperfine'),
    'TEALDEER': lambda: crate('tealdeer'),
    'FZF': lambda: gomod('github.com/junegunn/fzf'),
    'DIRENV': lambda: gomod('github.com/direnv/direnv/v2'),
    'LAZYGIT': lambda: gomod('github.com/jesseduffield/lazygit'),
    'YQ': lambda: gomod('github.com/mikefarah/yq/v4'),
    'AGE': lambda: gomod('filippo.io/age'),
    'GIT_LFS': lambda: gomod('github.com/git-lfs/git-lfs/v3'),
    'LIBEVENT': lambda: newest('https://libevent.org/', r'libevent-(\d+\.\d+\.\d+)-stable\.tar\.gz'),
    'TMUX': lambda: github('tmux/tmux', ''),
    'NCDU': lambda: newest('https://dev.yorhel.nl/download/', r'ncdu-(1\.\d+)\.tar\.gz'),
    'RSYNC': lambda: newest('https://download.samba.org/pub/rsync/src/', r'rsync-(\d+\.\d+\.\d+)\.tar\.gz'),
    'ENTR': lambda: newest('https://eradman.com/entrproject/', r'entr-(\d+\.\d+)\.tar\.gz'),
    'READLINE': lambda: newest('https://ftp.gnu.org/gnu/readline/', r'readline-(\d+\.\d+)\.tar\.gz'),
    'SQLITE': sqlite,
    'PV': lambda: newest('https://www.ivarch.com/programs/pv.shtml', r'pv-(\d+\.\d+\.\d+)\.tar\.gz'),
    'HTOP': lambda: github('htop-dev/htop', ''),
    'ZIP': lambda: '3.0',
    'WGET': lambda: newest('https://ftp.gnu.org/gnu/wget/', r'wget-(\d+\.\d+(?:\.\d+)?)\.tar\.gz'),
    'MOREUTILS': lambda: newest('https://deb.debian.org/debian/pool/main/m/moreutils/', r'moreutils_(\d+\.\d+)\.orig\.tar\.xz'),
    'TLDR_PAGES_EN': lambda: github('tldr-pages/tldr', 'v', back=1),
    'TLDR_PAGES_JA': lambda: github('tldr-pages/tldr', 'v', back=1),
}


def moved_url(url, old, new):
    """The URL of the newer release: the version where it stood, and the folders named by part of it."""
    url = url.replace(old, new)
    o, n = old.split('.'), new.split('.')
    if len(o) >= 2 and len(n) >= 2:
        # A folder named by the series (util-linux v2.42/, the kernel's v7.x/).
        url = url.replace(f'/v{o[0]}.{o[1]}/', f'/v{n[0]}.{n[1]}/').replace(f'/v{o[0]}.x/', f'/v{n[0]}.x/')
    return url


def digests(data, pins, name):
    return {a: hashlib.new(a.lower(), data).hexdigest() for a in ('SHA256', 'SHA512') if f'{name}_{a}' in pins}


def one_file(path):
    """The table's rows for the file at `path`, and the file as it would be."""
    lines = open(path).read().splitlines()
    pins = dict(l.split('=', 1) for l in lines if '=' in l and not l.startswith('#'))
    names = [k[:-len('_URL')] for k in pins if k.endswith('_URL')]

    def look(name):
        try:
            return name, NEWEST[name](), None
        except Exception as e:  # said in the table; the pin stays as it is
            return name, None, f'{type(e).__name__}: {e}'

    def take(found):
        name, latest, why = found
        at = None
        if isinstance(latest, tuple):  # a rule that knows where the release is, not only its version
            latest, at = latest
        was = pins.get(f'{name}_VERSION') or pins.get(f'{name}_DATE')
        newer = latest and not why and latest != was
        url = (at or moved_url(pins[f'{name}_URL'], was, latest)) if newer else pins[f'{name}_URL']
        try:
            data = get(url, binary=True)
        except Exception as e:
            return name, was, latest or '?', f'{url}: {e}', {}
        got = digests(data, pins, name)
        if not newer:
            bad = [a for a, d in got.items() if pins[f'{name}_{a}'] != d]
            note = f'PIN BROKEN: {url} is not its {", ".join(bad)}' if bad else 'pin checked'
            return name, was, latest or '?', (why + '; ' if why else '') + note, {}
        field = f'{name}_VERSION' if f'{name}_VERSION' in pins else f'{name}_DATE'
        changed = {field: latest, f'{name}_URL': url, **{f'{name}_{a}': d for a, d in got.items()}}
        return name, was, latest, f'{len(data)} bytes', changed

    with ThreadPoolExecutor(12) as pool:
        rows = list(pool.map(take, pool.map(look, names)))
    changed = {k: v for *_, c in rows for k, v in c.items()}
    out = path.rsplit('/', 1)[-1] + '.next'
    with open(out, 'w') as f:
        for l in lines:
            k = l.split('=', 1)[0]
            f.write(f'{k}={changed[k]}\n' if k in changed else l + '\n')
    return [r[:4] for r in rows], out


def bash_patches(path):
    """bash's makers' patches to the release pinned: how many module/ricebox/packages/bash/ holds, and how many they publish."""
    pins = dict(l.split('=', 1) for l in open(path).read().splitlines() if '=' in l and not l.startswith('#'))
    release = pins.get('GNU_BASH_VERSION')
    if not release:
        return []
    tag = 'bash' + release.replace('.', '')
    held = os.path.join(os.path.dirname(os.path.abspath(path)), '..', 'packages', 'bash')
    have = len([f for f in os.listdir(held) if re.fullmatch(tag + r'-\d{3}', f)]) if os.path.isdir(held) else 0
    try:
        out = len(set(re.findall(tag + r'-(\d{3})(?![.\d])', get(f'https://ftp.gnu.org/gnu/bash/bash-{release}-patches/'))))
        note = 'patches held' if out == have else f'{out - have} more of its makers\' patches: take each, checked by its .sig'
    except Exception as e:
        out, note = '?', f'{type(e).__name__}: {e}'
    return [('GNU_BASH patches', str(have), str(out), note)]


def main():
    rows, outs = [], []
    for path in sys.argv[1:]:
        r, out = one_file(path)
        rows += r + bash_patches(path)
        outs.append(out)
    width = max(len(r[0]) for r in rows)
    print(f'{"":{width}}  pinned        newest        ')
    for name, was, latest, note in rows:
        mark = '  ' if was == latest else '->'
        print(f'{name:{width}}  {was:12}  {mark} {latest:12}  {note}')
    newer = sum(1 for r in rows if r[1] != r[2] and r[2] != '?')
    broken = sum(1 for r in rows if 'PIN BROKEN' in r[3])
    print(f'\n{newer} newer, {broken} pins broken; {", ".join(outs)} hold the newer ones')
    sys.exit(1 if broken else 0)


if __name__ == '__main__':
    main()
