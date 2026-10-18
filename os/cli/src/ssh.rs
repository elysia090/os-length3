//! The SSH listener: `l3 address ssh serve`, started in the background by
//! turning SSH on (cmd/address.rs; the app's switch runs the same l3). An
//! ordinary OpenSSH client lands in a repo's Prompt: the SSH user is the
//! repo, and each session is `l3 prompt REPO` (`-- /bin/sh -c CMD` for a
//! command), so it is the same shell, the same sandbox, the same network
//! grant and the same record (`l3 prompt ls` lists it) as any Prompt.
//!
//!   auth      public keys only, those in the `.authorized_keys` dotfile
//!             (taken in from the Remote at most every 10 s as keys are
//!             tried, so one added or removed elsewhere counts here at once);
//!             no password, no keyboard-interactive; an address refused too
//!             often is not heard for a minute (core ssh::Tries)
//!   where     every address, but a connection is taken only if it came in
//!             on loopback or a private network (core ssh::reachable)
//!   channels  sessions only: no port or agent forwarding, no X11, no
//!             subsystem (sftp); a command's exit code goes back to ssh
//!   lifetime  one thread (every session's process is started from it, so
//!             each dies with the listener: PR_SET_PDEATHSIG); asks the
//!             Remote every 5 s whether it is still on, and stops, ending
//!             every session, when it is off, the device is signed out, or
//!             it is told to (SIGTERM: l3 address ssh off, logout, the app)

use length3_core::{paths, remote, repos, ssh, tr};
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId, ChannelMsg, MethodKind, MethodSet};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// How often the Remote is asked whether SSH is still on.
const BEAT: Duration = Duration::from_secs(5);
/// Keys are taken in from the Remote no more often than this.
const KEYS_FRESH: Duration = Duration::from_secs(10);
/// Sessions one connection may have open at once.
const CHANNELS: usize = 4;
/// A connection not signed in by then is closed.
const GRACE: Duration = Duration::from_secs(60);

/// A line for the log (`<data>/ssh/log`): what came, from where, and what was done.
fn log(s: &str) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let _ = writeln!(std::io::stderr(), "{now} {s}");
}

/// The host key: read, or made once (Ed25519, from the kernel's randomness) and kept owner-only.
pub fn host_key(data: &Path) -> Result<PrivateKey, String> {
    let at = ssh::host_key(data);
    if let Ok(text) = std::fs::read(&at) {
        return PrivateKey::from_openssh(text).map_err(|e| tr!("The host key {} cannot be read: {}", "ホスト鍵 {} を読めません：{}", at.display(), e));
    }
    length3_core::boundary::private_dir(&ssh::dir(data)).map_err(|e| e.to_string())?;
    let mut seed = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut seed)).map_err(|e| e.to_string())?;
    let pair = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&seed);
    let key = PrivateKey::new(pair.into(), "length3").map_err(|e| e.to_string())?;
    let text = key.to_openssh(russh::keys::ssh_key::LineEnding::LF).map_err(|e| e.to_string())?;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&at).map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(key)
}

/// The host key's fingerprint, as ssh shows it when it first connects.
pub fn fingerprint(key: &PrivateKey) -> String {
    ssh::fingerprint(&key.public_key().to_bytes().unwrap_or_default())
}

/// The repos here, by name: the SSH users there are.
fn repo_names() -> Vec<String> {
    repos::Repos::open().and_then(|r| r.list()).map(|l| l.into_iter().map(|s| s.name).collect()).unwrap_or_default()
}

/// Where each repo is reached now.
pub fn destinations(port: u16) -> Vec<String> {
    ssh::destinations(port, &repo_names(), ssh::addresses()[0])
}

/// What every connection shares.
struct Shared {
    /// l3 itself, which each session runs as `l3 prompt REPO`.
    exe: PathBuf,
    keys: Mutex<(Instant, Vec<ssh::Key>)>,
    tries: Mutex<ssh::Tries>,
    /// The session processes running (their pids): ended with the listener.
    sessions: Mutex<HashSet<u32>>,
}

impl Shared {
    /// The keys, taken in from the Remote first when they were last taken in a while ago.
    async fn keys(&self) -> Vec<ssh::Key> {
        let stale = self.keys.lock().map(|k| k.0.elapsed() >= KEYS_FRESH).unwrap_or(true);
        if stale {
            // Out of reach, the keys this device has stand.
            let took = tokio::time::timeout(Duration::from_secs(5), tokio::task::spawn_blocking(|| remote::sync_home("dotfiles"))).await;
            if !matches!(took, Ok(Ok(Ok(_)))) { log("keys: the Remote's not taken in; this device's stand"); }
            if let Ok(mut k) = self.keys.lock() { *k = (Instant::now(), ssh::keys().keys); }
        }
        self.keys.lock().map(|k| k.1.clone()).unwrap_or_default()
    }
}

