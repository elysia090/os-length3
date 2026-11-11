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

# Read as runc reads it: a member that is null is not there, one given twice is the second, a kind of hook with none
# in it and no resources asked for are nothing; where it runs is made when nothing is there (in a root that is then
# read-only); a mount whose destination is a link lands on what the link leads to, in the box's root.
mkdir -p "$t/read/rootfs/etc" "$t/read/rootfs/target"
ln -s /target/real "$t/read/rootfs/etc/link" && echo "the root's" > "$t/read/rootfs/target/real"
# (and a link that climbs out of the root, as far as the host's own paths: in the box it leads nowhere but the box,
# to the place of that name the root itself has)
ln -s "../../../../../../../../../../../..$t/outside" "$t/read/rootfs/climbs" && mkdir -p "$t/read/rootfs$t/outside"
bundle read <<JSON
{"ociVersion": "1.0.2",
 "process": {"args": ["/probe", "first"], "args": ["/probe", "see:/etc/link", "see:/target/real", "see:/climbs/file", "see:/up/file"], "cwd": "/made/for/it", "env": null,
  "capabilities": null, "rlimits": null, "user": {"uid": 7, "gid": 7, "additionalGids": null}},
 "root": {"path": "rootfs", "readonly": true}, "hostname": null, "hooks": {"prestart": [], "poststop": null},
 "mounts": [{"destination": "/proc", "type": "proc", "source": "proc"},
  {"destination": "/etc/link", "type": "bind", "source": "$t/given/file", "options": ["bind", "ro"]},
  {"destination": "/climbs/file", "type": "bind", "source": "$t/given/file", "options": ["bind", "ro"]},
  {"destination": "/../../../up/file", "type": "bind", "source": "$t/given/file", "options": ["bind", "ro"]}],
 "linux": {"resources": {}, "seccomp": null, "maskedPaths": null,
  "namespaces": [{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}]}}
JSON
both read 0
has read 'fds 0 1 2'
has read 'uid 7 gid 7 groups 0 pid 1'
has read 'cwd /made/for/it'
has read 'arg see:/etc/link'
has read 'see /etc/link 120777 -> /target/real = given'
has read 'see /target/real 100644 = given'
has read 'see /climbs/file 100644 = given'
has read 'see /up/file 100644 = given'
n=$((n + 1)); ! grep -qx 'arg first' "$t/read.muk" || no "read: args given twice were both read"
n=$((n + 1)); [ ! -e "$t/outside" ] && [ ! -e "$t/up" ] && [ ! -e "$t/read/up" ] || no "read: a mount's destination was made outside the box's root"

# Namespaces that are there already are joined, not made: the box is in the network and UTS namespaces of a process
# that has its own, and its devices are made as any box's are.
unshare --net --uts sleep 300 &
holder=$!
i=0
until [ "$(readlink "/proc/$holder/ns/net" 2> /dev/null)" != "$(readlink /proc/self/ns/net)" ] && [ "$(readlink "/proc/$holder/ns/uts" 2> /dev/null)" != "$(readlink /proc/self/ns/uts)" ]; do
  i=$((i + 1)); [ "$i" -lt 500 ] || no "joined: no process with namespaces of its own"
  sleep 0.01
done
bundle joined <<JSON
{"ociVersion": "1.0.2",
 "process": {"args": ["/probe", "see:/proc/self/ns/net", "see:/proc/self/ns/uts"], "cwd": "/"},
 "root": {"path": "rootfs"}, "hostname": "joined",
 "mounts": [{"destination": "/proc", "type": "proc", "source": "proc"}],
 "linux": {"namespaces": [{"type": "pid"}, {"type": "mount"}, {"type": "network", "path": "/proc/$holder/ns/net"}, {"type": "uts", "path": "/proc/$holder/ns/uts"}]}}
JSON
both joined 0
kill "$holder" 2> /dev/null || :
has joined "see /proc/self/ns/net 120777 -> $(readlink /proc/self/ns/net | sed 's/[0-9]*]$//')$(sed -n 's|^see /proc/self/ns/net .*\[\([0-9]*\)]$|\1|p' "$t/joined.muk")]"
n=$((n + 1)); ! grep -qx "see /proc/self/ns/net 120777 -> $(readlink /proc/self/ns/net)" "$t/joined.muk" || no "joined: the box is in the host's network namespace"
has joined 'host joined domain (none)'
has joined '/dev/null 20666 1:3'

