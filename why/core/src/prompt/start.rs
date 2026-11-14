//! A Prompt started on this machine: its bundle written (bundle.rs), `muk run` on it, and at a terminal the other end
//! of the terminal muk made handed to `prompt attach`. Nothing here makes a box: no namespace, no mount, no filter
//! (muk's, all of it: module/muk). What is here is what a product decides: which root, what is lent, what the
//! person's dotfiles ask of the root, and what a signal to the one who started it means.
//!
//!   at a terminal, the shell      a terminal of the box's own (muk makes it; `prompt attach` holds its other end):
//!                                 Ctrl-C is a byte typed there
//!   the shell, no terminal        the descriptors it was started with (the app's pipes); an interrupt (SIGINT to
//!                                 this process) is sent to what runs in the box, as a terminal sends it
//!   a command (why prompt -- …)   the descriptors it was started with; interrupted, its box ends
//!
//! The box's process is the first of its pid namespace: every process in it ends with it (the kernel's), and it ends
//! with muk, which ends with this process (its parent's end is its own: PDEATHSIG).

// Unsafe is left only where the OS is called and no safe call says it: a signal's handler set, a child told to end
// with its parent and given a descriptor before it execs, waitpid for any child. Each block one call.

use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicI32, Ordering};

use super::bundle::{self, Lent, Run, Shell, Told};

/// A Prompt to start.
#[derive(Clone)]
pub struct Prompt {
    /// The installed root (`root::current`).
    pub root: PathBuf,
    /// It is another distribution's (Ubuntu, Debian): its shell is as that distribution sets it up, and it has apt.
    pub other: bool,
    /// The repo's directory on the host, and its name inside.
    pub repo: PathBuf,
    pub name: String,
    /// What to run; none, the Prompt's shell.
    pub cmd: Vec<String>,
    /// Share the host's network (an explicit grant); otherwise there is none.
    pub network: bool,
    /// The person's dotfiles (Home's), written into /root before the shell starts.
    pub dotfiles: Vec<(String, String)>,
    /// The data directory, where the repo's environment and caches are kept (prompt/writes.rs) and the bundle is
    /// written; without one nothing outlives the Prompt.
    pub data: Option<PathBuf>,
    /// What it is told besides, in its environment (a task's words: agent/spec.rs Spec): added to what every Prompt
    /// runs with, never over it.
    pub env: Vec<(String, String)>,
    /// What a test lends besides: a directory of the host's, and where it is inside (from /).
    #[cfg(test)]
    pub also: Vec<(String, PathBuf)>,
}

/// Home keeps the dotfiles (home/); a Prompt has in /root those this device took (dotfiles_in_effect).
pub use crate::home::{dotfile_name, dotfiles_in_effect};

fn said(what: impl std::fmt::Display) -> impl FnOnce(io::Error) -> io::Error {
    move |e| io::Error::new(e.kind(), format!("{what}: {e}"))
}

/// A program why runs a box with, found beside why (installed together) unless named (`named`, in the environment);
/// in a build made to work on, the one made with it.
fn beside(name: &str, named: &str, built: Option<&str>) -> io::Result<PathBuf> {
    if let Some(p) = std::env::var_os(named) { return Ok(p.into()); }
    let here = std::env::current_exe()?.with_file_name(name);
    if here.is_file() { return Ok(here); }
    if cfg!(debug_assertions) { if let Some(b) = built.filter(|b| Path::new(b).is_file()) { return Ok(b.into()); } }
    Err(io::Error::new(io::ErrorKind::NotFound, crate::tr!("{} is not beside why ({})", "{} が why の隣にありません（{}）", name, here.display())))
}

/// muk, the one maker of a box.
pub fn muk() -> io::Result<PathBuf> {
    beside("muk", "WHY_MUK", option_env!("WHY_BUILT_MUK"))
}

