# muk — the machine

A small x86-64 Linux container runner in C, with no C library or dynamic runtime dependencies: one program, made of
`../lib`'s headers and nothing else. It makes an OCI bundle's box, isolates it, starts its program and waits for
it. That is all of it: it reads no image, keeps no box, holds no terminal's other end, and has no code for any
host but Linux.

```
src/muk.c        the Linux operations, in the order they are safe in
src/bundle.h     config.json read where it lies, and the floor every box has whatever it asks
src/filter.h     the filter over every call a box makes
src/linux-abi.h  the numbers of the x86-64 Linux ABI it uses
make/slots.ts    the tables bundle.h finds names by, made again when a name is added
test/            beside runc, against a hostile config.json, and beside a model of the parser
tool/            measurement (profile.sh), apart from the checks
```

```
muk run [-b BUNDLE] [--console-socket PATH] [--lend PATH]... [--ids FIRST-LAST] [--cgroup DIR] [ID]
                       the bundle's process, started and waited for; muk ends as it ends
sh test/muk.sh         the same bundles under muk and under runc: what each box says of itself, the same
sh test/hostile.sh     a config.json written against muk, every way it has: refused, or a box without it
sh test/same.sh        the C parser and a model of it (test/asks.ts), asked the same 8,748 config.jsons
```

**What it is compatible with, and how that is held.** One contract: the OCI runtime bundle (`config.json` and a
root), read as runc reads it and run as runc runs it, the `run` profile of it (not the whole lifecycle CLI).
`test/muk.sh` runs the same bundles under both and compares what each box says of itself, line for line. Where muk
is stricter than runc it refuses in words rather than differing quietly (the floor, below). It has no second
contract: an image's layers are the distribution's to read ([`../ricebox/layers`](../ricebox/layers)), and where
there is no Linux under it (a browser, another system) the Linux it asks for is sods'
([`../sods`](../sods/README.md)), so this same C is what runs there. That last step is not made yet: sods' Linux
answers what a program asks, and refuses in words what a box's maker asks (namespaces, mounts, a filter).

**Where muk ends.** A run is a box's whole life here: muk names no box, keeps none beyond its run, lists none, and
writes nothing about one. A terminal is a device of the box, so muk makes it where only it can (in the box's own
/dev/pts, when config.json asks: `process.terminal`, with its `consoleSize`), makes it the box's (its three
descriptors, its session's terminal, /dev/console), and gives its other end away whole: one descriptor sent to the
one listening at `--console-socket`, and closed. With no one to take it there is no terminal. What is typed and
shown there, its size as it changes, who is at it, a box left and come back to, a box that outlives what started
it: the caller owns those policies. [`../prompt`](../prompt/README.md) attaches to the supplied descriptor and handles terminal input, output and resize.

The C runner owns configuration enforcement. config.json is read once, where it is (a string is used in its place in the text, a NUL
over its closing quote; nothing is copied, nothing allocated). One clone makes the box in its namespaces. In it the
root is bound on itself and made the root (pivot_root), **the host's root is taken away, and only then is anything
looked up in the box**: after pivot_root the old root lies on the new one, and `..` at the box's root steps onto
it, so a mount's destination through a link that climbs was the host's until this order. What a bind takes from the
host is opened before the root changes (open_tree), while the host's paths still mean the host's; what a user
namespace is given only while it sees the host's (a new /proc or /sys, the host's devices) is made or taken then
too, and placed after. Then who the process is and what it may do, and the program. muk waits for every signal
rather than taking any: one sent to it is passed on, the box's end is one of them, and the box ends with muk (its
process starts only when muk says so over a pipe, and ends if muk was gone before it asked to be ended with it).

## The floor

