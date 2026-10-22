//! A Prompt on this machine: the distribution's root, run by the host's own
//! kernel, with nothing of the host's but what is handed in. No privilege
//! is needed: a user namespace makes the caller root inside it only.
//!
//!   /               the installed root, with the repo's environment over
//!                   it (owned.rs): what a package manager installs is the
//!                   repo's, written to the host beside the root, which
//!                   itself is never written
//!   /var/cache, /var/tmp, /var/log, /root/.cache
//!                   the repo's caches, on the host, freed whenever wanted
//!   /root/<repo>    the repo itself (a bind of its directory), writable
//!   /tmp, /run      empty, gone when the Prompt ends
//!   /dev            null, zero, full, random, urandom, tty only
//!   /proc           this Prompt's processes only (its own pid namespace)
//!   network         none (its own empty namespace) unless asked for
//!   system calls    none of those a sandboxed program has no use for and
//!                   escapes are found through (seccomp.rs): ptrace, mount,
//!                   namespaces, modules, bpf, keys and the like
//!
//! The environment is set, not inherited: no host home, keys, agent or
//! variables come in. Pid 1 inside is a small init (this process) that
//! reaps everything and, when the shell ends, ends everything left; and it
//! is killed with its supervisor, so no process of a Prompt outlives it.

use std::ffi::CString;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Sandbox {
    /// The installed root (`root::current`).
    pub root: PathBuf,
    /// The repo's directory on the host, and its name inside.
    pub repo: PathBuf,
    pub name: String,
    pub argv: Vec<String>,
    /// Share the host's network (an explicit grant); otherwise there is none.
    pub network: bool,
    /// The person's dotfiles (Home's), written into /root before the shell starts.
    pub dotfiles: Vec<(String, String)>,
    /// The data directory, where the repo's environment and caches are kept
    /// (owned.rs); without one the root is read-only and nothing outlives the Prompt.
    pub data: Option<PathBuf>,
}

/// Home keeps the dotfiles (home.rs); a Prompt writes them into /root.
pub use crate::home::{dotfile_name, dotfiles};

fn check(r: libc::c_int, what: &str) -> io::Result<()> {
    if r < 0 {
        let e = io::Error::last_os_error();
        return Err(io::Error::new(e.kind(), format!("{what}: {e}")));
    }
    Ok(())
}

fn c(s: impl AsRef<std::ffi::OsStr>) -> CString {
    use std::os::unix::ffi::OsStrExt;
    CString::new(s.as_ref().as_bytes()).expect("no NUL in a path")
}

fn write(path: &str, text: &str) -> io::Result<()> {
    std::fs::write(path, text).map_err(|e| io::Error::new(e.kind(), format!("{path}: {e}")))
}

fn mount(src: Option<&Path>, dst: &Path, fstype: Option<&str>, flags: libc::c_ulong, data: Option<&str>) -> io::Result<()> {
    let (s, t, d) = (src.map(c), fstype.map(c), data.map(c));
    let r = unsafe {
        libc::mount(
            s.as_ref().map_or(std::ptr::null(), |x| x.as_ptr()),
            c(dst).as_ptr(),
            t.as_ref().map_or(std::ptr::null(), |x| x.as_ptr()),
            flags,
            d.as_ref().map_or(std::ptr::null(), |x| x.as_ptr() as *const libc::c_void),
        )
    };
    check(r, &format!("mount {}", dst.display()))
}

/// The flags a mount already has that a remount inside a user namespace
/// must keep (the kernel refuses to drop locked ones).
fn locked_flags(path: &Path) -> libc::c_ulong {
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c(path).as_ptr(), &mut s) } != 0 {
        return 0;
    }
    // Linux's ST_RELATIME; the libc crate leaves it out on musl.
    const ST_RELATIME: libc::c_ulong = 0x1000;
    let mut out = 0;
    for (st, ms) in [(libc::ST_NOSUID, libc::MS_NOSUID), (libc::ST_NODEV, libc::MS_NODEV), (libc::ST_NOEXEC, libc::MS_NOEXEC),
        (libc::ST_NOATIME, libc::MS_NOATIME), (libc::ST_NODIRATIME, libc::MS_NODIRATIME), (ST_RELATIME, libc::MS_RELATIME)] {
        if s.f_flag & st != 0 {
            out |= ms;
        }
    }
    out
}