/// prompt, which holds the other end of a box's terminal.
fn attach() -> io::Result<PathBuf> {
    beside("prompt", "WHY_ATTACH", option_env!("WHY_BUILT_ATTACH"))
}

/// The host's time zone by its name: TZ where it names one, else the zone /etc/localtime is (a link into a
/// zoneinfo directory). Only a plain name passes (bundle.rs); none, and the Prompt keeps UTC.
fn zone() -> Option<String> {
    std::env::var("TZ").ok().map(|t| t.trim_start_matches(':').to_string()).filter(|t| !t.is_empty()).or_else(|| {
        let at = std::fs::read_link("/etc/localtime").ok()?;
        Some(at.to_str()?.split_once("zoneinfo/")?.1.to_string())
    })
}

/// Whether this process is at a terminal, both ways.
fn at_terminal() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
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

/// Where the root looks for the resolver's file: its own /etc/resolv.conf, or where that links into /run (Ubuntu's),
/// which is the Prompt's. None where it has neither.
fn resolver_inside(root: &Path) -> Option<String> {
    let at = root.join("etc/resolv.conf");
    let m = std::fs::symlink_metadata(&at).ok()?;
    if m.file_type().is_symlink() {
        let to = std::fs::read_link(&at).ok()?;
        let inside = clean(&if to.is_absolute() { to } else { Path::new("/etc").join(to) });
        return inside.starts_with("/run").then(|| inside.to_string_lossy().into_owned());
    }
    m.is_file().then(|| "/etc/resolv.conf".to_string())
}

/// The last signal sent to this process while it waits on a box (0: none).
static SIGNALLED: AtomicI32 = AtomicI32::new(0);
extern "C" fn signalled(sig: libc::c_int) {
    SIGNALLED.store(sig, Ordering::SeqCst);
}
/// A child ended: nothing to note, the wait it interrupts looks again.
extern "C" fn woken(_: libc::c_int) {}

/// `sig` handled by `handler`, a wait it comes in the middle of interrupted (no SA_RESTART); what handled it before.
fn handle(sig: libc::c_int, handler: libc::sighandler_t) -> libc::sigaction {
    let mut new: libc::sigaction = unsafe { std::mem::zeroed() };
    new.sa_sigaction = handler;
    let mut old: libc::sigaction = unsafe { std::mem::zeroed() };
    // SAFETY: both point at live structs; the handler only stores to an atomic.
    unsafe { libc::sigaction(sig, &new, &mut old) };
    old
}

/// A child that ends when this process does, whatever ends it.
fn ends_with_me(c: &mut Command) -> &mut Command {
    // SAFETY: between fork and exec, one call that allocates nothing.
    unsafe { c.pre_exec(|| { if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 { Err(io::Error::last_os_error()) } else { Ok(()) } }) }
}

/// A wait status as a shell says it: the exit code, or 128 and the signal that ended it.
fn code_of(status: libc::c_int) -> i32 {
    if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) }
}

