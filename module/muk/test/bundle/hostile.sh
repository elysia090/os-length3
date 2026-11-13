#!/bin/sh
# muk, given a config.json written against it. On a machine many share, a box is run from what someone else wrote,
# and that someone may mean harm: so each way a config.json has of asking for what is the host's (a path, a device,
# a namespace, a user, the kernel itself, more of the machine than a box's share) is asked here, with nothing lent
# but what the case says, and comes to one of two ends. muk does not run it, and says why; or the box runs and has
# not got it, which the box says of itself (probe.c).
#
#   sh module/muk/test/bundle/hostile.sh [MUK]     MUK: the program (made here when not given)
#
# Run by root: it is root's muk that a config.json would turn on the host, and the cases that need root to try are
# most of them. One who is not root is held by the kernel to what is its own; what is left to check is checked.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'kill ${holder:-} 2> /dev/null || :; [ -z "${grouped:-}" ] || { rmdir "$grouped/box" "$grouped/full" 2> /dev/null; if [ -n "${mounted:-}" ]; then umount "$grouped"; else rmdir "$grouped"; fi; } || :; [ -n "${KEEP:-}" ] || rm -rf "$t"' EXIT
[ -z "${KEEP:-}" ] || echo "# kept: $t"
if [ "$#" -ge 1 ]; then muk=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); else sh "$here/../../../lib/build.sh" "$here/../../src/muk.c" "$t/muk"; muk=$t/muk; fi
sh "$here/../../../lib/build.sh" "$here/probe.c" "$t/probe"
n=0
no() { printf 'not ok %d: %s\n' "$n" "$*" >&2; exit 1; }
root=; [ "$(id -u)" != 0 ] || root=1

# The users a box is here: by root, a range of the host's that is no one's (lent by saying so); else the one who runs
# this (whom the kernel lends, and no other).
if [ -n "$root" ]; then first=100000 many=65536 ids="--ids 100000-165535"; else first=$(id -u) many=1 ids=; fi
maps='"uidMappings": [{"containerID": 0, "hostID": '$first', "size": '$many'}], "gidMappings": [{"containerID": 0, "hostID": '$([ -n "$root" ] && echo 100000 || id -g)', "size": '$many'}]'
own='{"type": "pid"}, {"type": "network"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}'
every="--ids 0-4294967294" # (every user of the host's, lent: what a box in no user namespace is)

bundle() { # bundle NAME: $t/NAME, its root holding the probe alone, the box's own to write; config.json from stdin
  mkdir -p "$t/$1/rootfs"
  cp "$t/probe" "$t/$1/rootfs/probe"
  [ -z "$root" ] || chown -R 100000:100000 "$t/$1/rootfs"
  cat > "$t/$1/config.json"
}
box() { # box NAME [ARGS [MOUNTS [LINUX [PROCESS [ROOT]]]]]: a box in a user namespace of its own; each part what config.json has there, after a comma
  bundle "$1" <<JSON
{"ociVersion":"1.2.0","process": {"args": ["/probe"${2:+, $2}], "cwd": "/"${5:+, $5}}, "root": {"path": "${6:-rootfs}"},
 "mounts": [{"destination": "/proc", "type": "proc", "source": "proc"}${3:+, $3}],
 "linux": {"namespaces": [$own, {"type": "user"}], $maps${4:+, $4}}}
JSON
}
host() { # host NAME [ARGS [MOUNTS [LINUX [PROCESS]]]]: a box in no user namespace: who it is, it is on the host
  bundle "$1" <<JSON
{"ociVersion":"1.2.0","process": {"args": ["/probe"${2:+, $2}], "cwd": "/"${5:+, $5}}, "root": {"path": "rootfs"},
 "mounts": [{"destination": "/proc", "type": "proc", "source": "proc"}${3:+, $3}],
 "linux": {"namespaces": [$own]${4:+, $4}}}
JSON
}
refuses() { # refuses NAME WORDS [LENT...]: muk, lent only LENT, does not run it, and says WORDS
  n=$((n + 1)); name=$1 words=$2; shift 2
  st=0; (cd "$t/$name" && "$muk" run "$@" -b . x) > "$t/$name.out" 2> "$t/$name.err" || st=$?
  [ "$st" = 1 ] || no "$name: muk ended $st, not 1: $(cat "$t/$name.err")"
  [ ! -s "$t/$name.out" ] || no "$name: something ran"
  grep -qF -- "$words" "$t/$name.err" || no "$name: muk said: $(cat "$t/$name.err")"
}
runs() { # runs NAME [LENT...]: muk, lent only LENT, runs it, and the box ends well
  n=$((n + 1)); name=$1; shift
  st=0; (cd "$t/$name" && "$muk" run "$@" -b . x < /dev/null) > "$t/$name.said" 2> "$t/$name.err" || st=$?
  [ "$st" = 0 ] || no "$name: muk ended $st: $(cat "$t/$name.err")"
}
said() { n=$((n + 1)); grep -qxF -- "$2" "$t/$1.said" || no "$1: the box did not say: $2 (it said: $(grep -F -- "$(echo "$2" | cut -d' ' -f1-2)" "$t/$1.said" | head -3))"; }
begins() { n=$((n + 1)); grep -q -- "^$2" "$t/$1.said" || no "$1: the box said no line beginning: $2"; }
kept() { # kept NAME PATH: the box tried to open PATH to write to it, and it did not open
  n=$((n + 1))
  grep -q "^opens $2 [1-9]" "$t/$1.said" || no "$1: $2 was the box's to write: $(grep "^opens $2 " "$t/$1.said")"
}

