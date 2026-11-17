//! Component-based prepared-root construction, not guest path resolution.
//!
//! Names are single byte components; symlinks are stored, never followed here.
//! Existing entries cannot be replaced. Namespace/metadata belong here; regular
//! payloads and lazy attempts have exactly one owner in sods-file-store.
//! No unlink/close API exists yet: in particular a collision cannot drop a
//! pending lazy source. Domain shutdown/source lifetime still needs integration.
//! Each operation preserves already published entries on failure; mounting a whole
//! archive is NOT a transaction. Lookup never creates parents (unlike legacy has).
//! Directory nlink starts at 2 plus child directories, as the current TS Dir does.
//! Guest stat is not implemented here.
//! This constructor admits names up to 255 bytes and nonempty, NUL-free symlink
//! targets up to 4095 bytes. It is a restricted preparation contract, not a claim
//! of full legacy path compatibility. Root overlay/given, inode origin, timestamps,
//! credentials/permission checks and guest path resolution remain separate work.
//! A single HashMap owns each directory's names and inode references. Capacity and
//! name ownership are acquired before payloads, so publication does not allocate.
//! Expected construction work is O(total name bytes + entries), not a worst-case
//! guarantee: adversarial collisions can still cause quadratic work within the
//! entry budget. RandomState's seed unpredictability on the Wasm target has not
//! been established. No enumeration order or guest getdents contract is exposed.
//! Inode and entry counts are separately bounded; hardlinks cannot bypass the
//! entry budget. This remains an internal prepared-root constructor.
use sods_file_store::store::{self, Store};
use std::collections::HashMap;

const NAME_MAX: usize = 255;
const TARGET_MAX: usize = 4095;
const MODE_BITS: u32 = 0o7777;
const DIRECTORY: u32 = 0o040000;
const REGULAR: u32 = 0o100000;
const SYMLINK: u32 = 0o120000;

/// Private tree-local identity, never reused. The domain must issue a unique
/// owner ID per tree and must not recreate a tree while that ID is referenced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Inode {
    owner: u64,
    number: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Metadata {
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub nlink: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Capacity,
    InvalidName,
    InvalidTarget,
    InvalidMode,
    UnknownInode,
    NotDirectory,
    NotRegular,
    Exists,
    Payload(store::Error),
}
impl From<store::Error> for Error {
    fn from(error: store::Error) -> Self {
        Self::Payload(error)
    }
}
enum Kind {
    Directory(HashMap<Vec<u8>, Inode>),
    Regular(u32),
    Symlink(Vec<u8>),
}
struct Node {
    metadata: Metadata,
    kind: Kind,
}
struct Place {
    parent: usize,
    name: Vec<u8>,
}