# A box that shares the host's UTS namespace is not named: the name would be the host's.
bundle named <<'JSON'
{"process": {"args": ["/probe"], "cwd": "/"}, "hostname": "not-the-hosts", "linux": {"namespaces": [{"type": "mount"}, {"type": "pid"}]}}
JSON
before=$(cat /proc/sys/kernel/hostname)
refuses named 'hostname'
n=$((n + 1)); [ "$(cat /proc/sys/kernel/hostname)" = "$before" ] || no "named: the host's name was changed"
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
{"process": {"args": ["/probe"]}, "hooks": {"prestart": [{"path": "/bin/true"}]}, "linux": {"namespaces": [{"type": "mount"}]}}
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

# A number is what it says or it is refused: none is cut to fit (4294967296 would be 0, root), none below zero, none
# with a fraction; a limit says which it is; what confines a box and is not done here is not passed over.
refused() { # refused NAME WORDS MEMBERS: a box with MEMBERS (of the whole, after its process) is not run, and muk says WORDS
  bundle "$1" <<JSON
{"process": {"args": ["/probe"], "cwd": "/"}, $3, "linux": {"namespaces": [{"type": "mount"}]}}
JSON
  refuses "$1" "$2"
}
in_process() { # in_process NAME WORDS MEMBERS: the same, MEMBERS being its process's
  bundle "$1" <<JSON
{"process": {"args": ["/probe"], "cwd": "/", $3}, "linux": {"namespaces": [{"type": "mount"}]}}
JSON
  refuses "$1" "$2"
}
in_linux() { # in_linux NAME WORDS MEMBERS: the same, MEMBERS being linux's
  bundle "$1" <<JSON
{"process": {"args": ["/probe"], "cwd": "/"}, "linux": {"namespaces": [{"type": "mount"}], $3}}
JSON
  refuses "$1" "$2"
}
in_process wraps 'a number is greater than what it sets can be' '"user": {"uid": 4294967296}'
in_process nobody 'a number is greater than what it sets can be' '"user": {"gid": 4294967295}'
in_process huge 'a number is greater than what it sets can be' '"user": {"uid": 18446744073709551617}'
in_process below 'a whole number, zero or more, is wanted' '"user": {"uid": -1}'
in_process part 'a whole number, zero or more, is wanted' '"user": {"uid": 1.5}'
in_process power 'a whole number, zero or more, is wanted' '"user": {"uid": 1e3}'
in_process mask 'a number is greater than what it sets can be' '"user": {"umask": 512}'
in_process untyped 'process.rlimits' '"rlimits": [{"soft": 0, "hard": 0}]'
in_process over 'a number is greater than what it sets can be' '"rlimits": [{"type": "RLIMIT_NOFILE", "soft": 18446744073709551616, "hard": 1}]'
in_process armor 'process.apparmorProfile' '"apparmorProfile": "box"'
in_process label 'process.selinuxLabel' '"selinuxLabel": "box"'
in_process score 'process.oomScoreAdj' '"oomScoreAdj": 100'
in_linux limits 'linux.resources' '"resources": {"memory": {"limit": 1048576}}'
in_linux group 'linux.cgroupsPath' '"cgroupsPath": "/box"'
in_linux tuned 'linux.sysctl' '"sysctl": {"net.ipv4.ip_forward": "1"}'
in_linux spread 'linux.rootfsPropagation' '"rootfsPropagation": "shared"'
refused owners 'mounts.uidMappings' '"mounts": [{"destination": "/x", "type": "bind", "source": "/", "uidMappings": []}]'
refused nowhere-to 'a mount' '"mounts": [{"destination": "x", "type": "tmpfs"}]'
bundle twice <<'JSON'
{"process": {"args": ["/probe"], "cwd": "/"}, "linux": {"namespaces": [{"type": "mount"}, {"type": "ipc"}, {"type": "ipc"}]}}
JSON
refuses twice 'twice'
bundle later <<'JSON'
{"process": {"args": ["/probe"], "cwd": "/"}, "linux": {"namespaces": [{"type": "mount"}, {"type": "time"}]}}
JSON
refuses later 'no such namespace is made here: time'
# What follows the text is not passed over, a NUL before it or not.
bundle follows <<'JSON'
{"process": {"args": ["/probe"], "cwd": "/"}, "linux": {"namespaces": [{"type": "mount"}]}} {}
JSON
refuses follows 'something follows it'
bundle hidden <<'JSON'
{"process": {"args": ["/probe"], "cwd": "/"}, "linux": {"namespaces": [{"type": "mount"}]}}
JSON
printf '\0{"process": {"args": ["/other"]}}' >> "$t/hidden/config.json"
refuses hidden 'something follows it'
# Nesting as deep as the text is long is passed over, not followed down.
bundle deep <<JSON
{"annotations": $(awk 'BEGIN {for (i = 0; i < 100000; i++) printf "["; for (i = 0; i < 100000; i++) printf "]"}'), "process": {"args": []}}
JSON
refuses deep 'process.args'
# More than is read is said to be, not read in part.
bundle long <<JSON
{"annotations": {"a": "$(awk 'BEGIN {for (i = 0; i < 1100000; i++) printf "x"}')"}, "process": {"args": ["/probe"], "cwd": "/"}}
JSON
refuses long 'it is longer than is read'
# What it is told to do is all read: no option it does not know, no word after the box's name.
usage() { # usage WORDS...: muk does not run with them, and says how it is used
  n=$((n + 1))
  st=0; (cd "$t/user" && "$muk" "$@") > "$t/usage.out" 2> "$t/usage.err" || st=$?
  [ "$st" = 1 ] && [ ! -s "$t/usage.out" ] && grep -q 'usage: muk run' "$t/usage.err" || no "muk $*: ended $st: $(cat "$t/usage.out" "$t/usage.err")"
}
usage
usage start
usage run --bundle
usage run --detach -b . x
usage run -b . x y
usage run -b . -x