/// Whether `user` names a repo here (an SSH user is a repo).
fn is_repo(user: &str) -> bool {
    repos::valid_name(user) && repos::Repos::open().is_ok_and(|r| r.dir(user).is_ok())
}

struct Conn {
    shared: Arc<Shared>,
    peer: IpAddr,
    repo: Option<String>,
    channels: usize,
    /// Signed in: the grace for signing in is over.
    authed: Arc<std::sync::atomic::AtomicBool>,
}

impl Conn {
    async fn check(&mut self, user: &str, key: &PublicKey) -> Auth {
        let listed = match key.to_bytes() {
            Ok(blob) => self.shared.keys().await.iter().any(|k| k.blob == blob),
            Err(_) => false,
        };
        let ok = listed && is_repo(user);
        if !ok {
            if let Ok(mut t) = self.shared.tries.lock() { t.failed(self.peer, Instant::now()); }
            return Auth::reject();
        }
        Auth::Accept
    }
}

impl server::Handler for Conn {
    type Error = russh::Error;

    async fn auth_publickey_offered(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        if self.shared.tries.lock().map(|mut t| t.held(self.peer, Instant::now())).unwrap_or(true) { return Ok(Auth::reject()); }
        Ok(self.check(user, key).await)
    }

    // The signature was checked: the key is the client's.
    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        let a = self.check(user, key).await;
        if a == Auth::Accept {
            log(&format!("{} in as {user} with {}", self.peer, ssh::fingerprint(&key.to_bytes().unwrap_or_default())));
            self.repo = Some(user.to_string());
            self.authed.store(true, std::sync::atomic::Ordering::SeqCst);
        } else {
            log(&format!("{} refused as {user}", self.peer));
        }
        Ok(a)
    }

    async fn channel_open_session(&mut self, channel: Channel<Msg>, reply: server::ChannelOpenHandle, session: &mut Session) -> Result<(), Self::Error> {
        let Some(repo) = self.repo.clone() else { return Ok(()) };
        if self.channels >= CHANNELS { return Ok(()); }
        self.channels += 1;
        reply.accept().await;
        tokio::spawn(run_channel(channel, session.handle(), self.shared.clone(), repo));
        Ok(())
    }
}

/// What a session asked for before it starts: a terminal (its name and size).
#[derive(Default)]
struct Asked {
    pty: Option<(String, u16, u16)>,
}

/// Where what the client types goes: the terminal, or the program's standard input.
enum Input {
    Pty(Arc<AsyncFd<std::fs::File>>),
    Pipe(tokio::process::ChildStdin),
    /// Its standard input ended (the client sent EOF).
    Ended,
}