/// The terminal muk made for the box: its other end, sent over `listener` (one descriptor, and muk closes its own).
/// None where muk ended without sending it (it says why itself).
fn terminal_from(listener: &std::os::unix::net::UnixListener, muk: &mut Child) -> io::Result<Option<OwnedFd>> {
    use rustix::net::{RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags};
    // muk ending interrupts the wait (SIGCHLD, handled for that): no time is waited out, nothing is asked twice.
    let stream = loop {
        match rustix::net::accept(listener) {
            Ok(s) => break s,
            Err(rustix::io::Errno::INTR) => if muk.try_wait()?.is_some() { return Ok(None); },
            Err(e) => return Err(e.into()),
        }
    };
    let mut space = [std::mem::MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut control = RecvAncillaryBuffer::new(&mut space);
    let mut name = [0u8; 64];
    loop {
        match rustix::net::recvmsg(&stream, &mut [io::IoSliceMut::new(&mut name)], &mut control, RecvFlags::CMSG_CLOEXEC) {
            Err(rustix::io::Errno::INTR) => continue,
            Err(e) => return Err(e.into()),
            Ok(_) => break,
        }
    }
    for m in control.drain() {
        if let RecvAncillaryMessage::ScmRights(fds) = m { if let Some(fd) = fds.into_iter().next() { return Ok(Some(fd)); } }
    }
    Ok(None)
}

/// A tree copied: its directories, links and files as they are, a file with several names one file still. What a
/// filesystem can share between a file and its copy, it shares (std's copy asks the kernel to).
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    fn walk(from: &Path, to: &Path, names: &mut std::collections::HashMap<(u64, u64), PathBuf>) -> io::Result<()> {
        std::fs::create_dir(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            let (src, dst) = (e.path(), to.join(e.file_name()));
            let m = std::fs::symlink_metadata(&src)?;
            if m.is_dir() { walk(&src, &dst, names)?; }
            else if m.file_type().is_symlink() { std::os::unix::fs::symlink(std::fs::read_link(&src)?, &dst)?; }
            else if m.is_file() {
                if m.nlink() > 1 {
                    if let Some(first) = names.get(&(m.dev(), m.ino())) { std::fs::hard_link(first, &dst)?; continue; }
                    names.insert((m.dev(), m.ino()), dst.clone());
                }
                std::fs::copy(&src, &dst)?;
            }
        }
        std::fs::set_permissions(to, std::fs::metadata(from)?.permissions())
    }
    walk(from, to, &mut std::collections::HashMap::new())
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
/// same environment wherever it is made (agent/spec.rs Spec), and a change to any of them sets it up again.
fn environment_key(root: &str, packages: &[&str], setup: &str) -> String {
    crate::fs::hash::sha256(format!("{root}\n{}\n{setup}", packages.join(" ")))
}

/// The packages `.packages` names (any number a line, `#` to the end of a line left out) and `.setup`.
fn asks(dotfiles: &[(String, String)]) -> (Vec<&str>, &str) {
    let get = |n: &str| dotfiles.iter().find(|(k, _)| k == n).map_or("", |(_, v)| v.as_str());
    (get(".packages").lines().map(|l| l.split('#').next().unwrap_or("")).flat_map(str::split_whitespace).collect(), get(".setup"))
}

/// The environment `dotfiles` ask of the root `root` (its sha256), as environment_key names it; empty when they ask
/// for nothing (the plain root).
pub fn environment_of(root: &str, dotfiles: &[(String, String)]) -> String {
    let (packages, setup) = asks(dotfiles);
    if packages.is_empty() && setup.trim().is_empty() { return String::new(); }
    environment_key(root, &packages, setup)
}

/// What one box of a Prompt runs, and on what.
struct Box_<'a> {
    argv: &'a [String],
    /// A terminal of the box's own, its other end held by `prompt attach`.
    terminal: bool,
    network: bool,
    /// What a signal to this process means: the shell's is passed to what runs in it; a command's ends its box.
    shell: bool,
}

impl Prompt {
    /// The repo's environment: a root of its own, where one was made (set_up); the root's own directory beside it.
    fn environment(&self) -> Option<PathBuf> {
        let env = crate::prompt::writes::env_over(self.data.as_ref()?, &self.name, &self.root).join("root");
        std::fs::symlink_metadata(env.join("bin")).is_ok().then_some(env)
    }

    /// Where this Prompt's bundle is written: with its record in the data directory, or a place of its own.
    fn bundle_dir(&self) -> PathBuf {
        match &self.data {
            Some(data) => data.join("prompts").join(format!("{}.box", std::process::id())),
            None => std::env::temp_dir().join(format!("why-prompt-{}.box", std::process::id())),
        }
    }

