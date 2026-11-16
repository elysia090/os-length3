use super::*;

fn fresh(tag: &str) -> PathBuf {
    static MADE: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!("ricebox-run-test-{}-{tag}-{}", std::process::id(), MADE.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// This machine makes a box, or says in muk's own words why not: asked of muk itself, with nothing but muk in the box.
#[test]
fn whether_a_box_can_be_made_here_is_asked_of_muk() {
    match no_box() {
        None | Some(NoBox::NotThisMachine) => {}
        Some(NoBox::NoMuk(why)) => panic!("muk was not built with this crate: {why}"),
        Some(NoBox::Refused(why)) => assert!(why.contains("muk"), "{why}"),
    }
}

#[test]
fn a_link_into_run_is_followed_inside_the_root() {
    assert_eq!(clean(Path::new("/etc/../run/systemd/resolve/stub-resolv.conf")), Path::new("/run/systemd/resolve/stub-resolv.conf"));
    assert_eq!(clean(Path::new("/etc/../../../run/x")), Path::new("/run/x"));
    let top = fresh("resolver");
    let _ = std::fs::remove_dir_all(&top);
    std::fs::create_dir_all(top.join("etc")).unwrap();
    assert_eq!(resolver_inside(&top), None);
    std::os::unix::fs::symlink("../run/systemd/resolve/stub-resolv.conf", top.join("etc/resolv.conf")).unwrap();
    assert_eq!(resolver_inside(&top).as_deref(), Some("/run/systemd/resolve/stub-resolv.conf"));
    std::fs::remove_file(top.join("etc/resolv.conf")).unwrap();
    std::os::unix::fs::symlink("/var/elsewhere", top.join("etc/resolv.conf")).unwrap();
    assert_eq!(resolver_inside(&top), None);
    std::fs::remove_file(top.join("etc/resolv.conf")).unwrap();
    std::fs::write(top.join("etc/resolv.conf"), "").unwrap();
    assert_eq!(resolver_inside(&top).as_deref(), Some("/etc/resolv.conf"));
    let _ = std::fs::remove_dir_all(&top);
}

#[test]
fn a_tree_is_copied_as_it_is_a_file_of_several_names_one_file_still() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let top = fresh("copy");
    let _ = std::fs::remove_dir_all(&top);
    let (from, to) = (top.join("from"), top.join("to"));
    std::fs::create_dir_all(from.join("usr/bin")).unwrap();
    std::fs::write(from.join("usr/bin/busybox"), "elf").unwrap();
    std::fs::set_permissions(from.join("usr/bin/busybox"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::hard_link(from.join("usr/bin/busybox"), from.join("usr/bin/ls")).unwrap();
    std::os::unix::fs::symlink("usr/bin", from.join("bin")).unwrap();
    std::fs::set_permissions(from.join("usr"), std::fs::Permissions::from_mode(0o750)).unwrap();
    copy_root(&from, &to).unwrap();
    let (a, b) = (std::fs::metadata(to.join("usr/bin/busybox")).unwrap(), std::fs::metadata(to.join("usr/bin/ls")).unwrap());
    assert_eq!((a.ino(), a.nlink(), a.mode() & 0o777), (b.ino(), 2, 0o755));
    assert_ne!(a.ino(), std::fs::metadata(from.join("usr/bin/busybox")).unwrap().ino(), "a copy, not the root's own file");
    assert_eq!(std::fs::read_link(to.join("bin")).unwrap(), Path::new("usr/bin"));
    assert_eq!(std::fs::metadata(to.join("usr")).unwrap().mode() & 0o777, 0o750);
    let _ = std::fs::remove_dir_all(&top);
}

/// `f` in a process of its own (a box is run by a process with one thread: it waits for any child): what it
/// returned as its exit code.
fn apart(f: impl FnOnce() -> i32) -> i32 {
    // SAFETY: the child goes on with this thread alone, runs the box and leaves with _exit.
    let pid = unsafe { libc::fork() };
    // SAFETY: as above; _exit after a fork.
    if pid == 0 { unsafe { libc::_exit(f()) } }
    let mut status = 0;
    // SAFETY: waitpid on a child of this test.
    unsafe { libc::waitpid(pid, &mut status, 0) };
    if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { -1 }
}

/// Run `script` in a box on a root made of this host's own /usr and /etc (lent as they are, to read), a directory
/// of the test's at /root/t; what it wrote to /root/t/out. None where this host makes no box, or lacks a compiler
/// or Python.
fn box_on_this_host(script: &str, network: bool) -> Option<String> {
    if !Path::new("/usr/bin/cc").exists() || !Path::new("/usr/bin/python3").exists() || no_box().is_some() { return None; }
    let top = fresh("box");
    let (root, home, work) = (top.join("root"), top.join("home"), top.join("work"));
    for d in ["usr", "etc", "root", "tmp", "run", "dev", "proc"] { std::fs::create_dir_all(root.join(d)).ok()?; }
    for (link, to) in [("bin", "usr/bin"), ("sbin", "usr/sbin"), ("lib", "usr/lib"), ("lib64", "usr/lib64")] {
        std::os::unix::fs::symlink(to, root.join(link)).ok()?;
    }
    std::fs::create_dir_all(&home).ok()?;
    std::fs::create_dir_all(&work).ok()?;
    let lend = |inside: &str, from: &Path, read_only: bool| Bind { inside: inside.into(), from: from.to_string_lossy().into_owned(), read_only };
    let binds = [lend("usr", Path::new("/usr"), true), lend("etc", Path::new("/etc"), true), lend("root", &home, false), lend("root/t", &work, false)];
    let cmd = ["/bin/sh".to_string(), "-c".into(), script.into()];
    let asked = Asked { root: &root, written: false, other: false, binds: &binds, network, cmd: &cmd, cwd: "/root/t", hostname: "box", more: &[], dir: &top.join("bundle"), id: "t" };
    let code = apart(|| run(&asked).unwrap_or_else(|e| { eprintln!("{e}"); 200 }));
    let out = std::fs::read_to_string(work.join("out")).ok();
    assert!(!top.join("bundle").exists(), "the bundle is gone with the box");
    let _ = std::fs::remove_dir_all(&top);
    assert_eq!(code, 0, "the box ended with {code}; it wrote: {out:?}");
    out
}

/// Calls muk's filter refuses, asked from Python inside the box (x86-64 numbers), each line `name result errno`.
#[cfg(target_arch = "x86_64")]
const ASK: &str = r#"
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
for name, nr, args in [('ptrace', 101, (0, 0, 0, 0)), ('mount', 165, (0, 0, 0, 0, 0)), ('umount2', 166, (0, 0)),
        ('unshare', 272, (0x10000000,)), ('setns', 308, (0, 0)), ('kexec_load', 246, (0, 0, 0, 0)), ('init_module', 175, (0, 0, 0)),
        ('finit_module', 313, (0, 0, 0)), ('bpf', 321, (0, 0, 0)), ('perf_event_open', 298, (0, 0, -1, -1, 0)),
        ('keyctl', 250, (0, 0, 0, 0, 0)), ('add_key', 248, (0, 0, 0, 0, 0)), ('userfaultfd', 323, (0,)),
        ('open_by_handle_at', 304, (0, 0, 0)), ('clone_newuser', 56, (0x10000000 | 17, 0, 0, 0, 0)),
        ('clone3', 435, (0, 0)), ('io_uring_setup', 425, (1, 0)), ('fsopen', 430, (0, 0)), ('pivot_root', 155, (0, 0))]:
    r = libc.syscall(nr, *args)
    print(name, r, ctypes.get_errno())
"#;

/// A root run here is in a box muk made: its programs run, and what muk's filter names (module/muk/src/filter.h) no
/// program in it asks the kernel.
#[cfg(target_arch = "x86_64")]
#[test]
fn a_box_runs_a_shell_and_a_compiler_and_asks_the_kernel_nothing_muks_filter_names() {
    let script = format!(r#"
out=/root/t/out
echo shell ok > $out
printf 'int main(void) {{ return 42; }}\n' > /tmp/a.c && cc /tmp/a.c -o /tmp/a; /tmp/a; echo "cc $?" >> $out
cat > /tmp/ask.py <<'PY'
{ASK}
PY
python3 /tmp/ask.py >> $out 2>&1
grep '^Seccomp:' /proc/self/status >> $out
grep '^NoNewPrivs:' /proc/self/status >> $out
unshare -U true 2>/dev/null; echo "unshare-command $?" >> $out
echo "host $(hostname) pwd $PWD home $HOME pid $$" >> $out
touch /usr/x 2>/dev/null; echo "root-written $?" >> $out
"#);
    let Some(out) = box_on_this_host(&script, false) else { eprintln!("skipped: no box, compiler or Python here"); return };
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], "shell ok");
    assert!(lines.contains(&"cc 42"), "{out}");
    assert!(lines.contains(&"Seccomp:\t2") && lines.contains(&"NoNewPrivs:\t1"), "the box's processes are filtered: {out}");
    assert!(lines.iter().any(|l| l.starts_with("unshare-command ") && *l != "unshare-command 0"), "{out}");
    assert!(lines.contains(&"host box pwd /root/t home /root pid 1"), "{out}");
    for (name, errno) in [("ptrace", libc::EPERM), ("mount", libc::EPERM), ("umount2", libc::EPERM), ("unshare", libc::EPERM), ("setns", libc::EPERM),
        ("kexec_load", libc::EPERM), ("init_module", libc::EPERM), ("finit_module", libc::EPERM), ("bpf", libc::EPERM), ("perf_event_open", libc::EPERM),
        ("keyctl", libc::EPERM), ("add_key", libc::EPERM), ("userfaultfd", libc::EPERM), ("open_by_handle_at", libc::EPERM),
        ("clone_newuser", libc::EPERM), ("clone3", libc::ENOSYS), ("io_uring_setup", libc::ENOSYS), ("fsopen", libc::EPERM), ("pivot_root", libc::EPERM)] {
        assert!(lines.contains(&format!("{name} -1 {errno}").as_str()), "{name}: {out}");
    }
}

#[cfg(target_arch = "x86_64")]
#[test]
fn a_box_lent_the_network_reaches_it() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let heard = std::thread::spawn(move || {
        listener.set_nonblocking(false).unwrap();
        let (mut s, _) = listener.accept().unwrap();
        let mut b = [0u8; 2];
        std::io::Read::read_exact(&mut s, &mut b).unwrap();
        b
    });
    let script = format!("python3 -c 'import socket; s = socket.create_connection((\"127.0.0.1\", {port}), timeout=5); s.sendall(b\"hi\"); print(\"net ok\")' > /root/t/out 2>&1");
    let Some(out) = box_on_this_host(&script, true) else { eprintln!("skipped: no box, compiler or Python here"); return };
    assert_eq!(out.trim(), "net ok");
    assert_eq!(&heard.join().unwrap(), b"hi");
}

/// A box's terminals are its own (#59): a devpts made for it, which shows only the ptys opened in it (none of
/// the host's sessions), and /dev/ptmx, where they are opened: apt runs dpkg on one, script and tmux run a shell
/// on theirs (each tried where this host has it).
#[cfg(target_arch = "x86_64")]
#[test]
fn a_box_opens_terminals_of_its_own_and_sees_none_of_the_hosts() {
    let script = r#"
out=/root/t/out
echo "pts $(ls -A /dev/pts)" > $out
echo "ptmx $(readlink /dev/ptmx)" >> $out
python3 -c 'import os; m, s = os.openpty(); print("python", os.ttyname(s), os.isatty(s))' >> $out 2>&1
if command -v script >/dev/null; then echo "script $(script -qc tty /dev/null | tr -d '\r')" >> $out; fi
if command -v tmux >/dev/null; then
    tmux -S /tmp/tmux new-session -d 'tty > /tmp/tty; exec sleep 60'
    i=0; while [ ! -s /tmp/tty ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
    echo "tmux $(cat /tmp/tty)" >> $out
    tmux -S /tmp/tmux kill-server
fi
"#;
    let Some(out) = box_on_this_host(script, false) else { eprintln!("skipped: no box, compiler or Python here"); return };
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[..3], ["pts ptmx", "ptmx pts/ptmx", "python /dev/pts/0 True"], "{out}");
    for line in &lines[3..] {
        assert!(line.starts_with("script /dev/pts/") || line.starts_with("tmux /dev/pts/"), "{out}");
    }
}