/// One session channel: its requests, in order, then the program it starts, until it ends.
async fn run_channel(mut ch: Channel<Msg>, handle: server::Handle, shared: Arc<Shared>, repo: String) {
    let id = ch.id();
    let mut asked = Asked::default();
    let mut input: Option<Input> = None;
    let mut pid = None;
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::RequestPty { want_reply, term, col_width, row_height, .. } => {
                let ok = input.is_none();
                if ok { asked.pty = Some((term, col_width.min(1000) as u16, row_height.min(1000) as u16)); }
                if want_reply { let _ = if ok { handle.channel_success(id).await } else { handle.channel_failure(id).await }; }
            }
            ChannelMsg::RequestShell { want_reply } | ChannelMsg::Exec { want_reply, .. } if input.is_some() => {
                if want_reply { let _ = handle.channel_failure(id).await; }
            }
            ChannelMsg::RequestShell { want_reply } => {
                (input, pid) = start(&shared, &handle, id, &repo, None, &asked).await.unzip();
                if want_reply { let _ = if input.is_some() { handle.channel_success(id).await } else { handle.channel_failure(id).await }; }
            }
            ChannelMsg::Exec { want_reply, command } => {
                let command = String::from_utf8_lossy(&command).into_owned();
                (input, pid) = start(&shared, &handle, id, &repo, Some(command), &asked).await.unzip();
                if want_reply { let _ = if input.is_some() { handle.channel_success(id).await } else { handle.channel_failure(id).await }; }
            }
            ChannelMsg::WindowChange { col_width, row_height, .. } => {
                if let Some(Input::Pty(m)) = &input { resize(m.get_ref().as_raw_fd(), col_width.min(1000) as u16, row_height.min(1000) as u16); }
            }
            ChannelMsg::Data { data } => match &mut input {
                Some(Input::Pty(m)) => { let _ = write_all(m, &data).await; }
                Some(Input::Pipe(p)) => { let _ = p.write_all(&data).await; }
                _ => {}
            },
            // The client has no more to send: a program's standard input ends (a terminal keeps going).
            ChannelMsg::Eof => { if matches!(input, Some(Input::Pipe(_))) { input = Some(Input::Ended); } }
            // A subsystem (sftp), X11, an agent, or a variable from the client's side: not here.
            ChannelMsg::RequestSubsystem { want_reply, .. } | ChannelMsg::RequestX11 { want_reply, .. }
            | ChannelMsg::AgentForward { want_reply } | ChannelMsg::SetEnv { want_reply, .. } => {
                if want_reply { let _ = handle.channel_failure(id).await; }
            }
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    // The client went (closed the channel, or the connection is gone) while its program runs: the program ends,
    // and its Prompt with it, as a terminal's hangup would.
    if let Some(pid) = pid.filter(|p| *p > 0 && shared.sessions.lock().is_ok_and(|s| s.contains(p))) {
        log(&format!("session {repo}: the client went; ended"));
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }
}

/// Start the session's program, `l3 prompt REPO` (with `-- /bin/sh -c CMD` for a command), on a terminal when
/// one was asked for; what it prints goes to the client, and its exit code once it ends.
async fn start(shared: &Arc<Shared>, handle: &server::Handle, id: ChannelId, repo: &str, command: Option<String>, asked: &Asked) -> Option<(Input, u32)> {
    let mut cmd = tokio::process::Command::new(&shared.exe);
    cmd.arg("prompt").arg(repo);
    if let Some(c) = &command { cmd.args(["--", "/bin/sh", "-c", c]); }
    cmd.env_remove("L3_PROMPT").env("TERM", asked.pty.as_ref().map_or("dumb", |p| p.0.as_str())).kill_on_drop(false);
    log(&format!("session {repo}: {}", command.as_deref().map_or("shell".to_string(), |c| format!("exec {} bytes", c.len()))));
    let started = match &asked.pty {
        Some((_, cols, rows)) => on_pty(cmd, *cols, *rows).map(|(child, master)| (child, Input::Pty(master), None)),
        None => on_pipes(cmd).map(|(child, stdin, out)| (child, Input::Pipe(stdin), Some(out))),
    };
    let (mut child, input, pipes) = match started {
        Ok(s) => s,
        Err(e) => { log(&format!("session {repo}: not started: {e}")); return None; }
    };
    let pid = child.id().unwrap_or(0);
    if let Ok(mut s) = shared.sessions.lock() { s.insert(pid); }
    // What it prints, to the client.
    let pumps: Vec<tokio::task::JoinHandle<()>> = match (&input, pipes) {
        (Input::Pty(m), _) => vec![tokio::spawn(pump_pty(m.clone(), handle.clone(), id))],
        (_, Some((out, err))) => vec![tokio::spawn(pump(out, handle.clone(), id, None)), tokio::spawn(pump(err, handle.clone(), id, Some(1)))],
        _ => Vec::new(),
    };
    let (handle, shared, repo) = (handle.clone(), shared.clone(), repo.to_string());
    tokio::spawn(async move {
        let status = child.wait().await;
        // Reaped: its pid may be another's from now, so it is no longer one to end.
        if let Ok(mut s) = shared.sessions.lock() { s.remove(&pid); }
        for p in pumps { let _ = p.await; }
        use std::os::unix::process::ExitStatusExt;
        let code = status.map(|s| s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0))).unwrap_or(255);
        log(&format!("session {repo}: ended {code}"));
        let _ = handle.exit_status_request(id, code as u32).await;
        let _ = handle.eof(id).await;
        let _ = handle.close(id).await;
    });
    Some((input, pid))
}

/// What every session's process is started with: its own session, and an end with the listener's.
fn detach(cmd: &mut tokio::process::Command, tty: bool) {
    unsafe {
        cmd.pre_exec(move || {
            libc::setsid();
            if tty { libc::ioctl(0, libc::TIOCSCTTY as _, 0); }
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0);
            Ok(())
        });
    }
}