# ---- Paths. A box's root, and what is bound into it, are the bundle's own or what was lent: never what a path
# says, a link leads to, or `..` climbs to.
mkdir -p "$t/lent" "$t/lentil" && echo lent > "$t/lent/file" && echo secret > "$t/secret" && echo other > "$t/lentil/file"
ln -s file "$t/lent/in" && ln -s "$t/secret" "$t/lent/out" && ln -s ../secret "$t/lent/up"
box whole '' '' '' '' '/'
refuses whole 'was not lent (--lend): /' $ids
box linked '' '' '' '' 'link'; ln -s / "$t/linked/link"
refuses linked 'root.path: link (errno 18)' $ids
box climbs '' '' '' '' 'rootfs/../..'
refuses climbs 'root.path: rootfs/../.. (errno 18)' $ids
box beside '' '' '' '' "$t/secret"
refuses beside 'was not lent (--lend)' $ids --lend "$t/lent"
bound() { echo '{"destination": "/given", "type": "bind", "source": "'"$1"'", "options": ["bind", "dev", "suid", "exec", "rw"]}'; }
box all '' "$(bound /)"
refuses all 'was not lent (--lend): /' $ids
box shadow '' "$(bound /etc/passwd)"
refuses shadow 'was not lent (--lend): /etc/passwd' $ids
box leak '' "$(bound leak)"; ln -s /etc "$t/leak/leak"
refuses leak 'its source: leak (errno 18)' $ids
box above '' "$(bound "$t/lent/../secret")"
refuses above '/lent/../secret (errno 18)' $ids --lend "$t/lent"
box out '' "$(bound "$t/lent/out")"
refuses out '/lent/out (errno 18)' $ids --lend "$t/lent"
box up '' "$(bound "$t/lent/up")"
refuses up '/lent/up (errno 18)' $ids --lend "$t/lent"
box alike '' "$(bound "$t/lentil/file")"
refuses alike 'was not lent (--lend)' $ids --lend "$t/lent"
# (what was lent is the box's: by its name, under it, and through a link that stays in it)
box given '"see:/given", "see:/in"' "$(bound "$t/lent/file"), {\"destination\": \"/in\", \"type\": \"bind\", \"source\": \"$t/lent/in\", \"options\": [\"bind\"]}"
runs given $ids --lend "$t/lent/"
said given 'see /given 100644 = lent'
said given 'see /in 100644 = lent'

