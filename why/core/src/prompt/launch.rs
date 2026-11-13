//! A Prompt on this machine: the distribution's root, run by the host's own
//! kernel, with nothing of the host's but what is handed in. No privilege
//! is needed: a user namespace makes the caller root inside it only.
//!
//!   /               the installed root, with the repo's environment over
//!                   it (prompt/writes.rs): what a package manager installs is the
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
//!                   escapes are found through (prompt/seccomp.rs): ptrace, mount,
//!                   namespaces, modules, bpf, keys and the like
//!
//! The environment is set, not inherited: no host home, keys, agent or
//! variables come in. Pid 1 inside is a small init (this process) that
//! reaps everything and, when the shell ends, ends everything left; and it
//! is killed with its supervisor, so no process of a Prompt outlives it.

// The kernel is asked through rustix's safe calls (mounts, pivot_root, namespaces entered, waits, signals sent, the
// terminal's group). Unsafe is left only for what no safe call says: fork, unshare, a signal's handler set, the
// shell's exec in the child of a fork, kill(-1), and _exit after a fork; each block one call, its reason beside it.

use rustix::mount::{MountFlags, MountPropagationFlags};
use rustix::process::{Pid, Signal, WaitOptions, WaitStatus};
use std::ffi::CString;
use std::io;
use std::os::fd::{AsFd, OwnedFd};
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
    /// (prompt/writes.rs); without one the root is read-only and nothing outlives the Prompt.
    pub data: Option<PathBuf>,
    /// What it is told besides, in its environment (a task's words: compute/spec.rs Spec): added to what every Prompt
    /// runs with, never over it.
    pub env: Vec<(String, String)>,
}

/// Home keeps the dotfiles (home/); a Prompt writes into /root those this device took (dotfiles_in_effect).
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

/// What a call that failed says, after what was asked.
fn failed(what: impl std::fmt::Display) -> impl FnOnce(rustix::io::Errno) -> io::Error {
    move |e| {
        let e = io::Error::from(e);
        io::Error::new(e.kind(), format!("{what}: {e}"))
    }
}

/// A filesystem of `kind` (tmpfs, proc, devpts, overlay) made at `at`, with `options`.
fn fresh(kind: &str, at: &Path, flags: MountFlags, options: Option<&str>) -> io::Result<()> {
    let options = options.map(c);
    rustix::mount::mount(kind, at, kind, flags, options.as_deref()).map_err(failed(format!("mount {}", at.display())))
}

/// What is mounted at `at` (and under it, `deep`) is seen in this namespace only: nothing done here goes out, nothing
/// mounted outside later comes in.
fn private(at: &Path, deep: bool) -> io::Result<()> {
    let flags = if deep { MountPropagationFlags::PRIVATE | MountPropagationFlags::REC } else { MountPropagationFlags::PRIVATE };
    rustix::mount::mount_change(at, flags).map_err(failed(format!("mount {}", at.display())))
}

/// The flags a mount already has that a remount inside a user namespace
/// must keep (the kernel refuses to drop locked ones).
fn locked_flags(path: &Path) -> MountFlags {
    use rustix::fs::StatVfsMountFlags as St;
    let Ok(s) = rustix::fs::statvfs(path) else { return MountFlags::empty() };
    [(St::NOSUID, MountFlags::NOSUID), (St::NODEV, MountFlags::NODEV), (St::NOEXEC, MountFlags::NOEXEC),
        (St::NOATIME, MountFlags::NOATIME), (St::NODIRATIME, MountFlags::NODIRATIME), (St::RELATIME, MountFlags::RELATIME)]
        .into_iter().filter(|(st, _)| s.f_flag.contains(*st)).fold(MountFlags::empty(), |out, (_, ms)| out | ms)
}

/// `at`, mounted already, made read-only, with the flags it must keep.
fn read_only(at: &Path) -> io::Result<()> {
    rustix::mount::mount_remount(at, MountFlags::BIND | MountFlags::RDONLY | locked_flags(at), "").map_err(failed(format!("mount {}", at.display())))
}

fn bind(src: &Path, dst: &Path, read_only_too: bool) -> io::Result<()> {
    rustix::mount::mount_bind_recursive(src, dst).map_err(failed(format!("mount {}", dst.display())))?;
    if read_only_too { read_only(dst)?; }
    Ok(())
}

