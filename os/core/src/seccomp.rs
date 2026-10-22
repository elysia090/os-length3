//! What a Prompt's programs may not ask the kernel at all (launch.rs): a
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
    // SAFETY: prctl with integer arguments; PR_SET_SECCOMP reads `prog`, which (and the vector it points
    // into) lives across the call; the kernel copies the program.
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 { return Err(io::Error::last_os_error()); }
        if libc::prctl(libc::PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog as *const SockFprog as libc::c_ulong, 0, 0) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// The Prompt's filter (launch.rs), refusing with EPERM.
pub fn install() -> io::Result<()> { install_with(libc::EPERM as u16) }

#[cfg(test)]
mod tests {
    use super::*;

    /// No call answers this by itself: a refusal with it is the filter's.
    const MARK: i32 = libc::ENOTRECOVERABLE;

    /// `f` in a child of its own (the filter cannot be taken off again), its lines handed back.
    fn apart(f: impl FnOnce() -> Vec<String>) -> Vec<String> {
        let mut fds = [0; 2];
        // SAFETY: pipe, fork, write, _exit, read and waitpid with valid arguments; the child only runs `f`
        // and writes, then leaves without unwinding into the test harness.
        unsafe {
            assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
            let pid = libc::fork();
            assert!(pid >= 0);
            if pid == 0 {
                libc::close(fds[0]);
                // A panic here is the child's to end on, never to unwind into the test harness it was forked from.
                let Ok(lines) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) else { libc::_exit(101) };
                let out = lines.join("\n");
                libc::write(fds[1], out.as_ptr() as *const libc::c_void, out.len());
                libc::_exit(0);
            }
            libc::close(fds[1]);
            let mut text = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = libc::read(fds[0], buf.as_mut_ptr() as *mut libc::c_void, buf.len());
                if n <= 0 { break; }
                text.extend_from_slice(&buf[..n as usize]);
            }
            libc::close(fds[0]);
            let mut status = 0;
            libc::waitpid(pid, &mut status, 0);
            assert!(libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0, "the child ended with {status}");
            String::from_utf8(text).unwrap().lines().filter(|l| !l.is_empty()).map(String::from).collect()
        }
    }

    /// A call with all-zero arguments: what it answered, as -errno, or what it returned.
    fn call(nr: libc::c_long) -> i64 {
        // SAFETY: every call asked here with zero arguments either fails for a bad or absent argument, is
        // refused to an unprivileged caller, or does nothing (unshare(0), settimeofday(NULL, NULL)).
        let r = unsafe { libc::syscall(nr, 0, 0, 0, 0, 0, 0) };
        if r == -1 { -(io::Error::last_os_error().raw_os_error().unwrap_or(0) as i64) } else { r }
    }

    #[test]
    fn every_denied_call_is_refused_by_the_filter_and_every_absent_one_is_not_there() {
        let wrong = apart(|| {
            install_with(MARK as u16).expect("the filter installs");
            let mut wrong = Vec::new();
            for &nr in DENIED { let r = call(nr); if r != -(MARK as i64) { wrong.push(format!("denied {nr}: {r}")); } }
            for &nr in ABSENT { let r = call(nr); if r != -(libc::ENOSYS as i64) { wrong.push(format!("absent {nr}: {r}")); } }
            // clone into any new namespace: refused; a plain fork still works.
            for flag in [libc::CLONE_NEWUSER, libc::CLONE_NEWNS, libc::CLONE_NEWPID, libc::CLONE_NEWNET, libc::CLONE_NEWUTS, libc::CLONE_NEWIPC, libc::CLONE_NEWCGROUP] {
                // SAFETY: clone with a namespace flag and SIGCHLD, no new stack: refused before it runs; if it ran, the child leaves at once.
                let r = unsafe { libc::syscall(libc::SYS_clone, (flag | libc::SIGCHLD) as libc::c_long, 0, 0, 0, 0) };
                if r == 0 { unsafe { libc::_exit(0) } }
                let e = io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if r != -1 || e != MARK { wrong.push(format!("clone {flag:#x}: {r} {e}")); }
            }
            wrong
        });
        assert_eq!(wrong, Vec::<String>::new());
    }

    #[test]
    fn what_a_shell_a_compiler_and_the_network_use_is_still_allowed() {
        let wrong = apart(|| {
            install_with(MARK as u16).expect("the filter installs");
            let mut wrong = Vec::new();
            // SAFETY: plain calls with valid arguments; the forked child leaves at once.
            unsafe {
                if libc::getpid() <= 0 { wrong.push("getpid".into()); }
                let pid = libc::fork();
                if pid == 0 { libc::_exit(7); }
                let mut status = 0;
                if pid < 0 || libc::waitpid(pid, &mut status, 0) != pid || libc::WEXITSTATUS(status) != 7 { wrong.push(format!("fork {pid}")); }
                for (domain, kind) in [(libc::AF_UNIX, libc::SOCK_STREAM), (libc::AF_INET, libc::SOCK_STREAM), (libc::AF_INET6, libc::SOCK_DGRAM)] {
                    let s = libc::socket(domain, kind, 0);
                    // A family this host has not (IPv6 off) is refused by the host, not the filter.
                    let host = || io::Error::last_os_error().raw_os_error() == Some(libc::EAFNOSUPPORT);
                    if s < 0 && !host() { wrong.push(format!("socket {domain}")); } else if s >= 0 { libc::close(s); }
                }
                let m = libc::mmap(std::ptr::null_mut(), 4096, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_PRIVATE | libc::MAP_ANONYMOUS, -1, 0);
                if m == libc::MAP_FAILED { wrong.push("mmap".into()); } else { libc::munmap(m, 4096); }
                if libc::chdir(c"/".as_ptr()) != 0 { wrong.push("chdir".into()); }
            }
            if std::fs::read("/proc/self/status").is_err() { wrong.push("open".into()); }
            if std::thread::spawn(|| 1).join().ok() != Some(1) { wrong.push("thread".into()); }
            wrong
        });
        assert_eq!(wrong, Vec::<String>::new());
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn another_abi_answers_nothing() {
        let got = apart(|| {
            // Before the filter: the i386 getpid (20) through int 0x80 answers this pid (where the kernel has IA32 emulation).
            let before = i386_getpid();
            install_with(MARK as u16).expect("the filter installs");
            let after = i386_getpid();
            // x32's getpid: its number with the x32 bit.
            let x32 = call(X32_BIT as libc::c_long | libc::SYS_getpid);
            vec![format!("{before} {after} {x32}")]
        });
        let v: Vec<i64> = got[0].split(' ').map(|n| n.parse().unwrap()).collect();
        assert!(v[0] > 0 || v[0] == -(libc::ENOSYS as i64), "{v:?}");
        assert_eq!(v[1], -(libc::ENOSYS as i64), "the i386 ABI is refused: {v:?}");
        assert_eq!(v[2], -(libc::ENOSYS as i64), "the x32 ABI is refused: {v:?}");
    }

    #[cfg(target_arch = "x86_64")]
    fn i386_getpid() -> i64 {
        let mut eax: i64 = 20;
        // SAFETY: int 0x80 with eax = 20 (i386 getpid), which takes no arguments and touches no memory.
        unsafe { std::arch::asm!("int 0x80", inout("rax") eax, options(nostack)) };
        eax as i32 as i64
    }

    #[test]
    fn the_prompts_filter_refuses_as_the_kernel_refuses_the_unprivileged() {
        // ptrace(PTRACE_TRACEME) is allowed to anyone by the kernel: without the filter it answers 0.
        let without = apart(|| vec![call(libc::SYS_ptrace).to_string()]);
        assert_eq!(without, vec!["0"]);
        let with = apart(|| { install().expect("the filter installs"); vec![call(libc::SYS_ptrace).to_string(), call(libc::SYS_unshare).to_string()] });
        assert_eq!(with, vec![(-libc::EPERM).to_string(), (-libc::EPERM).to_string()]);
    }
}
