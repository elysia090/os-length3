//! What a Prompt's programs may not ask the kernel at all (prompt/launch.rs): a
//! seccomp filter over the namespaces, so that what the user namespace makes
//! "root" cannot reach the parts of the kernel a sandboxed program has no
//! use for, and that are where escapes are found. It is installed in the
//! Prompt's pid 1 once the root is laid out, before anything of the root's
//! runs, and every process of the Prompt inherits it; no_new_privs is set
//! first, so nothing can drop it (an exec of a setuid file gains nothing).
//!
//! Refused with EPERM, as the kernel refuses an unprivileged caller:
//!   ptrace, process_vm_readv/writev, pidfd_getfd, process_madvise (reading
//!     or steering another process: the Prompt's own included, so strace and
//!     gdb do not run in a Prompt)
//!   kexec_load, kexec_file_load, reboot; init_module, finit_module,
//!     delete_module (the host's kernel itself)
//!   mount, umount2, pivot_root and the new mount API (open_tree, move_mount,
//!     fsopen, fsconfig, fsmount, fspick, mount_setattr): the Prompt's tree
//!     is laid out once, before this, and not changed from inside
//!   unshare, setns, and clone with any CLONE_NEW* flag (a namespace inside
//!     the Prompt's is a user namespace's whole surface again)
//!   bpf, perf_event_open, userfaultfd, keyctl, add_key, request_key,
//!     lookup_dcookie, open_by_handle_at, quotactl, quotactl_fd, swapon,
//!     swapoff, acct, syslog, vhangup, settimeofday, clock_settime,
//!     clock_adjtime, adjtimex, and on x86-64 iopl, ioperm, modify_ldt,
//!     uselib, _sysctl, nfsservctl
//!   ioctl's TIOCSTI and TIOCLINUX (typing into, or pasting onto, a
//!     terminal: root3 prompt at a terminal hands the Prompt the person's own,
//!     whose shell would read what was pushed once the Prompt ends)
//! Refused with ENOSYS, so a program takes its other way, as on a kernel
//! without them: clone3 (its flags cannot be read by a filter; libc falls
//! back to clone, which is checked), io_uring_setup/enter/register.
//! Another ABI than the native one (x86-64's i386 and x32 calls) is ENOSYS
//! for every call: a Prompt's root is the native ABI's alone.
//!
//! Everything else is allowed: a shell, compilers, package managers, the
//! network when the Prompt is granted it. The filter is a classic BPF
//! program built here (no dependency): a list of comparisons, read top to
//! bottom.

use std::io;

#[repr(C)]
struct SockFilter { code: u16, jt: u8, jf: u8, k: u32 }
#[repr(C)]
struct SockFprog { len: u16, filter: *const SockFilter }

// Classic BPF (linux/filter.h) and seccomp (linux/seccomp.h).
const LD_W_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
const JEQ_K: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
// Only x86-64 has a second ABI (x32) to turn away by its syscall numbers' bit.
#[cfg(target_arch = "x86_64")]
const JGE_K: u16 = 0x35; // BPF_JMP | BPF_JGE | BPF_K
const JSET_K: u16 = 0x45; // BPF_JMP | BPF_JSET | BPF_K
const RET_K: u16 = 0x06; // BPF_RET | BPF_K
const RET_ALLOW: u32 = 0x7fff_0000;
const RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_MODE_FILTER: libc::c_ulong = 2;
// struct seccomp_data: nr (u32), arch (u32), instruction_pointer (u64), args[6] (u64 each).
const NR: u32 = 0;
const ARCH: u32 = 4;
/// The low 32 bits of the first argument (little-endian): clone's flags.
const ARG0_LOW: u32 = 16;
/// The low 32 bits of the second argument: an ioctl's request, which the kernel takes as an `unsigned int`.
const ARG1_LOW: u32 = 24;

/// The ioctl requests that put input into a terminal: TIOCSTI (a byte into its input, as if typed) and TIOCLINUX
/// (a console's selection pasted, among others). The terminal root3 prompt runs in is the person's, the controlling
/// one of the session their shell is in; a byte pushed into it is read by that shell once the Prompt ends.
const TERMINAL_INPUT: [u32; 2] = [libc::TIOCSTI as u32, libc::TIOCLINUX as u32];

#[cfg(target_arch = "x86_64")]
const NATIVE: u32 = 0xc000_003e; // AUDIT_ARCH_X86_64
#[cfg(target_arch = "aarch64")]
const NATIVE: u32 = 0xc000_00b7; // AUDIT_ARCH_AARCH64
/// x32's calls are x86-64's numbers with this bit set.
#[cfg(target_arch = "x86_64")]
const X32_BIT: u32 = 0x4000_0000;

/// Every CLONE_NEW* flag: NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID, NEWNET (and NEWTIME's bit, 0x80).
const NEW_NAMESPACE: u32 = (libc::CLONE_NEWNS | libc::CLONE_NEWCGROUP | libc::CLONE_NEWUTS | libc::CLONE_NEWIPC
    | libc::CLONE_NEWUSER | libc::CLONE_NEWPID | libc::CLONE_NEWNET) as u32 | 0x80;

