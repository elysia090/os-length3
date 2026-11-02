//! This device's secrets, kept apart from everything else it keeps: the bearer of its session on the Remote, and the
//! Agent's key. Never in Home's state (which a page reads, and which is synced), never in a repo or a dotfile, never
//! sent to the Remote (secrets.rs holds a file that carries one). A browser keeps no bearer at all: its session is a
//! cookie no script reads (remote/mod.rs), so on the web only the Agent's key is kept here.
//!
//! Each is a file of its own, `<data>/secrets/<name>`, the person's alone (0600, its folder 0700), replaced whole.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::Result;
use std::path::{Path, PathBuf};

/// A secret this device keeps, by what it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Secret {
    /// The bearer of this device's session on the Remote (its token signed, as the Remote hands it over).
    Session,
    /// The Agent's key (agent_key.rs).
    AgentKey,
}

impl Secret {
    fn name(self) -> &'static str {
        match self {
            Secret::Session => "session",
            Secret::AgentKey => "agent-key",
        }
    }
}

fn dir() -> PathBuf { crate::paths::data_dir().join("secrets") }

/// `secret`, if it is kept here.
pub fn get(secret: Secret) -> Option<String> { get_in(&dir(), secret) }

/// Keep `value` as `secret` from now on, in place of any kept before.
pub fn set(secret: Secret, value: &str) -> Result<()> { set_in(&dir(), secret, value) }

/// `secret` kept here no more (kept or not).
pub fn remove(secret: Secret) -> Result<()> { remove_in(&dir(), secret) }

fn get_in(dir: &Path, secret: Secret) -> Option<String> {
    std::fs::read_to_string(dir.join(secret.name())).ok().filter(|v| !v.is_empty())
}

fn set_in(dir: &Path, secret: Secret, value: &str) -> Result<()> {
    crate::boundary::private_dir(dir).map_err(|e| e.to_string())?;
    crate::atomic::replace(&dir.join(secret.name()), value.as_bytes(), crate::atomic::How::PRIVATE).map_err(|e| e.to_string())
}

fn remove_in(dir: &Path, secret: Secret) -> Result<()> {
    match std::fs::remove_file(dir.join(secret.name())) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_private_replaced_and_taken_away() {
        let d = crate::testing::dir("l3-vault");
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(get_in(&d, Secret::Session), None);
        set_in(&d, Secret::Session, "one.sig").unwrap();
        set_in(&d, Secret::Session, "two.sig").unwrap();
        assert_eq!(get_in(&d, Secret::Session).as_deref(), Some("two.sig"));
        assert_eq!(get_in(&d, Secret::AgentKey), None, "each is kept apart");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join("session")).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
        }
        remove_in(&d, Secret::Session).unwrap();
        remove_in(&d, Secret::Session).unwrap();
        assert_eq!(get_in(&d, Secret::Session), None);
        let _ = std::fs::remove_dir_all(&d);
    }
}