What every box has, whatever config.json says. It may ask for more, never for less: and it is written by someone
else, on a machine many share, who may mean harm. So **config.json asks, and the one who runs muk lends**. Nothing
of the host's is a box's for its asking: a path, a namespace, a user, a share of the machine are each the bundle's
own, or what was lent in words config.json has no say in (muk's own: `--lend`, `--ids`, `--cgroup`).

- **Paths.** The box's root, and what a bind takes, is in the bundle or was lent (`--lend PATH`: that path, and
  what is under it). It is opened once, by the kernel's rule that nothing leads out (openat2, RESOLVE_BENEATH: not
  a link, not `..`, not a path from the root), and what was opened is what is mounted, not what its path leads to
  by then. What was lent is opened by the one who lent it, however the box is to see the host's files.
- **Namespaces.** Its mount, pid, ipc, uts and network namespaces are its own or one lent by its path, and the
  first four are never the host's, lent or not (the one muk itself is in: a box in it is refused); it has a
  cgroup namespace. The host's network is a box's only by being lent, as a path: saying nothing is not asking
  for it.
- **Users.** Each of the host's users and groups a box can be is one lent (`--ids FIRST-LAST`; to one who is not
  root the kernel lends the one it is; root's muk lends none until told). In a user namespace of its own: those
  its own are mapped onto. In none: the ones it runs as, or, where it may change who it is (SETUID, SETGID),
  every one.
- **Privilege.** It gains none by what it runs (no_new_privs, always). It has the capabilities config.json names
  and no others; and, in no user namespace, none over the host itself: only those over its own files and
  processes (CHOWN, DAC_OVERRIDE, DAC_READ_SEARCH, FOWNER, FSETID, KILL, SETGID, SETUID, SETPCAP, SETFCAP,
  NET_BIND_SERVICE, IPC_OWNER, SYS_CHROOT, LEASE, AUDIT_WRITE) and, in a network namespace made for it, its own
  network (NET_ADMIN, NET_RAW, NET_BROADCAST). The rest (SYS_ADMIN, the host's devices, clock, memory,
  scheduler, log, modules, tracing) are a box's only in a user namespace, where they are over that namespace's
  things. One that joins namespaces is not traceable, nor read through /proc, while it is still muk.
- **Devices.** A device is what muk made, in a /dev that is the box's own (a tmpfs, where config.json mounts
  none), or one lent by its own name. Every other mount is nodev: the root, so a device file an image holds is
  not one; a bind, so one planted in a directory that was lent is not one; a tmpfs, whatever its options say. A
  box makes none (CAP_MKNOD is of a user namespace), and `linux.devices`, or any nonempty
  `linux.resources.devices` rule list, is refused rather than silently ignored. Its terminals are 256 at most, whatever its devpts asks for: they are
  the host's to run out of.
- **Mounts.** What is mounted is what was lent (a bind) or one of the kinds that are a box's own, made new for it:
  proc, sysfs, tmpfs, devpts, mqueue, its cgroups. No other kind: not a disk, not the kernel's own tables
  (debugfs, tracefs, securityfs, bpf, binfmt_misc), not devtmpfs. A proc is mounted at /proc and a sysfs at
  /sys, where the floor hides what they tell.
- **The host's kernel.** A box that can be the host's root (in no user namespace; or in one whose mappings put a
  user of its own on the host's root) has what of /proc and /sys tells of the host hidden and what changes it
  read-only, listed by config.json or not (/proc/kcore, /proc/keys, /proc/interrupts, /proc/sys,
  /proc/sysrq-trigger, /sys/firmware, the processor's power counters, and the rest every runtime's defaults
  name); reads its /sys and its cgroups and writes neither; and has the host's own /proc or /sys, if lent, to
  read only. What hides a path is there, or the box is not run.
- **What no box asks the kernel.** A filter over every call it makes (seccomp), there from the program's first
  instruction and for every process it starts: the host's kernel itself (kexec, reboot, modules), another
  process's memory (ptrace and its kin), the mounts, a namespace inside its own (unshare, setns, clone with any
  CLONE_NEW), bpf, perf_event_open, userfaultfd, the kernel's keys, typing into the terminal of the one who ran
  it, are refused as the kernel refuses one who may not; clone3 and io_uring, and every call of another ABI, as a
  kernel without them; the socket a machine talks to the one that runs it by (AF_VSOCK, which is in no
  namespace), as a kernel without it. **And what the filter was not written against is not there to ask**: a
  call numbered past the last it knows (Linux 6.18's) is answered as a kernel without it, so a call a newer
  kernel adds is no box's until it has been read. 56 calls named, made a tree: one that is none of them is found
  to be none in six comparisons.
- **The machine's share.** A limit is at most the one muk itself runs under (the lender's: no box raises it). A
  box made in the cgroup lent it (`--cgroup DIR`, the lender's, with the most it may use set on it: processes,
  memory, processors) is in it from its first instruction, with everything it starts, and its cgroup namespace
  begins there; with none lent, it is in muk's own. It is never out of the one it was made in: nothing moves it
  (the tree is read-only to one that could write it, and it mounts no other).