/// A process's wait status as a shell says it: its exit code, or 128 and the signal that ended it.
fn code_of(status: WaitStatus) -> i32 {
    status.exit_status().unwrap_or_else(|| 128 + status.terminating_signal().unwrap_or(0))
}

/// Wait for `pid` to end, through signals that interrupt the waiting.
fn wait_for(pid: Pid) -> io::Result<WaitStatus> {
    loop {
        match rustix::process::waitpid(Some(pid), WaitOptions::empty()) {
            Ok(Some((_, status))) => return Ok(status),
            Ok(None) | Err(rustix::io::Errno::INTR) => continue,
            Err(e) => return Err(e.into()),
        }
    }
}

/// The child's pid as fork gave it to the parent; none when fork failed (-1, and errno says why).
fn pid(raw: libc::pid_t) -> io::Result<Pid> {
    (raw > 0).then(|| Pid::from_raw(raw)).flatten().ok_or_else(io::Error::last_os_error)
}

/// Where a Prompt's programs are looked for.
const PROMPT_PATH: &str = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// What a Prompt runs with: set here, never taken from the host; then what it is told besides (`told`), each by
/// a name of capitals, digits and _ that is none of these, its words without a NUL.
fn environment(name: &str, shell: &str, told: &[(String, String)]) -> Vec<CString> {
    let lang = if crate::text::i18n::ja() { "ja" } else { "en" };
    let mut all: Vec<String> = [
        format!("PATH={PROMPT_PATH}"),
        "HOME=/root".into(),
        "USER=root".into(),
        "LOGNAME=root".into(),
        format!("SHELL={shell}"),
        format!("TERM={}", term()),
        "LANG=C.UTF-8".into(),
        "PS1=$PWD $ ".into(),
        // The root's own why sees the open repo where the shell does, and leaves Home, the Remote and the
        // device to the app; it speaks the person's language (Home's).
        "WHY_REPOS=/root".into(),
        "WHY_PROMPT=1".into(),
        format!("WHY_REPO={name}"),
        format!("WHY_LANG={lang}"),
        // The same four by the names the root released as 0.6.4 reads them by (its l3 and its shell's settings),
        // and where an interactive sh finds those settings: all five go when the pin is of a root made after it.
        "LENGTH3_REPOS=/root".into(),
        "L3_PROMPT=1".into(),
        format!("LENGTH3_REPO={name}"),
        format!("LENGTH3_LANG={lang}"),
        "ENV=/etc/length3/shrc".into(),
    ].into();
    // The person's clock: the root has every zone the host may name, so date, ls -l and git's log read as theirs.
    if let Some(z) = zone() { all.push(format!("TZ={z}")); }
    let fixed: Vec<String> = all.iter().filter_map(|e| e.split_once('=').map(|(k, _)| k.to_string())).collect();
    for (k, v) in told {
        if k.is_empty() || !k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') || fixed.contains(k) { continue; }
        all.push(format!("{k}={}", v.replace('\0', "")));
    }
    all.iter().map(c).collect()
}

/// The host's time zone by its name: TZ where it names one, else the zone /etc/localtime is (a link into a
/// zoneinfo directory, on Linux and macOS alike). Only a plain name passes; none, and the Prompt keeps UTC.
fn zone() -> Option<String> {
    let named = std::env::var("TZ").ok().map(|t| t.trim_start_matches(':').to_string()).filter(|t| !t.is_empty()).or_else(|| {
        let at = std::fs::read_link("/etc/localtime").ok()?;
        Some(at.to_str()?.split_once("zoneinfo/")?.1.to_string())
    })?;
    plain_zone(&named).then_some(named)
}

/// A zone's name as zoneinfo has them (Asia/Tokyo, Etc/GMT+9), or a POSIX rule (JST-9): nothing that leaves it.
fn plain_zone(z: &str) -> bool {
    !z.is_empty() && z.len() <= 64 && !z.contains("..") && !z.starts_with('/')
        && z.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b))
}