fn on_pipes(mut cmd: tokio::process::Command) -> std::io::Result<(tokio::process::Child, tokio::process::ChildStdin, (tokio::process::ChildStdout, tokio::process::ChildStderr))> {
    use std::process::Stdio;
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    detach(&mut cmd, false);
    let mut child = cmd.spawn()?;
    let (i, o, e) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    match (i, o, e) { (Some(i), Some(o), Some(e)) => Ok((child, i, (o, e))), _ => Err(std::io::Error::other("stdio")) }
}

fn on_pty(mut cmd: tokio::process::Command, cols: u16, rows: u16) -> std::io::Result<(tokio::process::Child, Arc<AsyncFd<std::fs::File>>)> {
    let (mut master, mut slave) = (-1, -1);
    let size = libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 };
    if unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), &size) } != 0 { return Err(std::io::Error::last_os_error()); }
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    unsafe {
        libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::fcntl(master.as_raw_fd(), libc::F_GETFL) | libc::O_NONBLOCK);
    }
    cmd.stdin(slave.try_clone()?).stdout(slave.try_clone()?).stderr(slave);
    detach(&mut cmd, true);
    let child = cmd.spawn()?;
    // The listener's own copies of the terminal's other end are closed with `cmd`, so it reads its end until the program's is gone.
    drop(cmd);
    // The terminal's end is owned by the File alone, and closed only by it.
    let master = unsafe { AsyncFd::register(std::fs::File::from(master)) }.map_err(std::io::Error::from)?;
    Ok((child, Arc::new(master)))
}

fn resize(fd: i32, cols: u16, rows: u16) {
    let size = libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 };
    unsafe { libc::ioctl(fd, libc::TIOCSWINSZ as _, &size) };
}

async fn write_all(m: &AsyncFd<std::fs::File>, mut bytes: &[u8]) -> std::io::Result<()> {
    while !bytes.is_empty() {
        let mut g = m.writable().await?;
        match g.try_io(|f| (&*f.get_ref()).write(bytes)) {
            Ok(Ok(n)) => bytes = &bytes[n..],
            Ok(Err(e)) => return Err(e),
            Err(_) => continue,
        }
    }
    Ok(())
}

/// The terminal's output to the client, until the program's end of it is gone (EIO).
async fn pump_pty(m: Arc<AsyncFd<std::fs::File>>, handle: server::Handle, id: ChannelId) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let Ok(mut g) = m.readable().await else { return };
        match g.try_io(|f| (&*f.get_ref()).read(&mut buf)) {
            Ok(Ok(0)) | Ok(Err(_)) => return,
            Ok(Ok(n)) => { if handle.data(id, buf[..n].to_vec()).await.is_err() { return; } }
            Err(_) => continue,
        }
    }
}

async fn pump(mut from: impl tokio::io::AsyncRead + Unpin, handle: server::Handle, id: ChannelId, ext: Option<u32>) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match from.read(&mut buf).await { Ok(0) | Err(_) => return, Ok(n) => n };
        let sent = match ext { Some(e) => handle.extended_data(id, e, buf[..n].to_vec()).await, None => handle.data(id, buf[..n].to_vec()).await };
        if sent.is_err() { return; }
    }
}

/// Why the listener stopped.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Why { Off, SignedOut, Asked }