# Text of every kind that is not a config.json: muk says so and ends, 1; it is never ended by a signal and never
# waits. Each is the user bundle's, cut short at every length or with one byte of it changed.
n=$((n + 1))
mkdir "$t/torn-at" && cp -R "$t/user/rootfs" "$t/torn-at/rootfs"
size=$(wc -c < "$t/user/config.json")
i=0
while [ "$i" -lt "$((size - 1))" ]; do # (all of it but the line feed at its end is all of it)
  head -c "$i" "$t/user/config.json" > "$t/torn-at/config.json"
  st=0; (cd "$t/torn-at" && timeout 20 "$muk" run -b . x) > /dev/null 2>&1 || st=$?
  [ "$st" = 1 ] || no "config.json cut at $i bytes: muk ended $st"
  i=$((i + 1))
done
n=$((n + 1))
for with in '"' '\\' '{' '}' '[' ']' ',' ':' 'x' '9' '-' ' '; do
  i=0
  while [ "$i" -lt "$size" ]; do
    { head -c "$i" "$t/user/config.json"; printf '%s' "$with"; tail -c +"$((i + 2))" "$t/user/config.json"; } > "$t/torn-at/config.json"
    st=0; (cd "$t/torn-at" && timeout 20 "$muk" run -b . x) > /dev/null 2>&1 || st=$?
    [ "$st" = 0 ] || [ "$st" = 1 ] || no "config.json with $with at $i: muk ended $st"
    i=$((i + 7))
  done
done

# The box's own files are anything: an /etc/passwd that is a pipe no one writes to is not waited on.
mkdir -p "$t/pipe/rootfs/etc" && mkfifo "$t/pipe/rootfs/etc/passwd"
bundle pipe <<JSON
{"process": {"args": ["/probe"], "cwd": "/"}, "root": {"path": "$t/pipe/rootfs"},
 "mounts": [{"destination": "/proc", "type": "proc", "source": "proc"}],
 "linux": {"namespaces": [{"type": "pid"}, {"type": "mount"}, {"type": "user"}],
  "uidMappings": [{"containerID": 0, "hostID": $(id -u), "size": 1}], "gidMappings": [{"containerID": 0, "hostID": $(id -g), "size": 1}]}}