/// The terminal the Prompt is drawn on: a real one's name when why runs in one (so nano and
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
    private(Path::new("/"), true)?;
    // The repo's environment over the root, where the kernel lets a user make an overlay; else the root alone
    // (never under a Prompt that has it: one that joins it has it, or does not start).
    let layered = match &s.data {
        Some(data) if joined.is_some() => Some(environment_over(&s.root, data, &s.name, joined)?),
        Some(data) => environment_over(&s.root, data, &s.name, None).ok(),
        None => None,
    };
    let top = layered.as_ref().unwrap_or(&s.root);
    if layered.is_none() { rustix::mount::mount_bind_recursive(top, top).map_err(failed(format!("mount {}", top.display())))?; }
    // Writable places first, while their mount points can still be made.
    let home = top.join("root");
    fresh("tmpfs", &home, MountFlags::NOSUID | MountFlags::NODEV, Some("mode=0700,size=16m"))?;
    let at = home.join(&s.name);
    std::fs::create_dir(&at)?;
    bind(&s.repo, &at, false)?;
    // The person's dotfiles, fresh in every Prompt (the repo stays the only place written back).
    for (name, text) in &s.dotfiles {
        if dotfile_name(name) && name != &format!(".{}", s.name) { std::fs::write(home.join(name), text)?; }
    }
    // The repo's caches: on the host, so what is left in them can be taken back from outside.
    if let Some(data) = &s.data {
        for (inside, name) in crate::prompt::writes::CACHES {
            let host = crate::prompt::writes::cache_dir(data, &s.name).join(name);
            std::fs::create_dir_all(&host)?;
            let at = top.join(inside);
            // Without the environment over it, the root on the host is not written to: only places it has.
            let there = if layered.is_some() || inside.starts_with("root/") { std::fs::create_dir_all(&at).is_ok() } else { at.is_dir() };
            if there { bind(&host, &at, false)?; }
        }
    }
    for (dir, size) in [("tmp", "1g"), ("run", "64m")] {
        fresh("tmpfs", &top.join(dir), MountFlags::NOSUID | MountFlags::NODEV, Some(&format!("mode=1777,size={size}")))?;
    }
    // With the network, the host's resolver too, where the root looks for it.
    if s.network { resolver(top)?; }
    let dev = top.join("dev");
    fresh("tmpfs", &dev, MountFlags::NOSUID | MountFlags::NOEXEC, Some("mode=0755,size=64k"))?;
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
    if fresh("devpts", &pts, MountFlags::NOSUID | MountFlags::NOEXEC, Some("newinstance,ptmxmode=0666,mode=0620")).is_ok() {
        std::os::unix::fs::symlink("pts/ptmx", dev.join("ptmx"))?;
    }
    for (link, to) in [("fd", "/proc/self/fd"), ("stdin", "/proc/self/fd/0"), ("stdout", "/proc/self/fd/1"), ("stderr", "/proc/self/fd/2")] {
        std::os::unix::fs::symlink(to, dev.join(link))?;
    }
    fresh("proc", &top.join("proc"), MountFlags::NOSUID | MountFlags::NODEV | MountFlags::NOEXEC, None)?;
    // Then the root itself becomes read-only (unless the repo's environment is over it, which takes
    // what is written); what was mounted on it stays as it is.
    if layered.is_none() { read_only(top)?; }
    // Become that root, and let go of the host's tree entirely.
    let chdir = |to: &Path| std::env::set_current_dir(to).map_err(|e| io::Error::new(e.kind(), format!("chdir {}: {e}", to.display())));
    chdir(top)?;
    rustix::process::pivot_root(".", ".").map_err(failed("pivot_root"))?;
    rustix::mount::unmount(".", rustix::mount::UnmountFlags::DETACH).map_err(failed("umount old root"))?;
    chdir(&Path::new("/root").join(&s.name))?;
    let _ = rustix::system::sethostname(b"why");
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
            let file = top.join("run/why-resolv.conf");
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
    let env = crate::prompt::writes::env_over(data, repo, root);
    let (upper, work, merged) = (env.join("upper"), env.join("work"), env.join("merged"));
    for d in [&upper, &work, &merged] { std::fs::create_dir_all(d)?; }
    if let Some(overlay) = joined {
        // The detached mount `overlay` holds, by its descriptor, onto a directory just made.
        rustix::mount::move_mount(&overlay, "", rustix::fs::CWD, &merged, rustix::mount::MoveMountFlags::MOVE_MOUNT_F_EMPTY_PATH).map_err(failed("move_mount"))?;
        // This Prompt's own mount of it: what is mounted on it here never reaches the other Prompt's tree, nor theirs this one's.
        private(&merged, false)?;
        return Ok(merged);
    }
    // userxattr: in a user namespace the overlay keeps its marks in user.* xattrs; without it it cannot mark
    // a new directory as its own and refuses to rename any (dpkg renames each it unpacks).
    let options = format!("lowerdir={},upperdir={},workdir={},userxattr", root.display(), upper.display(), work.display());
    fresh("overlay", &merged, MountFlags::NOSUID | MountFlags::NODEV, Some(&options))?;
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
    mine: Option<String>,
}

