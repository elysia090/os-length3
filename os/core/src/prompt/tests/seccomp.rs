//! The tests of run/seccomp.rs.

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

/// What an ioctl on `fd` answered, as -errno, or what it returned; `cmd` whole, its upper half too.
fn ioctl(fd: i32, cmd: u64, arg: *const libc::c_void) -> i64 {
    // SAFETY: an ioctl on a descriptor this child owns, its argument a live byte or winsize.
    let r = unsafe { libc::syscall(libc::SYS_ioctl, fd as libc::c_long, cmd as libc::c_long, arg) };
    if r == -1 { -(io::Error::last_os_error().raw_os_error().unwrap_or(0) as i64) } else { r }
}

#[test]
fn nothing_in_a_prompt_types_into_the_terminal_it_was_started_from() {
    // l3 prompt at a terminal hands the Prompt that terminal, which is its session's own: TIOCSTI on it puts
    // keys in its input as if typed, read by the person's shell once the Prompt ends (a way out of the
    // sandbox, as bubblewrap's CVE-2017-5226), and TIOCLINUX pastes on a console. Both are refused, by their
    // number in the low half of the argument as the kernel reads it (an `unsigned int`), whatever is above.
    let got = apart(|| {
        let (mut master, mut slave) = (-1, -1);
        // SAFETY: openpty into two ints; setsid in this forked child (no group leader); TIOCSCTTY on the
        // terminal it just made, which becomes its controlling one, as the person's is a Prompt's.
        unsafe {
            assert_eq!(libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), std::ptr::null()), 0);
            assert!(libc::setsid() > 0);
            assert_eq!(libc::ioctl(slave, libc::TIOCSCTTY as _, 0), 0);
        }
        let key = b'x';
        let sti = |cmd: u64| ioctl(slave, cmd, &key as *const u8 as *const libc::c_void);
        // As the filter reads them, 64 bits wide (libc's own type is a C long here, an int on musl).
        let (tiocsti, tioclinux): (u64, u64) = (libc::TIOCSTI as _, libc::TIOCLINUX as _);
        let before = sti(tiocsti);
        install_with(MARK as u16).expect("the filter installs");
        let after = [sti(tiocsti), sti(0xdead_beef_0000_0000 | tiocsti), sti(tioclinux)];
        // Every other ioctl is the kernel's to answer: a terminal's size is still read.
        // SAFETY: a winsize for TIOCGWINSZ to fill.
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        let size = ioctl(slave, libc::TIOCGWINSZ as _, &mut size as *mut libc::winsize as *const libc::c_void);
        vec![format!("{before} {} {} {} {size}", after[0], after[1], after[2])]
    });
    let v: Vec<i64> = got[0].split(' ').map(|n| n.parse().unwrap()).collect();
    // Without the filter the kernel takes it (or refuses it to everyone, where dev.tty.legacy_tiocsti is 0).
    assert!(v[0] == 0 || v[0] == -(libc::EIO as i64), "{v:?}");
    assert_eq!(&v[1..4], &[-(MARK as i64); 3], "TIOCSTI, TIOCSTI with high bits, TIOCLINUX: {v:?}");
    assert_eq!(v[4], 0, "TIOCGWINSZ: {v:?}");
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
