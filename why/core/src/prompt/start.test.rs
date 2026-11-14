use super::*;

/// This machine makes a box, or says in muk's own words why not: asked of muk itself, with nothing but muk in the box.
#[test]
fn whether_a_box_can_be_made_here_is_asked_of_muk() {
    match kept_from_boxes() {
        None => {}
        Some(why) => assert!(why.contains("muk"), "{why}"),
    }
}

#[test]
fn a_package_name_is_what_apt_takes_and_nothing_a_shell_reads() {
    for p in ["git", "g++", "libssl-dev", "python3.12", "nodejs=20.1-1~deb", "libc6:amd64"] { assert!(package_name(p), "{p}"); }
    for p in ["", "-y", "a b", "a;b", "$(x)", "a`b`", "a|b", "a&b", &"x".repeat(129)] { assert!(!package_name(p), "{p}"); }
}

#[test]
fn a_link_into_run_is_followed_inside_the_root() {
    assert_eq!(clean(Path::new("/etc/../run/systemd/resolve/stub-resolv.conf")), Path::new("/run/systemd/resolve/stub-resolv.conf"));
    assert_eq!(clean(Path::new("/etc/../../../run/x")), Path::new("/run/x"));
    let top = crate::fs::testing::dir("why-resolver-test");
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
    let top = crate::fs::testing::dir("why-copy-test");
    let _ = std::fs::remove_dir_all(&top);
    let (from, to) = (top.join("from"), top.join("to"));
    std::fs::create_dir_all(from.join("usr/bin")).unwrap();
    std::fs::write(from.join("usr/bin/busybox"), "elf").unwrap();
    std::fs::set_permissions(from.join("usr/bin/busybox"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::hard_link(from.join("usr/bin/busybox"), from.join("usr/bin/ls")).unwrap();
    std::os::unix::fs::symlink("usr/bin", from.join("bin")).unwrap();
    std::fs::set_permissions(from.join("usr"), std::fs::Permissions::from_mode(0o750)).unwrap();
    copy_tree(&from, &to).unwrap();
    let (a, b) = (std::fs::metadata(to.join("usr/bin/busybox")).unwrap(), std::fs::metadata(to.join("usr/bin/ls")).unwrap());
    assert_eq!((a.ino(), a.nlink(), a.mode() & 0o777), (b.ino(), 2, 0o755));
    assert_ne!(a.ino(), std::fs::metadata(from.join("usr/bin/busybox")).unwrap().ino(), "a copy, not the root's own file");
    assert_eq!(std::fs::read_link(to.join("bin")).unwrap(), Path::new("usr/bin"));
    assert_eq!(std::fs::metadata(to.join("usr")).unwrap().mode() & 0o777, 0o750);
    let _ = std::fs::remove_dir_all(&top);
}

/// `f` in a process of its own (a Prompt is run by a process with one thread: it waits for any child, and its bundle
/// is named by its pid): what it returned as its exit code.
fn apart(f: impl FnOnce() -> i32) -> libc::pid_t {
    // SAFETY: the child goes on with this thread alone, runs the Prompt and leaves with _exit.
    let pid = unsafe { libc::fork() };
    if pid == 0 { unsafe { libc::_exit(f()) } }
    pid
}
fn ended(pid: libc::pid_t) -> i32 {
    let mut status = 0;
    // SAFETY: waitpid on a child of this test.
    unsafe { libc::waitpid(pid, &mut status, 0) };
    if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { -1 }
}

/// Run `script` in a Prompt on a root made of this host's own /usr and /etc (lent as they are), the repo at /root/t;
/// what it wrote to /root/t/out. None where this host makes no box, or lacks a compiler or Python.
fn prompt_on_this_host(script: &str, network: bool) -> Option<String> {
    if !Path::new("/usr/bin/cc").exists() || !Path::new("/usr/bin/python3").exists() || kept_from_boxes().is_some() { return None; }
    // A place of each call's own: the tests that call this run side by side.
    static CALLS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let top = crate::fs::testing::dir(&format!("why-prompt-test-{}", CALLS.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&top);
    let (root, repo) = (top.join("root"), top.join("repo"));
    for d in ["usr", "etc", "root", "tmp", "run", "dev", "proc"] { std::fs::create_dir_all(root.join(d)).ok()?; }
    for (link, to) in [("bin", "usr/bin"), ("sbin", "usr/sbin"), ("lib", "usr/lib"), ("lib64", "usr/lib64")] {
        std::os::unix::fs::symlink(to, root.join(link)).ok()?;
    }
    std::fs::create_dir_all(&repo).ok()?;
    let p = Prompt { root, other: false, repo: repo.clone(), name: "t".into(), cmd: vec!["/bin/sh".into(), "-c".into(), script.into()], env: Vec::new(),
        network, dotfiles: Vec::new(), data: None, also: vec![("usr".into(), "/usr".into()), ("etc".into(), "/etc".into())] };
    let code = ended(apart(|| p.run().unwrap_or_else(|e| { eprintln!("{e}"); 200 })));
    let out = std::fs::read_to_string(repo.join("out")).ok();
    let _ = std::fs::remove_dir_all(&top);
    assert_eq!(code, 0, "the Prompt ended with {code}; it wrote: {out:?}");
    out
}

/// Calls muk's filter refuses, asked from Python inside the Prompt (x86-64 numbers), each line `name result errno`.
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

/// A Prompt is a box muk made: its programs run, and what muk's filter names (module/muk/src/filter.h) no program
/// in it asks the kernel, as the launcher's own filter held before it.
#[cfg(target_arch = "x86_64")]
#[test]
fn a_prompt_runs_a_shell_and_a_compiler_in_a_box_of_muks_and_asks_the_kernel_nothing_its_filter_names() {
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
    let Some(out) = prompt_on_this_host(&script, false) else { eprintln!("skipped: no box, compiler or Python here"); return };
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], "shell ok");
    assert!(lines.contains(&"cc 42"), "{out}");
    assert!(lines.contains(&"Seccomp:\t2") && lines.contains(&"NoNewPrivs:\t1"), "the Prompt's processes are filtered: {out}");
    assert!(lines.iter().any(|l| l.starts_with("unshare-command ") && *l != "unshare-command 0"), "{out}");
    assert!(lines.contains(&"host why pwd /root/t home /root pid 1"), "{out}");
    for (name, errno) in [("ptrace", libc::EPERM), ("mount", libc::EPERM), ("umount2", libc::EPERM), ("unshare", libc::EPERM), ("setns", libc::EPERM),
        ("kexec_load", libc::EPERM), ("init_module", libc::EPERM), ("finit_module", libc::EPERM), ("bpf", libc::EPERM), ("perf_event_open", libc::EPERM),
        ("keyctl", libc::EPERM), ("add_key", libc::EPERM), ("userfaultfd", libc::EPERM), ("open_by_handle_at", libc::EPERM),
        ("clone_newuser", libc::EPERM), ("clone3", libc::ENOSYS), ("io_uring_setup", libc::ENOSYS), ("fsopen", libc::EPERM), ("pivot_root", libc::EPERM)] {
        assert!(lines.contains(&format!("{name} -1 {errno}").as_str()), "{name}: {out}");
    }
}

#[cfg(target_arch = "x86_64")]
#[test]
fn a_prompt_granted_the_network_reaches_it() {
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
    let Some(out) = prompt_on_this_host(&script, true) else { eprintln!("skipped: no box, compiler or Python here"); return };
    assert_eq!(out.trim(), "net ok");
    assert_eq!(&heard.join().unwrap(), b"hi");
}

/// A Prompt's terminals are its own (#59): a devpts made for it, which shows only the ptys opened in it (none of
/// the host's sessions), and /dev/ptmx, where they are opened: apt runs dpkg on one, script and tmux run a shell
/// on theirs (each tried where this host has it).
#[cfg(target_arch = "x86_64")]
#[test]
fn a_prompt_opens_terminals_of_its_own_and_sees_none_of_the_hosts() {
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
    let Some(out) = prompt_on_this_host(script, false) else { eprintln!("skipped: no box, compiler or Python here"); return };
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[..3], ["pts ptmx", "ptmx pts/ptmx", "python /dev/pts/0 True"], "{out}");
    for line in &lines[3..] {
        assert!(line.starts_with("script /dev/pts/") || line.starts_with("tmux /dev/pts/"), "{out}");
    }
}