impl Environment {
    /// Wait for the environment's lock, and hold it.
    fn lock(env: &Path) -> io::Result<Environment> {
        let dir = env.join("prompts");
        std::fs::create_dir_all(&dir)?;
        let prompts = std::fs::File::open(&dir)?;
        // Let go of when it is closed, however the process ends.
        loop {
            match prompts.lock() { Err(e) if e.kind() == io::ErrorKind::Interrupted => continue, r => break r?, }
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
            let ending = || ns_of().is_none() && crate::prompt::running::start_ticks(init).is_some() && !crate::prompt::running::zombie(init);
            let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while ending() && std::time::Instant::now() < until { std::thread::sleep(std::time::Duration::from_millis(10)); }
            if ending() { return Err(io::Error::other(crate::tr!("its Prompt (pid {}) is still ending", "その Prompt（pid {}）がまだ終わりきっていません", init))); }
            let _ = std::fs::remove_file(e.path());
        }
        Ok(None)
    }

    /// This Prompt's tree is laid out, its pid 1 `init` in the mount namespace `ns`: recorded, if the environment is
    /// its root, for the next to join; and the lock let go of.
    fn hold(&mut self, init: Pid, ns: u64, layered: bool) -> io::Result<()> {
        if layered {
            use rustix::fs::{Mode, OFlags};
            // Made in the directory this holds (its descriptor, not its path: by now `/` is the Prompt's).
            let name = init.as_raw_nonzero().to_string();
            let fd = rustix::fs::openat(&self.prompts, name.as_str(), OFlags::WRONLY | OFlags::CREATE | OFlags::TRUNC | OFlags::CLOEXEC, Mode::from_raw_mode(0o600))
                .map_err(failed("prompts"))?;
            self.mine = Some(name);
            std::io::Write::write_all(&mut std::fs::File::from(fd), ns.to_string().as_bytes())?;
        }
        self.prompts.unlock()
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        // The name it wrote in the directory this holds.
        if let Some(name) = &self.mine { let _ = rustix::fs::unlinkat(&self.prompts, name.as_str(), rustix::fs::AtFlags::empty()); }
    }
}

/// A clone of the overlay that is the root of the mount namespace `mnt` (a running Prompt's), made there and
/// brought back into this process's own: the same overlay, mounted, without what that Prompt mounted on it.
fn clone_root(mnt: &OwnedFd) -> io::Result<OwnedFd> {
    let here = std::env::current_dir().ok();
    let own = std::fs::File::open("/proc/self/ns/mnt")?;
    let enter = |ns: std::os::fd::BorrowedFd| rustix::thread::move_into_link_name_space(ns, Some(rustix::thread::LinkNameSpaceType::Mount)).map_err(failed("setns"));
    enter(mnt.as_fd())?;
    // `/` there, which is that Prompt's root.
    use rustix::mount::OpenTreeFlags;
    let cloned = rustix::mount::open_tree(rustix::fs::CWD, "/", OpenTreeFlags::OPEN_TREE_CLONE | OpenTreeFlags::OPEN_TREE_CLOEXEC).map_err(failed("open_tree"));
    // Back in its own namespace, and where it was (setns leaves it at the namespace's /), so a relative data
    // directory is found as before.
    enter(own.as_fd())?;
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
    let not_started = crate::tr!("why: {} could not start: ", "why: {} を起動できませんでした：", s.argv[0]);
    // The shell a person's programs start for them (an editor's :!, tmux's panes) is the one they were given.
    let shell = if s.argv.first().is_some_and(|a| a.ends_with("/bash")) { "/bin/bash" } else { "/bin/sh" };
    let env = environment(&s.name, shell, &s.env);
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
    let Ok(shell) = pid(shell) else { unsafe { libc::_exit(126) } };
    let _ = rustix::process::setpgid(Some(shell), Some(shell));
    SHELL.store(shell.as_raw_nonzero().get(), std::sync::atomic::Ordering::SeqCst);
    // SIGUSR1 from the supervisor is Ctrl-C: SIGINT to the shell's group.
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGUSR1, interrupt as *const () as libc::sighandler_t);
    }
    loop {
        match rustix::process::wait(WaitOptions::empty()) {
            Ok(Some((ended, status))) if ended == shell => {
                // Whatever the shell left running ends with it: every process this pid namespace holds (kill(-1),
                // which no safe call says).
                unsafe { libc::kill(-1, libc::SIGKILL) };
                while rustix::process::wait(WaitOptions::empty()).is_ok_and(|w| w.is_some()) {}
                unsafe { libc::_exit(code_of(status)) };
            }
            Err(e) if e != rustix::io::Errno::INTR => unsafe { libc::_exit(1) },
            _ => {}
        }
    }
}

