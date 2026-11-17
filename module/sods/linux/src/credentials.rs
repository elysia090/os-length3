//! Initial-user-namespace credentials. Only Rust ROOT and exec-derived values
//! can be constructed; this is not an arbitrary namespace/host identity importer.
//! Profile: mode-only DAC (no POSIX ACL), default securebits, no file capabilities,
//! ptrace, LSM, idmapped mounts, unsafe shared exec or supplementary-group mutation.
//! nosuid assumes the initial user namespace; it is not general mnt_may_suid.
//! Such features must gain an
//! explicit admission/implementation gate, not silently enter this profile.
//! Reference: Linux v6.12 security/commoncap.c cap_bprm_creds_from_file and
//! fs/exec.c bprm_fill_uid / begin_new_exec. NoNewPrivs is monotonic.
use crate::inode::Metadata;
const ALL: u64 = (1u64 << 41) - 1;
const DAC_OVERRIDE: u64 = 1 << 1;
const DAC_READ_SEARCH: u64 = 1 << 2;
const KIND: u32 = 0o170000;
const DIR: u32 = 0o040000;
const FILE: u32 = 0o100000;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ids {
    pub real: u32,
    pub effective: u32,
    pub saved: u32,
    pub fs: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Capabilities {
    pub permitted: u64,
    pub effective: u64,
    pub inheritable: u64,
    pub bounding: u64,
    pub ambient: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Credentials {
    user: Ids,
    group: Ids,
    caps: Capabilities,
    no_new_privs: bool,
}
#[derive(Debug, Clone, Copy)]
pub(crate) enum Access {
    Search,
    Execute,
    Read,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Access,
    NotRegular,
    InvalidIdentity,
}
#[derive(Debug)]
pub(crate) struct Decision {
    pub credentials: Credentials,
    pub secure: bool,
    /// Profile fixes suid_dumpable=0, with unreadable-executable protection.
    /// Not a general kernel dump policy or a claim to implement core dumps.
    pub dumpable: bool,
}
impl Decision {
    pub(crate) fn stack_credentials(&self) -> crate::stack::Credentials {
        crate::stack::Credentials {
            uid: self.credentials.user.real,
            euid: self.credentials.user.effective,
            gid: self.credentials.group.real,
            egid: self.credentials.group.effective,
            secure: self.secure,
        }
    }
}
impl Credentials {
    pub(crate) fn initial_root() -> Self {
        Self {
            user: Ids {
                real: 0,
                effective: 0,
                saved: 0,
                fs: 0,
            },
            group: Ids {
                real: 0,
                effective: 0,
                saved: 0,
                fs: 0,
            },
            caps: Capabilities {
                permitted: ALL,
                effective: ALL,
                inheritable: 0,
                bounding: ALL,
                ambient: 0,
            },
            no_new_privs: false,
        }
    }
    pub(crate) fn user(&self) -> Ids {
        self.user
    }
    pub(crate) fn group(&self) -> Ids {
        self.group
    }
    pub(crate) fn capabilities(&self) -> Capabilities {
        self.caps
    }
    pub(crate) fn no_new_privs(&self) -> bool {
        self.no_new_privs
    }
    pub(crate) fn forbid_new_privileges(&mut self) {
        self.no_new_privs = true;
    }
    pub(crate) fn may(&self, node: &Metadata, access: Access) -> bool {
        if node.uid == u32::MAX || node.gid == u32::MAX {
            return false;
        }
        let directory = node.mode & KIND == DIR;
        if matches!(access, Access::Search) && !directory {
            return false;
        }
        let want = if matches!(access, Access::Read) { 4 } else { 1 };
        let bits = if self.user.fs == node.uid {
            node.mode >> 6
        } else if self.group.fs == node.gid {
            node.mode >> 3
        } else {
            node.mode
        };
        if bits & want == want {
            return true;
        }
        if self.caps.effective & DAC_OVERRIDE != 0
            && (directory || want == 4 || node.mode & 0o111 != 0)
        {
            return true;
        }
        self.caps.effective & DAC_READ_SEARCH != 0 && (directory || want == 4)
    }
    /// Metadata/mount policy must come from the held, validated program route.
    /// Return a proposal; caller commits with the admitted image, never before.
    pub(crate) fn program(
        &self,
        node: &Metadata,
        noexec: bool,
        nosuid: bool,
    ) -> Result<Decision, Error> {
        if node.uid == u32::MAX || node.gid == u32::MAX {
            return Err(Error::InvalidIdentity);
        }
        if node.mode & KIND != FILE {
            return Err(Error::NotRegular);
        }
        if noexec || node.mode & 0o111 == 0 || !self.may(node, Access::Execute) {
            return Err(Error::Access);
        }
        let readable = self.may(node, Access::Read);
        let mut next = self.clone(); // Closed profile contains no supplementary groups.
        if !nosuid && !self.no_new_privs {
            if node.mode & 0o4000 != 0 {
                next.user.effective = node.uid;
            }
            if node.mode & 0o2010 == 0o2010 {
                next.group.effective = node.gid;
            }
        }
        let effective_file = next.user.effective == 0;
        let setid =
            next.user.effective != self.user.real || next.group.effective != self.group.real;
        let mut permitted = if next.user.effective == 0 || next.user.real == 0 {
            self.caps.bounding | self.caps.inheritable
        } else {
            0
        };
        if self.no_new_privs && (setid || permitted & !self.caps.permitted != 0) {
            next.user.effective = next.user.real;
            next.group.effective = next.group.real;
            permitted &= self.caps.permitted;
        }
        next.user.saved = next.user.effective;
        next.user.fs = next.user.effective;
        next.group.saved = next.group.effective;
        next.group.fs = next.group.effective;
        next.caps.ambient = if setid { 0 } else { self.caps.ambient };
        next.caps.permitted = permitted | next.caps.ambient;
        // effective_file was captured before the unsafe/NNP downgrade.
        next.caps.effective = if effective_file {
            next.caps.permitted
        } else {
            next.caps.ambient
        };
        let secure = setid
            || (next.user.real != 0
                && (effective_file || next.caps.permitted & !next.caps.ambient != 0));
        // begin_new_exec tests OLD current credentials; commit_creds then
        // resets dumpability on changed effective/fs IDs or permitted gain.
        // These are distinct from secureexec and from new real/effective equality.
        let dumpable = readable
            && self.user.real == self.user.effective
            && self.group.real == self.group.effective
            && self.user.effective == next.user.effective
            && self.group.effective == next.group.effective
            && self.user.fs == next.user.fs
            && self.group.fs == next.group.fs
            && next.caps.permitted & !self.caps.permitted == 0;
        Ok(Decision {
            credentials: next,
            secure,
            dumpable,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn file(mode: u32, uid: u32, gid: u32) -> Metadata {
        Metadata {
            mode: FILE | mode,
            uid,
            gid,
            nlink: 1,
        }
    }
    #[test]
    fn root_exec_and_search_are_not_blanket_permission() {
        let root = Credentials::initial_root();
        assert!(!root.may(&file(0o600, 0, 0), Access::Execute));
        assert!(root.program(&file(0o600, 0, 0), false, false).is_err());
        assert!(root.program(&file(0o755, 0, 0), true, false).is_err());
        let dir = Metadata {
            mode: DIR,
            uid: 7,
            gid: 8,
            nlink: 1,
        };
        assert!(root.may(&dir, Access::Search));
        let d = root.program(&file(0o4755, 0, 0), false, false).unwrap();
        assert!(!d.secure);
        assert!(d.dumpable);
        assert_eq!(d.credentials, root);
    }
    #[test]
    fn root_to_setid_owner_updates_saved_fs_caps_and_aux_together() {
        let root = Credentials::initial_root();
        let d = root
            .program(&file(0o6755, 1000, 2000), false, false)
            .unwrap();
        assert_eq!(
            d.credentials.user(),
            Ids {
                real: 0,
                effective: 1000,
                saved: 1000,
                fs: 1000
            }
        );
        assert_eq!(d.credentials.group().effective, 2000);
        assert_eq!(d.credentials.capabilities().permitted, ALL);
        assert_eq!(d.credentials.capabilities().effective, 0);
        assert!(d.secure);
        assert!(!d.dumpable);
        let aux = d.stack_credentials();
        assert_eq!((aux.uid, aux.euid, aux.gid, aux.egid), (0, 1000, 0, 2000));
        assert!(aux.secure);
        assert_eq!(root.user().effective, 0);
    }
    #[test]
    fn nosuid_nnp_and_nonexecuting_group_setgid() {
        let mut root = Credentials::initial_root();
        let node = file(0o6755, 1000, 2000);
        assert_eq!(
            root.program(&node, false, true)
                .unwrap()
                .credentials
                .user()
                .effective,
            0
        );
        root.forbid_new_privileges();
        assert!(root.no_new_privs());
        let d = root.program(&node, false, false).unwrap();
        assert_eq!(d.credentials.user().effective, 0);
        assert!(!d.secure);
        let d = Credentials::initial_root()
            .program(&file(0o2701, 0, 2000), false, false)
            .unwrap();
        assert_eq!(d.credentials.group().effective, 0);
    }
    #[test]
    fn nnp_downgrade_keeps_pre_downgrade_effective_flag() {
        // Linux v6.12 commoncap.c: handle_privileged_root captures effective
        // before lines 861-872 downgrade, then lines 889-892 consume that flag.
        let mut c = Credentials::initial_root()
            .program(&file(0o4755, 1000, 0), false, false)
            .unwrap()
            .credentials;
        c.forbid_new_privileges();
        let d = c.program(&file(0o755, 0, 0), false, false).unwrap();
        assert_eq!(
            d.credentials.user(),
            Ids {
                real: 0,
                effective: 0,
                saved: 0,
                fs: 0
            }
        );
        assert_eq!(d.credentials.caps.permitted, ALL);
        assert_eq!(d.credentials.caps.effective, 0); // not recomputed from downgraded euid
        assert!(d.secure); // is_setid captured before downgrade, too
        assert!(!d.dumpable);
        assert_eq!(c.user.effective, 1000); // proposal did not mutate old credentials
    }
    #[test]
    fn dumpability_checks_fs_identity_and_permitted_gain_independently() {
        // Private policy counterexamples, not newly supported credential mutation APIs.
        let mut c = Credentials::initial_root();
        c.user.fs = 1000;
        let d = c.program(&file(0o755, 0, 0), false, false).unwrap();
        assert!(!d.secure);
        assert!(!d.dumpable); // commit restores fsuid even though real/effective match
        let mut c = Credentials::initial_root();
        c.caps.permitted = 0;
        c.caps.effective = 0;
        let d = c.program(&file(0o755, 0, 0), false, false).unwrap();
        assert!(!d.secure);
        assert_eq!(d.credentials.caps.permitted, ALL);
        assert!(!d.dumpable); // permitted gain, independent of ID change
    }
    #[test]
    fn retained_real_root_is_not_active_dac_override() {
        let c = Credentials::initial_root()
            .program(&file(0o4755, 1000, 0), false, false)
            .unwrap()
            .credentials;
        assert!(!c.may(&file(0o700, 2000, 2000), Access::Execute));
        assert!(c.program(&file(0o700, 2000, 2000), false, false).is_err());
        let d = c.program(&file(0o111, 2000, 2000), false, false).unwrap();
        assert!(!d.dumpable);
        assert!(d.secure);
        assert_eq!(d.credentials.user().real, 0);
        assert_eq!(d.credentials.user().effective, 1000);
    }
}
