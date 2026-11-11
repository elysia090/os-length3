# muk — the machine

An OCI-compatible VMM: an image's layers at rest, named by their digest, each byte fetched when it is first
touched, and a box run from them, as the OCI runtime says. No KVM and no Firecracker under it. On Linux the host's
kernel is the machine and a box is its namespaces (`src/muk.c`: C on `../lib` alone, with no C library, written
as `../you` is: what it does counted by hand first, then written until the counts are those). In a browser there
is no kernel to ask, so muk answers a box's system calls itself (`runtime/`), over the code sods makes.

```
muk run [-b BUNDLE] [--console-socket PATH] [ID]
                              the bundle's process, started and waited for; muk ends as it ends
sh test/bundle/muk.sh         the same bundles under muk and under runc: what each box says of itself, the same
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

What every box has, whatever config.json says. It may ask for more, never for less.

- **Namespaces.** Its mount, pid, ipc and uts namespaces are its own or another box's, never the host's (a box in
  the host's is refused); it has a cgroup namespace. The network is the one thing of the host's it may be given,
  by a config.json that names no network namespace.
- **Privilege.** It gains none by what it runs (no_new_privs, always). It has the capabilities config.json names
  and no others: none, where it names none. One that joins namespaces is not traceable, nor read through /proc,
  while it is still muk.
- **Devices.** A device is what muk made, in a /dev that is the box's own (a tmpfs, where config.json mounts
  none: nothing is made in the root's own files). The root is mounted nodev, so a device file an image holds is
  not one. A box makes none: CAP_MKNOD is refused but in a user namespace. `linux.resources.devices` that denies
  all is this; one that allows a device is refused.
- **The host's kernel.** Where a box is not in a user namespace, what of /proc and /sys tells of the host or
  changes it is hidden or read-only, listed by config.json or not (/proc/kcore, /proc/keys, /proc/sys,
  /proc/sysrq-trigger and the rest every runtime's defaults name).
- **What no box asks the kernel.** A filter over every call it makes (seccomp), there from the program's first
  instruction and for every process it starts: the host's kernel itself (kexec, reboot, modules), another
  process's memory (ptrace and its kin), the mounts, a namespace inside its own (unshare, setns, clone with any
  CLONE_NEW), bpf, perf_event_open, userfaultfd, the kernel's keys, typing into the terminal of the one who ran
  it, are refused as the kernel refuses one who may not; clone3 and io_uring, and every call of another ABI, as a
  kernel without them. 54 calls, made a tree: one that is none of them is found to be none in six comparisons.
- **What is asked and not done is refused**, by name: a seccomp filter of config.json's own, hooks that are there, cgroup
  limits and `cgroupsPath`, `sysctl`, `rootfsPropagation`, an AppArmor profile or SELinux label, `oomScoreAdj`,
  a mount given other owners, a mount namespace joined. A number is what it says or it is refused (a uid of
  4294967296 is not 0).

Where it reads config.json as runc does: null is a member not there, a member given twice is the second, a mount
on a link lands on what the link leads to (in the box), where it runs is made when nothing is there. Where it does
not: a mount's destination through a link that leads nowhere is refused (runc makes what it leads to).

`test/bundle/muk.sh` is the check: 140 as root, 81 as another user. The same bundles under runc where it runs
them (what each box says of itself the same, line for line, the floor said to runc in its config.json); what is
refused; every cut of a config.json and bytes changed in it (never a signal, never a wait); 24 runs at once on
one root; muk killed; a signal passed on; its three descriptors closed; every name of its tables; every call the
filter names, asked from inside a box; a terminal, its other end taken at a socket, beside runc's.

## Its counts

The bundle `runc spec` writes (2.6 KB of config.json: five namespaces, seven mounts, /dev filled, ten paths hidden
and five read-only, three capabilities), running `/bin/true`, as root, on one machine (Linux 6.18, a Firecracker
guest):

| | by hand | muk | runc 1.5.2 |
| --- | --- | --- | --- |
| system calls, the whole run | 117 | 123 | 5,761 |
| instructions in muk itself | 12,000 | 31,700 | (a Go runtime) |
| time, start to end | 1.9 ms | 2.0 ms | 24 ms |
| the program, its bytes | | 40 KB | 9.7 MB |
| muk's memory while its box runs | | 68 KB, 36 KB of it its own | |

By hand, the calls: the bundle read 5 (chdir, open, read, a read that says it was all, close); signals held, the
pipe, the clone 3. In the box: its end of the pipe closed, its end with muk's, muk's word, the mask 4; the root
made its own, bound, entered, turned, the host's let go 5; the seven mounts 7 and three directories made for them
in the new /dev 3; six devices and five names 11; where it runs 1; ten paths hidden 12 (two are directories here,
two calls each); five read-only 9 (one is not there); the root nodev and read-only 1; the mask back, the name, a
limit 3; the 38 capabilities it may never gain and the first past the kernel's last 39; groups and ids 3; the three
sets 1; no new privileges 1; its end with muk's again (who it is changed) 1; descriptors closed, signals as they
were, the filter, the program 4. Outside: muk's word, the wait, the box's end taken, muk's own 4. The six more muk makes are
HOME read from the box's /etc/passwd, as runc gives it (3), and the cgroup tree as a host with the old
hierarchies has it, bound with its flags (4 calls for 1). The time by hand is what the kernel takes for a clone
into six namespaces and two programs started, which nothing in muk can lower.

Instructions: reading config.json is all but 1,400 of them. It was 60,000 (23 a byte): a name looked for in its
list one name after another, a key compared letter by letter with each key it might be, what is between words
passed a byte at a time. Now a key is one comparison of words, a capability or an option one look in a table
made ahead (`src/slots.ts`), a string's end and a run of spaces found sixteen bytes at a time: 30,400 (12 a byte),
the same text written with no spaces 26,100, written wide 30,900. By hand it is 12,000: what is left over is a
call and its return for each of 150 strings and 100 members, which a reader written as one pass would not make.

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

A Prompt on Linux is still run by root3's core (`root3/core/src/prompt`: namespaces, the root under an overlay, a
seccomp filter, an init); the box becomes the bundle prompt writes for `muk run`, and what is left of it there
(the terminal's group, what is kept) is prompt's.