/// Why this machine does not let a Prompt run on the root here, if it does not: a child of this process makes the
/// namespaces a Prompt is made in (a user namespace, and a mount namespace in it) and mounts in them, then ends.
/// A kernel may have user namespaces off for everyone (user.max_user_namespaces=0, or
/// kernel.unprivileged_userns_clone=0); Ubuntu 23.10 and later keep them, through AppArmor, from a program no profile
/// lets make them (the .deb's lets /usr/bin/why). Where they cannot be made, Prompts run translated, as in a browser.
pub fn kept_from_namespaces() -> Option<String> {
    // SAFETY: the child makes only system calls (no allocation, no lock: the caller may have threads), then _exit.
    let child = unsafe { libc::fork() };
    if child < 0 { return Some(io::Error::last_os_error().to_string()); }
    if child == 0 {
        let code = if unsafe { libc::unshare(libc::CLONE_NEWUSER | libc::CLONE_NEWNS) } != 0 { 1 }
            else if rustix::mount::mount_change(c"/", MountPropagationFlags::PRIVATE | MountPropagationFlags::REC).is_err() { 2 }
            else { 0 };
        unsafe { libc::_exit(code) };
    }
    let status = match pid(child).and_then(wait_for) { Ok(s) => s, Err(e) => return Some(e.to_string()) };
    match status.exit_status() {
        Some(0) => None,
        Some(1) => Some(crate::tr!("This system lets no program make user namespaces, which Prompts are made in (user.max_user_namespaces, kernel.unprivileged_userns_clone)",
            "このシステムは、Prompt が作られるユーザー名前空間をどのプログラムにも作らせません（user.max_user_namespaces、kernel.unprivileged_userns_clone）")),
        Some(_) => Some(crate::tr!("AppArmor keeps user namespaces from this why (Ubuntu 23.10 and later); the .deb installs the profile that lets /usr/bin/why make them",
            "AppArmor がこの why にユーザー名前空間を作らせません（Ubuntu 23.10 以降）。.deb で入れると、/usr/bin/why に作らせるプロファイルが入ります")),
        None => Some(crate::tr!("The check of user namespaces ended by a signal", "ユーザー名前空間の確認がシグナルで終わりました")),
    }
}

