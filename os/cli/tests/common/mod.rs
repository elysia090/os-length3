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
