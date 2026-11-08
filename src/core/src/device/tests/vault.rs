//! The tests of device/vault.rs.

use super::*;

fn place(name: &str) -> PathBuf {
    let d = crate::fs::testing::dir(name);
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn where_there_is_no_keyring_each_is_a_file_of_its_own_private_replaced_and_taken_away() {
    let d = place("l3-vault-files");
    let v = Vault { #[cfg(not(target_os = "wasi"))] keyring: None, dir: &d };
    assert_eq!(v.get(Secret::Session), Ok(None));
    v.set(Secret::Session, "one.sig").unwrap();
    v.set(Secret::Session, "two.sig").unwrap();
    assert_eq!(v.get(Secret::Session), Ok(Some("two.sig".into())));
    assert_eq!(v.get(Secret::AgentKey), Ok(None), "each is kept apart");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(d.join("session")).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
    }
    v.remove(Secret::Session).unwrap();
    v.remove(Secret::Session).unwrap();
    assert_eq!(v.get(Secret::Session), Ok(None));
    let _ = std::fs::remove_dir_all(&d);
}

#[cfg(not(target_os = "wasi"))]
#[test]
fn with_a_keyring_each_is_kept_there_alone_a_file_kept_before_is_moved_in_and_one_it_refuses_stays_a_file() {
    use keyring_core::{api::CredentialStoreApi, CredentialStore, Error, mock};
    let d = place("l3-vault-keyring");
    let store = mock::Store::new().unwrap();
    let keyring: &CredentialStore = store.as_ref();
    let v = Vault { keyring: Some(keyring), dir: &d };
    // Kept in the keyring, and in no file.
    v.set(Secret::Session, "one.sig").unwrap();
    assert_eq!(v.get(Secret::Session), Ok(Some("one.sig".into())));
    assert!(!d.join("session").exists());
    // A file kept before (an earlier release, or a keyring that would not take it then) is moved in when read.
    Vault { keyring: None, dir: &d }.set(Secret::AgentKey, "{\"key\":\"k\"}").unwrap();
    assert_eq!(v.get(Secret::AgentKey), Ok(Some("{\"key\":\"k\"}".into())));
    assert!(!d.join("agent-key").exists(), "moved into the keyring");
    assert_eq!(keyring::get(keyring, Secret::AgentKey, &d), Ok(Some("{\"key\":\"k\"}".into())));
    // A keyring that refuses it (locked, over SSH): kept as a file, and read from there.
    let entry = |s: Secret| store.build(crate::fs::paths::IDENTIFIER, &format!("{} ({})", s.name(), d.display()), None).unwrap();
    let refuse = |s: Secret| entry(s).as_any().downcast_ref::<mock::Cred>().unwrap().set_error(Error::NoStorageAccess("locked".into()));
    refuse(Secret::Session);
    v.set(Secret::Session, "two.sig").unwrap();
    assert_eq!(std::fs::read_to_string(d.join("session")).unwrap(), "two.sig");
    refuse(Secret::Session);
    assert_eq!(v.get(Secret::Session), Ok(Some("two.sig".into())), "the file beside a keyring that will not give it");
    // Taken away from both.
    v.remove(Secret::Session).unwrap();
    assert_eq!(v.get(Secret::Session), Ok(None));
    assert!(!d.join("session").exists());
    let _ = std::fs::remove_dir_all(&d);
}
