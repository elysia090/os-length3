//! The tests of run/launch.rs.

use super::*;

#[test]
fn a_time_zone_passes_by_its_name_and_nothing_that_leaves_zoneinfo() {
    for ok in ["Asia/Tokyo", "UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+9", "JST-9"] { assert!(plain_zone(ok), "{ok}"); }
    for bad in ["", "../../etc/shadow", "/etc/localtime", "Asia/To kyo", "Asia/$(x)", "a;b"] { assert!(!plain_zone(bad), "{bad}"); }
}

#[test]
fn a_package_name_is_what_apt_takes_and_nothing_a_shell_reads() {
    for ok in ["jq", "build-essential", "python3.12", "libc6:amd64", "nodejs=20.1-1", "g++", "ca-certificates"] { assert!(package_name(ok), "{ok}"); }
    for bad in ["", "-y", "a;rm", "$(x)", "a b", "`x`", "a|b", "a&b", "a>b"] { assert!(!package_name(bad), "{bad}"); }
}

#[test]
fn a_link_into_run_is_followed_inside_the_root() {
    assert_eq!(clean(Path::new("/etc/../run/systemd/resolve/stub-resolv.conf")), PathBuf::from("/run/systemd/resolve/stub-resolv.conf"));
    assert_eq!(clean(Path::new("/../../x")), PathBuf::from("/x"));
}

/// A real Prompt, on a root made of this host's own /usr and /etc (a user namespace of the test's
/// own lays it out), running a script: what it wrote into the repo. None where this host gives no
/// user namespace (a CI runner may not), or has no compiler or Python to try.
#[cfg(target_arch = "x86_64")]
fn prompt_on_this_host(script: &str, network: bool) -> Option<String> {
    if !Path::new("/usr/bin/cc").exists() || !Path::new("/usr/bin/python3").exists() { return None; }
    // A place of each call's own: the tests that call this run side by side.
    static CALLS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let top = crate::fs::testing::dir(&format!("l3-prompt-test-{}", CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    let (root, repo) = (top.join("root"), top.join("repo"));
    std::fs::create_dir_all(&root).ok()?;
    std::fs::create_dir_all(&repo).ok()?;
    // SAFETY: the child is single-threaded after fork, lays out its own namespaces, runs the Prompt and
    // leaves with _exit; the parent only waits.
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        let code = (|| -> io::Result<i32> {
            let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
            check(unsafe { libc::unshare(libc::CLONE_NEWUSER | libc::CLONE_NEWNS) }, "unshare")?;
            write("/proc/self/setgroups", "deny")?;
            write("/proc/self/uid_map", &format!("0 {uid} 1"))?;
            write("/proc/self/gid_map", &format!("0 {gid} 1"))?;
            mount(None, Path::new("/"), None, libc::MS_REC | libc::MS_PRIVATE, None)?;
            mount(Some(Path::new("tmpfs")), &root, Some("tmpfs"), 0, Some("mode=0755"))?;
            for d in ["usr", "etc", "root", "tmp", "run", "dev", "proc"] { std::fs::create_dir(root.join(d))?; }
            for (link, to) in [("bin", "usr/bin"), ("sbin", "usr/sbin"), ("lib", "usr/lib"), ("lib64", "usr/lib64")] {
                std::os::unix::fs::symlink(to, root.join(link))?;
            }
            for d in ["usr", "etc"] { bind(&Path::new("/").join(d), &root.join(d), false)?; }
            run_apart(&Sandbox { root: root.clone(), repo: repo.clone(), name: "t".into(), argv: vec!["/bin/sh".into(), "-c".into(), script.into()], env: Vec::new(),
                network, dotfiles: Vec::new(), data: None })
        })();
        unsafe { libc::_exit(code.unwrap_or(200)) };
    }
    let mut status = 0;
    unsafe { libc::waitpid(pid, &mut status, 0) };
    let out = std::fs::read_to_string(repo.join("out")).ok();
    let _ = std::fs::remove_dir_all(&top);
    let code = if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { -1 };
    if code == 200 { return None; }
    assert_eq!(code, 0, "the Prompt ended with {code}; it wrote: {out:?}");
    out
}

/// Calls the filter refuses, asked from Python inside the Prompt (x86-64 numbers), each line `name result errno`.
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

#[cfg(target_arch = "x86_64")]
#[test]
fn a_prompt_runs_a_shell_and_a_compiler_and_refuses_each_call_the_filter_names() {
    let script = format!(r#"
out=/root/t/out
echo shell ok > $out
printf 'int main(void) {{ return 42; }}\n' > /tmp/a.c && cc /tmp/a.c -o /tmp/a; /tmp/a; echo "cc $?" >> $out
cat > /tmp/ask.py <<'PY'
{ASK}
PY
python3 /tmp/ask.py >> $out 2>&1
grep '^Seccomp:' /proc/self/status >> $out
unshare -U true 2>/dev/null; echo "unshare-command $?" >> $out
"#);
    let Some(out) = prompt_on_this_host(&script, false) else { eprintln!("skipped: no user namespace, compiler or Python here"); return };
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], "shell ok");
    assert!(lines.contains(&"cc 42"), "{out}");
    assert!(lines.contains(&"Seccomp:\t2"), "the Prompt's processes are filtered: {out}");
    assert!(lines.iter().any(|l| l.starts_with("unshare-command ") && *l != "unshare-command 0"), "{out}");
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
    let Some(out) = prompt_on_this_host(&script, true) else { eprintln!("skipped: no user namespace, compiler or Python here"); return };
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
    let Some(out) = prompt_on_this_host(script, false) else { eprintln!("skipped: no user namespace, compiler or Python here"); return };
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[..3], ["pts ptmx", "ptmx pts/ptmx", "python /dev/pts/0 True"], "{out}");
    for line in &lines[3..] {
        assert!(line.starts_with("script /dev/pts/") || line.starts_with("tmux /dev/pts/"), "{out}");
    }
}