pub(crate) struct Tree {
    owner: u64,
    nodes: Vec<Node>,
    max_inodes: usize,
    entries: usize,
    max_entries: usize,
    payloads: Store,
}
fn copied(bytes: &[u8]) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    out.try_reserve_exact(bytes.len())
        .map_err(|_| Error::Capacity)?;
    out.extend_from_slice(bytes);
    Ok(out)
}
fn name(bytes: &[u8]) -> Result<(), Error> {
    if bytes.is_empty()
        || bytes.len() > NAME_MAX
        || bytes == b"."
        || bytes == b".."
        || bytes.contains(&0)
        || bytes.contains(&b'/')
    {
        return Err(Error::InvalidName);
    }
    Ok(())
}
fn mode(mode: u32) -> Result<(), Error> {
    if mode & !MODE_BITS != 0 {
        Err(Error::InvalidMode)
    } else {
        Ok(())
    }
}
impl Tree {
    pub(crate) fn new(
        owner: u64,
        max_inodes: usize,
        max_entries: usize,
        max_file_bytes: usize,
    ) -> Result<Self, Error> {
        if max_inodes == 0 {
            return Err(Error::Capacity);
        }
        let mut nodes = Vec::new();
        nodes
            .try_reserve_exact(max_inodes)
            .map_err(|_| Error::Capacity)?;
        nodes.push(Node {
            metadata: Metadata {
                mode: DIRECTORY | 0o755,
                uid: 0,
                gid: 0,
                nlink: 2,
            },
            kind: Kind::Directory(HashMap::new()),
        });
        Ok(Self {
            owner,
            nodes,
            max_inodes,
            entries: 0,
            max_entries,
            payloads: Store::new(max_file_bytes),
        })
    }
    pub(crate) fn root(&self) -> Inode {
        Inode {
            owner: self.owner,
            number: 1,
        }
    }
    fn index(&self, inode: Inode) -> Result<usize, Error> {
        if inode.owner != self.owner || inode.number == 0 {
            return Err(Error::UnknownInode);
        }
        let index = usize::try_from(inode.number - 1).map_err(|_| Error::UnknownInode)?;
        if index >= self.nodes.len() {
            Err(Error::UnknownInode)
        } else {
            Ok(index)
        }
    }
    pub(crate) fn metadata(&self, inode: Inode) -> Result<Metadata, Error> {
        Ok(self.nodes[self.index(inode)?].metadata)
    }
    pub(crate) fn lookup(&self, parent: Inode, component: &[u8]) -> Result<Option<Inode>, Error> {
        name(component)?;
        let Kind::Directory(entries) = &self.nodes[self.index(parent)?].kind else {
            return Err(Error::NotDirectory);
        };
        Ok(entries.get(component).copied())
    }
    /// Perform fallible name/capacity/allocation work before acquiring payloads.
    fn prepare(&mut self, parent: Inode, component: &[u8], inode: bool) -> Result<Place, Error> {
        if self.lookup(parent, component)?.is_some() {
            return Err(Error::Exists);
        }
        if self.entries == self.max_entries || (inode && self.nodes.len() == self.max_inodes) {
            return Err(Error::Capacity);
        }
        let parent = self.index(parent)?;
        let name = copied(component)?;
        let Kind::Directory(entries) = &mut self.nodes[parent].kind else {
            unreachable!()
        };
        entries.try_reserve(1).map_err(|_| Error::Capacity)?;
        Ok(Place { parent, name })
    }
    /// Only reserved insertion/push remain; no callbacks or payload acquisition.
    fn publish(&mut self, place: Place, node: Node) -> Inode {
        let inode = Inode {
            owner: self.owner,
            number: self.nodes.len() as u64 + 1,
        };
        self.nodes.push(node);
        self.link_entry(place, inode);
        inode
    }
    fn link_entry(&mut self, place: Place, inode: Inode) {
        let Kind::Directory(entries) = &mut self.nodes[place.parent].kind else {
            unreachable!()
        };
        // prepare checked absence and reserved one slot. Exclusive Tree access
        // and no intervening callbacks keep that admission valid through insert.
        let previous = entries.insert(place.name, inode);
        debug_assert!(previous.is_none());
        self.entries += 1;
    }
    pub(crate) fn directory(
        &mut self,
        parent: Inode,
        component: &[u8],
        permissions: u32,
    ) -> Result<Inode, Error> {
        mode(permissions)?;
        if let Some(inode) = self.lookup(parent, component)? {
            let index = self.index(inode)?;
            if !matches!(self.nodes[index].kind, Kind::Directory(_)) {
                return Err(Error::NotDirectory);
            }
            self.nodes[index].metadata.mode = DIRECTORY | permissions;
            return Ok(inode);
        }
        let place = self.prepare(parent, component, true)?;
        let links = self.nodes[place.parent]
            .metadata
            .nlink
            .checked_add(1)
            .ok_or(Error::Capacity)?;
        let parent_index = place.parent;
        let inode = self.publish(
            place,
            Node {
                metadata: Metadata {
                    mode: DIRECTORY | permissions,
                    uid: 0,
                    gid: 0,
                    nlink: 2,
                },
                kind: Kind::Directory(HashMap::new()),
            },
        );
        self.nodes[parent_index].metadata.nlink = links;
        Ok(inode)
    }
    pub(crate) fn file_take(
        &mut self,
        parent: Inode,
        component: &[u8],
        permissions: u32,
        bytes: &mut Vec<u8>,
    ) -> Result<Inode, Error> {
        mode(permissions)?;
        let place = self.prepare(parent, component, true)?;
        let payload = self.payloads.create_take(bytes)?;
        Ok(self.publish(
            place,
            Node {
                metadata: Metadata {
                    mode: REGULAR | permissions,
                    uid: 0,
                    gid: 0,
                    nlink: 1,
                },
                kind: Kind::Regular(payload),
            },
        ))
    }
    pub(crate) fn lazy_file(
        &mut self,
        parent: Inode,
        component: &[u8],
        permissions: u32,
        source: u32,
        size: usize,
    ) -> Result<Inode, Error> {
        mode(permissions)?;
        let place = self.prepare(parent, component, true)?;
        let payload = self.payloads.create_lazy(source, size)?;
        Ok(self.publish(
            place,
            Node {
                metadata: Metadata {
                    mode: REGULAR | permissions,
                    uid: 0,
                    gid: 0,
                    nlink: 1,
                },
                kind: Kind::Regular(payload),
            },
        ))
    }
    pub(crate) fn symlink(
        &mut self,
        parent: Inode,
        component: &[u8],
        target: &[u8],
    ) -> Result<Inode, Error> {
        if target.is_empty() || target.len() > TARGET_MAX || target.contains(&0) {
            return Err(Error::InvalidTarget);
        }
        let place = self.prepare(parent, component, true)?;
        let target = copied(target)?;
        Ok(self.publish(
            place,
            Node {
                metadata: Metadata {
                    mode: SYMLINK | 0o777,
                    uid: 0,
                    gid: 0,
                    nlink: 1,
                },
                kind: Kind::Symlink(target),
            },
        ))
    }
    pub(crate) fn hardlink(
        &mut self,
        parent: Inode,
        component: &[u8],
        inode: Inode,
    ) -> Result<(), Error> {
        let index = self.index(inode)?;
        if !matches!(self.nodes[index].kind, Kind::Regular(_)) {
            return Err(Error::NotRegular);
        }
        let links = self.nodes[index]
            .metadata
            .nlink
            .checked_add(1)
            .ok_or(Error::Capacity)?;
        let place = self.prepare(parent, component, false)?;
        self.link_entry(place, inode);
        self.nodes[index].metadata.nlink = links;
        Ok(())
    }
    pub(crate) fn target(&self, inode: Inode) -> Result<&[u8], Error> {
        match &self.nodes[self.index(inode)?].kind {
            Kind::Symlink(target) => Ok(target),
            _ => Err(Error::InvalidTarget),
        }
    }
    fn payload(&self, inode: Inode) -> Result<u32, Error> {
        match self.nodes[self.index(inode)?].kind {
            Kind::Regular(payload) => Ok(payload),
            _ => Err(Error::NotRegular),
        }
    }
    pub(crate) fn read(&mut self, inode: Inode, at: usize, length: usize) -> Result<&[u8], Error> {
        Ok(self.payloads.read(self.payload(inode)?, at, length)?)
    }
    pub(crate) fn size(&mut self, inode: Inode) -> Result<usize, Error> {
        Ok(self.payloads.size(self.payload(inode)?)?)
    }
    pub(crate) fn source(&mut self, inode: Inode) -> Result<u32, Error> {
        Ok(self.payloads.load_source(self.payload(inode)?)?)
    }
    pub(crate) fn load_begin(&mut self, inode: Inode) -> Result<u32, Error> {
        Ok(self.payloads.load_begin(self.payload(inode)?)?)
    }
    pub(crate) fn load_finish(
        &mut self,
        inode: Inode,
        attempt: u32,
        success: bool,
        bytes: &mut Vec<u8>,
    ) -> Result<(), Error> {
        Ok(self
            .payloads
            .load_finish_take(self.payload(inode)?, attempt, success, bytes)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tree() -> Tree {
        Tree::new(9, 8, 8, 32).unwrap()
    }
    #[test]
    fn hardlinks_share_inode_metadata_and_single_payload() {
        let mut t = tree();
        let root = t.root();
        let mut bytes = b"payload".to_vec();
        let pointer = bytes.as_ptr();
        let file = t.file_take(root, b"a", 0o640, &mut bytes).unwrap();
        assert!(bytes.is_empty());
        t.hardlink(root, b"b", file).unwrap();
        assert_eq!(t.lookup(root, b"b"), Ok(Some(file)));
        assert_eq!(t.metadata(file).unwrap().nlink, 2);
        assert_eq!(t.read(file, 0, 99).unwrap().as_ptr(), pointer);
        assert_eq!(
            t.read(t.lookup(root, b"b").unwrap().unwrap(), 0, 99)
                .unwrap(),
            b"payload"
        );
    }
    #[test]
    fn many_siblings_keep_identity_and_payload_through_growth_and_rejection() {
        const COUNT: usize = 4096;
        let mut t = Tree::new(31, COUNT + 2, COUNT + 1, 8).unwrap();
        let root = t.root();
        let mut original = b"kept".to_vec();
        let pointer = original.as_ptr();
        let file = t.file_take(root, b"file", 0o640, &mut original).unwrap();
        for i in 0..COUNT {
            let name = format!("sibling-{i:04}");
            t.hardlink(root, name.as_bytes(), file).unwrap();
        }
        for i in (0..COUNT).rev() {
            let name = format!("sibling-{i:04}");
            assert_eq!(t.lookup(root, name.as_bytes()), Ok(Some(file)));
        }
        let mut rejected = b"new".to_vec();
        let rejected_pointer = rejected.as_ptr();
        assert_eq!(
            t.file_take(root, b"sibling-2048", 0o777, &mut rejected),
            Err(Error::Exists)
        );
        assert_eq!(
            t.file_take(root, b"extra", 0o777, &mut rejected),
            Err(Error::Capacity)
        );
        assert_eq!(t.hardlink(root, b"extra", file), Err(Error::Capacity));
        assert_eq!(rejected, b"new");
        assert_eq!(rejected.as_ptr(), rejected_pointer);
        assert_eq!(t.lookup(root, b"extra"), Ok(None));
        assert_eq!(t.metadata(file).unwrap().nlink, (COUNT + 1) as u64);
        assert_eq!(t.metadata(file).unwrap().mode, REGULAR | 0o640);
        assert_eq!(t.read(file, 0, 8).unwrap().as_ptr(), pointer);
        assert_eq!(t.read(file, 0, 8).unwrap(), b"kept");
    }
    #[test]
    fn many_distinct_siblings_keep_payload_and_inode_identity() {
        const COUNT: usize = 2048;
        let mut t = Tree::new(32, COUNT + 1, COUNT, 8).unwrap();
        let root = t.root();
        let mut identities = Vec::new();
        for i in 0..COUNT {
            let name = format!("file-{i:04}");
            let mut payload = (i as u64).to_le_bytes().to_vec();
            identities.push(
                t.file_take(root, name.as_bytes(), 0o600, &mut payload)
                    .unwrap(),
            );
            assert!(payload.is_empty());
        }
        for i in (0..COUNT).rev() {
            let name = format!("file-{i:04}");
            let inode = t.lookup(root, name.as_bytes()).unwrap().unwrap();
            assert_eq!(inode, identities[i]);
            assert_eq!(t.read(inode, 0, 8).unwrap(), &(i as u64).to_le_bytes());
        }
    }
    #[test]
    fn collisions_and_capacity_preserve_input_and_existing_identity() {
        let mut t = Tree::new(9, 2, 2, 3).unwrap();
        let root = t.root();
        let mut original = b"old".to_vec();
        let file = t.file_take(root, b"a", 0o600, &mut original).unwrap();
        let mut next = b"new".to_vec();
        let pointer = next.as_ptr();
        assert_eq!(
            t.file_take(root, b"a", 0o777, &mut next),
            Err(Error::Exists)
        );
        assert_eq!(
            t.file_take(root, b"c", 0o777, &mut next),
            Err(Error::Capacity)
        );
        assert_eq!(next.as_ptr(), pointer);
        assert_eq!(next, b"new");
        t.hardlink(root, b"b", file).unwrap();
        assert_eq!(t.hardlink(root, b"c", file), Err(Error::Capacity));
        assert_eq!(t.metadata(file).unwrap().nlink, 2);
        assert_eq!(t.read(file, 0, 99).unwrap(), b"old");
    }
    #[test]
    fn payload_rejection_does_not_publish_or_consume_input() {
        let mut t = Tree::new(9, 2, 2, 1).unwrap();
        let root = t.root();
        let mut bytes = vec![1, 2];
        let pointer = bytes.as_ptr();
        assert_eq!(
            t.file_take(root, b"a", 0o600, &mut bytes),
            Err(Error::Payload(store::Error::TooLarge))
        );
        assert_eq!(t.lookup(root, b"a"), Ok(None));
        assert_eq!(bytes.as_ptr(), pointer);
        assert_eq!(bytes, [1, 2]);
        bytes.truncate(1);
        assert!(t.file_take(root, b"a", 0o600, &mut bytes).is_ok());
    }
    #[test]
    fn directories_update_mode_without_replacing_and_cannot_be_hardlinked() {
        let mut t = tree();
        let root = t.root();
        let dir = t.directory(root, b"etc", 0o755).unwrap();
        assert_eq!(t.directory(root, b"etc", 0o700), Ok(dir));
        assert_eq!(t.metadata(dir).unwrap().mode, DIRECTORY | 0o700);
        assert_eq!(t.metadata(root).unwrap().nlink, 3);
        assert_eq!(t.hardlink(root, b"alias", dir), Err(Error::NotRegular));
        let mut bytes = vec![];
        let file = t.file_take(root, b"f", 0o600, &mut bytes).unwrap();
        assert_eq!(t.directory(root, b"f", 0o755), Err(Error::NotDirectory));
        assert_eq!(t.lookup(file, b"x"), Err(Error::NotDirectory));
    }
    #[test]
    fn components_and_foreign_or_unknown_handles_are_rejected() {
        let mut t = tree();
        let root = t.root();
        for name in [&b""[..], b".", b"..", b"a/b", b"a\0b"] {
            assert_eq!(t.directory(root, name, 0o755), Err(Error::InvalidName));
        }
        let other = Tree::new(10, 1, 0, 0).unwrap();
        assert_eq!(t.metadata(other.root()), Err(Error::UnknownInode));
        assert_eq!(
            t.hardlink(root, b"x", other.root()),
            Err(Error::UnknownInode)
        );
        assert_eq!(
            t.metadata(Inode {
                owner: 9,
                number: 0
            }),
            Err(Error::UnknownInode)
        );
        assert_eq!(
            t.metadata(Inode {
                owner: 9,
                number: 99
            }),
            Err(Error::UnknownInode)
        );
        assert_eq!(
            t.directory(root, b"x", REGULAR | 0o600),
            Err(Error::InvalidMode)
        );
    }
    #[test]
    fn non_utf8_components_and_targets_are_preserved() {
        let mut t = tree();
        let root = t.root();
        let link = t.symlink(root, &[0xff, 0xfe], &[b'.', b'/', 0xff]).unwrap();
        assert_eq!(t.lookup(root, &[0xff, 0xfe]), Ok(Some(link)));
        assert_eq!(t.target(link).unwrap(), &[b'.', b'/', 0xff]);
        assert_eq!(t.symlink(root, b"empty", b""), Err(Error::InvalidTarget));
        assert_eq!(t.symlink(root, b"nul", b"a\0b"), Err(Error::InvalidTarget));
    }

    #[test]
    fn symlink_target_is_stored_without_resolution() {
        let mut t = tree();
        let root = t.root();
        let link = t.symlink(root, b"link", b"../missing/./target").unwrap();
        assert_eq!(t.target(link).unwrap(), b"../missing/./target");
        assert_eq!(t.lookup(root, b"link"), Ok(Some(link)));
        assert_eq!(t.lookup(link, b"target"), Err(Error::NotDirectory));
        assert_eq!(t.hardlink(root, b"alias", link), Err(Error::NotRegular));
    }
    #[test]
    fn pending_lazy_source_survives_collision_and_completes_for_all_names() {
        let mut t = tree();
        let root = t.root();
        let f = t.lazy_file(root, b"a", 0o644, 7, 3).unwrap();
        t.hardlink(root, b"b", f).unwrap();
        assert_eq!(t.size(f), Ok(3));
        assert_eq!(t.source(f), Ok(7));
        let attempt = t.load_begin(f).unwrap();
        assert_ne!(attempt, 0);
        assert_eq!(t.symlink(root, b"a", b"elsewhere"), Err(Error::Exists));
        let mut bytes = b"new".to_vec();
        assert_eq!(
            t.file_take(root, b"b", 0o644, &mut bytes),
            Err(Error::Exists)
        );
        assert_eq!(
            t.load_finish(f, attempt + 1, true, &mut bytes),
            Err(Error::Payload(store::Error::BadCompletion))
        );
        assert_eq!(bytes, b"new");
        t.load_finish(f, attempt, true, &mut bytes).unwrap();
        assert!(bytes.is_empty());
        assert_eq!(
            t.read(t.lookup(root, b"b").unwrap().unwrap(), 0, 99)
                .unwrap(),
            b"new"
        );
    }
}
