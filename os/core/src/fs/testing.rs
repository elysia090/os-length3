//! Where core's tests make their files: a folder of this test process's own
//! under the system's temporary directory (`length3-test-run-<pid>`), one
//! entry in it per test. A run leaves nothing for long: each one first takes
//! away the folders of runs whose process is gone (one that passed, failed,
//! or was killed), so what a failed test made is there to look at until the
//! next run, and no longer.

use std::path::PathBuf;
use std::sync::OnceLock;

const RUN: &str = "length3-test-run-";

/// `name`, under this run's folder (not made: the test makes what it needs, as before), and anything an earlier
/// test of this run left there gone.
pub fn dir(name: &str) -> PathBuf {
    let d = run().join(name);
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// This run's folder, made once, after the folders of runs that have ended are taken away.
fn run() -> PathBuf {
    static RUN_DIR: OnceLock<PathBuf> = OnceLock::new();
    RUN_DIR.get_or_init(|| {
        let tmp = std::env::temp_dir();
        for e in std::fs::read_dir(&tmp).into_iter().flatten().flatten() {
            let name = e.file_name();
            let Some(pid) = name.to_str().and_then(|n| n.strip_prefix(RUN)).and_then(|p| p.parse::<u32>().ok()) else { continue };
            if pid != std::process::id() && !alive(pid) { let _ = std::fs::remove_dir_all(e.path()); }
        }
        let d = tmp.join(format!("{RUN}{}", std::process::id()));
        std::fs::create_dir_all(&d).expect("this test run's folder");
        d
    }).clone()
}

/// Whether a process is there (one of another user's, which may not be signalled, is).
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only asks whether the process exists; nothing is sent and no memory is passed.
    (unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }) || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