- **What is asked and not done is refused**, by name: a seccomp filter of config.json's own, hooks that are there, cgroup
  limits and `cgroupsPath`, `sysctl`, `rootfsPropagation`, an AppArmor profile or SELinux label, `oomScoreAdj`,
  a mount given other owners, a mount namespace joined. A number is what it says or it is refused (a uid of
  4294967296 is not 0).

What it does not hold: a box's processes that end badly are handed, by the host's kernel, to whatever the host
has set to take them (`kernel.core_pattern`), which is the host's to set; `sync` makes the host write out, as
any process's does; and a kernel's own faults are a kernel's (a box asks it less, not nothing).

Where it reads config.json as runc does: null is a member not there, a member given twice is the second, a mount
on a link lands on what the link leads to (in the box), where it runs is made when nothing is there. Where it does
not: a mount's destination through a link that leads nowhere is refused (runc makes what it leads to).

`test/muk.sh` is the check beside runc: 153 as root, 91 as another user. The same bundles under runc where
it runs them (what each box says of itself the same, line for line, the floor said to runc in its config.json,
and what runc is given by being run, lent); what is refused; every cut of a config.json and bytes changed in it
(never a signal, never a wait); 24 runs at once on one root; muk killed; a signal passed on; its three
descriptors closed; every name of its tables; every call the filter names, asked from inside a box; a terminal,
its other end taken at a socket, beside runc's.

`test/hostile.sh` is the check against a config.json that means harm: 255 as root, 63 as another user,
each with nothing lent but what the case says. The root or a bind's source anywhere on the host, through a link,
up by `..`, beside what was lent; the host's devices by their paths, a device planted in a directory that was
lent, one an image holds; twenty kinds of file system that are no box's; a proc or a sysfs somewhere the floor
does not look; the host's namespaces and another's, by their paths, and the host's own lent by mistake; no
network namespace; the host's root and every other user, in a user namespace and in none; each capability over
the host, in each of the five sets; /proc/sys, sysrq, the kernel's helpers, its cgroups, and the host's own
/proc lent, opened to be written by a box that is the host's root; a /dev with nothing to hide a path by; hooks,
sysctl, devices; a limit raised; terminals without end; calls the filter never heard of; a box made in a cgroup,
and (where the tree counts processes) one that starts all it can. Each is refused in words, or runs and says of
itself that it has not got it.

## Validation and measurement

`sh test/muk.sh` compares native bundle behavior with runc when available; `hostile.sh` checks isolation refusals.
`same.sh` compares the C configuration parser with a test-only model (`test/asks.ts`), including truncated and
malformed input; `node --test test/*.test.ts` asks the model alone. The TypeScript model is not a second
production parser.

```
sh tool/profile.sh --lifecycle --memory --trials 9 --boxes 8
sh tool/profile.sh --parser
sh tool/profile.sh ./candidate --baseline ./baseline --lifecycle
```

The profiler emits raw JSON lines with source and artifact hashes, affinity and toolchain information. Startup is
first observed guest output, shutdown is stdin EOF to supervisor and known guest exit. PSS separates supervisor and
guest processes. An optional pre-existing exclusive cgroup supplies kernel memory; global memory fluctuations are
not attributed to boxes. Counts are bounded and cleanup signals only owned process groups and pidfds. Timing is
separate from security validation.