fn bind(src: &Path, dst: &Path, read_only: bool) -> io::Result<()> {
    mount(Some(src), dst, None, libc::MS_BIND | libc::MS_REC, None)?;
    if read_only {
        mount(None, dst, None, libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY | locked_flags(dst), None)?;
    }
    Ok(())
}

/// Where a Prompt's programs are looked for.
const PROMPT_PATH: &str = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// What a Prompt runs with: set here, never taken from the host.
fn environment(name: &str) -> Vec<CString> {
    [
        format!("PATH={PROMPT_PATH}"),
        "HOME=/root".into(),
        "USER=root".into(),
        "LOGNAME=root".into(),
        "SHELL=/bin/sh".into(),
        format!("TERM={}", term()),
        "LANG=C.UTF-8".into(),
        // The person's language (Home's), so the root's l3 and shell speak it too.
        format!("LENGTH3_LANG={}", if crate::i18n::ja() { "ja" } else { "en" }),
        "PS1=$PWD $ ".into(),
        // The root's own l3 sees the open repo where the shell does, and
        // leaves Home, the Remote and the device to the app.
        "LENGTH3_REPOS=/root".into(),
        "L3_PROMPT=1".into(),
        // An interactive sh reads this (the root's /etc/length3/shrc, if it has one).
        "ENV=/etc/length3/shrc".into(),
        format!("LENGTH3_REPO={name}"),
    ].iter().map(c).collect()
}

/// The terminal the Prompt is drawn on: a real one's name when l3 runs in one (so nano and
/// less can draw), else dumb. Only a plain name passes; nothing else of the host's does.
fn term() -> String {
    use std::io::IsTerminal;
    let t = std::env::var("TERM").unwrap_or_default();
    let plain = !t.is_empty() && t.len() <= 64 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._+".contains(&b));
    if plain && t != "dumb" && std::io::stdin().is_terminal() && std::io::stdout().is_terminal() { t } else { "dumb".into() }
}

/// Lay out the root under `top` and make it `/` (runs as pid 1, inside).
fn build(s: &Sandbox) -> io::Result<()> {
    // Nothing done here is seen outside, and nothing outside comes in later.
    mount(None, Path::new("/"), None, libc::MS_REC | libc::MS_PRIVATE, None)?;
    // The repo's environment over the root, where the kernel lets a user make an overlay; else the root alone.
    let layered = s.data.as_ref().and_then(|data| environment_over(&s.root, data, &s.name).ok());
    let top = layered.as_ref().unwrap_or(&s.root);
    if layered.is_none() { mount(Some(top), top, None, libc::MS_BIND | libc::MS_REC, None)?; }
    // Writable places first, while their mount points can still be made.
    let home = top.join("root");
    mount(Some(Path::new("tmpfs")), &home, Some("tmpfs"), libc::MS_NOSUID | libc::MS_NODEV, Some("mode=0700,size=16m"))?;
    let at = home.join(&s.name);
    std::fs::create_dir(&at)?;
    bind(&s.repo, &at, false)?;
    // The person's dotfiles, fresh in every Prompt (the repo stays the only place written back).
    for (name, text) in &s.dotfiles {
        if dotfile_name(name) && name != &format!(".{}", s.name) { std::fs::write(home.join(name), text)?; }
    }
    // The repo's caches: on the host, so what is left in them can be taken back from outside.
    if let Some(data) = &s.data {
        for (inside, name) in crate::owned::CACHES {
            let host = crate::owned::cache_dir(data, &s.name).join(name);
            std::fs::create_dir_all(&host)?;
            let at = top.join(inside);
            // Without the environment over it, the root on the host is not written to: only places it has.
            let there = if layered.is_some() || inside.starts_with("root/") { std::fs::create_dir_all(&at).is_ok() } else { at.is_dir() };
            if there { bind(&host, &at, false)?; }
        }
    }
    for (dir, size) in [("tmp", "1g"), ("run", "64m")] {
        mount(Some(Path::new("tmpfs")), &top.join(dir), Some("tmpfs"), libc::MS_NOSUID | libc::MS_NODEV, Some(&format!("mode=1777,size={size}")))?;
    }
    // With the network, the host's resolver too, where the root looks for it.
    if s.network { resolver(top)?; }
    let dev = top.join("dev");
    mount(Some(Path::new("tmpfs")), &dev, Some("tmpfs"), libc::MS_NOSUID | libc::MS_NOEXEC, Some("mode=0755,size=64k"))?;
    for node in ["null", "zero", "full", "random", "urandom", "tty"] {
        let host = Path::new("/dev").join(node);
        if !host.exists() {
            continue;
        }
        std::fs::File::create(dev.join(node))?;
        bind(&host, &dev.join(node), false)?;
    }
    for (link, to) in [("fd", "/proc/self/fd"), ("stdin", "/proc/self/fd/0"), ("stdout", "/proc/self/fd/1"), ("stderr", "/proc/self/fd/2")] {
        std::os::unix::fs::symlink(to, dev.join(link))?;
    }
    mount(Some(Path::new("proc")), &top.join("proc"), Some("proc"), libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC, None)?;
    // Then the root itself becomes read-only (unless the repo's environment is over it, which takes
    // what is written); what was mounted on it stays as it is.
    if layered.is_none() { mount(None, top, None, libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY | locked_flags(top), None)?; }
    // Become that root, and let go of the host's tree entirely.
    check(unsafe { libc::chdir(c(top).as_ptr()) }, "chdir")?;
    check(unsafe { libc::syscall(libc::SYS_pivot_root, c(".").as_ptr(), c(".").as_ptr()) as libc::c_int }, "pivot_root")?;
    check(unsafe { libc::umount2(c(".").as_ptr(), libc::MNT_DETACH) }, "umount old root")?;
    check(unsafe { libc::chdir(c(format!("/root/{}", s.name)).as_ptr()) }, "chdir repo")?;
    let name = b"length3";
    unsafe { libc::sethostname(name.as_ptr() as *const libc::c_char, name.len()) };
    Ok(())
}

