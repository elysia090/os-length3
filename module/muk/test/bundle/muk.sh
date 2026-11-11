#!/bin/sh
# muk, checked beside runc: the same bundles run by both, and what the box says of itself (probe.c) the same, line
# for line; then what muk refuses, and how it ends.
#
#   sh muk/test/muk.sh [MUK]     MUK: the program (as lib/build.sh makes it; made here when not given)
#
# It makes namespaces, so it is run by root (or by one who may make a user namespace: the bundles that need root are
# then left out). Where runc is not installed, the boxes are still run, and what they say is checked against what a
# box must say.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] || rm -rf "$t"' EXIT; [ -z "${KEEP:-}" ] || echo "# kept: $t"
if [ "$#" -ge 1 ]; then muk=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); else sh "$here/../../../lib/build.sh" "$here/../../src/muk.c" "$t/muk"; muk=$t/muk; fi
sh "$here/../../../lib/build.sh" "$here/probe.c" "$t/probe"
n=0
no() { printf 'not ok %d: %s\n' "$n" "$*" >&2; exit 1; }

# A bundle: its root holds the probe alone; config.json is $1's (a file of this script's making), the root's path put in.
bundle() { # bundle NAME: $t/NAME/config.json from stdin
  mkdir -p "$t/$1/rootfs"
  cp "$t/probe" "$t/$1/rootfs/probe"
  cat > "$t/$1/config.json"
  cp -R "$t/$1" "$t/$1.for-runc"
}
# Both run it; what the box says, sorted (mounts are listed in the order they were made, which is not what is checked).
both() { # both NAME STATUS
  n=$((n + 1))
  st=0; (cd "$t/$1" && "$muk" run -b . "muk$n") > "$t/$1.muk" 2> "$t/$1.muk.err" || st=$?
  [ "$st" = "$2" ] || no "$1: muk ended $st, not $2: $(cat "$t/$1.muk.err")"
  [ -s "$t/$1.muk" ] || no "$1: the box said nothing"
  if command -v runc > /dev/null; then
    # (A copy of the bundle for each: what one makes in a root with no /dev mounted, the other would find there.)
    st=0; (cd "$t/$1.for-runc" && runc --root "$t/state" run -b . "runc$n") > "$t/$1.runc" 2> "$t/$1.runc.err" || st=$?
    [ "$st" = "$2" ] || no "$1: runc ended $st, not $2: $(cat "$t/$1.runc.err")"
    sort "$t/$1.muk" > "$t/$1.a"; sort "$t/$1.runc" > "$t/$1.b"
    cmp -s "$t/$1.a" "$t/$1.b" || { diff "$t/$1.a" "$t/$1.b" | head -20 >&2; no "$1: muk (<) and runc (>) differ"; }
  fi
}
has() { # has NAME LINE: the box under muk said LINE
  n=$((n + 1))
  grep -qxF -- "$2" "$t/$1.muk" || no "$1: the box did not say: $2"
}
begins() { # begins NAME WORDS: the box under muk said a line that begins WORDS
  n=$((n + 1))
  grep -q -- "^$2" "$t/$1.muk" || no "$1: the box said no line beginning: $2"
}
refuses() { # refuses NAME WORDS: muk does not run it, and says WORDS
  n=$((n + 1))
  st=0; (cd "$t/$1" && "$muk" run -b . x) > "$t/$1.out" 2> "$t/$1.err" || st=$?
  [ "$st" = 1 ] || no "$1: muk ended $st, not 1"
  [ ! -s "$t/$1.out" ] || no "$1: something ran"
  grep -qF -- "$2" "$t/$1.err" || no "$1: muk said: $(cat "$t/$1.err")"
}

if [ "$(id -u)" = 0 ]; then
# As root: every kind of namespace but the user's, the mounts a box has, some of /proc hidden and some read-only, a
# root not written to, three capabilities, a limit.
bundle plain <<'JSON'
{"ociVersion": "1.0.2",
 "process": {"terminal": false, "user": {"uid": 0, "gid": 0}, "args": ["/probe", "a b", "é\n"],
  "env": ["PATH=/usr/bin:/bin", "TERM=xterm", "A=\"q\" \\ /"], "cwd": "/",
  "capabilities": {"bounding": ["CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE"], "effective": ["CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE"],
   "permitted": ["CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE"]},
  "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 2048, "soft": 512}], "noNewPrivileges": true},
 "root": {"path": "rootfs", "readonly": true}, "hostname": "box", "domainname": "there",
 "mounts": [
  {"destination": "/proc", "type": "proc", "source": "proc"},
  {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "strictatime", "mode=755", "size=65536k"]},
  {"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"]},
  {"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"]},
  {"destination": "/dev/mqueue", "type": "mqueue", "source": "mqueue", "options": ["nosuid", "noexec", "nodev"]},
  {"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": ["nosuid", "noexec", "nodev", "ro"]}],
 "linux": {"namespaces": [{"type": "pid"}, {"type": "network"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}],
  "maskedPaths": ["/proc/acpi", "/proc/kcore", "/proc/keys", "/proc/timer_list", "/proc/no-such", "/sys/firmware"],
  "readonlyPaths": ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger", "/proc/no-such"]}}
JSON
both plain 0
has plain 'uid 0 gid 0 groups 0 pid 1'
has plain 'host box domain there'
has plain 'arg a b'
has plain 'env A="q" \ /'
has plain 'CapEff:	0000000020000420'
has plain 'CapBnd:	0000000020000420'
has plain 'NoNewPrivs:	1'
has plain 'nofile 512 2048'
begins plain 'mount / ro,'
has plain 'mount /proc/sys ro,relatime proc'
has plain '/dev/null 20666 1:3'
has plain '/dev/tty 20666 5:0'
has plain '/dev/ptmx 120777 -> pts/ptmx'
has plain '/dev/stderr 120777 -> /proc/self/fd/2'
has plain 'write in / 30'

# One who is not root, with groups, where it is told to be, with what the host has bound in: a directory read-only, a
# file where there was none; and how it ends is how muk ends.
mkdir -p "$t/given" && echo given > "$t/given/file"
bundle other <<JSON
{"ociVersion": "1.0.2",
 "process": {"user": {"uid": 1000, "gid": 1000, "additionalGids": [5, 6], "umask": 63}, "args": ["probe", "seven"], "cwd": "/given",
  "env": ["PATH=/nowhere:/"]},
 "root": {"path": "rootfs"},
 "mounts": [
  {"destination": "/proc", "type": "proc", "source": "proc"},
  {"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=1777"]},
  {"destination": "/given", "type": "bind", "source": "$t/given", "options": ["rbind", "ro", "nosuid"]},
  {"destination": "/etc/a/file", "type": "bind", "source": "$t/given/file", "options": ["bind"]}],
 "linux": {"namespaces": [{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}]}}
