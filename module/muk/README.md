# muk — the machine

An OCI-compatible VMM: an image's layers at rest, named by their digest, each byte fetched when it is first
touched, and a box run from them, as the OCI runtime says. No KVM and no Firecracker under it. On Linux the host's
kernel is the machine and a box is its namespaces (`src/muk.c`: C on `../lib` alone, with no C library, written
as `../you` is: what it does counted by hand first, then written until the counts are those). In a browser there
is no kernel to ask, so muk answers a box's system calls itself (`runtime/`), over the code sods makes.

```
muk run [-b BUNDLE] [--console-socket PATH] [--lend PATH]... [--ids FIRST-LAST] [--cgroup DIR] [ID]
                              the bundle's process, started and waited for; muk ends as it ends
sh test/bundle/muk.sh         the same bundles under muk and under runc: what each box says of itself, the same
sh test/bundle/hostile.sh     a config.json written against muk, every way it has: refused, or a box without it
```

**Where muk ends.** A run is a box's whole life here: muk names no box, keeps none beyond its run, lists none, and
writes nothing about one. A terminal is a device of the box, so muk makes it where only it can (in the box's own
/dev/pts, when config.json asks: `process.terminal`, with its `consoleSize`), makes it the box's (its three
descriptors, its session's terminal, /dev/console), and gives its other end away whole: one descriptor sent to the
one listening at `--console-socket`, and closed. With no one to take it there is no terminal. What is typed and
shown there, its size as it changes, who is at it, a box left and come back to, a box that outlives what started
it: those are the Prompt's ([`../prompt`](../prompt/README.md)), which takes muk and which muk knows nothing of.

`src/muk.c` is all of it. config.json is read once, where it is (a string is used in its place in the text, a NUL
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
  box makes none (CAP_MKNOD is of a user namespace), and `linux.devices`, or a device allowed in
  `linux.resources.devices`, is refused. Its terminals are 256 at most, whatever its devpts asks for: they are
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

`test/bundle/muk.sh` is the check beside runc: 140 as root, 81 as another user. The same bundles under runc where
it runs them (what each box says of itself the same, line for line, the floor said to runc in its config.json,
and what runc is given by being run, lent); what is refused; every cut of a config.json and bytes changed in it
(never a signal, never a wait); 24 runs at once on one root; muk killed; a signal passed on; its three
descriptors closed; every name of its tables; every call the filter names, asked from inside a box; a terminal,
its other end taken at a socket, beside runc's.

`test/bundle/hostile.sh` is the check against a config.json that means harm: 255 as root, 63 as another user,
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

## Its counts

The bundle `runc spec` writes (2.6 KB of config.json: five namespaces, seven mounts, /dev filled, ten paths hidden
and five read-only, three capabilities), running `/bin/true`, as root, on one machine (Linux 6.18, a Firecracker
guest):

| | by hand | muk | runc 1.5.2 |
| --- | --- | --- | --- |
| system calls, the whole run | 121 | 127 | 5,761 |
| instructions in muk itself | 12,000 | 31,400 | (a Go runtime) |
| time, start to end | 1.9 ms | 2.0 ms | 23 ms |
| the program, its bytes | | 49 KB | 9.7 MB |
| muk's memory while its box runs | | 68 KB, 36 KB of it its own | |

By hand, the calls: the bundle read 5 (chdir, open, read, a read that says it was all, close); signals held, the
pipe, the clone 3. In the box: its end of the pipe closed, its end with muk's, muk's word, the mask 4; the root
made its own, opened (as the kernel keeps it in the bundle), copied, put on itself, entered, turned, the host's let
go 7; the seven mounts 7 and three directories made for them
in the new /dev 3; six devices and five names 11; where it runs 1; twelve paths hidden 14 (the floor's two that `runc spec` does not
name among them; two are directories here, two calls each); five read-only 9 (one is not there); the root nodev and read-only 1; the mask back, the name, a
limit 3; the 38 capabilities it may never gain and the first past the kernel's last 39; groups and ids 3; the three
sets 1; no new privileges 1; its end with muk's again (who it is changed) 1; descriptors closed, signals as they
were, the filter, the program 4. Outside: muk's word, the wait, the box's end taken, muk's own 4. The six more muk makes are
HOME read from the box's /etc/passwd, as runc gives it (3), and the cgroup tree as a host with the old
hierarchies has it, bound with its flags (4 calls for 1). The time by hand is what the kernel takes for a clone
into six namespaces and two programs started, which nothing in muk can lower.

Instructions: reading config.json is all but 1,400 of them. It was 60,000 (23 a byte): a name looked for in its
list one name after another, a key compared letter by letter with each key it might be, what is between words
passed a byte at a time. Now a key is one comparison of words (two for a long one), a capability, an option or one
of the floor's paths one look in a table made ahead (`src/slots.ts`), a string's end and a run of spaces found
sixteen bytes at a time, a string with no escape read where it is asked for: 27,400 (11 a byte), the same text
written with no spaces 22,500. By hand it is 12,000: what is left over is what each of 150 strings and 100 members
still costs around its bytes (a word looked for before it, its length kept, its key made a word), which a reader
written as one pass over the text would not pay.

## At density

`sh test/bundle/dense.sh [N]`: N boxes of one bundle at once (the mounts and hidden paths `runc spec` writes, a
root not written to, each box in namespaces of its own, a network namespace among them), started together, left
waiting, ended together. 1,000 of them, on the same machine (4 processors, 16 GB):

| 1,000 boxes at once | muk, the host's root | muk, users of its own | runc 1.5.2 |
| --- | --- | --- | --- |
| until the last has started | 0.69 s | 0.70 s | 8.8 s |
| a box, of the machine's memory | 388 KB | 407 KB | 1,056 KB |
| of that, its processes' own | 59 KB | 59 KB | 6 KB |
| of that, the kernel's for it | 329 KB | 348 KB | 1,050 KB |
| until the last is gone | 1.2 s | 1.7 s | 1.3 s |

1,450 boxes a second on four processors, 0.4 MB each: what the kernel takes for a box's namespaces (its network
namespace most of all) and mounts is four fifths of it, and is the floor of a box made this way. Its processes'
own is muk's 53 KB and the waiting program's 6: runc is started detached here, so nothing of it stays with a
box, and what it leaves in the kernel beside the same namespaces is the cgroups it makes for each (muk makes
none: a box's cgroup is the lender's, `--cgroup`). The muk that stays with each box is the seam still to be cut
([`../prompt`](../prompt/README.md)): a box's end is waited for by one keeper for all, not by one muk each.