# ---- Mounts. What is mounted in a box is what was lent, or one of the kinds that are a box's own: no disk, none of
# the kernel's own tables, no devtmpfs. And a proc or a sysfs only where the floor looks for it.
for kind in devtmpfs debugfs tracefs securityfs bpf binfmt_misc configfs pstore efivarfs hugetlbfs fusectl fuse overlay ext4 9p nfs ramfs autofs squashfs cgroup1 none; do
  box "kind-$kind" '' '{"destination": "/x", "type": "'"$kind"'", "source": "/dev/sda1", "options": ["rw", "dev"]}'
  refuses "kind-$kind" "no such kind is mounted in a box: $kind" $ids
done
box kindless '' '{"destination": "/x", "source": "/dev/sda1"}'
refuses kindless 'no such kind is mounted in a box: (none is said)' $ids
box elsewhere '' '{"destination": "/x", "type": "proc", "source": "proc"}'
refuses elsewhere 'a proc is mounted at /proc and a sysfs at /sys, nowhere else' $ids
box elsewhere-sys '' '{"destination": "/proc/x", "type": "sysfs", "source": "sysfs"}'
refuses elsewhere-sys 'a proc is mounted at /proc and a sysfs at /sys, nowhere else' $ids

# ---- Namespaces. One joined is one lent, by its path; the host's own is never joined, lent or not (the network's
# apart); and a box has a network namespace, the host's not being its for saying nothing.
joins() { echo '"namespaces": [{"type": "mount"}, '"$1"'], '"$maps"; }
bundle hosts-pid <<JSON
{"ociVersion":"1.2.0","process": {"args": ["/probe"], "cwd": "/"}, "linux": {$(joins '{"type": "pid", "path": "/proc/1/ns/pid"}, {"type": "network"}, {"type": "ipc"}, {"type": "uts"}, {"type": "user"}')}}
JSON
refuses hosts-pid 'was not lent (--lend): /proc/1/ns/pid' $ids
bundle hosts-net <<JSON
{"ociVersion":"1.2.0","process": {"args": ["/probe"], "cwd": "/"}, "linux": {$(joins '{"type": "pid"}, {"type": "network", "path": "/proc/1/ns/net"}, {"type": "ipc"}, {"type": "uts"}, {"type": "user"}')}}
JSON
refuses hosts-net 'was not lent (--lend): /proc/1/ns/net' $ids
bundle hosts-user <<JSON
{"ociVersion":"1.2.0","process": {"args": ["/probe"], "cwd": "/"}, "linux": {"namespaces": [{"type": "mount"}, {"type": "pid"}, {"type": "network"}, {"type": "ipc"}, {"type": "uts"}, {"type": "user", "path": "/proc/1/ns/user"}]}}
JSON
refuses hosts-user 'was not lent (--lend): /proc/1/ns/user' $ids
for kind in pid uts ipc; do
  bundle "own-$kind" <<JSON
{"ociVersion":"1.2.0","process": {"args": ["/probe"], "cwd": "/"}, "linux": {$(joins "$(echo '{"type": "pid"}, {"type": "network"}, {"type": "ipc"}, {"type": "uts"}, {"type": "user"}' | sed "s|{\"type\": \"$kind\"}|{\"type\": \"$kind\", \"path\": \"/proc/self/ns/$kind\"}|")")}}
JSON
  refuses "own-$kind" "the host's own is no box's to join: /proc/self/ns/$kind" $ids --lend "/proc/self/ns/$kind"
done
bundle netless <<JSON
{"ociVersion":"1.2.0","process": {"args": ["/probe"], "cwd": "/"}, "linux": {$(joins '{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "user"}')}}
JSON
refuses netless 'a box has a network namespace of its own, or one lent' $ids
if [ -n "$root" ]; then
  # (another's, which root could open: not lent, not joined)
  unshare --net --uts sleep 300 &
  holder=$!
  i=0
  until [ "$(readlink "/proc/$holder/ns/net" 2> /dev/null)" != "$(readlink /proc/self/ns/net)" ]; do
    i=$((i + 1)); [ "$i" -lt 500 ] || no "no process with a network namespace of its own"
    sleep 0.01
  done
  bundle anothers <<JSON
{"ociVersion":"1.2.0","process": {"args": ["/probe"], "cwd": "/"}, "linux": {$(joins '{"type": "pid"}, {"type": "network", "path": "/proc/'"$holder"'/ns/net"}, {"type": "ipc"}, {"type": "uts"}, {"type": "user"}')}}
JSON
  refuses anothers "was not lent (--lend): /proc/$holder/ns/net" $ids --lend "/proc/$holder/ns/uts"
fi

# ---- Calls. What no box asks the kernel is what muk.c's filter names (muk.sh asks each); and what it does not know
# of is not there to ask: a call past the last it was written against, and the socket a machine talks to the one
# that runs it by, which is in no namespace.
box calls '"asks:41:40:1", "asks:41:1:1", "asks:467", "asks:470", "asks:999", "asks:165", "asks:272:268435456", "asks:101", "asks:321", "asks:425", "asks:39"'
runs calls $ids
said calls 'asks 41:40:1 97'
said calls 'asks 41:1:1 0'
said calls 'asks 467 1'
said calls 'asks 470 38'
said calls 'asks 999 38'
said calls 'asks 165 1'
said calls 'asks 272:268435456 1'
said calls 'asks 101 1'
said calls 'asks 321 1'
said calls 'asks 425 38'
said calls 'asks 39 0'

# ---- Terminals: a box has so many and no more, whatever it asks for (they are the host's to run out of).
pts() { echo '{"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": ["newinstance", "ptmxmode=0666", "mode=0620"'"$1"']}'; }
box terminals '"ptys"' "$(pts '')"
runs terminals $ids
said terminals 'ptys 256'
box terminals-more '"ptys"' "$(pts ', "max=100000"')"
runs terminals-more $ids
said terminals-more 'ptys 256'
box terminals-fewer '"ptys"' "$(pts ', "max=3"')"
runs terminals-fewer $ids
said terminals-fewer 'ptys 3'

if [ -z "$root" ]; then echo "# not root: what root's muk is held to is left out"; echo "ok $n"; exit 0; fi

# ---- Devices. A device is what muk made in the box's own /dev, or one lent by its own name: not the host's by its
# path, not a file of what was lent, not one a directory lent holds.
mknod "$t/lent/disk" c 1 3 && chmod 666 "$t/lent/disk"
box device '' "$(bound /dev/null)"
refuses device 'was not lent (--lend): /dev/null' $ids
box devices '' '{"destination": "/dev", "type": "bind", "source": "/dev", "options": ["rbind", "dev"]}'
refuses devices 'was not lent (--lend): /dev' $ids
box planted '"see:/given", "see:/lent/disk"' "$(bound "$t/lent/disk"), {\"destination\": \"/lent\", \"type\": \"bind\", \"source\": \"$t/lent\", \"options\": [\"rbind\", \"dev\"]}"
runs planted $ids --lend "$t/lent"
said planted 'see /given 20666 !13'
said planted 'see /lent/disk 20666 !13'
runs planted $ids --lend "$t/lent" --lend "$t/lent/disk" # (the directory lent first: what is under it is found there)
said planted 'see /given 20666 !13'
runs planted $ids --lend "$t/lent/disk" --lend "$t/lent" # (lent by its own name: the box's)
said planted 'see /given 20666'
said planted 'see /lent/disk 20666 !13'
box image '"see:/disk", "see:/t/disk"' '{"destination": "/t", "type": "tmpfs", "source": "tmpfs", "options": ["dev"]}'
mknod "$t/image/rootfs/disk" c 1 3 && chmod 666 "$t/image/rootfs/disk"
runs image $ids
said image 'see /disk 20666 !13'
begins image 'mount /t rw,nodev'

# ---- Users. Each of the host's users a box can be is one lent: none, by root's muk, until said.
host nobody
refuses nobody 'was not lent (--ids)'
box as-root '' '' '' ''; sed -i 's/"hostID": 100000, "size": 65536/"hostID": 0, "size": 1/' "$t/as-root/config.json"
refuses as-root 'was not lent (--ids)' $ids
box as-all '' '' '' ''; sed -i 's/"hostID": 100000, "size": 65536/"hostID": 0, "size": 4294967295/' "$t/as-all/config.json"
refuses as-all 'was not lent (--ids)' $ids
box past '' '' '' ''; sed -i 's/"hostID": 100000, "size": 65536/"hostID": 165535, "size": 2/' "$t/past/config.json"
refuses past 'was not lent (--ids)' $ids
box before '' '' '' ''; sed -i 's/"hostID": 100000, "size": 65536/"hostID": 99999, "size": 2/' "$t/before/config.json"
refuses before 'was not lent (--ids)' $ids
box no-one '' '' '' ''; sed -i 's/"hostID": 100000, "size": 65536/"hostID": 100000, "size": 0/' "$t/no-one/config.json"
refuses no-one 'was not lent (--ids)' $ids
box group-root '' '' '' ''; sed -i 's/"gidMappings": \[{"containerID": 0, "hostID": 100000/"gidMappings": [{"containerID": 0, "hostID": 0/' "$t/group-root/config.json"
refuses group-root 'was not lent (--ids)' $ids
# (in no user namespace: the ones it runs as; or, where it may change who it is, every one)
host someone '"opens:/proc/sys/kernel/core_pattern"' '' '' '"user": {"uid": 100000, "gid": 100001, "additionalGids": [100002]}, "capabilities": {}'
runs someone $ids
said someone 'uid 100000 gid 100001 groups 1 pid 1'
kept someone /proc/sys/kernel/core_pattern
host changes '' '' '' '"user": {"uid": 100000, "gid": 100000}, "capabilities": {"bounding": ["CAP_SETUID"]}'
refuses changes 'was not lent (--ids)' $ids
host changes-group '' '' '' '"user": {"uid": 100000, "gid": 100000}, "capabilities": {"permitted": ["CAP_SETGID"]}'
refuses changes-group 'was not lent (--ids)' $ids
host in-roots-group '' '' '' '"user": {"uid": 100000, "gid": 100000, "additionalGids": [0]}, "capabilities": {}'
refuses in-roots-group 'was not lent (--ids)' $ids
host roots-group '' '' '' '"user": {"uid": 100000, "gid": 0}, "capabilities": {}'
refuses roots-group 'was not lent (--ids)' $ids
host root-itself '' '' '' '"user": {"uid": 0, "gid": 100000}, "capabilities": {}'
refuses root-itself 'was not lent (--ids)' $ids

# ---- Capabilities. In no user namespace, what a box may do is done to the host: it has what is over its own files
# and processes and (in a network namespace made for it) its own network, and none of those over the host itself,
# every user lent or not.
its="CHOWN DAC_OVERRIDE DAC_READ_SEARCH FOWNER FSETID KILL SETGID SETUID SETPCAP NET_BIND_SERVICE NET_BROADCAST NET_ADMIN NET_RAW IPC_OWNER SYS_CHROOT LEASE AUDIT_WRITE SETFCAP"
names=$(sed -n '/^static const char CAPS\[\]/,/};/p' "$here/../../src/muk.c" | grep -o '"[A-Z_]*"' | tr -d '"')
n=$((n + 1)); [ "$(echo "$names" | wc -l)" -ge 41 ] || no "muk.c's capabilities are not read"
for cap in $names; do
  case " $its " in *" $cap "*) continue ;; esac
  for set in bounding effective permitted inheritable ambient; do
    host "cap-$cap-$set" '' '' '' '"capabilities": {"'"$set"'": ["CAP_'"$cap"'"]}'
    refuses "cap-$cap-$set" "a box's only in a user namespace: CAP_$cap" $every
  done
done
all=$(echo $its | sed 's/[A-Z_]*/"CAP_&"/g; s/ /, /g')
host capable '' '' '' '"capabilities": {"bounding": ['"$all"'], "effective": ['"$all"'], "permitted": ['"$all"']}'
runs capable $every
said capable 'CapEff:	00000000b004bdff'
# (and its network's only where the network is its own: not one lent it, which may be the host's)
bundle lent-network <<JSON
{"ociVersion":"1.2.0","process": {"args": ["/probe"], "cwd": "/", "capabilities": {"bounding": ["CAP_NET_ADMIN"]}},
 "linux": {"namespaces": [{"type": "mount"}, {"type": "pid"}, {"type": "network", "path": "/proc/$holder/ns/net"}, {"type": "ipc"}, {"type": "uts"}]}}
JSON
refuses lent-network "a box's only in a user namespace: CAP_NET_ADMIN" $every --lend "/proc/$holder/ns/net"

# ---- The host's kernel. One that can be the host's root (in no user namespace; or in one that maps a user of its
# own onto the host's root) has what of /proc and /sys tells of the host hidden and what changes it read-only,
# asking for neither; reads its /sys and its cgroups and writes neither; and has the host's own /proc, lent it,
# to read and not to write. (Taken with what is mounted in it: the kernel gives one in a user namespace no copy of
# a mount without what is mounted on it.)
tries='"opens:/proc/sys/kernel/core_pattern", "opens:/proc/sysrq-trigger", "opens:/proc/sys/kernel/modprobe", "opens:/sys/kernel/uevent_helper", "opens:/sys/fs/cgroup/cgroup.procs", "opens:/host/sys/kernel/core_pattern", "opens:/host/sysrq-trigger", "see:/proc/kcore", "see:/proc/interrupts", "see:/proc/keys"'
wide='{"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": ["rw"]}, {"destination": "/sys/fs/cgroup", "type": "cgroup", "source": "cgroup", "options": ["rw", "nsdelegate"]}, {"destination": "/host", "type": "bind", "source": "/proc", "options": ["rbind", "rw"]}'
host rooted "$tries" "$wide" '' '"capabilities": {"bounding": ['"$all"'], "effective": ['"$all"'], "permitted": ['"$all"']}'
box mapped "$tries" "$wide"; sed -i 's/"hostID": 100000, "size": 65536/"hostID": 0, "size": 65536/g' "$t/mapped/config.json"; chown -R 0:0 "$t/mapped/rootfs"
for name in rooted mapped; do
  runs "$name" $every --lend /proc
  for path in /proc/sys/kernel/core_pattern /proc/sysrq-trigger /proc/sys/kernel/modprobe /sys/kernel/uevent_helper /sys/fs/cgroup/cgroup.procs /host/sys/kernel/core_pattern /host/sysrq-trigger; do kept "$name" "$path"; done
  said "$name" 'opens /proc/sys/kernel/core_pattern 30'
  said "$name" 'opens /host/sys/kernel/core_pattern 30'
  begins "$name" 'mount /sys ro,'
  begins "$name" 'mount /sys/fs/cgroup ro,'
  begins "$name" 'mount /host ro,'
  # (each of them this kernel has: the place nothing is read from is over it)
  for path in /proc/kcore /proc/interrupts /proc/keys; do [ ! -e "$path" ] || begins "$name" "see $path 20666"; done
done
# (what hides them is there, or the box is not run: a /dev that is not muk's making, with no /dev/null in it)
mkdir -p "$t/empty"
host bare '' '{"destination": "/dev", "type": "bind", "source": "'"$t"'/empty", "options": ["bind"]}'
refuses bare 'the box has no /dev/null to hide them by' $every --lend "$t/empty"
# (what confines a box and is not done here is not passed over: a device allowed, devices made, the kernel tuned)
host allowed '' '' '"resources": {"devices": [{"allow": true, "access": "rwm"}]}'
refuses allowed 'linux.resources.devices' $every
host made '' '' '"devices": [{"path": "/dev/sda", "type": "b", "major": 8, "minor": 0}]'
refuses made 'linux.devices' $every
host tuned '' '' '"sysctl": {"kernel.core_pattern": "|/probe"}'
refuses tuned 'linux.sysctl' $every
bundle hooked <<JSON
{"ociVersion":"1.2.0","process": {"args": ["/probe"], "cwd": "/"}, "hooks": {"createRuntime": [{"path": "/bin/sh", "args": ["sh", "-c", "id > $t/hooked.ran"]}]}, "linux": {"namespaces": [$own]}}
JSON
refuses hooked 'hooks' $every
n=$((n + 1)); [ ! -e "$t/hooked.ran" ] || no "hooked: a hook ran"

# ---- The machine's share. A limit is at most the one muk itself runs under; and a box made in the cgroup lent it
# is in it from its first instruction, with what it starts, and has its processes counted there.
host limitless '' '' '' '"rlimits": [{"type": "RLIMIT_NOFILE", "hard": 8192, "soft": 1024}]'
n=$((n + 1))
st=0; (ulimit -n 4096; cd "$t/limitless" && "$muk" run $every -b . x) > "$t/limitless.out" 2> "$t/limitless.err" || st=$?
# (said by muk, where root may raise a limit; by the kernel, where this root may not)
[ "$st" = 1 ] && [ ! -s "$t/limitless.out" ] && grep -q 'more than the one who runs muk has\|rlimits: one is not set (errno 1)' "$t/limitless.err" || no "limitless: muk ended $st: $(cat "$t/limitless.err")"
host limited '' '' '' '"rlimits": [{"type": "RLIMIT_NOFILE", "hard": 4096, "soft": 1024}]'
n=$((n + 1))
st=0; (ulimit -n 4096; cd "$t/limited" && "$muk" run $every -b . x) > "$t/limited.said" 2> "$t/limited.err" || st=$?
[ "$st" = 0 ] || no "limited: muk ended $st: $(cat "$t/limited.err")"
said limited 'nofile 1024 4096'
# (the one tree of cgroups: the host's, or one mounted here where the host has the old ones)
if [ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ]; then grouped=/sys/fs/cgroup/muk-hostile-$$; mkdir "$grouped"
else grouped=$t/groups; mkdir "$grouped"; mount -t cgroup2 none "$grouped"; mounted=1; fi
mkdir "$grouped/box"
box grouped '"wait"'
(cd "$t/grouped" && exec "$muk" run $ids --cgroup "$grouped/box" -b . g) > "$t/grouped.said" 2> "$t/grouped.err" &
m=$!
i=0
until grep -q '^fds' "$t/grouped.said" 2> /dev/null; do
  i=$((i + 1)); [ "$i" -lt 500 ] || no "grouped: the box did not start: $(cat "$t/grouped.err")"
  sleep 0.01
done
n=$((n + 1)); [ "$(wc -l < "$grouped/box/cgroup.procs")" = 1 ] || no "grouped: the box is not in the cgroup lent it: $(cat "$grouped/box/cgroup.procs")"
n=$((n + 1)); ! grep -qx "$m" "$grouped/box/cgroup.procs" || no "grouped: muk itself is in the box's cgroup"
kill -TERM "$m"; wait "$m" || :
# (its end with muk's is the kernel's to carry out: a moment after muk's own)
n=$((n + 1)); i=0
while [ -n "$(cat "$grouped/box/cgroup.procs")" ]; do
  i=$((i + 1)); [ "$i" -lt 500 ] || no "grouped: something of the box outlived it: $(cat "$grouped/box/cgroup.procs")"
  sleep 0.01
done
refuses grouped '--cgroup: ' $ids --cgroup "$t/no-such-cgroup"
refuses grouped '--cgroup: the box is not made in it' $ids --cgroup "$t/empty"
# (where the tree counts processes: a box that starts all it can has as many as its cgroup may, and the next is refused it)
if grep -qw pids "$grouped/cgroup.controllers" && echo +pids > "$grouped/cgroup.subtree_control" 2> /dev/null; then
  mkdir "$grouped/full" && echo 12 > "$grouped/full/pids.max"
  box full '"forks:200"'
  runs full $ids --cgroup "$grouped/full"
  n=$((n + 1)); [ "$(sed -n 's/^forks //p' "$t/full.said")" = 11 ] || no "full: the box started $(sed -n 's/^forks //p' "$t/full.said") processes in a cgroup of 12"
else echo "# no cgroup here counts processes: a box's are not counted"; fi

echo "ok $n"
