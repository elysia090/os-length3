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
    pub(crate) fn metadata(&self, inode: Inode) -> Result<Metadata, Error> {
        self.tree(inode)?.metadata(inode)
    }
    pub(crate) fn source(&mut self, inode: Inode) -> Result<u32, Error> {
        self.tree_mut(inode)?.source(inode)
    }
    pub(crate) fn size(&mut self, inode: Inode) -> Result<usize, Error> {
        self.tree_mut(inode)?.size(inode)
    }
    pub(crate) fn read(&mut self, inode: Inode, at: usize, length: usize) -> Result<&[u8], Error> {
        self.tree_mut(inode)?.read(inode, at, length)
    }
}