## In a browser

There the machine is muk's too: `runtime/` answers a box's system calls itself (TypeScript, for now, and far from
its bound: docs/STRUCTURE.md), over the code sods makes of the box's programs.

- Processes run at once, as on Linux: fork returns in the parent at once; a
  call that must wait (input not typed yet, a child still running, a full
  pipe) leaves its thread waiting, and muk makes it again when
  something changed.
- Threads (clone with CLONE_VM) share their process's memory, with futexes,
  robust lists and a tid cleared at exit.
- Signals reach handlers through an rt_sigframe that rt_sigreturn reads back
  (masks, SA_SIGINFO, SA_RESTART, sigaltstack).
- Pipes hold 64 KiB in pages as Linux's do, and a full one makes its writer
  wait.
- Threads run here one at a time (each until it waits, or for a time slice
  taken at its calls), or each in its own Worker with memory shared, when the
  host allows SharedArrayBuffer (`runtime/remote.ts`). There a write to the
  console, as a read of the clock, is done in the thread's own Worker (into an
  outbox muk takes from, `runtime/channel.ts`), not asked of muk
  a line at a time.

The code it runs is sods' (`../sods`). What it reads at rest are a root's layers: a file's bytes by a Range of its
pack, used only once they are what the pack's table says (`runtime/pack.ts`, `runtime/table.ts`), put in its tree
(`runtime/mount.ts`; a repo kept in step with the outside, `runtime/mirror.ts`), and the copies kept between runs,
sealed by their digest (`runtime/keeper.ts`; what a translation's copy holds is sods' `kept.ts`). The tree is to be
`src/tree.h`: a root's index as bytes, used where it is, which says what Linux says of every name of a whole root
(`test/tree`); the calls do not walk it yet.

```
node runtime/run.ts PROGRAM [args...]            # host ELF as /bin/PROGRAM
node runtime/run.ts --root DIR /bin/sh -c '...'  # a host tree as /
sh test/programs/run.sh                          # native vs translated, and the unit tests
node test/floors/floors.ts                       # each floor beside Linux
sh test/tree/tree.sh [DIR]                       # the tree (src/tree.h) beside Linux, every name of a directory
```

A Prompt on Linux is still run by why's core (`why/core/src/prompt`: namespaces, the root under an overlay, a
seccomp filter, an init); the box becomes the bundle prompt writes for `muk run`, and what is left of it there
(the terminal's group, what is kept) is prompt's.