/// This host's shell and `programs`, each with the libraries it loads at the same paths, copied into `root`: a
/// tree of the test's user, as an installed root is its user's. None where one is not there, or not linked as glibc
/// links (which lists them under LD_TRACE_LOADED_OBJECTS).
fn copied_root(root: &Path, programs: &[&str]) -> Option<()> {
    let path = std::env::var("PATH").ok()?;
    for name in std::iter::once(&"sh").chain(programs) {
        let host = path.split(':').map(|d| Path::new(d).join(name)).find(|p| p.is_file())?;
        std::fs::create_dir_all(root.join("bin")).ok()?;
        std::fs::copy(&host, root.join("bin").join(name)).ok()?;
        let listed = std::process::Command::new(&host).env("LD_TRACE_LOADED_OBJECTS", "1").stdin(std::process::Stdio::null()).output().ok()?;
        let libs: Vec<String> = String::from_utf8_lossy(&listed.stdout).lines()
            .filter_map(|l| l.rsplit("=>").next()?.split_whitespace().next().filter(|p| p.starts_with('/')).map(String::from)).collect();
        if libs.is_empty() { return None; }
        for lib in libs {
            let at = root.join(lib.trim_start_matches('/'));
            std::fs::create_dir_all(at.parent()?).ok()?;
            std::fs::copy(&lib, &at).ok()?;
        }
    }
    Some(())
}

