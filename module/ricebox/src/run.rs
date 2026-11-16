//! A root run in a box on this machine: its bundle written (bundle.rs), `muk run` on it, and at a terminal the other
//! end of the terminal muk made handed to `prompt attach`. Nothing here makes a box: no namespace, no mount, no
//! filter (muk's, all of it: module/muk). What is here is how the root is started and what a signal to the one who
//! started it means.
//!
//!   at a terminal, the shell      a terminal of the box's own (muk makes it; `prompt attach` holds its other end):
//!                                 Ctrl-C is a byte typed there
//!   the shell, no terminal        the descriptors it was started with (pipes); an interrupt (SIGINT to this
//!                                 process) is sent to what runs in the box, as a terminal sends it
//!   a command                     the descriptors it was started with; interrupted, its box ends
//!
//! The box's process is the first of its pid namespace: every process in it ends with it (the kernel's), and it ends
//! with muk, which ends with this process (its parent's end is its own: PDEATHSIG).
//!
//! Called by a process with one thread, which waits for any child of its own while the box runs.

// Unsafe is left only where the OS is called and no safe call says it: a signal's handler set, a child told to end
// with its parent and given a descriptor before it execs, a signal sent, waitpid for any child. Each block one call.
#![allow(unsafe_code)]

use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};

use crate::bundle::{self, Bind, Lent, Run, Shell, Told};

/// A box to run.
#[derive(Clone, Copy, Debug)]
pub struct Asked<'a> {
    /// The root, and whether the box writes it (a root that is the box's own).
    pub root: &'a Path,
    pub written: bool,
    /// It is another distribution's (Ubuntu, Debian): its shell is as that distribution sets it up.
    pub other: bool,
    /// What else of the host's is lent, in the order it is mounted.
    pub binds: &'a [Bind],
    /// Share the host's network; otherwise the box has none but its loopback.
    pub network: bool,
    /// What to run; none, the root's shell.
    pub cmd: &'a [String],
    /// Where it starts, inside, and the box's name for itself.
    pub cwd: &'a str,
    pub hostname: &'a str,
    /// What it is told besides, in its environment: added to what every box runs with, never over it.
    pub more: &'a [(String, String)],
    /// The bundle's directory: made here, and gone when the box has ended.
    pub dir: &'a Path,
    /// What muk calls the box.
    pub id: &'a str,
}

fn said(what: impl std::fmt::Display) -> impl FnOnce(io::Error) -> io::Error {
    move |e| io::Error::new(e.kind(), format!("{what}: {e}"))
}

/// A program a box is started with, found beside the one running (installed together) unless named (`named`, in the
/// environment); in a build made to work on, the one made with it (build.rs).
fn beside(name: &str, named: &str, built: Option<&str>) -> io::Result<PathBuf> {
    if let Some(p) = std::env::var_os(named) { return Ok(p.into()); }
    let here = std::env::current_exe()?.with_file_name(name);
    if here.is_file() { return Ok(here); }
    if cfg!(debug_assertions) { if let Some(b) = built.filter(|b| Path::new(b).is_file()) { return Ok(b.into()); } }
    Err(io::Error::new(io::ErrorKind::NotFound, format!("{name} is not there ({})", here.display())))
}

/// muk, the one maker of a box.
pub fn muk() -> io::Result<PathBuf> {
    beside("muk", "RICEBOX_MUK", option_env!("RICEBOX_BUILT_MUK"))
}

/// prompt, which holds the other end of a box's terminal.
fn attach() -> io::Result<PathBuf> {
    beside("prompt", "RICEBOX_PROMPT", option_env!("RICEBOX_BUILT_PROMPT"))
}

/// The host's time zone by its name: TZ where it names one, else the zone /etc/localtime is (a link into a
/// zoneinfo directory). Only a plain name passes (bundle.rs); none, and the box keeps UTC.
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
/// which is the box's. None where it has neither.
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
    // SAFETY: a sigaction of zeroes is one (no flags, no mask, the default action).
    let mut new: libc::sigaction = unsafe { std::mem::zeroed() };
    new.sa_sigaction = handler;
    // SAFETY: as above.
    let mut old: libc::sigaction = unsafe { std::mem::zeroed() };
    // SAFETY: both point at live structs; the handlers only store to an atomic, or do nothing.
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

/// A file or a directory that goes when this does.
struct Gone(PathBuf);
impl Drop for Gone {
    fn drop(&mut self) {
        if self.0.is_dir() { let _ = std::fs::remove_dir_all(&self.0); } else { let _ = std::fs::remove_file(&self.0); }
    }
}