JSON
n=$((n + 1))
st=0; (cd "$t/pipe" && timeout 20 "$muk" run -b . x) > "$t/pipe.muk" 2> "$t/pipe.err" || st=$?
[ "$st" = 0 ] || no "pipe: muk ended $st: $(cat "$t/pipe.err")"
has pipe 'env HOME=/'

# Started with its three closed, it does not put what it opens in their places: the box has three, and they are
# the place nothing is read from.
n=$((n + 1))
st=0; (cd "$t/user" && "$muk" run -b . x 0<&- 1>&- 2>&-) || st=$?
[ "$st" = 0 ] || no "closed: muk ended $st"
n=$((n + 1))
st=0; (cd "$t/user" && "$muk" run -b . x 0<&- 2>&-) > "$t/closed.muk" || st=$?
[ "$st" = 0 ] && grep -qx 'fds 0 1 2' "$t/closed.muk" || no "closed: muk ended $st, the box said: $(head -1 "$t/closed.muk")"

# Many at once on one root that has none of the places its mounts go: each makes what is missing, and what another
# made meanwhile is not in its way.
bundle crowd <<JSON
{"process": {"args": ["/probe"], "cwd": "/a/place/of/its/own"}, "root": {"path": "$t/crowd/rootfs"},
 "mounts": [{"destination": "/proc", "type": "proc", "source": "proc"},
  {"destination": "/a/b/c/file", "type": "bind", "source": "$t/crowd/config.json", "options": ["bind", "ro"]}],
 "linux": {"namespaces": [{"type": "pid"}, {"type": "mount"}, {"type": "user"}],
  "uidMappings": [{"containerID": 0, "hostID": $(id -u), "size": 1}], "gidMappings": [{"containerID": 0, "hostID": $(id -g), "size": 1}]}}
JSON
n=$((n + 1))
for round in 1 2 3 4; do
  rm -rf "$t/crowd/rootfs/a" "$t/crowd/rootfs/proc" "$t/crowd/rootfs/dev"
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24; do
    (cd "$t/crowd" && "$muk" run -b . x > /dev/null 2> "$t/crowd.err.$i" || echo "$i" >> "$t/crowd.failed") &
  done
  wait
  [ ! -e "$t/crowd.failed" ] || no "crowd: round $round: $(for i in $(cat "$t/crowd.failed"); do cat "$t/crowd.err.$i"; done | sort | uniq -c | head -3)"
done

# The box ends when muk does, however muk is ended; a signal sent to muk is the box's.
bundle waits <<JSON
{"process": {"args": ["/probe", "wait"], "cwd": "/"}, "root": {"path": "$t/waits/rootfs"},
 "linux": {"namespaces": [{"type": "mount"}, {"type": "user"}],
  "uidMappings": [{"containerID": 0, "hostID": $(id -u), "size": 1}], "gidMappings": [{"containerID": 0, "hostID": $(id -g), "size": 1}]}}
JSON
started() { # started: muk is running the waits bundle; its pid is $m, its box's $kid (the probe, which has said all it says)
  (cd "$t/waits" && exec "$muk" run -b . w) > "$t/waits.muk" 2> "$t/waits.err" &
  m=$!
  i=0
  until grep -q '^write in' "$t/waits.muk" 2> /dev/null; do
    i=$((i + 1)); [ "$i" -lt 500 ] || no "waits: the box did not start: $(cat "$t/waits.err")"
    sleep 0.01
  done
  kid=$(cat "/proc/$m/task/$m/children"); kid=${kid% }
  [ -n "$kid" ] && [ -e "/proc/$kid" ] || no "waits: muk has no box"
}
n=$((n + 1))
started
kill -9 "$m"; wait "$m" 2> /dev/null || :
i=0
while [ -e "/proc/$kid" ] && ! grep -q '^State:.Z' "/proc/$kid/status" 2> /dev/null; do
  i=$((i + 1)); [ "$i" -lt 500 ] || { kill -9 "$kid"; no "waits: muk was killed and its box went on"; }
  sleep 0.01
done
n=$((n + 1))
started
kill -TERM "$m"; st=0; wait "$m" || st=$?
[ "$st" = 143 ] || no "waits: SIGTERM to muk: it ended $st, not 143 as its box did"
echo "ok $n"