/// Run `s` and return the shell's exit code. Must be called from a process
/// with one thread (why itself), since it forks and changes namespaces.
pub fn run(s: &Sandbox) -> io::Result<i32> {
    if !s.root.join("bin").exists() {
        return Err(io::Error::new(io::ErrorKind::NotFound, crate::tr!("There is no root (why root install)", "root がありません（why root install）")));
    }
    let (uid, gid) = (rustix::process::getuid().as_raw(), rustix::process::getgid().as_raw());
    let mut flags = libc::CLONE_NEWNS | libc::CLONE_NEWPID | libc::CLONE_NEWIPC | libc::CLONE_NEWUTS;
    if !s.network {
        flags |= libc::CLONE_NEWNET;
    }
    // The repo's environment, held while this Prompt joins or mounts it and lays out its tree.
    let mut env = s.data.as_ref().map(|data| Environment::lock(&crate::prompt::writes::env_over(data, &s.name, &s.root))).transpose()?;
    // A Prompt of the repo running on this root already: this one joins its user namespace (the same user's, so it
    // may) and its environment; one that cannot is not started, rather than mount another over it.
    let joined = match env.as_ref().map(Environment::running).transpose().map_err(|e| not_joined(s, e))?.flatten() {
        Some((user, mnt)) => {
            let join = || {
                rustix::thread::move_into_link_name_space(user.as_fd(), Some(rustix::thread::LinkNameSpaceType::User)).map_err(failed("setns"))?;
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
    let (heard, said_by) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC).map_err(failed("pipe"))?;
    let front = Front::now();
    // SAFETY: called from a process of one thread (above), so the child may go on as this process did.
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }
    if child == 0 {
        // Pid 1 inside: dies with its supervisor, and everything in it with it. The environment's lock is the
        // supervisor's to let go of, not held on in here.
        drop(env);
        drop(heard);
        let _ = rustix::process::set_parent_process_death_signal(Some(Signal::KILL));
        match build(s, joined) {
            Ok(layered) => {
                let _ = rustix::io::write(&said_by, &[layered as u8]);
                drop(said_by);
            }
            Err(e) => {
                eprintln!("{}", crate::tr!("why: Could not prepare the Prompt: {}", "why: Prompt を用意できませんでした：{}", e));
                unsafe { libc::_exit(126) };
            }
        }
        // The tree is laid out: from here on nothing in the Prompt asks the kernel what prompt/seccomp.rs refuses,
        // init and everything it starts. A kernel that cannot filter runs no Prompt (fails closed).
        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        if let Err(e) = crate::prompt::seccomp::install() {
            eprintln!("{}", crate::tr!("why: Could not prepare the Prompt: {}", "why: Prompt を用意できませんでした：{}", format!("seccomp: {e}")));
            unsafe { libc::_exit(126) };
        }
        init(s);
    }
    drop(joined);
    drop(said_by);
    let child = pid(child)?;
    // The supervisor: pass Ctrl-C to init, which hands it to the shell's group.
    SUPERVISED.store(child.as_raw_nonzero().get(), std::sync::atomic::Ordering::SeqCst);
    // SAFETY: the handler only loads an atomic and sends a signal, both safe in a handler.
    unsafe { libc::signal(libc::SIGINT, forward as *const () as libc::sighandler_t) };
    // Laid out: recorded over the environment if that is its root, and the next Prompt may join it. One that
    // could not be recorded is ended (a Prompt after it would not know to join it).
    let mut said = [0u8; 1];
    let n = loop {
        match rustix::io::read(&heard, &mut said) { Err(rustix::io::Errno::INTR) => continue, r => break r.unwrap_or(0) }
    };
    drop(heard);
    let held = env.as_mut().map_or(Ok(()), |e| e.hold(child, ns, n == 1 && said[0] == 1));
    if held.is_err() { let _ = rustix::process::kill_process(child, Signal::KILL); }
    let waited = wait_for(child);
    front.give_back();
    // Ended: its file over the environment goes (dropped), and the environment is unmounted once no Prompt holds it.
    drop(env);
    let status = waited?;
    held?;
    Ok(code_of(status))
}

/// A Prompt of the repo is running over its environment, and this one could not join it: it is not started.
fn not_joined(s: &Sandbox, e: io::Error) -> io::Error {
    io::Error::new(e.kind(), crate::tr!(
        "Another Prompt of {} is running over its environment, and this one could not join it ({}); it can start once that one has ended",
        "{} の別の Prompt がその環境の上で動いていて、この Prompt はそこに加われませんでした（{}）。そちらが終われば開けます", s.name, e))
}

/// The terminal's group in front when a Prompt starts. The shell inside takes the terminal (init),
/// and when it ends its group is gone: whoever started it is left behind, where reading a key stops
/// it (SIGTTIN) or ends input (bug: Menu → Prompt → exit left why instead of the menu). So it is given back.
struct Front(Option<Pid>);

impl Front {
    fn now() -> Front {
        let input = std::io::stdin();
        Front(rustix::termios::isatty(&input).then(|| rustix::termios::tcgetpgrp(&input).ok()).flatten())
    }

    fn give_back(&self) {
        let Some(group) = self.0 else { return };
        // Asked from behind, the request is SIGTTOU: ignored for the asking, then as it was.
        // SAFETY: the disposition set is SIG_IGN, and then the one there before.
        let before = unsafe { libc::signal(libc::SIGTTOU, libc::SIG_IGN) };
        let _ = rustix::termios::tcsetpgrp(std::io::stdin(), group);
        // SAFETY: as above.
        unsafe { libc::signal(libc::SIGTTOU, before) };
    }
}

/// Run `s` in a child, so this process keeps its own namespaces and can run another after it, with `keep` made in
/// the child first and held while it runs: the child is the Prompt's supervisor, so its record (prompt::record) names
/// the child, which Stop ends. The exit code of the child's shell.
pub fn run_apart_with<G>(s: &Sandbox, keep: impl FnOnce() -> io::Result<G>) -> io::Result<i32> {
    let front = Front::now();
    // SAFETY: called from a process of one thread (why), so the child may go on as this process did; it leaves
    // with _exit, never returning into the caller's code.
    let child = unsafe { libc::fork() };
    if child < 0 { return Err(io::Error::last_os_error()); }
    if child == 0 {
        let code = match keep() {
            Ok(held) => { let code = run(s).unwrap_or_else(|e| { eprintln!("why: {e}"); 126 }); drop(held); code }
            Err(e) => { eprintln!("why: {e}"); 126 }
        };
        unsafe { libc::_exit(code) };
    }
    // Ctrl-C is the child's to pass on; this one waits it out.
    // SAFETY: the disposition set is SIG_IGN, and then the one there before.
    let before = unsafe { libc::signal(libc::SIGINT, libc::SIG_IGN) };
    let waited = pid(child).and_then(wait_for);
    // SAFETY: as above.
    unsafe { libc::signal(libc::SIGINT, before) };
    // Stopped from outside, the child gave nothing back itself.
    front.give_back();
    Ok(code_of(waited?))
}

/// In a child: killed when `parent` ends, or ended now if it has already.
fn ends_with(parent: u32) -> io::Result<()> {
    rustix::process::set_parent_process_death_signal(Some(Signal::KILL)).map_err(failed("prctl"))?;
    if rustix::process::getppid().map(|p| p.as_raw_nonzero().get() as u32) != Some(parent) { unsafe { libc::_exit(128 + libc::SIGKILL) } }
    Ok(())
}

/// A package's name as `.packages` may give it: what apt takes, and nothing a shell reads otherwise.
fn package_name(p: &str) -> bool {
    !p.is_empty() && p.len() <= 128 && !p.starts_with('-') && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"+-.:=~_/".contains(&b))
}

