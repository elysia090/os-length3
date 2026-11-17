//! Owned filesystem storage, independent of mount views and namespaces.
//! Each admitted Tree has one owner here. No replacement/removal or mutable Tree
//! export exists: descriptions and pending reads cannot outlive their storage.
//! This retains all storage until Files ends; it is not mount-aware reclamation.
//! The bootstrap Tree stays inline so the existing one-tree constructor remains
//! allocation-free. A single fallible registry constructor would be more uniform,
//! but would change existing ABI seal failure/ownership behavior. This inline
//! bootstrap preserves that contract during this internal migration. Additional
//! trees are indexed by their unique incarnation.
//! Duplicate-owner rejection precedes capacity rejection, including at capacity one.
//! Admission reserves before transfer and returns the unchanged Tree on failure.
//! Capacity bounds tree count, not HashMap spare capacity or total payload bytes.
//! Lookup of additional trees is expected constant time, not a worst-case claim.
use super::inode::{Error, Inode, Metadata, Tree};
use std::collections::HashMap;
use std::num::NonZeroUsize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AdmissionError {
    DuplicateOwner,
    Capacity,
}

pub(crate) struct Filesystems {
    first: Tree,
    others: HashMap<u64, Tree>,
    capacity: NonZeroUsize,
}
impl Filesystems {
    pub(crate) fn new(first: Tree, capacity: NonZeroUsize) -> Self {
        Self {
            first,
            others: HashMap::new(),
            capacity,
        }
    }
    pub(crate) fn admit(&mut self, tree: Tree) -> Result<Inode, (AdmissionError, Tree)> {
        let root = tree.root();
        let owner = root.owner();
        if owner == self.first.root().owner() || self.others.contains_key(&owner) {
            return Err((AdmissionError::DuplicateOwner, tree));
        }
        // first consumes one slot; subtraction is safe because capacity is nonzero.
        if self.others.len() >= self.capacity.get() - 1 {
            return Err((AdmissionError::Capacity, tree));
        }
        if self.others.try_reserve(1).is_err() {
            return Err((AdmissionError::Capacity, tree));
        }
        // No callbacks, allocation or fallible work after ownership transfer.
        let old = self.others.insert(owner, tree);
        debug_assert!(old.is_none());
        Ok(root)
    }
    fn tree(&self, inode: Inode) -> Result<&Tree, Error> {
        if inode.owner() == self.first.root().owner() {
            return Ok(&self.first);
        }
        self.others.get(&inode.owner()).ok_or(Error::UnknownInode)
    }
    fn tree_mut(&mut self, inode: Inode) -> Result<&mut Tree, Error> {
        if inode.owner() == self.first.root().owner() {
            return Ok(&mut self.first);
        }
        self.others
            .get_mut(&inode.owner())
            .ok_or(Error::UnknownInode)
    }
    pub(crate) fn lookup(&self, parent: Inode, name: &[u8]) -> Result<Option<Inode>, Error> {
        self.tree(parent)?.lookup(parent, name)
    }
    pub(crate) fn is_root(&self, inode: Inode) -> Result<bool, Error> {
        Ok(self.tree(inode)?.root() == inode)
    }
    pub(crate) fn metadata(&self, inode: Inode) -> Result<Metadata, Error> {
        self.tree(inode)?.metadata(inode)
    }
    pub(crate) fn directory_parent(&self, inode: Inode) -> Result<Option<(Inode, &[u8])>, Error> {
        self.tree(inode)?.directory_parent(inode)
    }
    pub(crate) fn target(&self, inode: Inode) -> Result<&[u8], Error> {
        self.tree(inode)?.target(inode)
    }
    pub(crate) fn source(&mut self, inode: Inode) -> Result<u32, Error> {
        self.tree_mut(inode)?.source(inode)
    }
    pub(crate) fn size(&mut self, inode: Inode) -> Result<usize, Error> {
        self.tree_mut(inode)?.size(inode)
    }
    pub(crate) fn load_begin(&mut self, inode: Inode) -> Result<u32, Error> {
        self.tree_mut(inode)?.load_begin(inode)
    }
    pub(crate) fn load_finish(
        &mut self,
        inode: Inode,
        attempt: u32,
        success: bool,
        bytes: &mut Vec<u8>,
    ) -> Result<(), Error> {
        self.tree_mut(inode)?
            .load_finish(inode, attempt, success, bytes)
    }
    pub(crate) fn read(&mut self, inode: Inode, at: usize, length: usize) -> Result<&[u8], Error> {
        self.tree_mut(inode)?.read(inode, at, length)
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
    #[test]
    fn parent_and_target_route_to_their_storage_without_copying() {
        let mut first = Tree::new(811, 4, 4, 8, root_owned(0o755)).unwrap();
        let aroot = first.root();
        let adir = first.directory(aroot, b"first", root_owned(0o755)).unwrap();
        let alink = first
            .symlink(adir, b"link", b"../first", root_owned(0o777))
            .unwrap();
        let aname = first.directory_parent(adir).unwrap().unwrap().1.as_ptr();
        let atarget = first.target(alink).unwrap().as_ptr();
        let mut second = Tree::new(812, 4, 4, 8, root_owned(0o755)).unwrap();
        let broot = second.root();
        let bdir = second
            .directory(broot, b"second", root_owned(0o755))
            .unwrap();
        let blink = second
            .symlink(bdir, b"link", b"../second", root_owned(0o777))
            .unwrap();
        let bname = second.directory_parent(bdir).unwrap().unwrap().1.as_ptr();
        let btarget = second.target(blink).unwrap().as_ptr();
        let mut fs = Filesystems::new(first, NonZeroUsize::new(2).unwrap());
        assert!(fs.admit(second).is_ok());
        assert_eq!(fs.directory_parent(aroot), Ok(None));
        assert_eq!(fs.directory_parent(broot), Ok(None));
        assert_eq!(fs.directory_parent(adir), Ok(Some((aroot, &b"first"[..]))));
        assert_eq!(fs.directory_parent(bdir), Ok(Some((broot, &b"second"[..]))));
        assert_eq!(
            fs.directory_parent(adir).unwrap().unwrap().1.as_ptr(),
            aname
        );
        assert_eq!(
            fs.directory_parent(bdir).unwrap().unwrap().1.as_ptr(),
            bname
        );
        assert_eq!(fs.target(alink), Ok(&b"../first"[..]));
        assert_eq!(fs.target(blink), Ok(&b"../second"[..]));
        assert_eq!(fs.target(alink).unwrap().as_ptr(), atarget);
        assert_eq!(fs.target(blink).unwrap().as_ptr(), btarget);
        assert_eq!(fs.target(adir), Err(Error::InvalidTarget));
        let foreign = Tree::new(813, 1, 0, 0, root_owned(0o755)).unwrap().root();
        assert_eq!(fs.directory_parent(foreign), Err(Error::UnknownInode));
        assert_eq!(fs.target(foreign), Err(Error::UnknownInode));
    }
}