    /// Run `b` in a box of this Prompt's and return its exit code.
    fn run_box(&self, b: &Box_) -> io::Result<i32> {
        let environment = self.environment();
        let root = environment.as_ref().unwrap_or(&self.root);
        if std::fs::symlink_metadata(root.join("bin")).is_err() {
            return Err(io::Error::new(io::ErrorKind::NotFound, crate::tr!("There is no root (why root install)", "root がありません（why root install）")));
        }
        let muk = muk()?;
        let dir = self.bundle_dir();
        let _ = std::fs::remove_dir_all(&dir);
        let gone = Gone(dir.clone());
        // The Prompt's home: the bundle's own, the person's dotfiles fresh in it (the repo stays the only place written back).
        let home = dir.join("home");
        crate::fs::write::private_dir(&dir)?;
        crate::fs::write::private_dir(&home)?;
        for (name, text) in &self.dotfiles {
            if dotfile_name(name) && name != &format!(".{}", self.name) { std::fs::write(home.join(name), text)?; }
        }
        // The repo's caches: on the host, so what is left in them can be taken back from outside. Without the
        // repo's own root, the root on the host is not written to: only the places it has.
        let mut caches = Vec::new();
        if let Some(data) = &self.data {
            for (inside, name) in crate::prompt::writes::CACHES {
                if !(inside.starts_with("root/") || environment.is_some() || root.join(inside).is_dir()) { continue; }
                let host = crate::prompt::writes::cache_dir(data, &self.name).join(name);
                std::fs::create_dir_all(&host)?;
                caches.push((inside.to_string(), host.to_string_lossy().into_owned()));
            }
        }
        #[cfg(test)]
        for (inside, host) in &self.also { caches.push((inside.clone(), host.to_string_lossy().into_owned())); }
        // With the network, the host's own (lent by its path) and its resolver's file, where the root looks for it.
        let mut resolver = None;
        if b.network {
            if let (Ok(text), Some(inside)) = (std::fs::read_to_string("/etc/resolv.conf"), resolver_inside(root)) {
                let file = dir.join("resolv.conf");
                std::fs::write(&file, text)?;
                resolver = Some((file.to_string_lossy().into_owned(), inside));
            }
        }
        let lent = Lent {
            root: root.to_string_lossy().into_owned(),
            written: environment.is_some(),
            home: Some(home.to_string_lossy().into_owned()),
            repo: Some(self.repo.to_string_lossy().into_owned()),
            caches,
            uid: rustix::process::getuid().as_raw(),
            gid: rustix::process::getgid().as_raw(),
            // (by the name that is each process's own: muk is in it as this process is, and so is the box it makes)
            network: b.network.then(|| "/proc/self/ns/net".to_string()),
            resolver,
            console: None,
        };
        let term = std::env::var("TERM").ok().filter(|t| t != "dumb" && at_terminal()).unwrap_or_default();
        let told = Told { term, zone: zone(), lang: if crate::text::i18n::ja() { "ja".into() } else { "en".into() }, more: self.env.clone() };
        let env = bundle::environment(&self.name, b.argv, &told);
        let screen = b.terminal.then(|| rustix::termios::tcgetwinsize(std::io::stdin()).map_or((80, 24), |w| (w.ws_col.max(1), w.ws_row.max(1))));
        let made = bundle::bundle(&Run { repo: &self.name, argv: b.argv, env: &env, screen }, &lent);
        crate::fs::write::replace(&dir.join("config.json"), made.config.as_bytes(), crate::fs::write::How::RECORD)?;
        let at = dir.to_string_lossy().into_owned();

        // From here a signal to this process is the box's to hear of: kept until the box has ended.
        SIGNALLED.store(0, Ordering::SeqCst);
        let before: Vec<(libc::c_int, libc::sigaction)> = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP, libc::SIGCHLD].into_iter()
            .map(|s| (s, handle(s, if s == libc::SIGCHLD { woken as *const () as libc::sighandler_t } else { signalled as *const () as libc::sighandler_t }))).collect();
        let ended = (|| -> io::Result<i32> {
            if !b.terminal {
                let mut child = ends_with_me(Command::new(&muk).args(made.words(&at, None, &self.name))).spawn().map_err(said(muk.display()))?;
                return Ok(self.wait(&mut child, None, b.shell));
            }
            // A terminal of the box's own: muk makes it and sends its other end here, and `prompt attach` holds it.
            let socket = dir.join("console");
            let socket = if socket.as_os_str().len() < 100 { socket } else { std::env::temp_dir().join(format!("why-{}.console", std::process::id())) };
            let _ = std::fs::remove_file(&socket);
            let listener = std::os::unix::net::UnixListener::bind(&socket)?;
            let _unnamed = Gone(socket.clone());
            let mut child = ends_with_me(Command::new(&muk).args(made.words(&at, Some(&socket.to_string_lossy()), &self.name))).spawn().map_err(said(muk.display()))?;
            let Some(terminal) = terminal_from(&listener, &mut child)? else { return Ok(self.wait(&mut child, None, b.shell)); };
            let fd = terminal.as_raw_fd();
            let holder = attach()?;
            let mut held = Command::new(&holder);
            held.args(["attach", "3"]);
            // SAFETY: between fork and exec, calls that allocate nothing: the terminal's descriptor as the 3 it is told.
            unsafe { held.pre_exec(move || {
                if fd == 3 { if libc::fcntl(3, libc::F_SETFD, 0) < 0 { return Err(io::Error::last_os_error()); } }
                else if libc::dup2(fd, 3) < 0 { return Err(io::Error::last_os_error()); }
                Ok(())
            }) };
            let mut holding = match ends_with_me(&mut held).spawn() {
                Ok(h) => h,
                Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(said(holder.display())(e)); }
            };
            drop(terminal);
            Ok(self.wait(&mut child, Some(&mut holding), b.shell))
        })();
        // SAFETY: each is the action that was there before, read by sigaction above.
        for (s, was) in &before { unsafe { libc::sigaction(*s, was, std::ptr::null_mut()) }; }
        drop(gone);
        ended
    }

    /// Wait for the box `muk` runs to end; its exit code. `holding`: what holds its terminal's other end, which ends
    /// when the box does, and whose end (the person's terminal gone) ends the box. A signal sent to this process
    /// meanwhile: for a shell an interrupt is passed to what runs in the box, as a terminal sends it; anything else,
    /// and any for a command, ends the box.
    fn wait(&self, muk: &mut Child, mut holding: Option<&mut Child>, shell: bool) -> i32 {
        let (box_, holder) = (muk.id() as libc::pid_t, holding.as_ref().map_or(0, |h| h.id() as libc::pid_t));
        let mut code = None;
        let mut signal = 0;
        let mut holder_gone = false;
        let end = |pid: libc::pid_t| { unsafe { libc::kill(pid, libc::SIGKILL) }; };
        loop {
            let mut status = 0;
            // SAFETY: waits for a child of this process; the status is a live int.
            let pid = unsafe { libc::waitpid(-1, &mut status, 0) };
            if pid == box_ {
                code = Some(code_of(status));
                // (the terminal's other end closes with the box: what holds it ends itself, having shown what was left)
                if holder == 0 || holder_gone { break; }
            } else if pid == holder && holder != 0 {
                if code.is_some() { break; }
                // It ends by itself, with nothing wrong, when the terminal's box end is closed: the box has ended
                // (muk is about to say how), and is waited for. Ended otherwise (the person's terminal gone, a
                // signal), so is the box.
                holder_gone = true;
                if code_of(status) != 0 { end(box_); if signal == 0 { signal = (code_of(status) - 128).max(1); } }
            } else if pid < 0 {
                if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) { break; }
                match SIGNALLED.swap(0, Ordering::SeqCst) {
                    0 => {}
                    // At a terminal of its own an interrupt is typed there; with none, it is sent to what runs in the box.
                    libc::SIGINT if shell => { if holder == 0 { interrupt(std::process::id()); } }
                    sig => { signal = sig; end(box_); }
                }
            }
        }
        // (both are waited for: nothing of them is left behind)
        let _ = muk.try_wait();
        if let Some(h) = holding.as_mut() { let _ = h.try_wait(); }
        if signal > 0 { 128 + signal } else { code.unwrap_or(1) }
    }

    /// Run the Prompt and return its exit code: its shell, or the command asked for.
    pub fn run(&self) -> io::Result<i32> {
        let terminal = self.cmd.is_empty() && at_terminal();
        let root = self.environment().unwrap_or_else(|| self.root.clone());
        let argv = if self.cmd.is_empty() { bundle::shell(Shell { bash: root.join("bin/bash").exists(), other: self.other, edits: terminal }) } else { self.cmd.clone() };
        self.run_box(&Box_ { argv: &argv, terminal, network: self.network, shell: self.cmd.is_empty() })
    }

    /// What the person's dotfiles ask of a root: `.packages` (names, any number a line, `#` to the end of a line
    /// left out), installed with the root's own package manager, then `.setup` run with sh. Language runtimes and
    /// tools come the way each says to install it, from there: the OS keeps no list of its own. It is made in a
    /// root of the repo's own (a copy of the installed one, made the first time: what it installs is the repo's and
    /// stays, and the installed root is never written), in a box of its own with the network (fetching is what it
    /// is for); and again only when the root or either file changes. Another distribution's root has apt (Ubuntu,
    /// Debian); why's own has no archive yet.
    pub fn set_up(&self) -> io::Result<()> {
        let Some(data) = &self.data else { return Ok(()) };
        let (packages, setup) = asks(&self.dotfiles);
        if packages.is_empty() && setup.trim().is_empty() { return Ok(()); }
        if let Some(p) = packages.iter().find(|p| !package_name(p)) {
            eprintln!("{}", crate::tr!("why: .packages: not a package name: {}", "why: .packages：パッケージ名ではありません：{}", p));
            return Ok(());
        }
        let key = environment_key(&root_digest(&self.root), &packages, setup);
        let env = crate::prompt::writes::env_over(data, &self.name, &self.root);
        let stamp = env.join("set-up");
        if std::fs::read_to_string(&stamp).ok().as_deref() == Some(key.as_str()) { return Ok(()); }
        let mut script = String::from("set -e\n");
        if !packages.is_empty() {
            if self.other {
                // apt runs dpkg on a pty it opens (the Prompt's own); where the Prompt has none, apt is told not to, rather
                // than say it could not (E: … posix_openpt) of an install that went well.
                script += &format!("export DEBIAN_FRONTEND=noninteractive\n[ -e /dev/ptmx ] || pty='-o Dpkg::Use-Pty=0'\napt-get update -q\napt-get install -y -q --no-install-recommends $pty {}\n", packages.join(" "));
            } else {
                eprintln!("{}", crate::tr!("why: this root has no package archive yet: .packages is for Ubuntu and Debian", "why: この root にはまだパッケージの置き場がありません。.packages は Ubuntu と Debian 用です"));
            }
        }
        if !setup.trim().is_empty() { script += "sh /root/.setup\n"; }
        let done = || -> io::Result<()> { std::fs::create_dir_all(&env)?; std::fs::write(&stamp, &key) };
        if script == "set -e\n" { return done(); }
        eprintln!("{}", crate::tr!("why: setting up from .packages and .setup…", "why: .packages と .setup から用意しています…"));
        // The repo's own root, made of the installed one the first time (whole, then named: one half copied is not one).
        if self.environment().is_none() {
            std::fs::create_dir_all(&env)?;
            let (making, made) = (env.join("root.making"), env.join("root"));
            let _ = std::fs::remove_dir_all(&making);
            copy_tree(&self.root, &making).map_err(said(making.display()))?;
            std::fs::rename(&making, &made)?;
        }
        // It ends with this process: stopped meanwhile (its supervisor killed, prompt::stop), nothing goes on writing
        // into the repo's environment and caches, which its record no longer keeps.
        let argv = ["/bin/sh".to_string(), "-c".into(), script];
        let code = self.run_box(&Box_ { argv: &argv, terminal: false, network: true, shell: false })?;
        if code == 0 { done() } else {
            eprintln!("{}", crate::tr!("why: setting up stopped (exit {}); the Prompt starts with what is there", "why: 用意が途中で止まりました（終了 {}）。今あるもので Prompt を始めます", code));
            Ok(())
        }
    }
}