/// The processes of the box `muk` runs, by their numbers on the host: every one in the pid namespace of the box's
/// first process (muk's one child).
fn in_box(muk: u32) -> Vec<u32> {
    let ns = |pid: u32| { use std::os::unix::fs::MetadataExt; std::fs::metadata(format!("/proc/{pid}/ns/pid")).ok().map(|m| m.ino()) };
    let first = std::fs::read_to_string(format!("/proc/{muk}/task/{muk}/children")).ok().and_then(|t| t.split_whitespace().next()?.parse::<u32>().ok());
    let Some(its) = first.and_then(ns) else { return Vec::new() };
    if Some(its) == ns(muk) { return Vec::new(); }
    std::fs::read_dir("/proc").into_iter().flatten().flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok()).filter(|&pid| ns(pid) == Some(its)).collect()
}

/// Wait for the box `muk` runs to end; its exit code. `holding`: what holds its terminal's other end, which ends
/// when the box does, and whose end otherwise (the person's terminal gone) ends the box. A signal sent to this
/// process meanwhile: for a shell an interrupt is passed to what runs in the box, as a terminal sends it; anything
/// else, and any for a command, ends the box.
fn wait(muk: &mut Child, mut holding: Option<&mut Child>, shell: bool) -> i32 {
    let (box_, holder) = (muk.id() as libc::pid_t, holding.as_ref().map_or(0, |h| h.id() as libc::pid_t));
    let mut code = None;
    let mut signal = 0;
    let mut holder_gone = false;
    // SAFETY: a signal sent to a child of this process, by its number.
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
            // It ends by itself, with nothing wrong, when the terminal's box end is closed: the box has ended (muk
            // is about to say how), and is waited for. Ended otherwise (the person's terminal gone, a signal), so
            // is the box.
            holder_gone = true;
            if code_of(status) != 0 { end(box_); if signal == 0 { signal = (code_of(status) - 128).max(1); } }
        } else if pid < 0 {
            if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) { break; }
            match SIGNALLED.swap(0, Ordering::SeqCst) {
                0 => {}
                // At a terminal of its own an interrupt is typed there; with none, it is sent to what runs in the box.
                libc::SIGINT if shell => {
                    // SAFETY: a signal sent to a process by its number, one of the box's own.
                    if holder == 0 { for pid in in_box(muk.id()) { unsafe { libc::kill(pid as libc::pid_t, libc::SIGINT) }; } }
                }
                sig => { signal = sig; end(box_); }
            }
        }
    }
    // (both are waited for: nothing of them is left behind)
    let _ = muk.try_wait();
    if let Some(h) = holding.as_mut() { let _ = h.try_wait(); }
    if signal > 0 { 128 + signal } else { code.unwrap_or(1) }
}

/// A directory only its owner enters.
fn private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Run the box asked for and return its exit code: the root's shell, or the command.
pub fn run(a: &Asked) -> io::Result<i32> {
    let muk = muk()?;
    let terminal = a.cmd.is_empty() && at_terminal();
    let shell;
    let argv: &[String] = if a.cmd.is_empty() { shell = bundle::shell(Shell { bash: a.root.join("bin/bash").exists(), other: a.other, edits: terminal }); &shell } else { a.cmd };
    let _ = std::fs::remove_dir_all(a.dir);
    private_dir(a.dir)?;
    let gone = Gone(a.dir.to_path_buf());
    // With the network, the host's own (lent by the name that is each process's own: muk is in it as this process
    // is, and so is the box it makes) and its resolver's file, where the root looks for it.
    let mut resolver = None;
    if a.network {
        if let (Ok(text), Some(inside)) = (std::fs::read_to_string("/etc/resolv.conf"), resolver_inside(a.root)) {
            let file = a.dir.join("resolv.conf");
            std::fs::write(&file, text)?;
            resolver = Some((file.to_string_lossy().into_owned(), inside));
        }
    }
    let lent = Lent {
        root: a.root.to_string_lossy().into_owned(),
        written: a.written,
        binds: a.binds.to_vec(),
        uid: rustix::process::getuid().as_raw(),
        gid: rustix::process::getgid().as_raw(),
        network: a.network.then(|| "/proc/self/ns/net".to_string()),
        resolver,
        console: None,
    };
    let term = std::env::var("TERM").ok().filter(|t| t != "dumb" && at_terminal()).unwrap_or_default();
    let env = bundle::environment(argv, &Told { term, zone: zone(), more: a.more.to_vec() });
    let screen = terminal.then(|| rustix::termios::tcgetwinsize(std::io::stdin()).map_or((80, 24), |w| (w.ws_col.max(1), w.ws_row.max(1))));
    let made = bundle::bundle(&Run { argv, env: &env, cwd: a.cwd, hostname: a.hostname, screen }, &lent);
    std::fs::write(a.dir.join("config.json"), made.config.as_bytes())?;
    let at = a.dir.to_string_lossy().into_owned();

    // From here a signal to this process is the box's to hear of: kept until the box has ended.
    SIGNALLED.store(0, Ordering::SeqCst);
    let before: Vec<(libc::c_int, libc::sigaction)> = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP, libc::SIGCHLD].into_iter()
        .map(|s| (s, handle(s, if s == libc::SIGCHLD { woken as *const () as libc::sighandler_t } else { signalled as *const () as libc::sighandler_t }))).collect();
    let ended = (|| -> io::Result<i32> {
        if !terminal {
            let mut child = ends_with_me(Command::new(&muk).args(made.words(&at, None, a.id))).spawn().map_err(said(muk.display()))?;
            return Ok(wait(&mut child, None, a.cmd.is_empty()));
        }
        // A terminal of the box's own: muk makes it and sends its other end here, and `prompt attach` holds it.
        let socket = a.dir.join("console");
        let socket = if socket.as_os_str().len() < 100 { socket } else { std::env::temp_dir().join(format!("ricebox-{}.console", std::process::id())) };
        let _ = std::fs::remove_file(&socket);
        let listener = std::os::unix::net::UnixListener::bind(&socket)?;
        let _unnamed = Gone(socket.clone());
        let mut child = ends_with_me(Command::new(&muk).args(made.words(&at, Some(&socket.to_string_lossy()), a.id))).spawn().map_err(said(muk.display()))?;
        let Some(terminal) = terminal_from(&listener, &mut child)? else { return Ok(wait(&mut child, None, true)); };
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
        Ok(wait(&mut child, Some(&mut holding), true))
    })();
    // SAFETY: each is the action that was there before, read by sigaction above.
    for (s, was) in &before { unsafe { libc::sigaction(*s, was, std::ptr::null_mut()) }; }
    drop(gone);
    ended
}

