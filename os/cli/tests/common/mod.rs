//! What l3's tests share: a data directory of their own for each test, and
//! l3 run in it as a script runs it (off a terminal).

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A data directory of its own, made empty for one test and left for a look afterwards.
pub struct Home {
    pub dir: PathBuf,
}

impl Home {
    pub fn new(name: &str) -> Home {
        let dir = std::env::temp_dir().join(format!("l3-test-{name}-{}", std::process::id()));
        if dir.exists() { std::fs::remove_dir_all(&dir).expect("an old test home goes"); }
        std::fs::create_dir_all(&dir).expect("a test home");
        Home { dir }
    }

    /// l3 with `args`, as a script runs it: no terminal anywhere, in `lang`.
    pub fn run(&self, lang: &str, args: &[&str]) -> Ran {
        let out = self.command(lang, args).stdin(Stdio::null()).output().expect("l3 runs");
        Ran { code: out.status.code().unwrap_or(-1), stdout: self.shown(&out.stdout), stderr: self.shown(&out.stderr) }
    }

    /// l3 in this home with nothing of the person's: no Remote, no language, no settings from outside.
    pub fn command(&self, lang: &str, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_l3"));
        c.args(args).current_dir(&self.dir).env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.dir).env("LENGTH3_HOME", &self.dir).env("LENGTH3_LANG", lang)
            // Nothing answers here: a test that reached for the Remote would say so, not wait.
            .env("LENGTH3_REMOTE", "http://127.0.0.1:9");
        c
    }

    /// Output as a person reads it, with this home's path written $HOME so it reads the same on every run.
    pub fn shown(&self, bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).replace(&self.dir.display().to_string(), "$HOME")
    }

    pub fn path(&self, rel: &str) -> PathBuf { self.dir.join(rel) }
}

// ---- l3 at a terminal: a real pty, driven by keys, waited on by what it writes ----

pub const UP: &str = "\x1b[A";
pub const DOWN: &str = "\x1b[B";
pub const RIGHT: &str = "\x1b[C";
pub const LEFT: &str = "\x1b[D";
pub const ENTER: &str = "\r";
pub const ESC: &str = "\x1b";

/// How long l3 may take to write what a test waits for before the test fails (it never sleeps).
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(20);

/// l3 running on a pty of 100×30, as in a terminal.
pub struct Pty {
    master: std::fs::File,
    child: std::process::Child,
    /// Everything l3 wrote, and where the last key was sent (what is waited for comes after it).
    out: Vec<u8>,
    mark: usize,
}

impl Home {
    /// l3 with `args` at a terminal, `env` over this home's (TERM is xterm's unless given).
    pub fn pty(&self, lang: &str, args: &[&str], env: &[(&str, &str)]) -> Pty {
        use std::os::fd::FromRawFd;
        use std::os::unix::process::CommandExt;
        let (mut m, mut s) = (0, 0);
        let size = libc::winsize { ws_row: 30, ws_col: 100, ws_xpixel: 0, ws_ypixel: 0 };
        assert_eq!(unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null(), &size) }, 0, "a pty");
        let (master, slave) = unsafe { (std::fs::File::from_raw_fd(m), std::fs::File::from_raw_fd(s)) };
        let mut c = self.command(lang, args);
        c.env("TERM", "xterm-256color");
        for (k, v) in env { c.env(k, v); }
        c.stdin(slave.try_clone().unwrap()).stdout(slave.try_clone().unwrap()).stderr(slave);
        // Its own session, the pty its terminal, as a shell would start it.
        unsafe { c.pre_exec(|| { libc::setsid(); libc::ioctl(0, libc::TIOCSCTTY as _, 0); Ok(()) }); }
        let child = c.spawn().expect("l3 starts");
        drop(c);
        Pty { master, child, out: Vec::new(), mark: 0 }
    }
}

impl Pty {
    /// Wait until l3 has written `text` (escapes aside) since the last key, or fail with what it wrote.
    pub fn expect(&mut self, text: &str) -> &mut Pty {
        let end = std::time::Instant::now() + PATIENCE;
        while !strip(&String::from_utf8_lossy(&self.out[self.mark..])).contains(text) {
            if !self.read_until(end) { panic!("l3 did not write {text:?}; the terminal shows:\n{}", self.screen()); }
        }
        self
    }

    /// Type `keys`.
    pub fn send(&mut self, keys: &str) -> &mut Pty {
        use std::io::Write;
        self.mark = self.out.len();
        self.master.write_all(keys.as_bytes()).expect("keys reach l3");
        self
    }