/// The installed root is never written, and a repo whose dotfiles ask nothing of it runs on it as it is, read-only.
/// What `.setup` asks is made in a root of the repo's own, once; and Prompts of the repo share it whatever order
/// they start and end in (#55), as programs share one machine: what one wrote another reads, one stopped (its
/// supervisor killed, as Stop does) takes nothing from the others, and a Prompt started after all have ended has
/// everything they made.
#[test]
fn a_repos_environment_is_a_root_of_its_own_made_once_and_shared_by_its_prompts() {
    if kept_from_boxes().is_some() { eprintln!("skipped: no box here"); return; }
    let top = crate::fs::testing::dir("why-environment-test");
    let (root, repo, data) = (top.join("system/aa/root"), top.join("repo"), top.join("data"));
    let _ = std::fs::remove_dir_all(&top);
    for d in ["etc", "usr/share/doc", "usr/lib", "opt", "srv", "var/lib", "root", "tmp", "run", "dev", "proc"] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    std::fs::create_dir_all(&repo).unwrap();
    if copied_root(&root, &["cat", "mkdir", "mv", "sleep"]).is_none() { eprintln!("skipped: no shell or programs linked by glibc here"); return; }
    let prompt = |script: &str, dotfiles: &[(&str, &str)]| Prompt { root: root.clone(), other: false, repo: repo.clone(), name: "t".into(),
        cmd: vec!["/bin/sh".into(), "-c".into(), format!("cd /root/t\nstep() {{ name=$1; shift; \"$@\" 2>/dev/null; echo \"$name $?\" >> log; }}\n\
            await() {{ while [ ! -e $1 ]; do sleep 0.02; done; }}\n{script}")],
        env: Vec::new(), network: false, dotfiles: dotfiles.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), data: Some(data.clone()), also: Vec::new() };
    let log = || std::fs::read_to_string(repo.join("log")).unwrap_or_default();
    // Nothing asked: the installed root itself, which a Prompt does not write.
    let plain = prompt("step plain-writes-root mkdir /usr/lib/x; step plain-writes-repo mkdir made", &[]);
    assert_eq!(ended(apart(|| { plain.set_up().unwrap(); plain.run().unwrap_or(200) })), 0, "{}", log());
    assert_eq!(log(), "plain-writes-root 1\nplain-writes-repo 0\n");
    assert!(!root.join("usr/lib/x").exists() && repo.join("made").is_dir());
    std::fs::remove_file(repo.join("log")).unwrap();
    // `.setup` asks: the repo's own root is made of the installed one and set up in it, once.
    let asks = [(".setup", "mkdir /opt/set-up && echo once >> /etc/set-up")];
    let start = |script: &str| { let p = prompt(script, &asks); apart(move || { p.set_up().unwrap(); p.run().unwrap_or(200) }) };
    let marked = |name: &str| {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !repo.join(name).exists() {
            assert!(std::time::Instant::now() < until, "{name} was not marked; the log:\n{}", log());
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    };
    let mark = |name: &str| std::fs::write(repo.join(name), "").unwrap();
    let a = start("step a-set-up test \"$(cat /etc/set-up)\" = once; step a-writes sh -c 'echo before > /etc/before'; : > ready-a\n\
            await go-a; step a-mkdir-while-b-runs mkdir /usr/share/doc/a; : > a-did\nwhile :; do sleep 1; done");
    marked("ready-a");
    let b = start("step b-set-up-once test \"$(cat /etc/set-up)\" = once; step b-reads-a test \"$(cat /etc/before)\" = before; step b-mkdir mkdir /usr/lib/b; : > ready-b\n\
            await go-b; step b-mkdir-after-a-stopped mkdir /opt/b; step b-rename mv /opt/b /opt/b2; : > b-did\nawait go-b2");
    marked("ready-b");
    mark("go-a");
    marked("a-did");
    // A is stopped as Runtime stops a Prompt: its supervisor killed, and with it everything in it.
    unsafe { libc::kill(a, libc::SIGKILL) };
    ended(a);
    mark("go-b");
    marked("b-did");
    let c = start("step c-mkdir-while-b-runs mkdir /srv/c; : > ready-c\nawait go-c; step c-mkdir-after-b-ended mkdir /var/lib/c\n\
            echo c > /var/lib/c/f; echo \"c-write $?\" >> log");
    marked("ready-c");
    mark("go-b2");
    assert_eq!(ended(b), 0, "{}", log());
    mark("go-c");
    assert_eq!(ended(c), 0, "{}", log());
    let d = start("for p in /etc/before /usr/share/doc/a /usr/lib/b /opt/b2 /srv/c /var/lib/c/f /opt/set-up; do [ -e $p ]; echo \"d-sees-$p $?\" >> log; done\n\
            step d-mkdir mkdir /usr/share/doc/d");
    assert_eq!(ended(d), 0, "{}", log());
    let log = log();
    let wrong: Vec<&str> = log.lines().filter(|l| !l.ends_with(" 0")).collect();
    assert!(wrong.is_empty() && log.lines().count() == 19, "{log}");
    // The installed root is as it was; what was made is in the repo's own, beside its mark of what set it up.
    assert!(!root.join("etc/before").exists() && !root.join("opt/set-up").exists());
    let env = crate::prompt::writes::env_over(&data, "t", &root);
    assert!(env.join("root/etc/before").is_file() && env.join("set-up").is_file());
    // No bundle is left of any of them but the one that was killed, which the next reading of the records lets go of.
    let left: Vec<String> = std::fs::read_dir(data.join("prompts")).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    assert_eq!(left, [format!("{a}.box")], "{left:?}");
    crate::prompt::running::all(&data);
    assert_eq!(std::fs::read_dir(data.join("prompts")).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(&top);
}
