#!/bin/sh
# muk at density: many boxes at once on one machine, and what each costs it. N boxes of one bundle (the mounts and
# hidden paths `runc spec` writes; a root not written to; a process that says it has started and waits), each in
# namespaces of its own, started together; then left to wait; then ended together. Said for each way of running
# them: how long until the last has started, what a box takes of the machine's memory while it waits (the
# processes' own, and the kernel's for its namespaces and mounts), how long until the last is gone.
#
#   sh module/muk/test/bundle/dense.sh [N [MUK]]     N: how many at once (1000)
#
# The ways: muk, the box the host's root as runc's is (every user lent); muk, the box in a user namespace of users
# that are no one's (what one tenant among many is given); runc, where it is installed (started detached: no runc
# stays with a box, where one muk does: README.md, the seam still to be cut). Run by root.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
many=${1:-1000}
t=$(mktemp -d)
trap 'kill -KILL $(cat "$t"/*.pids 2> /dev/null) 2> /dev/null || :; [ ! -d "$t/state" ] || for id in $(ls "$t/state"); do runc --root "$t/state" delete -f "$id" > /dev/null 2>&1 || :; done; rm -rf "$t"' EXIT
[ "$(id -u)" = 0 ] || { echo "dense: run by root (it lends users, and is compared with runc)" >&2; exit 1; }
if [ "$#" -ge 2 ]; then muk=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); else sh "$here/../../../lib/build.sh" "$here/../../src/muk.c" "$t/muk"; muk=$t/muk; fi

# The box's program: one byte said, then nothing until it is ended.
cat > "$t/idle.S" <<'ASM'
.globl _start
_start:
  mov $1, %eax
  mov $1, %edi
  lea dot(%rip), %rsi
  mov $1, %edx
  syscall
1: mov $34, %eax
  syscall
  jmp 1b
dot: .ascii "."
ASM
mounts='{"destination": "/proc", "type": "proc", "source": "proc"},
  {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "strictatime", "mode=755", "size=65536k"]},
  {"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"]},
  {"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"]},
  {"destination": "/dev/mqueue", "type": "mqueue", "source": "mqueue", "options": ["nosuid", "noexec", "nodev"]},
  {"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": ["nosuid", "noexec", "nodev", "ro"]}'
hidden='"maskedPaths": ["/proc/acpi", "/proc/asound", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug", "/proc/scsi", "/proc/interrupts", "/sys/firmware"],
  "readonlyPaths": ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"]'
own='{"type": "pid"}, {"type": "network"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}, {"type": "cgroup"}'
bundle() { # bundle NAME LINUX: its root holds the program and the places its mounts go; nothing is written to it
  mkdir -p "$t/$1/rootfs/proc" "$t/$1/rootfs/dev" "$t/$1/rootfs/sys"
  cc -static -nostdlib -o "$t/$1/rootfs/idle" "$t/idle.S"
  cat > "$t/$1/config.json" <<JSON
{"ociVersion": "1.0.2",
 "process": {"args": ["/idle"], "cwd": "/", "env": ["PATH=/bin"], "noNewPrivileges": true,
  "capabilities": {"bounding": ["CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE"], "effective": ["CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE"], "permitted": ["CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE"]}},
 "root": {"path": "rootfs", "readonly": true}, "hostname": "box",
 "mounts": [$mounts],
 "linux": {"namespaces": [$own$2}}
JSON
}
bundle rooted "], $hidden"
bundle mapped ', {"type": "user"}], "uidMappings": [{"containerID": 0, "hostID": 100000, "size": 65536}], "gidMappings": [{"containerID": 0, "hostID": 100000, "size": 65536}]'
chown -R 100000:100000 "$t/mapped/rootfs"

now() { date +%s%N; }
memory() { awk '/^MemAvailable:/ {print $2}' /proc/meminfo; }
# What the processes of a way hold of memory that is theirs alone or their share of what they share (Pss), in KB.
held() { for pid in "$@"; do awk '/^Pss:/ {print $2}' "/proc/$pid/smaps_rollup" 2> /dev/null || :; done | awk '{s += $1} END {print s + 0}'; }
row() { printf '%-34s %8s %10s %10s %10s %9s\n' "$@"; }
row "$many boxes at once" started 'a box' "its own" "the kernel's" ended
row '' '(ms)' '(KB)' '(KB)' '(KB)' '(ms)'

measure() { # measure NAME BUNDLE START: START (a function given a box's number) starts one; the row for this way
  name=$1 b=$t/$2 start=$3
  : > "$t/said"; : > "$t/$name.pids"; : > "$t/err"
  sync; before=$(memory); began=$(now)
  i=0
  while [ "$i" -lt "$many" ]; do "$start" "$i"; i=$((i + 1)); done
  tries=0
  until [ "$(wc -c < "$t/said")" -ge "$many" ]; do
    tries=$((tries + 1)); [ "$tries" -lt 6000 ] || { echo "dense: $name: $(wc -c < "$t/said") of $many started: $(head -3 "$t/err")" >&2; exit 1; }
    sleep 0.01
  done
  started=$(( ($(now) - began) / 1000000 ))
  sleep 1; after=$(memory)
  # (each box's processes: what stays of the one that ran it, and the box's own)
  pids=$(cat "$t/$name.pids"); boxes=$(pgrep -x idle || :)
  own=$(held $pids $boxes)
  each=$(( (before - after) / many )); its=$(( own / many ))
  began=$(now)
  ended "$name"
  tries=0
  while pgrep -x idle > /dev/null; do tries=$((tries + 1)); [ "$tries" -lt 6000 ] || { echo "dense: $name: boxes are left" >&2; exit 1; }; sleep 0.01; done
  gone=$(( ($(now) - began) / 1000000 ))
  row "$name" "$started" "$each" "$its" "$(( each - its ))" "$gone"
  sleep 1 # (what the kernel frees of them, it frees a little after)
}
by_muk() { (cd "$b" && exec "$muk" run $lent -b . "b$1") >> "$t/said" 2>> "$t/err" & echo $! >> "$t/$name.pids"; }
by_runc() { (cd "$b" && exec runc --root "$t/state" run -d -b . "b$1") >> "$t/said" 2>> "$t/err" & }
ended() { # the boxes of a way ended: muk's by muk's own end (a box ends with it); runc's each by its own
  case $1 in runc*) pkill -KILL -x idle || : ;; *) kill -KILL $(cat "$t/$1.pids") ;; esac
  wait 2> /dev/null || :
}

lent="--ids 0-4294967294"; measure "muk, the host's root" rooted by_muk
lent="--ids 100000-165535"; measure "muk, users of its own" mapped by_muk
if command -v runc > /dev/null; then measure "runc ($(runc --version | sed -n 's/^runc version //p'))" rooted by_runc; fi
