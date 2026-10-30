//! A Prompt on this machine: the distribution's root, run by the host's own
//! kernel, with nothing of the host's but what is handed in. No privilege
//! is needed: a user namespace makes the caller root inside it only.
//!
//!   /               the installed root, with the repo's environment over
//!                   it (owned.rs): what a package manager installs is the
//!                   repo's, written to the host beside the root, which
//!                   itself is never written; one overlay for all the
//!                   repo's Prompts on that root (Environment)
//!   /var/cache, /var/tmp, /var/log, /root/.cache
//!                   the repo's caches, on the host, freed whenever wanted
//!   /root/<repo>    the repo itself (a bind of its directory), writable
//!   /tmp, /run      empty, gone when the Prompt ends
//!   /dev            null, zero, full, random, urandom, tty, and terminals
//!                   of its own (pts, ptmx: a devpts of this Prompt's)
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
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
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

/// Home keeps the dotfiles (home.rs); a Prompt writes into /root those this device took (dotfiles_in_effect).
pub use crate::home::{dotfile_name, dotfiles_in_effect};

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

/// Lay out the root under `top` and make it `/` (runs as pid 1, inside), over `joined` (a running Prompt's
/// environment) if given; whether the repo's environment is over the root.
fn build(s: &Sandbox, joined: Option<OwnedFd>) -> io::Result<bool> {
    // Nothing done here is seen outside, and nothing outside comes in later.
    mount(None, Path::new("/"), None, libc::MS_REC | libc::MS_PRIVATE, None)?;
    // The repo's environment over the root, where the kernel lets a user make an overlay; else the root alone
    // (never under a Prompt that has it: one that joins it has it, or does not start).
    let layered = match &s.data {
        Some(data) if joined.is_some() => Some(environment_over(&s.root, data, &s.name, joined)?),
        Some(data) => environment_over(&s.root, data, &s.name, None).ok(),
        None => None,
    };
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
    // Terminals of its own: a devpts instance made here, which holds only the ptys opened in this Prompt (never the
    // host's sessions), and /dev/ptmx, where they are opened (apt runs dpkg on one; script and tmux run a shell on
    // theirs). The host keeps its own (kernel.pty.reserve). Where the kernel will not make one, there is none.
    let pts = dev.join("pts");
    std::fs::create_dir(&pts)?;
    if mount(Some(Path::new("devpts")), &pts, Some("devpts"), libc::MS_NOSUID | libc::MS_NOEXEC, Some("newinstance,ptmxmode=0666,mode=0620")).is_ok() {
        std::os::unix::fs::symlink("pts/ptmx", dev.join("ptmx"))?;
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
    Ok(layered.is_some())
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
/// Each root has its own environment (owned::env_over), one overlay for all
/// the repo's Prompts on it (Environment): `joined`, the one a running
/// Prompt's root is, if given; else it is mounted here.
fn environment_over(root: &Path, data: &Path, repo: &str, joined: Option<OwnedFd>) -> io::Result<PathBuf> {
    let env = crate::owned::env_over(data, repo, root);
    let (upper, work, merged) = (env.join("upper"), env.join("work"), env.join("merged"));
    for d in [&upper, &work, &merged] { std::fs::create_dir_all(d)?; }
    if let Some(overlay) = joined {
        // SAFETY: move_mount of the detached mount `overlay` holds, by its descriptor, onto a directory just made.
        let r = unsafe { libc::syscall(libc::SYS_move_mount, overlay.as_raw_fd(), c"".as_ptr(), libc::AT_FDCWD, c(&merged).as_ptr(), libc::MOVE_MOUNT_F_EMPTY_PATH) };
        check(r as libc::c_int, "move_mount")?;
        // This Prompt's own mount of it: what is mounted on it here never reaches the other Prompt's tree, nor theirs this one's.
        mount(None, &merged, None, libc::MS_PRIVATE, None)?;
        return Ok(merged);
    }
    // userxattr: in a user namespace the overlay keeps its marks in user.* xattrs; without it it cannot mark
    // a new directory as its own and refuses to rename any (dpkg renames each it unpacks).
    let options = format!("lowerdir={},upperdir={},workdir={},userxattr", root.display(), upper.display(), work.display());
    mount(Some(Path::new("overlay")), &merged, Some("overlay"), libc::MS_NOSUID | libc::MS_NODEV, Some(&options))?;
    Ok(merged)
}

/// The Prompts over one environment, so that it is one overlay for all of them. Two overlays on one upper and
/// work do not both work: mounting the second clears `work/work`, the first's scratch, and makes it anew, so every
/// copy-up the first makes after (a directory made where the root has one, a file of the root's first written)
/// fails with ENOENT (#55). So the first Prompt mounts it, and each started while one runs joins it: that Prompt's
/// root, cloned into its own tree, the same overlay (one upper, one work, one view of them), mounted as long as
/// any of them runs. Ending, stopping or a network change of one leaves the others' as it was.
///
/// `<env>/prompts` holds a file for each one running, named by its pid 1 (pid on the host), whose namespaces hold
/// its tree, and holding its mount namespace's inode; the directory itself is the lock a Prompt holds from looking
/// for one to join until its own tree is laid out and recorded, so that no two ever mount it.
struct Environment {
    dir: PathBuf,
    /// `dir`, open: the lock (flock) while held, and where this Prompt's file is written and removed once its tree
    /// is laid out (by then the supervisor's `/` is the Prompt's, not the host's: pivot_root moved it).
    prompts: std::fs::File,
    mine: Option<CString>,
}

impl Environment {
    /// Wait for the environment's lock, and hold it.
    fn lock(env: &Path) -> io::Result<Environment> {
        let dir = env.join("prompts");
        std::fs::create_dir_all(&dir)?;
        let prompts = std::fs::File::open(&dir)?;
        // SAFETY: flock on a descriptor this function holds; let go of when it is closed (however the process ends).
        while unsafe { libc::flock(prompts.as_raw_fd(), libc::LOCK_EX) } != 0 {
            let e = io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::EINTR) { return Err(e); }
        }
        Ok(Environment { dir, prompts, mine: None })
    }

    /// The user and mount namespaces of a Prompt over this environment still running, held open (so they stay
    /// while this one joins, even if it ends meanwhile), if there is one; the files of those that ended go.
    fn running(&self) -> io::Result<Option<(OwnedFd, OwnedFd)>> {
        for e in std::fs::read_dir(&self.dir)?.flatten() {
            let Some(init) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
            let Some(ns) = std::fs::read_to_string(e.path()).ok().and_then(|t| t.trim().parse::<u64>().ok()) else { continue };
            // Its pid 1 is that Prompt's while its mount namespace is that one (a pid given to another since is in another).
            let ns_of = || std::fs::metadata(format!("/proc/{init}/ns/mnt")).ok().map(|m| m.ino());
            let open = |kind: &str| std::fs::File::open(format!("/proc/{init}/ns/{kind}"));
            if ns_of() == Some(ns) {
                if let (Ok(mnt), Ok(user)) = (open("mnt"), open("user")) {
                    // The namespace held is that one, and the process was still it once both were open.
                    if mnt.metadata()?.ino() == ns && ns_of() == Some(ns) { return Ok(Some((user.into(), mnt.into()))); }
                }
            }
            // Ending: its pid 1 has let go of its namespaces and is ending the rest of its processes. It is gone (a
            // zombie, or reaped) only once none is left that could still write through its overlay, and only then
            // may another be mounted.
            let ending = || ns_of().is_none() && crate::prompt::start_ticks(init).is_some() && !crate::prompt::zombie(init);
            let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while ending() && std::time::Instant::now() < until { std::thread::sleep(std::time::Duration::from_millis(10)); }
            if ending() { return Err(io::Error::other(crate::tr!("its Prompt (pid {}) is still ending", "その Prompt（pid {}）がまだ終わりきっていません", init))); }
            let _ = std::fs::remove_file(e.path());
        }
        Ok(None)
    }

    /// This Prompt's tree is laid out, its pid 1 `init` in the mount namespace `ns`: recorded, if the environment is
    /// its root, for the next to join; and the lock let go of.
    fn hold(&mut self, init: libc::pid_t, ns: u64, layered: bool) -> io::Result<()> {
        if layered {
            let name = c(init.to_string());
            // SAFETY: openat in the directory this holds, by a name just made; the descriptor is taken into a File.
            let fd = unsafe { libc::openat(self.prompts.as_raw_fd(), name.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_CLOEXEC, 0o600) };
            check(fd, "prompts")?;
            self.mine = Some(name);
            std::io::Write::write_all(&mut unsafe { std::fs::File::from_raw_fd(fd) }, ns.to_string().as_bytes())?;
        }
        // SAFETY: flock on the descriptor this holds.
        check(unsafe { libc::flock(self.prompts.as_raw_fd(), libc::LOCK_UN) }, "flock")
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        // SAFETY: unlinkat in the directory this holds, of the name it wrote there.
        if let Some(name) = &self.mine { unsafe { libc::unlinkat(self.prompts.as_raw_fd(), name.as_ptr(), 0) }; }
    }
}

/// A clone of the overlay that is the root of the mount namespace `mnt` (a running Prompt's), made there and
/// brought back into this process's own: the same overlay, mounted, without what that Prompt mounted on it.
fn clone_root(mnt: &OwnedFd) -> io::Result<OwnedFd> {
    let here = std::env::current_dir().ok();
    let own = std::fs::File::open("/proc/self/ns/mnt")?;
    check(unsafe { libc::setns(mnt.as_raw_fd(), libc::CLONE_NEWNS) }, "setns")?;
    // SAFETY: open_tree of `/` there, which is that Prompt's root; a new descriptor, or -1.
    let fd = unsafe { libc::syscall(libc::SYS_open_tree, libc::AT_FDCWD, c"/".as_ptr(), libc::OPEN_TREE_CLONE | libc::OPEN_TREE_CLOEXEC) } as libc::c_int;
    // SAFETY: a descriptor open_tree just made, owned from here on.
    let cloned = check(fd, "open_tree").map(|()| unsafe { OwnedFd::from_raw_fd(fd) });
    // Back in its own namespace, and where it was (setns leaves it at the namespace's /), so a relative data
    // directory is found as before.
    check(unsafe { libc::setns(own.as_raw_fd(), libc::CLONE_NEWNS) }, "setns")?;
    if let Some(here) = here { std::env::set_current_dir(here)?; }
    cloned
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
    let mut flags = libc::CLONE_NEWNS | libc::CLONE_NEWPID | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS;
    if !s.network {
        flags |= libc::CLONE_NEWNET;
    }
    // The repo's environment, held while this Prompt joins or mounts it and lays out its tree.
    let mut env = s.data.as_ref().map(|data| Environment::lock(&crate::owned::env_over(data, &s.name, &s.root))).transpose()?;
    // A Prompt of the repo running on this root already: this one joins its user namespace (the same user's, so it
    // may) and its environment; one that cannot is not started, rather than mount another over it.
    let joined = match env.as_ref().map(Environment::running).transpose().map_err(|e| not_joined(s, e))?.flatten() {
        Some((user, mnt)) => {
            let join = || {
                check(unsafe { libc::setns(user.as_raw_fd(), libc::CLONE_NEWUSER) }, "setns")?;
                check(unsafe { libc::unshare(flags) }, "unshare")?;
                clone_root(&mnt)
            };
            Some(join().map_err(|e| not_joined(s, e))?)
        }
        None => {
            check(unsafe { libc::unshare(libc::CLONE_NEWUSER | flags) }, "unshare (user namespaces may be off on this host)")?;
            write("/proc/self/setgroups", "deny")?;
            write("/proc/self/uid_map", &format!("0 {uid} 1"))?;
            write("/proc/self/gid_map", &format!("0 {gid} 1"))?;
            None
        }
    };
    // The mount namespace pid 1 lays out its tree in (this one's), as a Prompt after it finds it.
    let ns = std::fs::metadata("/proc/self/ns/mnt")?.ino();
    // Pid 1 says once its tree is laid out whether the environment is its root (or, failing, ends unsaid).
    let mut ready = [0; 2];
    check(unsafe { libc::pipe2(ready.as_mut_ptr(), libc::O_CLOEXEC) }, "pipe")?;
    let front = Front::now();
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }
    if child == 0 {
        // Pid 1 inside: dies with its supervisor, and everything in it with it. The environment's lock is the
        // supervisor's to let go of, not held on in here.
        drop(env);
        unsafe { libc::close(ready[0]) };
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) };
        match build(s, joined) {
            Ok(layered) => {
                unsafe { libc::write(ready[1], [layered as u8].as_ptr() as *const libc::c_void, 1) };
                unsafe { libc::close(ready[1]) };
            }
            Err(e) => {
                eprintln!("{}", crate::tr!("l3: Could not prepare the Prompt: {}", "l3: Prompt を用意できませんでした：{}", e));
                unsafe { libc::_exit(126) };
            }
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
    drop(joined);
    unsafe { libc::close(ready[1]) };
    // The supervisor: pass Ctrl-C to init, which hands it to the shell's group.
    SUPERVISED.store(child, std::sync::atomic::Ordering::SeqCst);
    unsafe { libc::signal(libc::SIGINT, forward as *const () as libc::sighandler_t) };
    // Laid out: recorded over the environment if that is its root, and the next Prompt may join it. One that
    // could not be recorded is ended (a Prompt after it would not know to join it).
    let mut said = [0u8; 1];
    let n = loop {
        let n = unsafe { libc::read(ready[0], said.as_mut_ptr() as *mut libc::c_void, 1) };
        if n >= 0 || io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) { break n; }
    };
    unsafe { libc::close(ready[0]) };
    let held = env.as_mut().map_or(Ok(()), |e| e.hold(child, ns, n == 1 && said[0] == 1));
    if held.is_err() { unsafe { libc::kill(child, libc::SIGKILL) }; }
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
    // Ended: its file over the environment goes (dropped), and the environment is unmounted once no Prompt holds it.
    drop(env);
    waited?;
    held?;
    Ok(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) })
}

