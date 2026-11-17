//! Synchronous prepared-namespace executable path lookup. Returns a nonholding
//! Place, not an executable authorization or a source pin. No callback/mutation
//! may interleave this borrow; acquire the final hold before asynchronous work.
//! No openat flags, missing-terminal creation, magic links, BENEATH, IN_ROOT or
//! NO_XDEV contract is exposed. Root/cwd and mount ascent use Files' FsContext.
//! Frames borrow targets instead of repeatedly concatenating target + suffix.
//! At most 40 followed symlinks and 41 frames (three machine words each:
//! 984 bytes on a 64-bit host, 492 on wasm32), plus the current Place. Each
//! component still incurs the
//! existing mount coverage scan O(M) and an owned Place name allocation per
//! component (not only for the final result). Overall
//! work is O(visited bytes + components*M), not a namespace-independent bound.
use crate::credentials::{Access, Credentials};
use crate::descriptor::{self, Files};
use crate::fs_context::{Base, Ticket};
use crate::mount::Place;
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    InvalidPath,
    NameTooLong,
    NotFound,
    NotDirectory,
    Access,
    Loop,
    Files(descriptor::Error),
}
impl From<descriptor::Error> for Error {
    fn from(error: descriptor::Error) -> Self {
        Self::Files(error)
    }
}
#[derive(Clone, Copy)]
struct Frame<'a> {
    bytes: &'a [u8],
    at: usize,
}
const DIRECTORY: u32 = 0o040000;
const SYMLINK: u32 = 0o120000;
const KIND: u32 = 0o170000;
fn directory(files: &Files, place: &Place, cred: Option<&Credentials>) -> Result<(), Error> {
    let metadata = files.place_metadata(place)?;
    if metadata.mode & KIND != DIRECTORY {
        return Err(Error::NotDirectory);
    }
    if cred.is_some_and(|c| !c.may(&metadata, Access::Search)) {
        return Err(Error::Access);
    }
    Ok(())
}
/// Path bytes exclude their ABI NUL terminator: the 4095-byte ingress limit
/// corresponds to 4096 including that terminator, not cumulative expansion.
/// Empty input is not a request for
/// cwd. Input limit is 4095 bytes; individual Tree link targets share that bound.
/// Frame stacking bounds expansion storage without imposing a new concatenated
/// PATH_MAX check on each intermediate rewrite.
pub(crate) fn resolve<'a>(
    files: &'a Files,
    fs: &Ticket,
    cred: &Credentials,
    path: &'a [u8],
) -> Result<Place, Error> {
    if path.is_empty() {
        return Err(Error::NotFound);
    }
    if path.contains(&0) {
        return Err(Error::InvalidPath);
    }
    if path.len() > 4095 {
        return Err(Error::NameTooLong);
    }
    let mut current = files.fs_start(
        fs,
        if path[0] == b'/' {
            Base::Root
        } else {
            Base::Cwd
        },
    )?;
    let mut frames = [Frame { bytes: &[], at: 0 }; 41];
    frames[0] = Frame { bytes: path, at: 0 };
    let mut depth = 0;
    let mut followed = 0;
    loop {
        let frame = &mut frames[depth];
        while frame.at < frame.bytes.len() && frame.bytes[frame.at] == b'/' {
            frame.at += 1;
        }
        if frame.at == frame.bytes.len() {
            if frame.bytes.last() == Some(&b'/') {
                directory(files, &current, None)?;
            }
            if depth == 0 {
                return Ok(current);
            }
            depth -= 1;
            continue;
        }
        let start = frame.at;
        while frame.at < frame.bytes.len() && frame.bytes[frame.at] != b'/' {
            frame.at += 1;
        }
        let component = &frame.bytes[start..frame.at];
        directory(files, &current, Some(cred))?;
        if component.len() > 255 {
            return Err(Error::NameTooLong);
        }
        if component == b"." {
            continue;
        }
        if component == b".." {
            current = files.fs_parent(fs, &current)?;
            continue;
        }
        let next = files
            .component(&current, component)?
            .ok_or(Error::NotFound)?;
        if files.place_metadata(&next)?.mode & KIND != SYMLINK {
            current = next;
            continue;
        }
        if followed == 40 || files.view_policy(&next)?.no_symfollow {
            return Err(Error::Loop);
        }
        followed += 1;
        let target = files.symlink_target(&next)?;
        if target.is_empty() {
            return Err(Error::NotFound);
        }
        if target[0] == b'/' {
            current = files.fs_start(fs, Base::Root)?;
        }
        depth += 1;
        frames[depth] = Frame {
            bytes: target,
            at: 0,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::descriptor::Limits;
    use crate::inode::{Creation, Tree};
    use crate::mount::{self, ViewPolicy};
    fn root_owned(mode: u32) -> Creation {
        Creation {
            mode,
            uid: 0,
            gid: 0,
        }
    }
    fn setup(policy: ViewPolicy) -> (Files, Ticket, Credentials) {
        setup_owned(policy, 801, 802)
    }
    fn setup_owned(
        policy: ViewPolicy,
        tree_owner: u64,
        files_owner: u64,
    ) -> (Files, Ticket, Credentials) {
        let mut t = Tree::new(tree_owner, 80, 80, 16, root_owned(0o755)).unwrap();
        let root = t.root();
        let a = t.directory(root, b"a", root_owned(0o755)).unwrap();
        t.directory(root, b"at", root_owned(0o755)).unwrap();
        t.directory(root, b"closed", root_owned(0o700)).unwrap();
        t.file_take(root, b"target", root_owned(0o644), &mut vec![1])
            .unwrap();
        t.file_take(a, b"file", root_owned(0o644), &mut vec![2])
            .unwrap();
        t.file_take(root, &[255, 254], root_owned(0o644), &mut vec![3])
            .unwrap();
        t.symlink(a, b"relative", b"../target", root_owned(0o777))
            .unwrap();
        t.symlink(a, b"absolute", b"/target", root_owned(0o777))
            .unwrap();
        t.symlink(root, b"dirlink", b"a/", root_owned(0o777))
            .unwrap();
        t.symlink(root, b"dotlink", b".", root_owned(0o777))
            .unwrap();
        t.symlink(root, b"regularslash", b"target/", root_owned(0o777))
            .unwrap();
        t.symlink(root, b"rootlink", b"/", root_owned(0o777))
            .unwrap();
        t.symlink(root, b"loop", b"loop", root_owned(0o777))
            .unwrap();
        for n in 0..40 {
            let name = format!("l{n}");
            let target = if n == 39 {
                "target".into()
            } else {
                format!("l{}", n + 1)
            };
            t.symlink(root, name.as_bytes(), target.as_bytes(), root_owned(0o777))
                .unwrap();
        }
        t.symlink(root, b"l40", b"l0", root_owned(0o777)).unwrap();
        let mut f = Files::new(
            files_owner,
            t,
            Limits {
                contexts: 2,
                tables: 1,
                descriptions: 1,
                slots: 2,
            },
        );
        let ticket = f
            .bootstrap_mount(
                root,
                mount::Limits {
                    views: 4,
                    holds: 12,
                },
                policy,
            )
            .unwrap();
        let r = f.view_root(&ticket).unwrap();
        let cwd = f.component(&r, b"a").unwrap().unwrap();
        let fs = f.create_fs(&r, &cwd, 0o022).unwrap();
        assert!(f.release_view(ticket).is_ok());
        (f, fs, Credentials::initial_root())
    }
    fn policy() -> ViewPolicy {
        ViewPolicy {
            no_exec: false,
            no_suid: false,
            no_symfollow: false,
        }
    }
    #[test]
    fn byte_paths_cwd_symlinks_and_trailing_directory_rules() {
        let (f, fs, c) = setup(policy());
        let target = resolve(&f, &fs, &c, b"/target").unwrap();
        assert!(resolve(&f, &fs, &c, &[b'/', 255, 254]).is_ok());
        for path in [
            b"relative".as_slice(),
            b"absolute",
            b"../target",
            b"/a/../target",
            b"/../../target",
        ] {
            assert_eq!(resolve(&f, &fs, &c, path).unwrap().inode(), target.inode());
        }
        assert_eq!(
            resolve(&f, &fs, &c, b"/dirlink/file").unwrap().inode(),
            resolve(&f, &fs, &c, b"file").unwrap().inode()
        );
        for path in [b"file/".as_slice(), b"file/.", b"file/..", b"/target//"] {
            assert!(matches!(
                resolve(&f, &fs, &c, path),
                Err(Error::NotDirectory)
            ));
        }
        assert!(matches!(resolve(&f, &fs, &c, b""), Err(Error::NotFound)));
        assert!(matches!(
            resolve(&f, &fs, &c, b"/absent"),
            Err(Error::NotFound)
        ));
        assert!(matches!(
            resolve(&f, &fs, &c, b"a\0b"),
            Err(Error::InvalidPath)
        ));
        assert!(matches!(
            resolve(&f, &fs, &c, &vec![b'x'; 4096]),
            Err(Error::NameTooLong)
        ));
        assert!(matches!(
            resolve(&f, &fs, &c, &vec![b'x'; 256]),
            Err(Error::NameTooLong)
        ));
    }
    #[test]
    fn total_symlink_budget_and_immutable_view_policy() {
        let (f, fs, c) = setup(policy());
        assert_eq!(
            resolve(&f, &fs, &c, b"/l0").unwrap().inode(),
            resolve(&f, &fs, &c, b"/target").unwrap().inode()
        );
        for p in [b"/l40".as_slice(), b"/loop"] {
            assert!(matches!(resolve(&f, &fs, &c, p), Err(Error::Loop)));
        }
        let (f, fs, c) = setup(ViewPolicy {
            no_symfollow: true,
            ..policy()
        });
        assert!(matches!(
            resolve(&f, &fs, &c, b"relative"),
            Err(Error::Loop)
        ));
        assert!(resolve(&f, &fs, &c, b"file").is_ok());
    }
    #[test]
    fn search_includes_dot_and_noexec_is_not_path_authorization() {
        let (f, fs, root) = setup(ViewPolicy {
            no_exec: true,
            ..policy()
        });
        let c = root
            .program(
                &crate::inode::Metadata {
                    mode: 0o104755,
                    uid: 11,
                    gid: 12,
                    nlink: 1,
                },
                false,
                false,
            )
            .unwrap()
            .credentials;
        for p in [b"/closed/.".as_slice(), b"/closed/..", b"/closed/absent"] {
            assert!(matches!(resolve(&f, &fs, &c, p), Err(Error::Access)));
        }
        // Final execute/noexec is a separate held-program decision.
        assert!(resolve(&f, &fs, &c, b"/target").is_ok());
    }
    #[test]
    fn bind_root_ascent_and_fs_root_confinement() {
        let (mut f, fs, c) = setup(policy());
        let root = resolve(&f, &fs, &c, b"/").unwrap();
        let source = resolve(&f, &fs, &c, b"/a").unwrap();
        let point = resolve(&f, &fs, &c, b"/at").unwrap();
        let bind = f.clone_view(&source).unwrap();
        f.attach_view(&bind, &point).unwrap();
        assert_eq!(
            resolve(&f, &fs, &c, b"/at/../target").unwrap().inode(),
            resolve(&f, &fs, &c, b"/target").unwrap().inode()
        );
        let mounted = resolve(&f, &fs, &c, b"/at").unwrap();
        let confined = f.create_fs(&mounted, &mounted, 0).unwrap();
        assert_eq!(
            resolve(&f, &confined, &c, b"/../file").unwrap().inode(),
            resolve(&f, &fs, &c, b"/a/file").unwrap().inode()
        );
        assert!(matches!(
            resolve(&f, &confined, &c, b"/absolute"),
            Err(Error::NotFound)
        ));
        assert_eq!(
            resolve(&f, &fs, &c, b"/at/relative").unwrap().inode(),
            resolve(&f, &fs, &c, b"/target").unwrap().inode()
        );
        assert_ne!(root.inode(), mounted.inode());
    }
    #[test]
    fn popped_frames_do_not_reset_total_link_budget() {
        let (f, fs, c) = setup(policy());
        let forty = format!("/{}target", "dotlink/".repeat(40));
        assert!(
            resolve(&f, &fs, &c, forty.as_bytes()).unwrap().inode()
                == resolve(&f, &fs, &c, b"/target").unwrap().inode()
        );
        let forty_one = format!("/{}target", "dotlink/".repeat(41));
        assert!(resolve(&f, &fs, &c, forty_one.as_bytes()) == Err(Error::Loop));
    }
    #[test]
    fn target_and_caller_trailing_slashes_require_directories() {
        let (f, fs, c) = setup(policy());
        for path in [b"/regularslash".as_slice(), b"relative/", b"relative/."] {
            assert!(resolve(&f, &fs, &c, path) == Err(Error::NotDirectory));
        }
        assert!(
            resolve(&f, &fs, &c, b"/rootlink/a/file").unwrap().inode()
                == resolve(&f, &fs, &c, b"file").unwrap().inode()
        );
        assert!(
            resolve(&f, &fs, &c, b"/rootlink").unwrap().inode()
                == resolve(&f, &fs, &c, b"/").unwrap().inode()
        );
    }
    #[test]
    fn same_symlink_inode_obeys_each_view_policy() {
        let (mut f, fs, c) = setup(policy());
        let root = resolve(&f, &fs, &c, b"/").unwrap();
        let restricted = f
            .filesystem_view(
                root.inode(),
                ViewPolicy {
                    no_symfollow: true,
                    ..policy()
                },
            )
            .unwrap();
        let restricted_root = f.view_root(&restricted).unwrap();
        let other = f.create_fs(&restricted_root, &restricted_root, 0).unwrap();
        assert!(
            f.component(&root, b"dirlink").unwrap().unwrap().inode()
                == f.component(&restricted_root, b"dirlink")
                    .unwrap()
                    .unwrap()
                    .inode()
        );
        assert!(resolve(&f, &fs, &c, b"/dirlink/file").is_ok());
        assert!(resolve(&f, &other, &c, b"/dirlink/file") == Err(Error::Loop));
        assert!(resolve(&f, &other, &c, b"/a/file").is_ok());
        f.release_fs(other).unwrap();
        assert!(f.release_view(restricted).is_ok());
        assert!(resolve(&f, &fs, &c, b"/dirlink/file").is_ok());
    }
    #[test]
    fn failed_resolutions_leave_positions_masks_metadata_and_capacity_unchanged() {
        let (mut f, fs, c) = setup(policy());
        let (foreign_files, foreign_fs, _) = setup_owned(policy(), 901, 902);
        let root = f.fs_start(&fs, Base::Root).unwrap();
        let cwd = f.fs_start(&fs, Base::Cwd).unwrap();
        let target = resolve(&f, &fs, &c, b"/target").unwrap();
        let metadata = f.place_metadata(&target).unwrap();
        let unprivileged = c
            .program(
                &crate::inode::Metadata {
                    mode: 0o104755,
                    uid: 11,
                    gid: 12,
                    nlink: 1,
                },
                false,
                false,
            )
            .unwrap()
            .credentials;
        for _ in 0..16 {
            assert!(matches!(
                resolve(&f, &foreign_fs, &c, b"/target"),
                Err(Error::Files(_))
            ));
            assert!(resolve(&f, &fs, &unprivileged, b"/closed/absent") == Err(Error::Access));
            assert!(resolve(&f, &fs, &c, b"/loop") == Err(Error::Loop));
        }
        assert!(f.fs_start(&fs, Base::Root).unwrap() == root);
        assert!(f.fs_start(&fs, Base::Cwd).unwrap() == cwd);
        assert!(f.fs_umask(&fs) == Ok(0o022));
        assert!(f.place_metadata(&target).unwrap() == metadata);
        assert!(resolve(&foreign_files, &foreign_fs, &c, b"/target").is_ok());
        // Ticket is non-Copy and release consumes it: a released ticket cannot
        // be presented to resolve through the safe API. Exercise slot reuse and
        // full reclamation without manufacturing a second owning ticket.
        for _ in 0..16 {
            let temporary = f.create_fs(&root, &cwd, 0o077).unwrap();
            f.release_fs(temporary).unwrap();
        }
        assert!(resolve(&f, &fs, &c, b"relative").is_ok());
    }
}