/// The host's /etc/resolv.conf, given to the root: over its own file, or
/// where its link points into /run (Ubuntu's), which is the Prompt's.
fn resolver(top: &Path) -> io::Result<()> {
    let Ok(text) = std::fs::read_to_string("/etc/resolv.conf") else { return Ok(()) };
    let at = top.join("etc/resolv.conf");
    match std::fs::symlink_metadata(&at) {
        Ok(m) if m.file_type().is_symlink() => {
            let to = std::fs::read_link(&at)?;
            let inside = clean(&if to.is_absolute() { to } else { Path::new("/etc").join(to) });
            if let Ok(rest) = inside.strip_prefix("/run") {
                let file = top.join("run").join(rest);
                if let Some(dir) = file.parent() { std::fs::create_dir_all(dir)?; }
                std::fs::write(file, text)?;
            }
        }
        Ok(m) if m.is_file() => {
            let file = top.join("run/length3-resolv.conf");
            std::fs::write(&file, text)?;
            bind(&file, &at, true)?;
        }
        _ => {}
    }
    Ok(())
}

/// A path inside with `.` and `..` worked out (never above /).
fn clean(p: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in p.components() {
        match c {
            std::path::Component::Normal(x) => out.push(x),
            std::path::Component::ParentDir => { out.pop(); }
            _ => {}
        }
    }
    out
}

/// The root with the repo's environment over it, mounted at `<env>/merged`:
/// the root is the overlay's read-only lower layer, so writing to /usr
/// writes to `<env>/upper` on the host, and the root stays as installed.
/// Each root has its own environment (owned::env_over).
fn environment_over(root: &Path, data: &Path, repo: &str) -> io::Result<PathBuf> {
    let env = crate::owned::env_over(data, repo, root);
    let (upper, work, merged) = (env.join("upper"), env.join("work"), env.join("merged"));
    for d in [&upper, &work, &merged] { std::fs::create_dir_all(d)?; }
    // userxattr: in a user namespace the overlay keeps its marks in user.* xattrs; without it it cannot mark
    // a new directory as its own and refuses to rename any (dpkg renames each it unpacks).
    let options = format!("lowerdir={},upperdir={},workdir={},userxattr", root.display(), upper.display(), work.display());
    mount(Some(Path::new("overlay")), &merged, Some("overlay"), libc::MS_NOSUID | libc::MS_NODEV, Some(&options))?;
    Ok(merged)
}