/// A root's sha256, by where it is held (`system/<sha256>/root`): the name it is fetched by anywhere.
fn root_digest(root: &Path) -> String {
    root.parent().and_then(|d| d.file_name()).map_or_else(|| root.display().to_string(), |n| n.to_string_lossy().into_owned())
}

/// What an environment is, by what set it up: the root (its sha256), `.packages` and `.setup`. The same key is the
/// same environment wherever it is made (compute/spec.rs Spec), and a change to any of them sets it up again.
fn environment_key(root: &str, packages: &[&str], setup: &str) -> String {
    crate::fs::hash::sha256(format!("{root}\n{}\n{setup}", packages.join(" ")))
}

/// The environment `dotfiles` ask of the root `root` (its sha256), as environment_key names it; empty when they ask
/// for nothing (the plain root).
pub fn environment_of(root: &str, dotfiles: &[(String, String)]) -> String {
    let get = |n: &str| dotfiles.iter().find(|(k, _)| k == n).map_or("", |(_, v)| v.as_str());
    let packages: Vec<&str> = get(".packages").lines().map(|l| l.split('#').next().unwrap_or("")).flat_map(str::split_whitespace).collect();
    if packages.is_empty() && get(".setup").trim().is_empty() { return String::new(); }
    environment_key(root, &packages, get(".setup"))
}

