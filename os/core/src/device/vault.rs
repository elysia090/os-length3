//! This device's secrets, kept apart from everything else it keeps: the bearer of its session on the Remote, and the
//! Agent's key. Never in Home's state (which a page reads, and which is synced), never in a repo or a dotfile, never
//! sent to the Remote (secrets.rs holds a file that carries one). A browser keeps no bearer at all: its session is a
//! cookie no script reads (remote/mod.rs), so on the web only the Agent's key is kept here.
//!
//! Each is kept in the OS's own keyring, the one its other programs keep theirs in: the Keychain (macOS), Credential
//! Manager (Windows, this computer's alone, never roaming with a profile), the Secret Service (Linux: GNOME Keyring,
//! KWallet, KeePassXC), reached by D-Bus from Rust alone, so the static l3 reaches it as the app does. There it is
//! encrypted at rest with what the person signs in with, and it is in no file a backup, a synced home folder or a
//! program reading files for tokens comes across. Where there is none that answers (a server, a container, SSH with no
//! session bus, a locked keyring nobody unlocks within `WAIT`), or `LENGTH3_KEYRING=off` says not to use it, it is a
//! file of its own, `<data>/secrets/<name>`, the person's alone (0600, its folder 0700), as `gh`, Claude Code and
//! git's credential stores do there; what is kept says which (`kept_in`). A file kept before is moved into the keyring
//! the first time it is read where there is one.
//!
//! What no store here stops, and nothing on the device can: a program running as the person reading the keyring as
//! the app does (Linux and Windows give any of them each secret of an unlocked keyring; macOS asks the person first
//! for a program that did not keep it). What limits that is elsewhere: a session is seen and ended from any other
//! device, and Prompts never see this folder (launch.rs).

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::Result;
use std::path::{Path, PathBuf};

/// A secret this device keeps, by what it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Secret {
    /// The bearer of this device's session on the Remote (its token signed, as the Remote hands it over).
    Session,
    /// The Agent's key, and the model it opens (agent_key.rs).
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

/// `secret`, if it is kept here; why not, when the keyring holding it did not give it.
pub fn get(secret: Secret) -> Result<Option<String>> { at(&dir()).get(secret) }

/// Keep `value` as `secret` from now on, in place of any kept before.
pub fn set(secret: Secret, value: &str) -> Result<()> { at(&dir()).set(secret, value) }

/// `secret` kept here no more (kept or not).
pub fn remove(secret: Secret) -> Result<()> { at(&dir()).remove(secret) }

/// Where this device's secrets are kept, in a person's words.
pub fn kept_in() -> String {
    #[cfg(not(target_os = "wasi"))]
    if keyring::store().is_some() { return keyring::NAME.to_string(); }
    crate::tr!("a file only this account reads ({})", "このアカウントだけが読めるファイル（{}）", dir().display())
}

/// The vault over `dir`: the OS's keyring with the files of `dir` beside it, or the files alone.
fn at(dir: &Path) -> Vault<'_> {
    #[cfg(not(target_os = "wasi"))]
    return Vault { keyring: keyring::store().map(|s| s.as_ref()), dir };
    #[cfg(target_os = "wasi")]
    return Vault { dir };
}

struct Vault<'a> {
    /// The OS's keyring, when this device has one that answers.
    #[cfg(not(target_os = "wasi"))]
    keyring: Option<&'a keyring_core::CredentialStore>,
    /// Where each is a file, where there is no keyring (or it would not take one).
    dir: &'a Path,
}

