/* The mandatory syscall policy and classic-BPF generation; no kernel calls or allocation. */
#pragma once
#include "../../lib/word.h"
#include "linux-abi.h"

/* ---- What no box asks the kernel: a filter over every call it makes (seccomp), there from its first instruction
 * and for every process it starts; nothing drops it, since nothing gains privilege (no_new_privs).
 *
 * Refused as the kernel refuses one who may not (EPERM): another process read or steered (ptrace,
 * process_vm_readv and writev, pidfd_getfd, process_madvise: the box's own included, so a tracer does not run in
 * one); the host's kernel itself (kexec, reboot, modules); the mounts, by the old calls and the new (the box's
 * tree is laid out once, before this); a namespace inside the box's (unshare, setns, clone with any CLONE_NEW:
 * a user namespace there is the kernel's whole surface again); bpf, perf_event_open, userfaultfd, the kernel's
 * keys, open_by_handle_at, quotas, swap, accounting, the kernel's log, vhangup, the clock set, and what only a
 * machine's owner does to x86 (iopl, ioperm, modify_ldt, uselib, _sysctl, nfsservctl); typing into a terminal or
 * pasting onto it (ioctl's TIOCSTI and TIOCLINUX: the terminal is the one who ran the box's, and its shell would
 * read it). Refused as a kernel without them does (ENOSYS), so a program takes its other way: clone3 (its flags
 * are where a filter cannot read them; clone, which is read, is what libc falls back to) and io_uring. Another
 * ABI than this machine's own (i386's and x32's calls) is ENOSYS for every call; and a socket of the kind a machine
 * talks to the one that runs it by (AF_VSOCK: it is in no namespace) is refused as a kernel without that kind does.
 *
 * And what this was not written against is not there to ask: a call numbered KNOWN or more (one a kernel newer
 * than the last read here has added) is ENOSYS, as on the kernel this was written against, until it has been read
 * and put among those refused or left to be asked. Every other call, each one read, is the box's to ask.
 *
 * The calls, in the order of their numbers: the filter is made from them as a tree, so a call that is none of
 * them is found to be none in six comparisons, not in fifty. */
enum { F_EPERM = 1, F_ENOSYS = 38, F_IOCTL = 200, F_CLONE = 201, F_SOCKET = 202 };
enum { KNOWN = 470 }; /* the first call's number that was not there to read when this was written (Linux 6.18's last is 469) */
static const struct { u16 nr; u8 how; } FILTER[] = {
  {16, F_IOCTL}, {41, F_SOCKET}, {56, F_CLONE},
  {101, F_EPERM}, /* ptrace */ {103, F_EPERM}, /* syslog */ {134, F_EPERM}, /* uselib */ {153, F_EPERM}, /* vhangup */
  {154, F_EPERM}, /* modify_ldt */ {155, F_EPERM}, /* pivot_root */ {156, F_EPERM}, /* _sysctl */
  {159, F_EPERM}, /* adjtimex */ {163, F_EPERM}, /* acct */ {164, F_EPERM}, /* settimeofday */ {165, F_EPERM}, /* mount */
  {166, F_EPERM}, /* umount2 */ {167, F_EPERM}, /* swapon */ {168, F_EPERM}, /* swapoff */ {169, F_EPERM}, /* reboot */
  {172, F_EPERM}, /* iopl */ {173, F_EPERM}, /* ioperm */ {175, F_EPERM}, /* init_module */
  {176, F_EPERM}, /* delete_module */ {179, F_EPERM}, /* quotactl */ {180, F_EPERM}, /* nfsservctl */
  {212, F_EPERM}, /* lookup_dcookie */ {227, F_EPERM}, /* clock_settime */ {246, F_EPERM}, /* kexec_load */
  {248, F_EPERM}, /* add_key */ {249, F_EPERM}, /* request_key */ {250, F_EPERM}, /* keyctl */ {272, F_EPERM}, /* unshare */
  {298, F_EPERM}, /* perf_event_open */ {304, F_EPERM}, /* open_by_handle_at */ {305, F_EPERM}, /* clock_adjtime */
  {308, F_EPERM}, /* setns */ {310, F_EPERM}, /* process_vm_readv */ {311, F_EPERM}, /* process_vm_writev */
  {313, F_EPERM}, /* finit_module */ {320, F_EPERM}, /* kexec_file_load */ {321, F_EPERM}, /* bpf */
  {323, F_EPERM}, /* userfaultfd */ {425, F_ENOSYS}, /* io_uring_setup */ {426, F_ENOSYS}, /* io_uring_enter */
  {427, F_ENOSYS}, /* io_uring_register */ {428, F_EPERM}, /* open_tree */ {429, F_EPERM}, /* move_mount */
  {430, F_EPERM}, /* fsopen */ {431, F_EPERM}, /* fsconfig */ {432, F_EPERM}, /* fsmount */ {433, F_EPERM}, /* fspick */
  {435, F_ENOSYS}, /* clone3 */ {438, F_EPERM}, /* pidfd_getfd */ {440, F_EPERM}, /* process_madvise */
  {442, F_EPERM}, /* mount_setattr */ {443, F_EPERM}, /* quotactl_fd */ {467, F_EPERM}, /* open_tree_attr */
};
enum { FILTERED = sizeof FILTER / sizeof FILTER[0] };
/* The kernel's own small machine for it (classic BPF): a word loaded of what is known of a call, compared, and an
 * answer given. */