/// Why this machine makes no box, where it makes none.
#[derive(Debug)]
pub enum NoBox {
    /// muk makes a box on x86-64 only.
    NotThisMachine,
    /// muk is not there to be run: what looking for it said.
    NoMuk(String),
    /// muk was refused: what it said. A kernel may have user namespaces off for everyone
    /// (user.max_user_namespaces=0, or kernel.unprivileged_userns_clone=0); Ubuntu 23.10 and later keep them, through
    /// AppArmor, from a program no profile lets make them.
    Refused(String),
}

/// Whether this machine lets a box be made, asked of muk itself: a box whose root holds muk alone, which says how
/// it is used and ends. Where none can be made, a root runs translated, as in a browser.
pub fn no_box() -> Option<NoBox> {
    if !cfg!(target_arch = "x86_64") { return Some(NoBox::NotThisMachine); }
    let muk = match muk() { Ok(m) => m, Err(e) => return Some(NoBox::NoMuk(e.to_string())) };
    // (a place of each asking's own: two threads of one process may ask at once)
    static ASKED: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!("ricebox-box-check-{}-{}", std::process::id(), ASKED.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    let _gone = Gone(dir.clone());
    let asked = (|| -> io::Result<std::process::Output> {
        std::fs::create_dir_all(dir.join("root/root"))?;
        std::fs::copy(&muk, dir.join("root/muk"))?;
        let argv = ["/muk".to_string()];
        let lent = Lent { root: dir.join("root").to_string_lossy().into_owned(), written: true, uid: rustix::process::getuid().as_raw(), gid: rustix::process::getgid().as_raw(), ..Lent::default() };
        let made = bundle::bundle(&Run { argv: &argv, env: &[], cwd: "/root", hostname: "ricebox", screen: None }, &lent);
        std::fs::write(dir.join("config.json"), &made.config)?;
        Command::new(&muk).args(made.words(&dir.to_string_lossy(), None, "check")).stdin(std::process::Stdio::null()).output()
    })();
    let said = match asked { Ok(o) => String::from_utf8_lossy(&o.stderr).into_owned(), Err(e) => return Some(NoBox::Refused(e.to_string())) };
    // In its box, muk run with no words says how it is used: the box was made.
    if said.contains("usage: muk run") { return None; }
    Some(NoBox::Refused(said.lines().next().unwrap_or("").trim().to_string()))
}

/// A root copied to be one of its own for whoever writes it: its directories, links and files as they are, a file
/// with several names one file still. What a filesystem can share between a file and its copy, it shares (std's
/// copy asks the kernel to). The root it is made of is only read.
pub fn copy_root(from: &Path, to: &Path) -> io::Result<()> {
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

#[cfg(test)]
#[path = "run.test.rs"]
mod tests;
