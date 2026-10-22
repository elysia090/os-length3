//! The desktop app, one on a device at a time, and how l3 reaches it. While
//! it runs, the app holds a lock in its own folder of the data directory
//! (owner-only) and answers on a Unix socket beside it, a word a line:
//! `here` (it is open), `show` (its window comes forward) and `close` (its
//! window closes, as its close button closes it). Nothing listens on a
//! network: the socket is a file only this person can open. `l3 app` asks
//! first and starts the app only when nothing answers; an app started while
//! another holds the lock (from the desktop's menu, say) shows that one and
//! ends.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The app's program, as the .deb installs it (/usr/bin) and the bundle names it (Cargo's package).
pub const PROGRAM: &str = "length3-os";

/// How long an answer is waited for, either way.
const ANSWER: Duration = Duration::from_secs(5);

/// The app's folder in the data directory: its lock and its socket.
pub fn dir(data: &Path) -> PathBuf {
    data.join("app")
}

fn socket(data: &Path) -> PathBuf {
    dir(data).join("socket")
}

/// Ask the app open here `word`: its answer, or None when none answers (none is open).
pub fn ask(data: &Path, word: &str) -> Option<String> {
    let mut s = UnixStream::connect(socket(data)).ok()?;
    s.set_read_timeout(Some(ANSWER)).ok()?;
    s.set_write_timeout(Some(ANSWER)).ok()?;
    s.write_all(format!("{word}\n").as_bytes()).ok()?;
    let mut said = String::new();
    BufReader::new(s.take(64)).read_line(&mut said).ok()?;
    Some(said.trim().to_string()).filter(|s| !s.is_empty())
}

/// The app's hold on this device while it runs: the lock, and the socket it answers on. Both go with the
/// process (the lock is the kernel's to let go; a socket left behind answers no one and is taken over).
pub struct Held {
    _lock: File,
    listener: UnixListener,
}

/// Take the hold, as the app starts: None when another app has it (that one is open).
pub fn hold(data: &Path) -> std::io::Result<Option<Held>> {
    let dir = dir(data);
    crate::boundary::private_dir(&dir)?;
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("lock"))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(None),
        Err(TryLockError::Error(e)) => return Err(e),
    }
    // Left by an app that ended without taking it away: the lock says none runs.
    let path = socket(data);
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let listener = UnixListener::bind(&path)?;
    Ok(Some(Held { _lock: lock, listener }))
}

impl Held {
    /// Answer each word asked with what `answer` says, one asker at a time, for as long as the app runs (on a
    /// thread of its own). An asker that says nothing is let go after a few seconds.
    pub fn serve(self, answer: impl Fn(&str) -> String) {
        for s in self.listener.incoming().flatten() {
            let _ = s.set_read_timeout(Some(ANSWER));
            let _ = s.set_write_timeout(Some(ANSWER));
            let mut word = String::new();
            if BufReader::new((&s).take(64)).read_line(&mut word).is_err() { continue; }
            let _ = (&s).write_all(format!("{}\n", answer(word.trim())).as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_app_holds_the_device_and_answers_what_it_is_asked() {
        let data = std::env::temp_dir().join(format!("length3-desktop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        // None open: nothing answers, and the first to start holds the device.
        assert_eq!(ask(&data, "here"), None);
        // A socket left by an app that ended is taken over.
        crate::boundary::private_dir(&dir(&data)).unwrap();
        std::fs::write(socket(&data), "").unwrap();
        let held = hold(&data).unwrap().expect("the first app holds it");
        // A second, while the first runs, does not: it shows the first instead.
        assert!(hold(&data).unwrap().is_none());
        std::thread::spawn(move || held.serve(|w| if w == "here" { "here".into() } else { format!("asked {w}") }));
        assert_eq!(ask(&data, "here").as_deref(), Some("here"));
        assert_eq!(ask(&data, "show").as_deref(), Some("asked show"));
        // Only the person reaches it: its folder is theirs alone.
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir(&data)).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(&data);
    }
}