/// Where `name` is run from: itself when it names a path, else the first
/// executable of that name in the Prompt's PATH, else itself (and exec says why).
fn find_program(name: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    if name.contains('/') { return name.to_string(); }
    for dir in PROMPT_PATH.split(':') {
        let p = Path::new(dir).join(name);
        if std::fs::metadata(&p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0) {
            return p.to_string_lossy().into_owned();
        }
    }
    name.to_string()
}

/// Pid 1: start the shell, reap whatever ends, and when the shell ends,
/// end everything that is left. Returns the shell's wait status.
fn init(s: &Sandbox) -> ! {
    let argv: Vec<CString> = s.argv.iter().map(c).collect();
    let mut ptrs: Vec<*const libc::c_char> = argv.iter().map(|a| a.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    // A command named without a path is looked for where the shell would look (the PATH it is given).
    let program = c(find_program(&s.argv[0]));
    // Said if it cannot start, in the child, before it would only end with 127.
    let not_started = crate::tr!("l3: {} could not start: ", "l3: {} を起動できませんでした：", s.argv[0]);
    let env = environment(&s.name);
    let mut envp: Vec<*const libc::c_char> = env.iter().map(|a| a.as_ptr()).collect();
    envp.push(std::ptr::null());
    let shell = unsafe { libc::fork() };
    if shell == 0 {
        unsafe {
            // Its own process group: what it runs is in it, and Ctrl-C goes to it.
            libc::setpgid(0, 0);
            // On a terminal (a terminal emulator's, or an SSH session's), that group is the one in front, as a
            // shell started at a terminal expects: a shell in a group behind it is stopped the moment it reads
            // (SIGTTIN), and Ctrl-C reaches it straight from the terminal. (Asking from behind is SIGTTOU, so
            // that is ignored for the asking, and set back below with every other signal.)
            if libc::isatty(0) == 1 {
                libc::signal(libc::SIGTTOU, libc::SIG_IGN);
                libc::tcsetpgrp(0, libc::getpid());
            }
            libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
            // The shell starts with every signal as a program expects it. An
            // ignored signal survives exec, and Rust ignores SIGPIPE: left so,
            // a writer to a closed pipe gets EPIPE instead of ending quietly.
            for sig in 1..32 {
                if sig != libc::SIGKILL && sig != libc::SIGSTOP { libc::signal(sig, libc::SIG_DFL); }
            }
            let mut none: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut none);
            libc::sigprocmask(libc::SIG_SETMASK, &none, std::ptr::null_mut());
            libc::execve(program.as_ptr(), ptrs.as_ptr(), envp.as_ptr());
            let why = std::io::Error::last_os_error().to_string();
            let line = format!("{not_started}{why}\n");
            libc::write(2, line.as_ptr() as *const libc::c_void, line.len());
            libc::_exit(127);
        }
    }
    unsafe { libc::setpgid(shell, shell) };
    SHELL.store(shell, std::sync::atomic::Ordering::SeqCst);
    // SIGUSR1 from the supervisor is Ctrl-C: SIGINT to the shell's group.
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGUSR1, interrupt as *const () as libc::sighandler_t);
    }
    loop {
        let mut status = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, 0) };
        if pid == shell {
            // Whatever the shell left running ends with it.
            unsafe { libc::kill(-1, libc::SIGKILL) };
            while unsafe { libc::waitpid(-1, std::ptr::null_mut(), 0) } > 0 {}
            let code = if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) };
            unsafe { libc::_exit(code) };
        }
        if pid < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            unsafe { libc::_exit(1) };
        }
    }
}