/// A file or a directory that goes when this does.
struct Gone(PathBuf);
impl Drop for Gone {
    fn drop(&mut self) {
        if self.0.is_dir() { let _ = std::fs::remove_dir_all(&self.0); } else { let _ = std::fs::remove_file(&self.0); }
    }
}

/// An interrupt sent to what runs in the box `supervisor` runs (every process of its pid namespace), as a terminal
/// sends it to those in front: a shell is left at its line, what it runs is ended.
pub fn interrupt(supervisor: u32) {
    let Some(ns) = super::running::ns_of(supervisor) else { return };
    for pid in super::running::members(ns) { super::running::signal(pid, super::running::Signal::Int); }
}

/// Why this machine does not let a Prompt run on the root here, if it does not: asked of muk, by a box whose root
/// holds muk alone, which says how it is used and ends. A kernel may have user namespaces off for everyone
/// (user.max_user_namespaces=0, or kernel.unprivileged_userns_clone=0); Ubuntu 23.10 and later keep them, through
/// AppArmor, from a program no profile lets make them (the .deb's lets muk beside why). Where no box can be made,
/// Prompts run translated, as in a browser.
pub fn kept_from_boxes() -> Option<String> {
    if !cfg!(target_arch = "x86_64") { return Some(crate::tr!("muk makes a box on x86-64 only", "muk が箱を作れるのは x86-64 だけです")); }
    let muk = match muk() { Ok(m) => m, Err(e) => return Some(e.to_string()) };
    // (a place of each asking's own: two threads of one process may ask at once)
    static ASKED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!("why-box-check-{}-{}", std::process::id(), ASKED.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    let _gone = Gone(dir.clone());
    let asked = (|| -> io::Result<std::process::Output> {
        std::fs::create_dir_all(dir.join("root/root"))?;
        std::fs::copy(&muk, dir.join("root/muk"))?;
        let argv = ["/muk".to_string()];
        let lent = Lent { root: dir.join("root").to_string_lossy().into_owned(), written: true, uid: rustix::process::getuid().as_raw(), gid: rustix::process::getgid().as_raw(), ..Lent::default() };
        let made = bundle::bundle(&Run { repo: "", argv: &argv, env: &[], screen: None }, &lent);
        std::fs::write(dir.join("config.json"), &made.config)?;
        Command::new(&muk).args(made.words(&dir.to_string_lossy(), None, "check")).stdin(std::process::Stdio::null()).output()
    })();
    let said = match asked { Ok(o) => String::from_utf8_lossy(&o.stderr).into_owned(), Err(e) => return Some(e.to_string()) };
    // In its box, muk run with no words says how it is used: the box was made.
    if said.contains("usage: muk run") { return None; }
    let said = said.lines().next().unwrap_or("").trim().to_string();
    Some(crate::tr!("This system lets muk make no box ({}): user namespaces may be off for every program (user.max_user_namespaces, kernel.unprivileged_userns_clone), or kept from it by AppArmor (Ubuntu 23.10 and later; the .deb installs the profile that lets it)",
        "このシステムでは muk が箱を作れません（{}）。ユーザー名前空間がどのプログラムにも許されていない（user.max_user_namespaces、kernel.unprivileged_userns_clone）か、AppArmor が止めています（Ubuntu 23.10 以降。.deb で入れるとそれを許すプロファイルが入ります）", said))
}

#[cfg(test)]
#[path = "start.test.rs"]
mod tests;