impl Vault<'_> {
    fn file(&self, secret: Secret) -> PathBuf { self.dir.join(secret.name()) }

    fn read(&self, secret: Secret) -> Option<String> {
        std::fs::read_to_string(self.file(secret)).ok().filter(|v| !v.is_empty())
    }

    fn write(&self, secret: Secret, value: &str) -> Result<()> {
        crate::disk::write::private_dir(self.dir).map_err(|e| e.to_string())?;
        crate::disk::write::replace(&self.file(secret), value.as_bytes(), crate::disk::write::How::PRIVATE).map_err(|e| e.to_string())
    }

    fn unlink(&self, secret: Secret) -> Result<()> {
        match std::fs::remove_file(self.file(secret)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    fn get(&self, secret: Secret) -> Result<Option<String>> {
        #[cfg(not(target_os = "wasi"))]
        if let Some(store) = self.keyring {
            return match keyring::get(store, secret, self.dir) {
                Ok(Some(v)) => Ok(Some(v)),
                // Not in the keyring: kept as a file before (or where the keyring would not take it), moved in now.
                Ok(None) => {
                    let Some(v) = self.read(secret) else { return Ok(None) };
                    if keyring::set(store, secret, self.dir, &v).is_ok() { let _ = self.unlink(secret); }
                    Ok(Some(v))
                }
                // The keyring did not give it (locked, refused, not answering): one kept as a file beside it is this
                // device's all the same; else, why not.
                Err(why) => self.read(secret).map(Some).ok_or(why),
            };
        }
        Ok(self.read(secret))
    }

    fn set(&self, secret: Secret, value: &str) -> Result<()> {
        #[cfg(not(target_os = "wasi"))]
        if let Some(store) = self.keyring {
            // In the keyring, and no copy left beside it; a keyring that would not take it (locked, over SSH) leaves it
            // a file, as where there is none.
            if keyring::set(store, secret, self.dir, value).is_ok() { return self.unlink(secret); }
        }
        self.write(secret, value)
    }

    fn remove(&self, secret: Secret) -> Result<()> {
        let file = self.unlink(secret);
        #[cfg(not(target_os = "wasi"))]
        if let Some(store) = self.keyring { keyring::remove(store, secret, self.dir)?; }
        file
    }
}

/// The OS's keyring (keyring-core, and each OS's store of it).
#[cfg(not(target_os = "wasi"))]
mod keyring {
    use super::Secret;
    use keyring_core::{CredentialStore, Entry, Error};
    use std::path::Path;
    use std::sync::{Arc, OnceLock};
    use std::time::Duration;

    /// Its name, as the person knows it.
    #[cfg(target_os = "macos")]
    pub const NAME: &str = "the macOS Keychain";
    #[cfg(target_os = "windows")]
    pub const NAME: &str = "Windows Credential Manager";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub const NAME: &str = "the Secret Service (the desktop's keyring)";

    /// How long a keyring is waited on: one asking the person first (to unlock it, or to let this program read what
    /// another kept) is answered by then, or taken as not there.
    const WAIT: Duration = Duration::from_secs(60);

    /// What every secret is kept under, beside its name and the data folder it is this device's for (so two folders,
    /// a test's and the person's, never share one).
    const SERVICE: &str = crate::paths::IDENTIFIER;

    /// This device's keyring, made once; none where it has none that answers, or `LENGTH3_KEYRING=off`.
    pub fn store() -> Option<&'static Arc<CredentialStore>> {
        static STORE: OnceLock<Option<Arc<CredentialStore>>> = OnceLock::new();
        STORE.get_or_init(|| {
            if std::env::var("LENGTH3_KEYRING").is_ok_and(|v| v.trim() == "off") { return None; }
            within(open).and_then(|r| r.ok())
        }).as_ref()
    }

    #[cfg(target_os = "macos")]
    fn open() -> keyring_core::Result<Arc<CredentialStore>> {
        Ok(apple_native_keyring_store::keychain::Store::new()?)
    }
    #[cfg(target_os = "windows")]
    fn open() -> keyring_core::Result<Arc<CredentialStore>> {
        Ok(windows_native_keyring_store::Store::new()?)
    }
    #[cfg(target_os = "linux")]
    fn open() -> keyring_core::Result<Arc<CredentialStore>> {
        Ok(zbus_secret_service_keyring_store::Store::new()?)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    fn open() -> keyring_core::Result<Arc<CredentialStore>> {
        Err(Error::NotSupportedByStore("no keyring here".into()))
    }

    /// `f`, if it is done within WAIT (a keyring waiting on a person, or on nothing, is not waited on for ever).
    fn within<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || { let _ = tx.send(f()); });
        rx.recv_timeout(WAIT).ok()
    }

    fn entry(store: &CredentialStore, secret: Secret, dir: &Path) -> keyring_core::Result<Entry> {
        let user = format!("{} ({})", secret.name(), dir.display());
        // Windows: this computer's alone; a credential that roams with the profile goes to every computer it signs in on.
        #[cfg(target_os = "windows")]
        let modifiers = std::collections::HashMap::from([("persistence", "Local")]);
        #[cfg(target_os = "windows")]
        return store.build(SERVICE, &user, Some(&modifiers));
        #[cfg(not(target_os = "windows"))]
        store.build(SERVICE, &user, None)
    }

    /// What a keyring said, as a person reads it.
    fn said(e: Error) -> String {
        match e {
            Error::NoStorageAccess(why) => crate::tr!("{} would not open ({})", "{} が開けませんでした（{}）", NAME, why),
            e => crate::tr!("{}: {}", "{}：{}", NAME, e),
        }
    }

    fn not_answering() -> String {
        crate::tr!("{} did not answer within {} s (is it waiting to be unlocked?)", "{} が {} 秒以内に答えませんでした（ロック解除を待っていませんか）", NAME, WAIT.as_secs())
    }

    pub fn get(store: &CredentialStore, secret: Secret, dir: &Path) -> Result<Option<String>, String> {
        let e = entry(store, secret, dir).map_err(said)?;
        match within(move || e.get_password()) {
            Some(Ok(v)) => Ok(Some(v)),
            Some(Err(Error::NoEntry)) => Ok(None),
            Some(Err(e)) => Err(said(e)),
            None => Err(not_answering()),
        }
    }

    pub fn set(store: &CredentialStore, secret: Secret, dir: &Path, value: &str) -> Result<(), String> {
        let (e, value) = (entry(store, secret, dir).map_err(said)?, value.to_string());
        within(move || e.set_password(&value)).ok_or_else(not_answering)?.map_err(said)
    }

    pub fn remove(store: &CredentialStore, secret: Secret, dir: &Path) -> Result<(), String> {
        let e = entry(store, secret, dir).map_err(said)?;
        match within(move || e.delete_credential()) {
            Some(Ok(())) | Some(Err(Error::NoEntry)) => Ok(()),
            Some(Err(e)) => Err(said(e)),
            None => Err(not_answering()),
        }
    }
}

#[cfg(test)]
#[path = "tests/vault.rs"]
mod tests;