/// This host's shell and `programs`, each with the libraries it loads at the same paths, copied into `root`: a
/// tree of the test's user, as an installed root is its user's, for an overlay to lie over. None where one is
/// not there, or not linked as glibc links (which lists them under LD_TRACE_LOADED_OBJECTS).
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

/// Prompts of one repo on one root share its environment, whatever order they start and end in (#55): each
/// started while another runs joins its overlay, and goes on making directories where the root has them (a
/// copy-up), renaming and writing after another was stopped (its supervisor killed, as Stop does) or ended.
#[test]
fn prompts_of_one_repo_share_its_environment_whatever_order_they_start_and_end_in() {
    let top = crate::fs::testing::dir("l3-environment-test");
    let (root, repo, data) = (top.join("root"), top.join("repo"), top.join("data"));
    let _ = std::fs::remove_dir_all(&top);
    for d in ["etc", "usr/share/doc", "usr/lib", "opt", "srv", "var/lib", "root", "tmp", "run", "dev", "proc"] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    std::fs::create_dir_all(&repo).unwrap();
    if copied_root(&root, &["cat", "mkdir", "mv", "sleep"]).is_none() { eprintln!("skipped: no shell or programs linked by glibc here"); return; }
    // Each Prompt's supervisor a process of its own; what each step did, a line of the log.
    let start = |script: &str| -> libc::pid_t {
        let script = format!("cd /root/t\nstep() {{ name=$1; shift; \"$@\" 2>/dev/null; echo \"$name $?\" >> log; }}\n\
                await() {{ while [ ! -e $1 ]; do sleep 0.02; done; }}\n{script}");
        let s = Sandbox { root: root.clone(), repo: repo.clone(), name: "t".into(), argv: vec!["/bin/sh".into(), "-c".into(), script], env: Vec::new(),
            network: false, dotfiles: Vec::new(), data: Some(data.clone()) };
        // SAFETY: the child is single-threaded after fork, runs the Prompt and leaves with _exit.
        let pid = unsafe { libc::fork() };
        if pid == 0 { unsafe { libc::_exit(run(&s).unwrap_or(200)) } }
        pid
    };
    let log = || std::fs::read_to_string(repo.join("log")).unwrap_or_default();
    let marked = |name: &str| {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !repo.join(name).exists() {
            assert!(std::time::Instant::now() < until, "{name} was not marked; the log:\n{}", log());
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    };
    let mark = |name: &str| std::fs::write(repo.join(name), "").unwrap();
    let ended = |pid: libc::pid_t| {
        let mut status = 0;
        // SAFETY: waitpid on a child of this test.
        unsafe { libc::waitpid(pid, &mut status, 0) };
        if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { -1 }
    };
    let a = start("echo before > /etc/before || { echo no-overlay > ready-a; exit; }\n: > ready-a\n\
            await go-a; step a-mkdir-while-b-runs mkdir /usr/share/doc/a; : > a-did\nwhile :; do sleep 1; done");
    marked("ready-a");
    if std::fs::read_to_string(repo.join("ready-a")).unwrap().contains("no-overlay") {
        eprintln!("skipped: this kernel makes no overlay in a user namespace");
        ended(a);
        return;
    }
    let b = start("step b-reads-a test \"$(cat /etc/before)\" = before; step b-mkdir mkdir /usr/lib/b; : > ready-b\n\
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
    // All have ended: a Prompt now mounts the environment anew, and has everything they made in it.
    let d = start("for p in /etc/before /usr/share/doc/a /usr/lib/b /opt/b2 /srv/c /var/lib/c/f; do [ -e $p ]; echo \"d-sees-$p $?\" >> log; done\n\
            step d-mkdir mkdir /usr/share/doc/d");
    assert_eq!(ended(d), 0, "{}", log());
    let log = log();
    let wrong: Vec<&str> = log.lines().filter(|l| !l.ends_with(" 0")).collect();
    assert!(wrong.is_empty() && log.lines().count() == 15, "{log}");
    let prompts = crate::prompt::writes::env_over(&data, "t", &root).join("prompts");
    assert_eq!(std::fs::read_dir(prompts).unwrap().count(), 0, "every Prompt over it has ended");
    let _ = std::fs::remove_dir_all(&top);
}
