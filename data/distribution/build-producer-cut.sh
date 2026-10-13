#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 3 || ! $2 =~ ^[a-f0-9]{64}$ || -e $3 ]]; then
  printf 'usage: build-producer-cut.sh FIXED-SOURCE-TAR SHA256 FRESH-DIRECTORY\n' >&2
  exit 2
fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
. "$here/../bootstrap/environment.sh"
archive=$(realpath -e -- "$1")
mkdir -- "$3"
destination=$(realpath -e -- "$3")
cp --reflink=auto -- "$archive" "$destination/source.tar"
printf '%s  %s\n' "$2" "$destination/source.tar" | sha256sum -c -
# These mounts belong to the isolated build guest/private mount namespace.
# They preserve filesystem permissions and prevent in-place executable drift.
mount --bind "$destination/source.tar" "$destination/source.tar"
mount -o remount,bind,ro "$destination/source.tar"
for directory in /usr /lib /bin /sbin; do
  mount --bind "$directory" "$directory"
  mount -o remount,bind,ro "$directory"
done
export LANG=C TZ=UTC
for replica in a b; do
  mkdir "$destination/$replica"
  tar -xf "$destination/source.tar" -C "$destination/$replica"
  # A clean input archive must not contain any Make output population.
  test -z "$(find "$destination/$replica/src/v2" -type d -name build -print -quit)"
  make -C "$destination/$replica/src/v2" -j4 CC=/usr/bin/gcc AR=/usr/bin/ar CFLAGS=-O2 all \
    >"$destination/make-$replica.log" 2>&1
done
mkdir "$destination/producers"
python3 - "$destination" "$2" "$QM_BOOTSTRAP_ID" <<'PY'
import hashlib,json,pathlib,shutil,subprocess,sys
root=pathlib.Path(sys.argv[1])
def identity(path):
    data=path.read_bytes()
    return {'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
paths={'compiler':'src/v2/postlink-compiler/build/postlink-compiler',
       'verifier':'src/v2/optimized-x86/build/postlink-verify',
       'stage':'src/v2/build/artifact-executable-stage',
       'audit':'src/v2/artifact/build/artifact-measure-root',
       'archive':'src/v2/artifact/build/artifact-normalize-archive'}
producers={}
for role,name in paths.items():
    first,second=identity(root/'a'/name),identity(root/'b'/name)
    if first!=second:raise ValueError('clean producer reproduction differs: '+role)
    target=root/'producers'/role
    shutil.copyfile(root/'a'/name,target);target.chmod(0o555)
    if identity(target)!=first:raise ValueError('producer cut copy differs')
    producers[role]=first
tools=set()
for directory in ['/usr/bin','/usr/sbin','/usr/include','/usr/libexec','/usr/lib','/lib','/bin','/sbin','/usr/share/pkgconfig']:
    for path in pathlib.Path(directory).rglob('*'):
        if path.is_file():tools.add(path.resolve(strict=True))
population={str(path):identity(path) for path in sorted(tools)}
encoded=(json.dumps(population,sort_keys=True,indent=2)+'\n').encode()
(root/'toolchain-files.json').write_bytes(encoded)
record={'format':'fixed-native-producer-cut-v1','sourceArchiveSha256':sys.argv[2],
        'bootstrapIdentity':sys.argv[3],'cleanReplicas':2,'producers':producers,
        'toolchainFilesSha256':hashlib.sha256(encoded).hexdigest(),'toolchainFiles':len(population),
        'conditions':{'CC':'/usr/bin/gcc','AR':'/usr/bin/ar','CFLAGS':'-O2','jobs':4,
        'LANG':'C','LC_ALL':'C','TZ':'UTC','SOURCE_DATE_EPOCH':'0',
        'command':'make -C src/v2 -j4 CC=/usr/bin/gcc AR=/usr/bin/ar CFLAGS=-O2 all'},
        'compilerVersion':subprocess.check_output(['/usr/bin/gcc','--version'],text=True).splitlines()[0],
        'scope':'two clean builds and fixed executable cut; product output binding follows actual execution'}
(root/'producers'/'manifest.json').write_bytes((json.dumps(record,sort_keys=True,indent=2)+'\n').encode())
PY
mount --bind "$destination/producers" "$destination/producers"
mount -o remount,bind,ro "$destination/producers"
printf '%s  %s\n' "$2" "$destination/source.tar" | sha256sum -c -
printf 'producer-cut=%s\n' "$destination/producers"
