# muk — the machine

An OCI-compatible VMM: an image's layers at rest, named by their digest, each byte fetched when it is first
touched, and a box run from them, as the OCI runtime says. No KVM and no Firecracker under it. On Linux the host's
kernel is the machine and a box is its namespaces (`src/muk.c`: C on `../lib` alone, with no C library, written
as `../you` is: what it does counted by hand first, then written until the counts are those). In a browser there
is no kernel to ask, so muk answers a box's system calls itself (`runtime/`), over the code sods makes.

```
muk run [-b BUNDLE] [ID]      the bundle's process, started and waited for; muk ends as it ends
sh test/bundle/muk.sh         the same bundles under muk and under runc: what each box says of itself, the same
```

`src/muk.c` is all of it. config.json is read once, where it is (a string is used in its place in the text, a NUL
over its closing quote; nothing is copied, nothing allocated). One clone makes the box in its namespaces. In it the
root is bound on itself and made the root (pivot_root) before anything is mounted there, so a destination is a path
in the box's own root and a link the root holds leads nowhere outside it; what a bind takes from the host is opened
before the root changes (open_tree), while the host's paths still mean the host's. Then who the process is and what
it may do (groups, ids, capabilities, limits, no new privileges), and the program. muk waits for every signal
rather than taking any: one sent to it is passed on, the box's end is one of them, and the box ends with muk.

What it reads of config.json: `process` (args, env, cwd, user, capabilities, rlimits, noNewPrivileges), `root`,
`hostname`, `domainname`, `mounts` (every option mount(8) has; a bind made with its flags at once; a `cgroup`
mount as the box may have it), and of `linux` the namespaces (made, or joined by their path), uidMappings and
gidMappings, maskedPaths and readonlyPaths. What it does not do yet it refuses, never leaves out: a seccomp filter,
a terminal, hooks, a mount namespace joined. Not yet at all: cgroups (`linux.resources`), and `create`, `start`,
`state`, `kill`, `delete` apart from `run`.

## Its counts

The bundle `runc spec` writes (2.6 KB of config.json: five namespaces, seven mounts, /dev filled, ten paths hidden
and five read-only, three capabilities), running `/bin/true`, as root, on one machine (Linux 6.18, a Firecracker
guest):

| | by hand | muk | runc 1.5.2 |
| --- | --- | --- | --- |
| system calls, the whole run | 113 | 119 | 5,709 |
| instructions in muk itself | 20,000 | 50,000 | (a Go runtime) |
| time, start to end | 1.9 ms | 2.0 ms | 20 to 30 ms |
| the program, its bytes | | 32 KB | 9.7 MB |

By hand, the calls: the bundle read 4 (chdir, open, read, close); signals held 2; the clone 1. In the box: its end
with muk's 2 (set, and set again once who it is has changed), the mask 2, the root made its own and bound 2, the
old root kept in hand 1, the root turned 3, the seven mounts 7 and three directories made for them in the new
/dev 3, six devices and five names 11, the old root let go 1, ten paths hidden 12 (two are directories here, two
calls each), five read-only 9 (one is not there), the root read-only 1, the name 1, a limit 1, the 38 capabilities
it may never gain and the first past the kernel's last 39, groups and ids 3, the three sets 1, no new privileges 1,
where it runs 1, descriptors closed 1, signals as they were 1, the program 1. Outside: the wait 2, the end 1. The
six more muk makes are HOME read from the box's /etc/passwd, as runc gives it (3), and the cgroup tree as a host
with the old hierarchies has it, bound with its flags (4 calls for 1). The time by hand is what the kernel takes for
a clone into five namespaces and two programs started (1.9 ms here), which nothing in muk can lower.

Instructions: reading config.json is nearly all of it (46,000 of the 50,000). A string's end is found eight bytes
at a time; what is left over the 20,000 is finding a name in its list one name after another (15 capabilities among
41, 30 options among 34), which a table made ahead would do in a tenth.

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
seccomp filter, an init), which becomes the bundle root3 writes once `muk run` makes the filter and the terminal.