/// A Prompt of the repo is running over its environment, and this one could not join it: it is not started.
fn not_joined(s: &Sandbox, e: io::Error) -> io::Error {
    io::Error::new(e.kind(), crate::tr!(
        "Another Prompt of {} is running over its environment, and this one could not join it ({}); it can start once that one has ended",
        "{} の別の Prompt がその環境の上で動いていて、この Prompt はそこに加われませんでした（{}）。そちらが終われば開けます", s.name, e))
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

/// In a child: killed when `parent` ends, or ended now if it has already.
fn ends_with(parent: u32) -> io::Result<()> {
    unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) };
    if unsafe { libc::getppid() } as u32 != parent { unsafe { libc::_exit(128 + libc::SIGKILL) } }
    Ok(())
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
            // apt runs dpkg on a pty it opens (the Prompt's own); where the Prompt has none, apt is told not to, rather
            // than say it could not (E: … posix_openpt) of an install that went well.
            script += &format!("export DEBIAN_FRONTEND=noninteractive\n[ -e /dev/ptmx ] || pty='-o Dpkg::Use-Pty=0'\napt-get update -q\napt-get install -y -q --no-install-recommends $pty {}\n", packages.join(" "));
        } else {
            eprintln!("{}", crate::tr!("l3: this root has no package archive yet: .packages is for Ubuntu and Debian", "l3: この root にはまだパッケージの置き場がありません。.packages は Ubuntu と Debian で使えます"));
        }
    }
    if !setup.trim().is_empty() { script += "sh /root/.setup\n"; }
    let done = || -> io::Result<()> { if let Some(d) = stamp.parent() { std::fs::create_dir_all(d)?; } std::fs::write(&stamp, &key) };
    if script == "set -e\n" { return done(); }
    eprintln!("{}", crate::tr!("l3: setting up from .packages and .setup…", "l3: .packages と .setup から用意しています…"));
    // It ends with the Prompt it prepares: stopped meanwhile (its supervisor killed, prompt::stop), nothing goes
    // on writing into the repo's environment and caches, which its record no longer keeps.
    let supervisor = std::process::id();
    let code = run_apart_with(&Sandbox { argv: vec!["/bin/sh".into(), "-c".into(), script], network: true, ..s.clone() }, || ends_with(supervisor))?;
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
        // A place of each call's own: the tests that call this run side by side.
        static CALLS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let top = std::env::temp_dir().join(format!("l3-prompt-test-{}-{}", std::process::id(), CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
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
        let top = std::env::temp_dir().join(format!("l3-environment-test-{}", std::process::id()));
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
            let s = Sandbox { root: root.clone(), repo: repo.clone(), name: "t".into(), argv: vec!["/bin/sh".into(), "-c".into(), script],
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
        let prompts = crate::owned::env_over(&data, "t", &root).join("prompts");
        assert_eq!(std::fs::read_dir(prompts).unwrap().count(), 0, "every Prompt over it has ended");
        let _ = std::fs::remove_dir_all(&top);
    }
}