/// Run the listener: bind, tell the Remote, record itself, say `ready` on standard output (what turning on waits
/// for), then serve until it stops. Standard output and error are the log from then on.
pub fn serve() -> Result<(), String> {
    let data = paths::data_dir();
    if ssh::keys().keys.is_empty() {
        return Err(tr!("There is no key in {} to let anyone in with", "{} に入れる鍵がありません", ssh::KEYS));
    }
    let key = host_key(&data)?;
    let print = fingerprint(&key);
    let port = ssh::port();
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port))
        .map_err(|e| tr!("Port {} cannot be listened on ({}); LENGTH3_SSH_PORT names another", "ポート {} で待てません（{}）。LENGTH3_SSH_PORT で別のポートを選べます", port, e))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let mut now = destinations(port);
    ssh::announce(port, &now)?;
    let mut recorded = ssh::record(&data, port, now.clone(), print.clone()).map_err(|e| e.to_string())?;
    // Turning on waits for this line; then the log takes standard output and error.
    println!("ready");
    let _ = std::io::stdout().flush();
    if let Ok(f) = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(ssh::dir(&data).join("log")) {
        unsafe { libc::dup2(f.as_raw_fd(), 1); libc::dup2(f.as_raw_fd(), 2); }
    }
    log(&format!("listening on port {port} · {print}"));
    let shared = Arc::new(Shared { exe: std::env::current_exe().map_err(|e| e.to_string())?, keys: Mutex::new((Instant::now(), ssh::keys().keys)),
        tries: Mutex::new(ssh::Tries::default()), sessions: Mutex::new(HashSet::new()) });
    let config = Arc::new(server::Config {
        methods: MethodSet::from(&[MethodKind::PublicKey][..]),
        auth_rejection_time: Duration::from_secs(1),
        auth_rejection_time_initial: Some(Duration::ZERO),
        keys: vec![key],
        max_auth_attempts: 6,
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        nodelay: true,
        ..Default::default()
    });
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    let why = rt.block_on(async {
        let listener = tokio::net::TcpListener::from_std(listener).map_err(|e| e.to_string())?;
        use tokio::signal::unix::{signal, SignalKind};
        let (mut term, mut int, mut hup) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt()), signal(SignalKind::hangup()));
        let (term, int, hup) = match (term.as_mut(), int.as_mut(), hup.as_mut()) {
            (Ok(t), Ok(i), Ok(h)) => (t, i, h),
            _ => return Err("signals".to_string()),
        };
        let mut beat = tokio::time::interval(BEAT);
        beat.tick().await;
        loop {
            tokio::select! {
                got = listener.accept() => {
                    let Ok((stream, peer)) = got else { continue };
                    accept(stream, peer, &shared, &config);
                }
                _ = beat.tick() => {
                    let next = destinations(port);
                    let said = next.clone();
                    let heard = tokio::time::timeout(Duration::from_secs(20), tokio::task::spawn_blocking(move || ssh::beat(&said))).await
                        .ok().and_then(|r| r.ok()).unwrap_or(ssh::Heard::Unreachable);
                    if !ssh::goes_on(heard) {
                        return Ok(if heard == ssh::Heard::Off { Why::Off } else { Why::SignedOut });
                    }
                    if next != now { let _ = recorded.set_destinations(next.clone()); now = next; }
                }
                _ = term.recv() => return Ok(Why::Asked),
                _ = int.recv() => return Ok(Why::Asked),
                _ = hup.recv() => return Ok(Why::Asked),
            }
        }
    })?;
    // Every session ends with it: its Prompt's supervisor is killed, and with it everything in the Prompt.
    for pid in shared.sessions.lock().map(|s| s.clone()).unwrap_or_default() {
        if pid > 0 { unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) }; }
    }
    if why == Why::Asked {
        // Said to the Remote, so pages stop showing it; not waited on past a few seconds.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || { let _ = tx.send(ssh::withdraw()); });
        let _ = rx.recv_timeout(Duration::from_secs(5));
    }
    log(&format!("stopped ({why:?})"));
    drop(recorded);
    Ok(())
}

/// A connection: taken only on loopback or a private network, from an address not held off.
fn accept(stream: tokio::net::TcpStream, peer: SocketAddr, shared: &Arc<Shared>, config: &Arc<server::Config>) {
    let local = stream.local_addr().map(|a| a.ip()).ok();
    if !local.is_some_and(ssh::reachable) {
        log(&format!("{} closed: came in on {:?}, not a private address", peer.ip(), local));
        return;
    }
    if shared.tries.lock().map(|mut t| t.held(peer.ip(), Instant::now())).unwrap_or(true) {
        log(&format!("{} closed: refused too often lately", peer.ip()));
        return;
    }
    let _ = stream.set_nodelay(true);
    let authed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let conn = Conn { shared: shared.clone(), peer: peer.ip(), repo: None, channels: 0, authed: authed.clone() };
    let config = config.clone();
    tokio::spawn(async move {
        let session = match server::run_stream(config, stream, conn).await {
            Ok(s) => s,
            Err(e) => { log(&format!("{} ended: {e}", peer.ip())); return; }
        };
        // Not signed in within the grace, the connection goes (dropped, it is closed).
        let grace = async {
            tokio::time::sleep(GRACE).await;
            if authed.load(std::sync::atomic::Ordering::SeqCst) { std::future::pending::<()>().await; }
        };
        tokio::select! {
            _ = session => {}
            _ = grace => log(&format!("{} closed: not signed in within {} s", peer.ip(), GRACE.as_secs())),
        }
    });
}