/// Refused as an unprivileged caller is (the errno the filter is built with: EPERM).
pub const DENIED: &[libc::c_long] = &[
    libc::SYS_ptrace, libc::SYS_process_vm_readv, libc::SYS_process_vm_writev, libc::SYS_pidfd_getfd, libc::SYS_process_madvise,
    libc::SYS_kexec_load, libc::SYS_kexec_file_load, libc::SYS_reboot,
    libc::SYS_init_module, libc::SYS_finit_module, libc::SYS_delete_module,
    libc::SYS_mount, libc::SYS_umount2, libc::SYS_pivot_root, libc::SYS_open_tree, libc::SYS_move_mount,
    libc::SYS_fsopen, libc::SYS_fsconfig, libc::SYS_fsmount, libc::SYS_fspick, libc::SYS_mount_setattr,
    libc::SYS_unshare, libc::SYS_setns,
    libc::SYS_bpf, libc::SYS_perf_event_open, libc::SYS_userfaultfd, libc::SYS_keyctl, libc::SYS_add_key, libc::SYS_request_key,
    libc::SYS_lookup_dcookie, libc::SYS_open_by_handle_at, libc::SYS_quotactl, libc::SYS_quotactl_fd,
    libc::SYS_swapon, libc::SYS_swapoff, libc::SYS_acct, libc::SYS_syslog, libc::SYS_vhangup,
    libc::SYS_settimeofday, libc::SYS_clock_settime, libc::SYS_clock_adjtime, libc::SYS_adjtimex,
    #[cfg(target_arch = "x86_64")] libc::SYS_iopl,
    #[cfg(target_arch = "x86_64")] libc::SYS_ioperm,
    #[cfg(target_arch = "x86_64")] libc::SYS_modify_ldt,
    #[cfg(target_arch = "x86_64")] libc::SYS_uselib,
    #[cfg(target_arch = "x86_64")] libc::SYS__sysctl,
    #[cfg(target_arch = "x86_64")] libc::SYS_nfsservctl,
];

/// Not there, as on a kernel without them: a program takes its other way.
pub const ABSENT: &[libc::c_long] = &[libc::SYS_clone3, libc::SYS_io_uring_setup, libc::SYS_io_uring_enter, libc::SYS_io_uring_register];

const fn op(code: u16, k: u32, jt: u8, jf: u8) -> SockFilter { SockFilter { code, jt, jf, k } }

/// The program: refusing with `errno` what DENIED names (and clone into a new namespace), ENOSYS for ABSENT and any other ABI.
fn program(errno: u16) -> Vec<SockFilter> {
    let deny = RET_ERRNO | errno as u32;
    let absent = RET_ERRNO | libc::ENOSYS as u32;
    let mut p = vec![
        op(LD_W_ABS, ARCH, 0, 0),
        op(JEQ_K, NATIVE, 1, 0),
        op(RET_K, absent, 0, 0),
        op(LD_W_ABS, NR, 0, 0),
    ];
    #[cfg(target_arch = "x86_64")]
    p.extend([op(JGE_K, X32_BIT, 0, 1), op(RET_K, absent, 0, 0)]);
    for &nr in DENIED {
        p.extend([op(JEQ_K, nr as u32, 0, 1), op(RET_K, deny, 0, 0)]);
    }
    for &nr in ABSENT {
        p.extend([op(JEQ_K, nr as u32, 0, 1), op(RET_K, absent, 0, 0)]);
    }
    // ioctl: refused for what types into or pastes onto a terminal (TERMINAL_INPUT); every other request is the kernel's.
    // The request is read as the kernel reads it, the low half of the argument, so bits above it change nothing.
    p.extend([
        op(JEQ_K, libc::SYS_ioctl as u32, 0, 5),
        op(LD_W_ABS, ARG1_LOW, 0, 0),
        op(JEQ_K, TERMINAL_INPUT[0], 2, 0),
        op(JEQ_K, TERMINAL_INPUT[1], 1, 0),
        op(RET_K, RET_ALLOW, 0, 0),
        op(RET_K, deny, 0, 0),
    ]);
    // clone: refused if its flags ask for any new namespace; else allowed (fork, threads).
    p.extend([
        op(JEQ_K, libc::SYS_clone as u32, 0, 4),
        op(LD_W_ABS, ARG0_LOW, 0, 0),
        op(JSET_K, NEW_NAMESPACE, 0, 1),
        op(RET_K, deny, 0, 0),
        op(RET_K, RET_ALLOW, 0, 0),
    ]);
    p.push(op(RET_K, RET_ALLOW, 0, 0));
    p
}

/// Install the filter on this process (and so on everything it starts), refusing with `errno`; no_new_privs first.
/// Production refuses with EPERM (`install`); the tests build it with an errno no call answers by itself, so
/// each refusal is seen to be the filter's.
pub fn install_with(errno: u16) -> io::Result<()> {
    let p = program(errno);
    let prog = SockFprog { len: p.len() as u16, filter: p.as_ptr() };
    rustix::thread::set_no_new_privs(true)?;
    // SAFETY: PR_SET_SECCOMP reads `prog`, which (and the vector it points into) lives across the call; the kernel
    // copies the program. No safe call installs a filter.
    if unsafe { libc::prctl(libc::PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog as *const SockFprog as libc::c_ulong, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The Prompt's filter (prompt/launch.rs), refusing with EPERM.
pub fn install() -> io::Result<()> { install_with(libc::EPERM as u16) }

#[cfg(test)]
#[path = "seccomp.test.rs"]
mod tests;