JSON
both other 7
has other 'uid 1000 gid 1000 groups 2 pid 1'
has other 'cwd /given'
has other 'arg seven'
has other 'env HOME=/'
has other 'CapEff:	0000000000000000'
has other '/dev/null 20666 1:3'
has other 'mount /given ro,nosuid,relatime '"$(awk '$5 == "/" {for (i = 7; i <= NF; i++) if ($i == "-") {print $(i + 1); exit}}' /proc/self/mountinfo)"
else
  echo "# not root: the bundles that want root are left out"
fi

# A user namespace, the one who runs this root in it: the devices are the host's, bound.
bundle user <<JSON
{"ociVersion": "1.0.2",
 "process": {"args": ["/probe"], "cwd": "/", "env": ["HOME=/home"], "noNewPrivileges": true},
 "root": {"path": "$t/user/rootfs", "readonly": true}, "hostname": "mine",
 "mounts": [
  {"destination": "/proc", "type": "proc", "source": "proc"},
  {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "strictatime", "mode=755", "size=65536k"]},
  {"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"]}],
 "linux": {"namespaces": [{"type": "pid"}, {"type": "network"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}, {"type": "user"}],
  "uidMappings": [{"containerID": 0, "hostID": $(id -u), "size": 1}], "gidMappings": [{"containerID": 0, "hostID": $(id -g), "size": 1}]}}
JSON
both user 0
has user 'uid 0 gid 0 groups 0 pid 1'
has user 'host mine domain (none)'
has user 'env HOME=/home'
has user '/dev/null 20666 1:3'
begins user 'mount /dev/null '
has user 'write in / 30'

# What it does not run: a filter it cannot make yet is not left out; a terminal; hooks; no program; what is not JSON.
bundle filter <<'JSON'
{"process": {"args": ["/probe"]}, "linux": {"namespaces": [{"type": "mount"}], "seccomp": {"defaultAction": "SCMP_ACT_ALLOW"}}}
JSON
refuses filter 'linux.seccomp'
bundle terminal <<'JSON'
{"process": {"terminal": true, "args": ["/probe"]}, "linux": {"namespaces": [{"type": "mount"}]}}
JSON
refuses terminal 'process.terminal'
bundle hooks <<'JSON'
{"process": {"args": ["/probe"]}, "hooks": {}, "linux": {"namespaces": [{"type": "mount"}]}}
JSON
refuses hooks 'hooks'
bundle nothing <<'JSON'
{"process": {"args": [], "cwd": "/"}, "linux": {"namespaces": [{"type": "mount"}]}}
JSON
refuses nothing 'process.args'
bundle nowhere <<'JSON'
{"process": {"args": ["/probe"], "cwd": "here"}, "linux": {"namespaces": [{"type": "mount"}]}}
JSON
refuses nowhere 'process.cwd'
bundle shared <<'JSON'
{"process": {"args": ["/probe"], "cwd": "/"}, "linux": {"namespaces": [{"type": "pid"}]}}
JSON
refuses shared 'a mount namespace'
bundle name <<'JSON'
{"process": {"args": ["/probe"], "capabilities": {"bounding": ["CAP_NO_SUCH"]}}, "linux": {"namespaces": [{"type": "mount"}]}}
JSON
refuses name 'no such name: CAP_NO_SUCH'
bundle torn <<'JSON'
{"process": {"args": ["/probe"
JSON
refuses torn 'config.json'
bundle missing <<JSON
{"process": {"args": ["/no-such-program"], "cwd": "/"}, "linux": {"namespaces": [{"type": "mount"}, {"type": "user"}],
  "uidMappings": [{"containerID": 0, "hostID": $(id -u), "size": 1}], "gidMappings": [{"containerID": 0, "hostID": $(id -g), "size": 1}]}}
JSON
refuses missing 'exec /no-such-program (errno 2)'
mkdir "$t/empty"
refuses empty 'open config.json (errno 2)'
echo "ok $n"