/// What the person's dotfiles ask of a root: `.packages` (names, any number
/// a line, `#` to the end of a line left out), installed with the root's own
/// package manager, then `.setup` run with sh. Language runtimes and tools
/// come the way each says to install it, from there: the OS keeps no list of
/// its own. It runs in a Prompt of its own, with the network (fetching is
/// what it is for), over the repo's environment, so what it installs is the
/// repo's and stays; and again only when the root or either file changes.
/// `apt`: the root has apt (Ubuntu, Debian); why's own has no archive yet.
pub fn set_up(s: &Sandbox, apt: bool) -> io::Result<()> {
    let Some(data) = &s.data else { return Ok(()) };
    let get = |n: &str| s.dotfiles.iter().find(|(k, _)| k == n).map_or("", |(_, v)| v.as_str());
    let packages: Vec<&str> = get(".packages").lines().map(|l| l.split('#').next().unwrap_or("")).flat_map(str::split_whitespace).collect();
    let setup = get(".setup");
    if packages.is_empty() && setup.trim().is_empty() { return Ok(()); }
    if let Some(p) = packages.iter().find(|p| !package_name(p)) {
        eprintln!("{}", crate::tr!("why: .packages: not a package name: {}", "why: .packages：パッケージ名ではありません：{}", p));
        return Ok(());
    }
    let key = environment_key(&root_digest(&s.root), &packages, setup);
    let stamp = crate::prompt::writes::env_over(data, &s.name, &s.root).join("set-up");
    if std::fs::read_to_string(&stamp).ok().as_deref() == Some(key.as_str()) { return Ok(()); }
    let mut script = String::from("set -e\n");
    if !packages.is_empty() {
        if apt {
            // apt runs dpkg on a pty it opens (the Prompt's own); where the Prompt has none, apt is told not to, rather
            // than say it could not (E: … posix_openpt) of an install that went well.
            script += &format!("export DEBIAN_FRONTEND=noninteractive\n[ -e /dev/ptmx ] || pty='-o Dpkg::Use-Pty=0'\napt-get update -q\napt-get install -y -q --no-install-recommends $pty {}\n", packages.join(" "));
        } else {
            eprintln!("{}", crate::tr!("why: this root has no package archive yet: .packages is for Ubuntu and Debian", "why: この root にはまだパッケージの置き場がありません。.packages は Ubuntu と Debian で使えます"));
        }
    }
    if !setup.trim().is_empty() { script += "sh /root/.setup\n"; }
    let done = || -> io::Result<()> { if let Some(d) = stamp.parent() { std::fs::create_dir_all(d)?; } std::fs::write(&stamp, &key) };
    if script == "set -e\n" { return done(); }
    eprintln!("{}", crate::tr!("why: setting up from .packages and .setup…", "why: .packages と .setup から用意しています…"));
    // It ends with the Prompt it prepares: stopped meanwhile (its supervisor killed, prompt::stop), nothing goes
    // on writing into the repo's environment and caches, which its record no longer keeps.
    let supervisor = std::process::id();
    let code = run_apart_with(&Sandbox { argv: vec!["/bin/sh".into(), "-c".into(), script], network: true, ..s.clone() }, || ends_with(supervisor))?;
    if code == 0 { done() } else {
        eprintln!("{}", crate::tr!("why: setting up stopped (exit {}); the Prompt starts with what is there", "why: 用意が途中で止まりました（終了 {}）。今あるもので Prompt を始めます", code));
        Ok(())
    }
}

static SUPERVISED: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static SHELL: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// In the supervisor: Ctrl-C becomes SIGUSR1 to init (both calls are signal-safe).
extern "C" fn forward(_: libc::c_int) {
    if let Some(init) = Pid::from_raw(SUPERVISED.load(std::sync::atomic::Ordering::SeqCst)) {
        let _ = rustix::process::kill_process(init, Signal::USR1);
    }
}

/// In init: SIGINT to the shell's process group. An interactive shell
/// survives it; what it runs does not, as at a terminal.
extern "C" fn interrupt(_: libc::c_int) {
    if let Some(shell) = Pid::from_raw(SHELL.load(std::sync::atomic::Ordering::SeqCst)) {
        let _ = rustix::process::kill_process_group(shell, Signal::INT);
    }
}

#[cfg(test)]
#[path = "launch.test.rs"]
mod tests;