struct bpf { u16 code; u8 jt, jf; u32 k; };
enum { LOAD = 0x20, JEQ = 0x15, JGE = 0x35, JSET = 0x45, RET = 0x06 };
enum { NR = 0, ARCH = 4, ARG0 = 16, ARG1 = 24 }; /* (where each is in what the kernel shows of a call; an argument's low half) */
#define ALLOW 0x7fff0000u
#define ERRNO(e) (0x00050000u | (e))
/* What one call's part of the filter is long, and the part itself: its number met, its answer; or, for the two
 * that are refused by what they are asked, the argument looked at. */
static u32 part(u32 i) { return FILTER[i].how == F_IOCTL ? 6 : FILTER[i].how >= F_CLONE ? 5 : 2; }
static u32 parts(u32 lo, u32 hi) {
  if (hi - lo <= 2) return (hi - lo == 2 ? part(lo) + part(lo + 1) : part(lo)) + 1;
  u32 mid = lo + (hi - lo) / 2;
  return 1 + parts(lo, mid) + parts(mid, hi);
}
static struct bpf *filter(struct bpf *p, u32 lo, u32 hi) {
  if (hi - lo > 2) { /* (the half its number is in: the lower one is next, the upper past it) */
    u32 mid = lo + (hi - lo) / 2;
    *p++ = (struct bpf){JGE, (u8)parts(lo, mid), 0, FILTER[mid].nr};
    return filter(filter(p, lo, mid), mid, hi);
  }
  for (u32 i = lo; i < hi; i++) {
    u32 nr = FILTER[i].nr, how = FILTER[i].how;
    if (how == F_IOCTL) {
      *p++ = (struct bpf){JEQ, 0, 5, nr}, *p++ = (struct bpf){LOAD, 0, 0, ARG1};
      *p++ = (struct bpf){JEQ, 1, 0, 0x5412 /* TIOCSTI */}, *p++ = (struct bpf){JEQ, 0, 1, 0x541c /* TIOCLINUX */};
      *p++ = (struct bpf){RET, 0, 0, ERRNO(EPERM)}, *p++ = (struct bpf){RET, 0, 0, ALLOW};
    } else if (how == F_CLONE) {
      *p++ = (struct bpf){JEQ, 0, 4, nr}, *p++ = (struct bpf){LOAD, 0, 0, ARG0};
      *p++ = (struct bpf){JSET, 0, 1, CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | 0x80 /* CLONE_NEWTIME */};
      *p++ = (struct bpf){RET, 0, 0, ERRNO(EPERM)}, *p++ = (struct bpf){RET, 0, 0, ALLOW};
    } else if (how == F_SOCKET) {
      *p++ = (struct bpf){JEQ, 0, 4, nr}, *p++ = (struct bpf){LOAD, 0, 0, ARG0};
      *p++ = (struct bpf){JEQ, 0, 1, 40 /* AF_VSOCK */};
      *p++ = (struct bpf){RET, 0, 0, ERRNO(EAFNOSUPPORT)}, *p++ = (struct bpf){RET, 0, 0, ALLOW};
    } else *p++ = (struct bpf){JEQ, 0, 1, nr}, *p++ = (struct bpf){RET, 0, 0, ERRNO(how)};
  }
  *p++ = (struct bpf){RET, 0, 0, ALLOW};
  return p;
}

static u32 filter_program(struct bpf *made) {
  struct bpf *p = made;
  *p++ = (struct bpf){LOAD, 0, 0, ARCH}, *p++ = (struct bpf){JEQ, 1, 0, 0xc000003e /* AUDIT_ARCH_X86_64 */};
  *p++ = (struct bpf){RET, 0, 0, ERRNO(F_ENOSYS)};
  *p++ = (struct bpf){LOAD, 0, 0, NR}, *p++ = (struct bpf){JGE, 0, 1, KNOWN /* (x32's calls, numbered from 0x40000000, among them) */};
  *p++ = (struct bpf){RET, 0, 0, ERRNO(F_ENOSYS)};
  p = filter(p, 0, FILTERED);
  return (u32)(p - made);
}