    /// Wait for l3 to end: its exit code, and the terminal as it was left.
    pub fn finish(&mut self) -> (i32, String) {
        let end = std::time::Instant::now() + PATIENCE;
        while self.read_until(end) {}
        let status = self.child.try_wait().ok().flatten().or_else(|| { let _ = self.child.kill(); None });
        let status = status.unwrap_or_else(|| panic!("l3 did not end; the terminal shows:\n{}", self.screen()));
        (status.code().unwrap_or(-1), self.screen())
    }

    /// Read what l3 writes before `end`; false once it has ended (or `end` passed).
    fn read_until(&mut self, end: std::time::Instant) -> bool {
        use std::io::Read;
        use std::os::fd::AsRawFd;
        let left = end.saturating_duration_since(std::time::Instant::now()).as_millis() as i32;
        if left == 0 { return false; }
        let mut p = libc::pollfd { fd: self.master.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        if unsafe { libc::poll(&mut p, 1, left) } <= 0 { return false; }
        let mut buf = [0u8; 65536];
        match self.master.read(&mut buf) {
            // EIO: the terminal's other side is closed: l3 has ended.
            Ok(0) | Err(_) => { let _ = self.child.wait(); false }
            Ok(n) => { self.out.extend_from_slice(&buf[..n]); true }
        }
    }

    /// The terminal's lines as a person sees them now: l3's redrawing (cursor up, clear below) played out.
    pub fn screen(&self) -> String { screen(&String::from_utf8_lossy(&self.out)) }
}

/// Text without its escapes.
pub fn strip(s: &str) -> String {
    let mut out = String::new();
    let mut esc = false;
    for c in s.chars() {
        if esc { if c.is_ascii_alphabetic() { esc = false; } continue; }
        if c == '\x1b' { esc = true; continue; }
        out.push(c);
    }
    out
}

/// A tiny terminal: text, CR, LF, cursor up (ESC[nA), clear below (ESC[J); other escapes shown as nothing.
pub fn screen(s: &str) -> String {
    let mut lines: Vec<Vec<char>> = vec![Vec::new()];
    let (mut row, mut col) = (0usize, 0usize);
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => {
                if chars.peek() != Some(&'[') { chars.next(); continue; }
                chars.next();
                let mut p = String::new();
                while let Some(&d) = chars.peek() { if d.is_ascii_alphabetic() { break; } p.push(d); chars.next(); }
                match chars.next() {
                    Some('A') => row = row.saturating_sub(p.parse().unwrap_or(1)),
                    Some('J') => { lines[row].truncate(col); lines.truncate(row + 1); }
                    Some('K') => lines[row].truncate(col),
                    _ => {}
                }
            }
            '\r' => col = 0,
            '\n' => { row += 1; col = 0; while lines.len() <= row { lines.push(Vec::new()); } }
            c => {
                let line = &mut lines[row];
                while line.len() < col { line.push(' '); }
                if col < line.len() { line[col] = c; } else { line.push(c); }
                col += 1;
            }
        }
    }
    let text: Vec<String> = lines.iter().map(|l| l.iter().collect::<String>().trim_end().to_string()).collect();
    text.join("\n").trim_end().to_string()
}

/// What one run of l3 gave.
#[derive(Debug, PartialEq)]
pub struct Ran {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Ran {
    /// The run as a transcript: what was typed, the exit code, then each stream.
    pub fn transcript(&self, args: &[&str]) -> String {
        format!("$ l3 {}\n[exit {}]\n--- stdout\n{}--- stderr\n{}\n", args.join(" "), self.code, self.stdout, self.stderr)
    }
}

/// Compare `got` with the golden file `name`, or write it when L3_GOLDEN=record.
pub fn golden(name: &str, got: &str) {
    let at = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden").join(name);
    if std::env::var("L3_GOLDEN").as_deref() == Ok("record") {
        std::fs::write(&at, got).expect("golden written");
        return;
    }
    let want = std::fs::read_to_string(&at).unwrap_or_else(|_| panic!("{} is missing (L3_GOLDEN=record writes it)", at.display()));
    if want != got {
        let line = want.lines().zip(got.lines()).position(|(a, b)| a != b).unwrap_or(want.lines().count().min(got.lines().count()));
        panic!("{name} differs first at line {}:\n want: {:?}\n  got: {:?}\n\n--- got\n{got}", line + 1, want.lines().nth(line), got.lines().nth(line));
    }
}
