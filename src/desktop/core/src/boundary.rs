//! What the OS lets reach the host, and what it keeps from it.
//!
//! Processes the OS starts on the host (git) inherit nothing of the person's
//! environment: no HOME, no SSH agent, no credential helpers, no GIT_*
//! settings, no terminal. The repo itself cannot make them run host code
//! either: the ways git runs a program named by configuration (fsmonitor,
//! hooks, ssh, credentials, pager, editor, external diff, signing) are
//! switched off on every call. The OS's own data is private to the person.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// git, found once on the PATH the app was started with.
fn git_program() -> PathBuf {
    std::env::var_os("PATH")
        .and_then(|paths| std::env::split_paths(&paths).map(|d| d.join("git")).find(|p| p.is_file()))
        .unwrap_or_else(|| PathBuf::from("/usr/bin/git"))
}

/// Configuration that names a program git would run, neutralised. `-c`
/// wins over the repo's own .git/config.
const GIT_NEUTRAL: &[&str] = &[
    "core.fsmonitor=false",
    "core.hooksPath=/dev/null",
    "core.sshCommand=false",
    "core.askPass=",
    "core.pager=cat",
    "core.editor=false",
    "credential.helper=",
    "diff.external=",
    "commit.gpgSign=false",
    "tag.gpgSign=false",
    "protocol.allow=never",
];

/// A git command for `dir` that crosses the host boundary only as git
/// itself: a cleared environment, closed stdin, neutral configuration.
pub fn git(dir: &Path) -> Command {
    let program = git_program();
    let bin = program.parent().map(|p| p.display().to_string()).unwrap_or_default();
    let mut c = Command::new(&program);
    c.current_dir(dir).env_clear()
        .env("PATH", format!("{bin}:/usr/bin:/bin"))
        .env("HOME", crate::paths::home_dir())
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_TEMPLATE_DIR", "")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null());
    for setting in GIT_NEUTRAL {
        c.args(["-c", setting]);
    }
    c
}

/// Make the OS's own directory private to the person (0700). Other users of
/// the host see neither repos nor Home's state.
pub fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_inherits_nothing_from_the_host() {
        // A secret in the environment must not reach git or what it runs.
        std::env::set_var("LENGTH3_TEST_SECRET", "s3cret");
        std::env::set_var("SSH_AUTH_SOCK", "/tmp/agent.sock");
        std::env::set_var("GIT_DIR", "/elsewhere");
        let dir = std::env::temp_dir();
        let Ok(out) = git(&dir).args(["var", "-l"]).output() else { return }; // no git here
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(!text.contains("s3cret"), "{text}");
        // `git var -l` prints the environment-derived identity; the command's
        // environment itself is checked directly.
        let envs: Vec<String> = git(&dir).get_envs().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        for leaked in ["LENGTH3_TEST_SECRET", "SSH_AUTH_SOCK", "GIT_DIR", "USER", "DISPLAY"] {
            assert!(!envs.iter().any(|k| k == leaked), "{leaked} reaches git");
        }
        let args: Vec<String> = git(&dir).get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.contains(&"core.hooksPath=/dev/null".to_string()));
        assert!(args.contains(&"core.fsmonitor=false".to_string()));
    }

    #[test]
    fn a_repos_config_cannot_make_git_run_a_program() {
        let root = std::env::temp_dir().join(format!("length3-boundary-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if git(&root).args(["init", "-q"]).status().map(|s| !s.success()).unwrap_or(true) { return; }
        let marker = root.join("ran");
        // A repo carried in from elsewhere may name programs in its config.
        let config = format!(
            "[core]\n\tfsmonitor = touch {m}\n\thooksPath = {h}\n\tpager = touch {m}\n",
            m = marker.display(), h = root.join("hooks").display());
        std::fs::write(root.join(".git/config"), config).unwrap();
        std::fs::create_dir_all(root.join("hooks")).unwrap();
        std::fs::write(root.join("hooks/pre-commit"), format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.join("hooks/pre-commit"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(root.join("f"), "x").unwrap();
        let _ = git(&root).args(["status", "--porcelain"]).output();
        let _ = git(&root).args(["add", "-A"]).output();
        let _ = git(&root).args(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "x"]).output();
        let _ = git(&root).args(["log", "-1"]).output();
        assert!(!marker.exists(), "the repo's config ran a program on the host");
        let _ = std::fs::remove_dir_all(&root);
    }
}
