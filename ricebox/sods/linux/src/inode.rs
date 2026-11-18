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
//! entry budget. Directory parent names add O(total directory-name bytes) retained
//! storage beside directory-entry keys; ascent and symlink targets borrow bytes
//! without scanning siblings or allocating. Rename/unlink and mount-aware ascent
//! are not implemented. This remains an internal prepared-root constructor.
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

impl Inode {
    pub(crate) fn from_parts(owner: u64, number: u64) -> Self {
        Self { owner, number }
    }
    pub(crate) fn number(self) -> u64 {
        self.number
    }
    /// Storage incarnation only, not a mount/namespace or an ownership ticket.
    pub(crate) fn owner(self) -> u64 {
        self.owner
    }
}

/// Prepared namespace creation metadata; kind and link count belong to Tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Creation {
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
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
    InvalidSize,
    Exists,
    Payload(store::Error),
}
impl From<store::Error> for Error {
    fn from(error: store::Error) -> Self {
        Self::Payload(error)
    }
}
struct Directory {
    entries: HashMap<Vec<u8>, Inode>,
    // Only directories have one parent in this immutable namespace. Names are
    // retained separately from the parent's key to support borrowed O(1) ascent.
    parent: Option<(Inode, Vec<u8>)>,
}
enum Kind {
    Directory(Directory),
    Regular {
        payload: u32,
        expected_size: Option<usize>,
    },
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
        creation: Creation,
    ) -> Result<Self, Error> {
        mode(creation.mode)?;
        if max_inodes == 0 {
            return Err(Error::Capacity);
        }
        let mut nodes = Vec::new();
        nodes
            .try_reserve_exact(max_inodes)
            .map_err(|_| Error::Capacity)?;
        nodes.push(Node {
            metadata: Metadata {
                mode: DIRECTORY | creation.mode,
                uid: creation.uid,
                gid: creation.gid,
                nlink: 2,
            },
            kind: Kind::Directory(Directory {
                entries: HashMap::new(),
                parent: None,
            }),
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
        let Kind::Directory(directory) = &self.nodes[self.index(parent)?].kind else {
            return Err(Error::NotDirectory);
        };
        Ok(directory.entries.get(component).copied())
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
        let Kind::Directory(directory) = &mut self.nodes[parent].kind else {
            unreachable!()
        };
        directory
            .entries
            .try_reserve(1)
            .map_err(|_| Error::Capacity)?;
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
        let Kind::Directory(directory) = &mut self.nodes[place.parent].kind else {
            unreachable!()
        };
        // prepare checked absence and reserved one slot. Exclusive Tree access
        // and no intervening callbacks keep that admission valid through insert.
        let previous = directory.entries.insert(place.name, inode);
        debug_assert!(previous.is_none());
        self.entries += 1;
    }
    pub(crate) fn directory(
        &mut self,
        parent: Inode,
        component: &[u8],
        creation: Creation,
    ) -> Result<Inode, Error> {
        mode(creation.mode)?;
        if let Some(inode) = self.lookup(parent, component)? {
            let index = self.index(inode)?;
            if !matches!(self.nodes[index].kind, Kind::Directory(_)) {
                return Err(Error::NotDirectory);
            }
            self.nodes[index].metadata.mode = DIRECTORY | creation.mode;
            self.nodes[index].metadata.uid = creation.uid;
            self.nodes[index].metadata.gid = creation.gid;
            return Ok(inode);
        }
        let place = self.prepare(parent, component, true)?;
        let links = self.nodes[place.parent]
            .metadata
            .nlink
            .checked_add(1)
            .ok_or(Error::Capacity)?;
        let parent_name = copied(component)?;
        let parent_index = place.parent;
        let inode = self.publish(
            place,
            Node {
                metadata: Metadata {
                    mode: DIRECTORY | creation.mode,
                    uid: creation.uid,
                    gid: creation.gid,
                    nlink: 2,
                },
                kind: Kind::Directory(Directory {
                    entries: HashMap::new(),
                    parent: Some((parent, parent_name)),
                }),
            },
        );
        self.nodes[parent_index].metadata.nlink = links;
        Ok(inode)
    }
    pub(crate) fn file_take(
        &mut self,
        parent: Inode,
        component: &[u8],
        creation: Creation,
        bytes: &mut Vec<u8>,
    ) -> Result<Inode, Error> {
        mode(creation.mode)?;
        let place = self.prepare(parent, component, true)?;
        let payload = self.payloads.create_take(bytes)?;
        Ok(self.publish(
            place,
            Node {
                metadata: Metadata {
                    mode: REGULAR | creation.mode,
                    uid: creation.uid,
                    gid: creation.gid,
                    nlink: 1,
                },
                kind: Kind::Regular {
                    payload,
                    expected_size: None,
                },
            },
        ))
    }
    pub(crate) fn lazy_file(
        &mut self,
        parent: Inode,
        component: &[u8],
        creation: Creation,
        source: u32,
        size: usize,
    ) -> Result<Inode, Error> {
        self.lazy_file_inner(parent, component, creation, source, size, false)
    }
    /// Sealed metadata profile: successful source delivery must have exactly the
    /// declared decoded size. This fixes length only, not payload authenticity.
    /// General lazy_file deliberately retains its provisional-size semantics.
    pub(crate) fn lazy_file_exact(
        &mut self,
        parent: Inode,
        component: &[u8],
        creation: Creation,
        source: u32,
        size: usize,
    ) -> Result<Inode, Error> {
        self.lazy_file_inner(parent, component, creation, source, size, true)
    }
    fn lazy_file_inner(
        &mut self,
        parent: Inode,
        component: &[u8],
        creation: Creation,
        source: u32,
        size: usize,
        exact: bool,
    ) -> Result<Inode, Error> {
        mode(creation.mode)?;
        let place = self.prepare(parent, component, true)?;
        let payload = self.payloads.create_lazy(source, size)?;
        Ok(self.publish(
            place,
            Node {
                metadata: Metadata {
                    mode: REGULAR | creation.mode,
                    uid: creation.uid,
                    gid: creation.gid,
                    nlink: 1,
                },
                kind: Kind::Regular {
                    payload,
                    expected_size: exact.then_some(size),
                },
            },
        ))
    }
    pub(crate) fn symlink(
        &mut self,
        parent: Inode,
        component: &[u8],
        target: &[u8],
        creation: Creation,
    ) -> Result<Inode, Error> {
        mode(creation.mode)?;
        if target.is_empty() || target.len() > TARGET_MAX || target.contains(&0) {
            return Err(Error::InvalidTarget);
        }
        let place = self.prepare(parent, component, true)?;
        let target = copied(target)?;
        Ok(self.publish(
            place,
            Node {
                metadata: Metadata {
                    mode: SYMLINK | creation.mode,
                    uid: creation.uid,
                    gid: creation.gid,
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
        if !matches!(self.nodes[index].kind, Kind::Regular { .. }) {
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
    /// Namespace parent, not mount-aware `..`. Root has none; files/hardlinks
    /// have no unique parent and are rejected. Borrowed name allocates nothing.
    pub(crate) fn directory_parent(&self, inode: Inode) -> Result<Option<(Inode, &[u8])>, Error> {
        let Kind::Directory(directory) = &self.nodes[self.index(inode)?].kind else {
            return Err(Error::NotDirectory);
        };
        Ok(directory
            .parent
            .as_ref()
            .map(|(parent, name)| (*parent, name.as_slice())))
    }
    pub(crate) fn target(&self, inode: Inode) -> Result<&[u8], Error> {
        match &self.nodes[self.index(inode)?].kind {
            Kind::Symlink(target) => Ok(target),
            _ => Err(Error::InvalidTarget),
        }
    }
    fn payload(&self, inode: Inode) -> Result<u32, Error> {
        match self.nodes[self.index(inode)?].kind {
            Kind::Regular { payload, .. } => Ok(payload),
            _ => Err(Error::NotRegular),
        }
    }
    pub(crate) fn read(&mut self, inode: Inode, at: usize, length: usize) -> Result<&[u8], Error> {
        Ok(self.payloads.read(self.payload(inode)?, at, length)?)
    }
    pub(crate) fn size(&mut self, inode: Inode) -> Result<usize, Error> {
        Ok(self.payloads.size(self.payload(inode)?)?)
    }
    pub(crate) fn resident_ready(&self, inode: Inode) -> Result<bool, Error> {
        Ok(self.payloads.resident_ready(self.payload(inode)?)?)
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
        let (payload, expected_size) = match self.nodes[self.index(inode)?].kind {
            Kind::Regular {
                payload,
                expected_size,
            } => (payload, expected_size),
            _ => return Err(Error::NotRegular),
        };
        if success && expected_size.is_some_and(|size| size != bytes.len()) {
            // Settle only a matching attempt, as a failed load. In particular a
            // stale receipt must remain BadCompletion and cannot consume the
            // active attempt, adopt bytes or alter the declared logical size.
            self.payloads
                .load_finish_take(payload, attempt, false, bytes)?;
            return Err(Error::InvalidSize);
        }
        Ok(self
            .payloads
            .load_finish_take(payload, attempt, success, bytes)?)
    }
}

#[cfg(test)]
mod tests {
    // Prepared-root fixture ownership, not a production metadata default.
    fn root_owned(mode: u32) -> crate::inode::Creation {
        crate::inode::Creation {
            mode,
            uid: 0,
            gid: 0,
        }
    }

    use super::*;
    fn tree() -> Tree {
        Tree::new(9, 8, 8, 32, root_owned(0o755)).unwrap()
    }
    #[test]
    fn directory_parent_is_borrowed_stable_and_not_applied_to_hardlinks() {
        let mut t = Tree::new(801, 8, 8, 16, root_owned(0o755)).unwrap();
        let root = t.root();
        assert_eq!(t.directory_parent(root), Ok(None));
        let dir = t.directory(root, b"dir", root_owned(0o755)).unwrap();
        let child = t.directory(dir, &[0xff, b'x'], root_owned(0o700)).unwrap();
        assert_eq!(
            t.directory_parent(child),
            Ok(Some((dir, &[0xff, b'x'][..])))
        );
        let name_pointer = t.directory_parent(child).unwrap().unwrap().1.as_ptr();
        assert_eq!(
            t.directory(dir, &[0xff, b'x'], root_owned(0o750)),
            Ok(child)
        );
        assert_eq!(
            t.directory_parent(child).unwrap().unwrap().1.as_ptr(),
            name_pointer
        );
        assert_eq!(t.directory_parent(dir), Ok(Some((root, &b"dir"[..]))));
        let file = t
            .file_take(root, b"file", root_owned(0o600), &mut vec![1])
            .unwrap();
        t.hardlink(dir, b"alias", file).unwrap();
        assert_eq!(t.directory_parent(file), Err(Error::NotDirectory));
        assert_eq!(t.hardlink(root, b"dir-alias", dir), Err(Error::NotRegular));
        let link = t
            .symlink(root, b"link", &[b'.', b'.', b'/', 0xfe], root_owned(0o777))
            .unwrap();
        assert_eq!(t.directory_parent(link), Err(Error::NotDirectory));
        assert_eq!(t.target(link), Ok(&[b'.', b'.', b'/', 0xfe][..]));
        assert_eq!(
            t.target(link).unwrap().as_ptr(),
            t.target(link).unwrap().as_ptr()
        );
        assert_eq!(
            t.directory_parent(Inode {
                owner: 802,
                number: 1
            }),
            Err(Error::UnknownInode)
        );
        assert_eq!(
            t.directory_parent(Inode {
                owner: 801,
                number: 99
            }),
            Err(Error::UnknownInode)
        );
    }
    #[test]
    fn directory_construction_failure_keeps_parent_name_links_and_entries() {
        let mut t = Tree::new(803, 3, 2, 16, root_owned(0o755)).unwrap();
        let root = t.root();
        let dir = t.directory(root, b"dir", root_owned(0o700)).unwrap();
        let before = t.metadata(root).unwrap();
        assert_eq!(
            t.directory(root, b"bad/name", root_owned(0o755)),
            Err(Error::InvalidName)
        );
        assert_eq!(
            t.directory(root, b"dir", root_owned(0o10000)),
            Err(Error::InvalidMode)
        );
        let root_index = t.index(root).unwrap();
        t.nodes[root_index].metadata.nlink = u64::MAX;
        assert_eq!(
            t.directory(root, b"overflow", root_owned(0o755)),
            Err(Error::Capacity)
        );
        assert_eq!(t.lookup(root, b"overflow"), Ok(None));
        assert_eq!(t.directory_parent(dir), Ok(Some((root, &b"dir"[..]))));
        assert_eq!(t.metadata(dir).unwrap().mode, DIRECTORY | 0o700);
        t.nodes[root_index].metadata = before;
        let child = t.directory(dir, b"child", root_owned(0o755)).unwrap();
        assert_eq!(
            t.directory(root, b"full", root_owned(0o755)),
            Err(Error::Capacity)
        );
        assert_eq!(t.lookup(root, b"full"), Ok(None));
        assert_eq!(t.directory_parent(child), Ok(Some((dir, &b"child"[..]))));
        assert_eq!(t.metadata(root), Ok(before));
    }
    #[test]
    fn hardlinks_share_inode_metadata_and_single_payload() {
        let mut t = tree();
        let root = t.root();
        let mut bytes = b"payload".to_vec();
        let pointer = bytes.as_ptr();
        let file = t
            .file_take(root, b"a", root_owned(0o640), &mut bytes)
            .unwrap();
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
        let mut t = Tree::new(31, COUNT + 2, COUNT + 1, 8, root_owned(0o755)).unwrap();
        let root = t.root();
        let mut original = b"kept".to_vec();
        let pointer = original.as_ptr();
        let file = t
            .file_take(root, b"file", root_owned(0o640), &mut original)
            .unwrap();
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
            t.file_take(root, b"sibling-2048", root_owned(0o777), &mut rejected),
            Err(Error::Exists)
        );
        assert_eq!(
            t.file_take(root, b"extra", root_owned(0o777), &mut rejected),
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
        let mut t = Tree::new(32, COUNT + 1, COUNT, 8, root_owned(0o755)).unwrap();
        let root = t.root();
        let mut identities = Vec::new();
        for i in 0..COUNT {
            let name = format!("file-{i:04}");
            let mut payload = (i as u64).to_le_bytes().to_vec();
            identities.push(
                t.file_take(root, name.as_bytes(), root_owned(0o600), &mut payload)
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
        let mut t = Tree::new(9, 2, 2, 3, root_owned(0o755)).unwrap();
        let root = t.root();
        let mut original = b"old".to_vec();
        let file = t
            .file_take(root, b"a", root_owned(0o600), &mut original)
            .unwrap();
        let mut next = b"new".to_vec();
        let pointer = next.as_ptr();
        assert_eq!(
            t.file_take(root, b"a", root_owned(0o777), &mut next),
            Err(Error::Exists)
        );
        assert_eq!(
            t.file_take(root, b"c", root_owned(0o777), &mut next),
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
        let mut t = Tree::new(9, 2, 2, 1, root_owned(0o755)).unwrap();
        let root = t.root();
        let mut bytes = vec![1, 2];
        let pointer = bytes.as_ptr();
        assert_eq!(
            t.file_take(root, b"a", root_owned(0o600), &mut bytes),
            Err(Error::Payload(store::Error::TooLarge))
        );
        assert_eq!(t.lookup(root, b"a"), Ok(None));
        assert_eq!(bytes.as_ptr(), pointer);
        assert_eq!(bytes, [1, 2]);
        bytes.truncate(1);
        assert!(t
            .file_take(root, b"a", root_owned(0o600), &mut bytes)
            .is_ok());
    }
    #[test]
    fn directories_update_mode_without_replacing_and_cannot_be_hardlinked() {
        let mut t = tree();
        let root = t.root();
        let dir = t.directory(root, b"etc", root_owned(0o755)).unwrap();
        assert_eq!(t.directory(root, b"etc", root_owned(0o700)), Ok(dir));
        assert_eq!(t.metadata(dir).unwrap().mode, DIRECTORY | 0o700);
        assert_eq!(t.metadata(root).unwrap().nlink, 3);
        assert_eq!(t.hardlink(root, b"alias", dir), Err(Error::NotRegular));
        let mut bytes = vec![];
        let file = t
            .file_take(root, b"f", root_owned(0o600), &mut bytes)
            .unwrap();
        assert_eq!(
            t.directory(root, b"f", root_owned(0o755)),
            Err(Error::NotDirectory)
        );
        assert_eq!(t.lookup(file, b"x"), Err(Error::NotDirectory));
    }
    #[test]
    fn components_and_foreign_or_unknown_handles_are_rejected() {
        let mut t = tree();
        let root = t.root();
        for name in [&b""[..], b".", b"..", b"a/b", b"a\0b"] {
            assert_eq!(
                t.directory(root, name, root_owned(0o755)),
                Err(Error::InvalidName)
            );
        }
        let other = Tree::new(10, 1, 0, 0, root_owned(0o755)).unwrap();
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
            t.directory(root, b"x", root_owned(REGULAR | 0o600)),
            Err(Error::InvalidMode)
        );
    }
    #[test]
    fn non_utf8_components_and_targets_are_preserved() {
        let mut t = tree();
        let root = t.root();
        let link = t
            .symlink(root, &[0xff, 0xfe], &[b'.', b'/', 0xff], root_owned(0o777))
            .unwrap();
        assert_eq!(t.lookup(root, &[0xff, 0xfe]), Ok(Some(link)));
        assert_eq!(t.target(link).unwrap(), &[b'.', b'/', 0xff]);
        assert_eq!(
            t.symlink(root, b"empty", b"", root_owned(0o777)),
            Err(Error::InvalidTarget)
        );
        assert_eq!(
            t.symlink(root, b"nul", b"a\0b", root_owned(0o777)),
            Err(Error::InvalidTarget)
        );
    }

    #[test]
    fn symlink_target_is_stored_without_resolution() {
        let mut t = tree();
        let root = t.root();
        let link = t
            .symlink(root, b"link", b"../missing/target", root_owned(0o777))
            .unwrap();
        assert_eq!(t.target(link).unwrap(), b"../missing/target");
        assert_eq!(t.lookup(root, b"link"), Ok(Some(link)));
        assert_eq!(t.lookup(link, b"target"), Err(Error::NotDirectory));
        assert_eq!(t.hardlink(root, b"alias", link), Err(Error::NotRegular));
    }
    #[test]
    fn pending_lazy_source_survives_collision_and_completes_for_all_names() {
        let mut t = tree();
        let root = t.root();
        let f = t.lazy_file(root, b"a", root_owned(0o644), 7, 3).unwrap();
        t.hardlink(root, b"b", f).unwrap();
        assert_eq!(t.size(f), Ok(3));
        assert_eq!(t.source(f), Ok(7));
        let attempt = t.load_begin(f).unwrap();
        assert_ne!(attempt, 0);
        assert_eq!(
            t.symlink(root, b"a", b"elsewhere", root_owned(0o777)),
            Err(Error::Exists)
        );
        let mut bytes = b"new".to_vec();
        assert_eq!(
            t.file_take(root, b"b", root_owned(0o644), &mut bytes),
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

#[cfg(test)]
mod creation_tests {
    // Prepared-root fixture ownership, not a production metadata default.
    fn root_owned(mode: u32) -> crate::inode::Creation {
        crate::inode::Creation {
            mode,
            uid: 0,
            gid: 0,
        }
    }

    use super::*;
    #[test]
    fn creation_owns_metadata_and_hardlinks_share_it() {
        let initial = Creation {
            mode: 0o750,
            uid: 11,
            gid: 12,
        };
        let mut t = Tree::new(710, 8, 8, 32, initial).unwrap();
        let root = t.root();
        assert_eq!(
            t.metadata(root).unwrap(),
            Metadata {
                mode: DIRECTORY | 0o750,
                uid: 11,
                gid: 12,
                nlink: 2
            }
        );
        let dir = t.directory(root, b"dir", initial).unwrap();
        let file = t
            .file_take(
                dir,
                b"file",
                Creation {
                    mode: 0o640,
                    uid: 21,
                    gid: 22,
                },
                &mut vec![1],
            )
            .unwrap();
        t.hardlink(root, b"alias", file).unwrap();
        let alias = t.lookup(root, b"alias").unwrap().unwrap();
        assert_eq!(alias, file);
        assert_eq!(
            t.metadata(alias).unwrap(),
            Metadata {
                mode: REGULAR | 0o640,
                uid: 21,
                gid: 22,
                nlink: 2
            }
        );
        let child = t.directory(dir, b"child", initial).unwrap();
        let next = Creation {
            mode: 0o700,
            uid: 31,
            gid: 32,
        };
        assert_eq!(t.directory(root, b"dir", next), Ok(dir));
        assert_eq!(t.lookup(dir, b"child").unwrap(), Some(child));
        assert_eq!(t.lookup(dir, b"file").unwrap(), Some(file));
        assert_eq!(
            t.metadata(dir).unwrap(),
            Metadata {
                mode: DIRECTORY | 0o700,
                uid: 31,
                gid: 32,
                nlink: 3
            }
        );
        assert_eq!(
            t.directory(
                root,
                b"dir",
                Creation {
                    mode: REGULAR,
                    uid: 99,
                    gid: 99
                }
            ),
            Err(Error::InvalidMode)
        );
        assert_eq!(t.metadata(dir).unwrap().uid, 31);
        let link = t
            .symlink(
                root,
                b"link",
                b"dir",
                Creation {
                    mode: 0o777,
                    uid: 41,
                    gid: 42,
                },
            )
            .unwrap();
        assert_eq!(t.metadata(link).unwrap().uid, 41);
        let lazy = t
            .lazy_file(
                root,
                b"lazy",
                Creation {
                    mode: 0o600,
                    uid: 51,
                    gid: 52,
                },
                1,
                0,
            )
            .unwrap();
        assert_eq!(t.metadata(lazy).unwrap().gid, 52);
        assert!(matches!(
            Tree::new(711, 1, 0, 0, root_owned(DIRECTORY)),
            Err(Error::InvalidMode)
        ));
    }
}

#[cfg(test)]
mod exact_size_tests {
    use super::*;

    fn creation() -> Creation {
        Creation {
            mode: 0o644,
            uid: 0,
            gid: 0,
        }
    }
    fn tree() -> Tree {
        Tree::new(
            901,
            8,
            8,
            32,
            Creation {
                mode: 0o755,
                ..creation()
            },
        )
        .unwrap()
    }
    #[test]
    fn exact_size_mismatch_settles_only_matching_attempt_without_adopting_bytes() {
        let mut tree = tree();
        let root = tree.root();
        let file = tree
            .lazy_file_exact(root, b"exact", creation(), 41, 3)
            .unwrap();
        tree.hardlink(root, b"alias", file).unwrap();
        let alias = tree.lookup(root, b"alias").unwrap().unwrap();
        let first = tree.load_begin(file).unwrap();
        let mut bad = Vec::with_capacity(17);
        bad.extend_from_slice(b"long");
        let pointer = bad.as_ptr();
        let capacity = bad.capacity();
        assert_eq!(
            tree.load_finish(alias, first + 1, true, &mut bad),
            Err(Error::Payload(store::Error::BadCompletion))
        );
        assert_eq!(tree.size(file), Ok(3));
        assert_eq!(
            tree.load_finish(alias, first, true, &mut bad),
            Err(Error::InvalidSize)
        );
        assert_eq!(bad, b"long");
        assert_eq!(bad.as_ptr(), pointer);
        assert_eq!(bad.capacity(), capacity);
        assert_eq!(tree.size(alias), Ok(3));
        assert_eq!(tree.source(alias), Ok(41));
        assert_eq!(
            tree.read(alias, 0, 9),
            Err(Error::Payload(store::Error::LoadConflict))
        );

        let mut good = b"abc".to_vec();
        assert_eq!(
            tree.load_finish(file, first, true, &mut good),
            Err(Error::Payload(store::Error::BadCompletion))
        );
        let next = tree.load_begin(alias).unwrap();
        assert_ne!(next, first);
        assert_eq!(
            tree.load_finish(file, first, true, &mut bad),
            Err(Error::Payload(store::Error::BadCompletion))
        );
        assert_eq!(bad, b"long");
        tree.load_finish(alias, next, true, &mut good).unwrap();
        assert!(good.is_empty());
        assert_eq!(tree.size(file), Ok(3));
        assert_eq!(tree.read(file, 0, 9), Ok(&b"abc"[..]));
        assert_eq!(
            tree.load_finish(file, next, true, &mut bad),
            Err(Error::Payload(store::Error::BadCompletion))
        );
        assert_eq!(tree.size(file), Ok(3));
        assert_eq!(tree.read(alias, 0, 9), Ok(&b"abc"[..]));
        assert_eq!(bad.as_ptr(), pointer);
        assert_eq!(bad.capacity(), capacity);
    }

    #[test]
    fn exact_size_failed_receipt_does_not_validate_or_adopt_failed_input() {
        let mut tree = tree();
        let root = tree.root();
        let file = tree
            .lazy_file_exact(root, b"exact", creation(), 42, 3)
            .unwrap();
        let first = tree.load_begin(file).unwrap();
        let mut bytes = b"not a successful payload".to_vec();
        let pointer = bytes.as_ptr();
        tree.load_finish(file, first, false, &mut bytes).unwrap();
        assert_eq!(bytes.as_ptr(), pointer);
        assert_eq!(bytes, b"not a successful payload");
        assert_eq!(tree.size(file), Ok(3));
        let next = tree.load_begin(file).unwrap();
        assert_ne!(next, first);
        tree.load_finish(file, next, false, &mut Vec::new())
            .unwrap();
    }

    #[test]
    fn exact_compressed_empty_accepts_only_decoded_empty_and_remains_source_backed() {
        let mut tree = tree();
        let root = tree.root();
        let file = tree
            .lazy_file_exact(root, b"compressed-empty", creation(), 43, 0)
            .unwrap();
        let first = tree.load_begin(file).unwrap();
        let mut bad = vec![1];
        assert_eq!(
            tree.load_finish(file, first, true, &mut bad),
            Err(Error::InvalidSize)
        );
        assert_eq!(bad, [1]);
        assert_eq!(tree.size(file), Ok(0));
        let next = tree.load_begin(file).unwrap();
        let mut empty = Vec::with_capacity(9);
        tree.load_finish(file, next, true, &mut empty).unwrap();
        assert_eq!(empty.capacity(), 0);
        assert_eq!(tree.size(file), Ok(0));
        assert_eq!(tree.source(file), Ok(43));
        assert_eq!(tree.read(file, 0, 1), Ok(&[][..]));
        assert_eq!(tree.load_begin(file), Ok(0));
    }

    #[test]
    fn general_lazy_file_retains_provisional_size_compatibility() {
        let mut tree = tree();
        let root = tree.root();
        let file = tree
            .lazy_file(root, b"provisional", creation(), 44, 9)
            .unwrap();
        let attempt = tree.load_begin(file).unwrap();
        let mut bytes = b"abc".to_vec();
        tree.load_finish(file, attempt, true, &mut bytes).unwrap();
        assert!(bytes.is_empty());
        assert_eq!(tree.size(file), Ok(3));
        assert_eq!(tree.read(file, 0, 9), Ok(&b"abc"[..]));
    }
}