/// Run `s` and return the shell's exit code. Must be called from a process
/// with one thread (l3 itself), since it forks and changes namespaces.
pub fn run(s: &Sandbox) -> io::Result<i32> {
    if !s.root.join("bin").exists() {
        return Err(io::Error::new(io::ErrorKind::NotFound, crate::tr!("There is no root (l3 root install)", "root がありません（l3 root install）")));
    }
    let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
    let mut flags = libc::CLONE_NEWUSER | libc::CLONE_NEWNS | libc::CLONE_NEWPID | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS;
    if !s.network {
        flags |= libc::CLONE_NEWNET;
    }
    check(unsafe { libc::unshare(flags) }, "unshare (user namespaces may be off on this host)")?;
    write("/proc/self/setgroups", "deny")?;
    write("/proc/self/uid_map", &format!("0 {uid} 1"))?;
    write("/proc/self/gid_map", &format!("0 {gid} 1"))?;
    let front = Front::now();
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }
    if child == 0 {
        // Pid 1 inside: dies with its supervisor, and everything in it with it.
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) };
        if let Err(e) = build(s) {
            eprintln!("{}", crate::tr!("l3: Could not prepare the Prompt: {}", "l3: Prompt を用意できませんでした：{}", e));
            unsafe { libc::_exit(126) };
        }
        // The tree is laid out: from here on nothing in the Prompt asks the kernel what seccomp.rs refuses,
        // init and everything it starts. A kernel that cannot filter runs no Prompt (fails closed).
        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        if let Err(e) = crate::seccomp::install() {
            eprintln!("{}", crate::tr!("l3: Could not prepare the Prompt: {}", "l3: Prompt を用意できませんでした：{}", format!("seccomp: {e}")));
            unsafe { libc::_exit(126) };
        }
        init(s);
    }
    // The supervisor: pass Ctrl-C to init, which hands it to the shell's group.
    SUPERVISED.store(child, std::sync::atomic::Ordering::SeqCst);
    unsafe { libc::signal(libc::SIGINT, forward as *const () as libc::sighandler_t) };
    let mut status = 0;
    let waited = loop {
        let r = unsafe { libc::waitpid(child, &mut status, 0) };
        if r == child {
            break Ok(());
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            break Err(io::Error::last_os_error());
        }
    };
    front.give_back();
    waited?;
    Ok(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) })
}

/// The terminal's group in front when a Prompt starts. The shell inside takes the terminal (init),
/// and when it ends its group is gone: whoever started it is left behind, where reading a key stops
/// it (SIGTTIN) or ends input (bug: Menu → Prompt → exit left l3 instead of the menu). So it is given back.
struct Front(Option<libc::pid_t>);

impl Front {
    fn now() -> Front {
        // SAFETY: plain calls on standard input.
        Front(unsafe { (libc::isatty(0) == 1).then(|| libc::tcgetpgrp(0)).filter(|p| *p > 0) })
    }

    fn give_back(&self) {
        let Some(group) = self.0 else { return };
        // SAFETY: asked from behind, the request is SIGTTOU; ignored for the asking, then as it was.
        unsafe {
            let before = libc::signal(libc::SIGTTOU, libc::SIG_IGN);
            libc::tcsetpgrp(0, group);
            libc::signal(libc::SIGTTOU, before);
        }
    }
}

/// Run `s` in a child, so this process keeps its own namespaces and can run
/// another after it; the exit code of the child's shell.
pub fn run_apart(s: &Sandbox) -> io::Result<i32> {
    run_apart_with(s, || Ok(()))
}

/// As run_apart, with `keep` made in the child first and held while it runs: the child is the
/// Prompt's supervisor, so its record (prompt::record) names the child, which Stop ends.
pub fn run_apart_with<G>(s: &Sandbox, keep: impl FnOnce() -> io::Result<G>) -> io::Result<i32> {
    let front = Front::now();
    let pid = unsafe { libc::fork() };
    if pid < 0 { return Err(io::Error::last_os_error()); }
    if pid == 0 {
        let code = match keep() {
            Ok(held) => { let code = run(s).unwrap_or_else(|e| { eprintln!("l3: {e}"); 126 }); drop(held); code }
            Err(e) => { eprintln!("l3: {e}"); 126 }
        };
        unsafe { libc::_exit(code) };
    }
    // Ctrl-C is the child's to pass on; this one waits it out.
    let before = unsafe { libc::signal(libc::SIGINT, libc::SIG_IGN) };
    let mut status = 0;
    let waited = loop {
        let r = unsafe { libc::waitpid(pid, &mut status, 0) };
        if r == pid { break Ok(()); }
        if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) { break Err(io::Error::last_os_error()); }
    };
    unsafe { libc::signal(libc::SIGINT, before) };
    // Stopped from outside, the child gave nothing back itself.
    front.give_back();
    waited?;
    Ok(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) })
}

/// A package's name as `.packages` may give it: what apt takes, and nothing a shell reads otherwise.
fn package_name(p: &str) -> bool {
    !p.is_empty() && p.len() <= 128 && !p.starts_with('-') && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"+-.:=~_/".contains(&b))
}

