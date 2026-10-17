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
//!
//! The environment is set, not inherited: no host home, keys, agent or
//! variables come in. Pid 1 inside is a small init (this process) that
//! reaps everything and, when the shell ends, ends everything left; and it
//! is killed with its supervisor, so no process of a Prompt outlives it.

use std::ffi::CString;
use std::io;
use std::path::{Path, PathBuf};

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

/// A dotfile's name as it may be written into /root: a dot, then letters, digits and . _ -.
pub fn dotfile_name(name: &str) -> bool {
    name.len() > 1 && name.len() <= 64 && name.starts_with('.') && name != ".." && !name.contains("..")
        && name.bytes().skip(1).all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// The dotfiles Home keeps (`dotfiles`: a JSON object of name → text), those with a name that may be written.
pub fn dotfiles() -> Vec<(String, String)> {
    let Ok(Some(text)) = crate::home::get("dotfiles") else { return Vec::new() };
    let Ok(map) = serde_json::from_str::<std::collections::BTreeMap<String, String>>(&text) else { return Vec::new() };
    map.into_iter().filter(|(n, _)| dotfile_name(n)).collect()
}

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

/// What a Prompt runs with: set here, never taken from the host.
fn environment(name: &str) -> Vec<CString> {
    [
        "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
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

/// The root with the repo's environment over it, mounted at `<env>/merged`:
/// the root is the overlay's read-only lower layer, so writing to /usr
/// writes to `<env>/upper` on the host, and the root stays as installed.
fn environment_over(root: &Path, data: &Path, repo: &str) -> io::Result<PathBuf> {
    let env = crate::owned::env_dir(data, repo);
    let (upper, work, merged) = (env.join("upper"), env.join("work"), env.join("merged"));
    for d in [&upper, &work, &merged] { std::fs::create_dir_all(d)?; }
    let options = format!("lowerdir={},upperdir={},workdir={}", root.display(), upper.display(), work.display());
    mount(Some(Path::new("overlay")), &merged, Some("overlay"), libc::MS_NOSUID | libc::MS_NODEV, Some(&options))?;
    Ok(merged)
}

/// Pid 1: start the shell, reap whatever ends, and when the shell ends,
/// end everything that is left. Returns the shell's wait status.
fn init(s: &Sandbox) -> ! {
    let argv: Vec<CString> = s.argv.iter().map(c).collect();
    let mut ptrs: Vec<*const libc::c_char> = argv.iter().map(|a| a.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let env = environment(&s.name);
    let mut envp: Vec<*const libc::c_char> = env.iter().map(|a| a.as_ptr()).collect();
    envp.push(std::ptr::null());
    let shell = unsafe { libc::fork() };
    if shell == 0 {
        unsafe {
            // Its own process group: what it runs is in it, and Ctrl-C goes to it.
            libc::setpgid(0, 0);
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
            libc::execve(ptrs[0], ptrs.as_ptr(), envp.as_ptr());
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
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }
    if child == 0 {
        // Pid 1 inside: dies with its supervisor, and everything in it with it.
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) };
        if let Err(e) = build(s) {
            eprintln!("{}", crate::tr!("l3: Could not prepare the Prompt: {}", "l3: Prompt を用意できませんでした: {}", e));
            unsafe { libc::_exit(126) };
        }
        init(s);
    }
    // The supervisor: pass Ctrl-C to init, which hands it to the shell's group.
    SUPERVISED.store(child, std::sync::atomic::Ordering::SeqCst);
    unsafe { libc::signal(libc::SIGINT, forward as *const () as libc::sighandler_t) };
    let mut status = 0;
    loop {
        let r = unsafe { libc::waitpid(child, &mut status, 0) };
        if r == child {
            break;
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) })
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
