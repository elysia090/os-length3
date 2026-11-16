//! A Prompt started on this machine: what why lends a box of the root, and nothing of how one is made or started.
//! The root in a box is ricebox's to run (module/ricebox/src/run.rs: its bundle written, `muk run`, at a terminal its
//! other end handed to `prompt attach`), and the box muk's to make (module/muk). What is here is a product's part:
//!
//!   /root             the Prompt's home: a directory of its own, the person's dotfiles written in, gone with it
//!   /root/<repo>      the repo
//!   /var/cache, /var/tmp, /var/log, /root/.cache
//!                     the repo's caches (prompt/writes.rs), freed whenever room is wanted
//!   /                 the installed root, read-only; or the repo's own (its environment), where its dotfiles ask
//!                     one (.packages, .setup), written
//!   network           the host's, where the repo was granted it
//!   told              which repo it is and where repos are, the person's language, and what a task says besides

// No unsafe code here: the OS is called by ricebox and muk. (Its tests fork, to run a Prompt in a process of its own.)
#![cfg_attr(not(test), forbid(unsafe_code))]

use std::io;
use std::path::{Path, PathBuf};

use ricebox::bundle::Bind;
use ricebox::run::{self, Asked};

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

fn said(what: impl std::fmt::Display) -> impl FnOnce(io::Error) -> io::Error {
    move |e| io::Error::new(e.kind(), format!("{what}: {e}"))
}

/// The directory a Prompt's home and bundle are in while it runs, and gone with it.
struct Gone(PathBuf);
impl Drop for Gone {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

impl Prompt {
    /// The repo's environment: a root of its own, where one was made (set_up); the root's own directory beside it.
    fn environment(&self) -> Option<PathBuf> {
        let env = crate::prompt::writes::env_over(self.data.as_ref()?, &self.name, &self.root).join("root");
        std::fs::symlink_metadata(env.join("bin")).is_ok().then_some(env)
    }

    /// Where this Prompt's own things are while it runs (its home, its bundle): with its record in the data
    /// directory, or a place of its own.
    fn own_dir(&self) -> PathBuf {
        match &self.data {
            Some(data) => data.join("prompts").join(format!("{}.box", std::process::id())),
            None => std::env::temp_dir().join(format!("why-prompt-{}.box", std::process::id())),
        }
    }

    /// Run `cmd` (none: the shell) in a box of this Prompt's, with the network or not, and return its exit code.
    fn run_box(&self, cmd: &[String], network: bool) -> io::Result<i32> {
        let environment = self.environment();
        let root = environment.as_ref().unwrap_or(&self.root);
        if std::fs::symlink_metadata(root.join("bin")).is_err() {
            return Err(io::Error::new(io::ErrorKind::NotFound, crate::tr!("There is no root (why root install)", "root がありません（why root install）")));
        }
        let dir = self.own_dir();
        let _ = std::fs::remove_dir_all(&dir);
        let _gone = Gone(dir.clone());
        // The Prompt's home: its own, the person's dotfiles fresh in it (the repo stays the only place written back).
        let home = dir.join("home");
        crate::fs::write::private_dir(&dir)?;
        crate::fs::write::private_dir(&home)?;
        for (name, text) in &self.dotfiles {
            if dotfile_name(name) && name != &format!(".{}", self.name) { std::fs::write(home.join(name), text)?; }
        }
        let lend = |inside: String, from: &Path| Bind { inside, from: from.to_string_lossy().into_owned(), read_only: false };
        let mut binds = vec![lend("root".into(), &home), lend(format!("root/{}", self.name), &self.repo)];
        // The repo's caches: on the host, so what is left in them can be taken back from outside. Without the
        // repo's own root, the root on the host is not written to: only the places it has.
        if let Some(data) = &self.data {
            for (inside, name) in crate::prompt::writes::CACHES {
                if !(inside.starts_with("root/") || environment.is_some() || root.join(inside).is_dir()) { continue; }
                let host = crate::prompt::writes::cache_dir(data, &self.name).join(name);
                std::fs::create_dir_all(&host)?;
                binds.push(lend(inside.to_string(), &host));
            }
        }
        #[cfg(test)]
        for (inside, host) in &self.also { binds.push(lend(inside.clone(), host)); }
        let more = super::told(&self.name, if crate::text::i18n::ja() { "ja" } else { "en" }, &self.env);
        run::run(&Asked { root, written: environment.is_some(), other: self.other, binds: &binds, network, cmd,
            cwd: &format!("/root/{}", self.name), hostname: "why", more: &more, dir: &dir.join("bundle"), id: &self.name })
    }

    /// Run the Prompt and return its exit code: its shell, or the command asked for.
    pub fn run(&self) -> io::Result<i32> {
        self.run_box(&self.cmd, self.network)
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
            run::copy_root(&self.root, &making).map_err(said(making.display()))?;
            std::fs::rename(&making, &made)?;
        }
        // It ends with this process: stopped meanwhile (its supervisor killed, prompt::stop), nothing goes on writing
        // into the repo's environment and caches, which its record no longer keeps.
        let code = self.run_box(&["/bin/sh".to_string(), "-c".into(), script], true)?;
        if code == 0 { done() } else {
            eprintln!("{}", crate::tr!("why: setting up stopped (exit {}); the Prompt starts with what is there", "why: 用意が途中で止まりました（終了 {}）。今あるもので Prompt を始めます", code));
            Ok(())
        }
    }
}

/// Why this machine does not let a Prompt run on the root here, if it does not, in why's words: asked of muk through
/// ricebox (run.rs no_box). Where no box can be made, Prompts run translated, as in a browser. The .deb carries the
/// AppArmor profile that lets muk beside why make user namespaces (Ubuntu 23.10 and later keep them from a program
/// no profile lets).
pub fn kept_from_boxes() -> Option<String> {
    Some(match run::no_box()? {
        run::NoBox::NotThisMachine => crate::tr!("muk makes a box on x86-64 only", "muk が箱を作れるのは x86-64 だけです"),
        run::NoBox::NoMuk(e) => crate::tr!("muk is not beside why ({})", "muk が why の隣にありません（{}）", e),
        run::NoBox::Refused(said) => crate::tr!("This system lets muk make no box ({}): user namespaces may be off for every program (user.max_user_namespaces, kernel.unprivileged_userns_clone), or kept from it by AppArmor (Ubuntu 23.10 and later; the .deb installs the profile that lets it)",
            "このシステムでは muk が箱を作れません（{}）。ユーザー名前空間がどのプログラムにも許されていない（user.max_user_namespaces、kernel.unprivileged_userns_clone）か、AppArmor が止めています（Ubuntu 23.10 以降。.deb で入れるとそれを許すプロファイルが入ります）", said),
    })
}

#[cfg(test)]
#[path = "start.test.rs"]
mod tests;