/// What the person's dotfiles ask of a root: `.packages` (names, any number
/// a line, `#` to the end of a line left out), installed with the root's own
/// package manager, then `.setup` run with sh. Language runtimes and tools
/// come the way each says to install it, from there: the OS keeps no list of
/// its own. It runs in a Prompt of its own, with the network (fetching is
/// what it is for), over the repo's environment, so what it installs is the
/// repo's and stays; and again only when the root or either file changes.
/// `apt`: the root has apt (Ubuntu, Debian); l3's own has no archive yet.
pub fn set_up(s: &Sandbox, apt: bool) -> io::Result<()> {
    use sha2::{Digest, Sha256};
    let Some(data) = &s.data else { return Ok(()) };
    let get = |n: &str| s.dotfiles.iter().find(|(k, _)| k == n).map_or("", |(_, v)| v.as_str());
    let packages: Vec<&str> = get(".packages").lines().map(|l| l.split('#').next().unwrap_or("")).flat_map(str::split_whitespace).collect();
    let setup = get(".setup");
    if packages.is_empty() && setup.trim().is_empty() { return Ok(()); }
    if let Some(p) = packages.iter().find(|p| !package_name(p)) {
        eprintln!("{}", crate::tr!("l3: .packages: not a package name: {}", "l3: .packages：パッケージ名ではありません：{}", p));
        return Ok(());
    }
    let mut h = Sha256::new();
    h.update(format!("{}\n{}\n{}", s.root.display(), packages.join(" "), setup));
    let key: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let stamp = crate::owned::env_over(data, &s.name, &s.root).join("set-up");
    if std::fs::read_to_string(&stamp).ok().as_deref() == Some(key.as_str()) { return Ok(()); }
    let mut script = String::from("set -e\n");
    if !packages.is_empty() {
        if apt {
            script += &format!("export DEBIAN_FRONTEND=noninteractive\napt-get update -q\napt-get install -y -q --no-install-recommends {}\n", packages.join(" "));
        } else {
            eprintln!("{}", crate::tr!("l3: this root has no package archive yet: .packages is for Ubuntu and Debian", "l3: この root にはまだパッケージの置き場がありません。.packages は Ubuntu と Debian で使えます"));
        }
    }
    if !setup.trim().is_empty() { script += "sh /root/.setup\n"; }
    let done = || -> io::Result<()> { if let Some(d) = stamp.parent() { std::fs::create_dir_all(d)?; } std::fs::write(&stamp, &key) };
    if script == "set -e\n" { return done(); }
    eprintln!("{}", crate::tr!("l3: setting up from .packages and .setup…", "l3: .packages と .setup から用意しています…"));
    let code = run_apart(&Sandbox { argv: vec!["/bin/sh".into(), "-c".into(), script], network: true, ..s.clone() })?;
    if code == 0 { done() } else {
        eprintln!("{}", crate::tr!("l3: setting up stopped (exit {}); the Prompt starts with what is there", "l3: 用意が途中で止まりました（終了 {}）。今あるもので Prompt を始めます", code));
        Ok(())
    }
}

static SUPERVISED: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static SHELL: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// In the supervisor: Ctrl-C becomes SIGUSR1 to init (both calls are signal-safe).
extern "C" fn forward(_: libc::c_int) {
    let pid = SUPERVISED.load(std::sync::atomic::Ordering::SeqCst);
    if pid > 0 {
        unsafe { libc::kill(pid, libc::SIGUSR1) };
    }
}

/// In init: SIGINT to the shell's process group. An interactive shell
/// survives it; what it runs does not, as at a terminal.
extern "C" fn interrupt(_: libc::c_int) {
    let shell = SHELL.load(std::sync::atomic::Ordering::SeqCst);
    if shell > 0 {
        unsafe { libc::kill(-shell, libc::SIGINT) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let top = std::env::temp_dir().join(format!("l3-prompt-test-{}-{}", std::process::id(), network));
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
                run_apart(&Sandbox { root: root.clone(), repo: repo.clone(), name: "t".into(), argv: vec!["/bin/sh".into(), "-c".into(), script.into()],
                    network, dotfiles: Vec::new(), data: None })
            })();
            unsafe { libc::_exit(match code { Ok(c) => c, Err(_) => 200 }) };
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
}
