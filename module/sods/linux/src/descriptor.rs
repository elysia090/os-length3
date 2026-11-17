//! Internal file ownership, not guest open/path/mount or read-effect semantics.
//! Tree is moved here and cannot be independently dropped or mutably borrowed.
//! Sparse tables own slots; descriptions own shared offsets. Inodes remain owned
//! by Tree even after the last descriptor closes (no unlink/physical reclamation).
//! No callbacks run inside these operations. The embedding must allocate a unique
//! owner incarnation; reusing it while handles exist is invalid.
//! Fork copies only live slots, but source HashMap iteration scans retained
//! capacity: expected work O(source capacity + live slots), plus arena admission.
//! A temporary count map reserves at most the live-slot count (not just the
//! distinct-description count). Hash maps retain spare capacity separately from
//! the live-slot cap; closing a table drops its map. Arena record counts are
//! capped, but Vec spare capacity/allocation may exceed those counts and remains
//! at its high water. Vacant-slot selection scans record high water. Hashing is
//! not a worst-case complexity guarantee. No per-table FD-limit-sized allocation.
//! Lowest-FD search can scan up to the table limit; no bitmap/index is added.
//! Pending operations are not supported: slot references are the only description
//! holders. No read or offset-after-copy contract is implemented. Table tokens are
//! non-Copy owning holder tickets; share creates a new ticket, let_go consumes it.
//! Dropping a ticket without let_go retains its table until Files is dropped; this
//! cannot prematurely retire another holder, but domain cleanup must consume it.
use super::inode::{Inode, Tree};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct Id {
    owner: u64,
    slot: usize,
    generation: u64,
}
#[must_use = "consume the holder with Files::let_go; dropping retains it until Files is dropped"]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Table(Id);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Error {
    BadHandle,
    BadFd,
    Capacity,
    Overflow,
    NotSupported,
}
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub tables: usize,
    pub descriptions: usize,
    pub slots: usize,
}
struct Cell<T> {
    generation: u64,
    value: Option<T>,
}
#[derive(Clone, Copy)]
struct Slot {
    description: Id,
    cloexec: bool,
}
struct TableState {
    slots: HashMap<u32, Slot>,
    limit: u32,
    holders: u64,
}
struct Description {
    inode: Inode,
    refs: u64,
    offset: u64,
    revision: u64,
}
pub(crate) struct Files {
    owner: u64,
    tree: Tree,
    limits: Limits,
    tables: Vec<Cell<TableState>>,
    descriptions: Vec<Cell<Description>>,
    live_slots: usize,
}
fn prepare<T>(arena: &mut Vec<Cell<T>>, cap: usize, owner: u64) -> Result<Id, Error> {
    for (slot, cell) in arena.iter().enumerate() {
        if cell.value.is_none() && cell.generation < u64::MAX {
            return Ok(Id {
                owner,
                slot,
                generation: cell.generation + 1,
            });
        }
    }
    if arena.len() >= cap {
        return Err(Error::Capacity);
    }
    arena.try_reserve(1).map_err(|_| Error::Capacity)?;
    Ok(Id {
        owner,
        slot: arena.len(),
        generation: 1,
    })
}
fn publish<T>(arena: &mut Vec<Cell<T>>, id: Id, value: T) {
    let cell = Cell {
        generation: id.generation,
        value: Some(value),
    };
    if id.slot == arena.len() {
        arena.push(cell);
    } else {
        arena[id.slot] = cell;
    }
}
fn get<T>(arena: &[Cell<T>], owner: u64, id: Id) -> Result<&T, Error> {
    let cell = arena.get(id.slot).ok_or(Error::BadHandle)?;
    if id.owner != owner || id.generation != cell.generation {
        return Err(Error::BadHandle);
    }
    cell.value.as_ref().ok_or(Error::BadHandle)
}
impl Files {
    pub(crate) fn new(owner: u64, tree: Tree, limits: Limits) -> Self {
        Self {
            owner,
            tree,
            limits,
            tables: Vec::new(),
            descriptions: Vec::new(),
            live_slots: 0,
        }
    }
    pub(crate) fn table(&mut self, limit: u32) -> Result<Table, Error> {
        let id = prepare(&mut self.tables, self.limits.tables, self.owner)?;
        publish(
            &mut self.tables,
            id,
            TableState {
                slots: HashMap::new(),
                limit,
                holders: 1,
            },
        );
        Ok(Table(id))
    }
    fn state(&self, table: &Table) -> Result<&TableState, Error> {
        get(&self.tables, self.owner, table.0)
    }
    fn description(&self, table: &Table, fd: u32) -> Result<Id, Error> {
        Ok(self
            .state(table)?
            .slots
            .get(&fd)
            .ok_or(Error::BadFd)?
            .description)
    }
    fn admit_fd(&mut self, table: &Table, from: u32) -> Result<u32, Error> {
        let state = self.state(table)?;
        let mut fd = from;
        while fd < state.limit && state.slots.contains_key(&fd) {
            fd += 1;
        }
        if fd >= state.limit || self.live_slots >= self.limits.slots {
            return Err(Error::Capacity);
        }
        self.tables[table.0.slot]
            .value
            .as_mut()
            .unwrap()
            .slots
            .try_reserve(1)
            .map_err(|_| Error::Capacity)?;
        Ok(fd)
    }
    pub(crate) fn open(
        &mut self,
        table: &Table,
        inode: Inode,
        cloexec: bool,
    ) -> Result<u32, Error> {
        self.state(table)?;
        let mode = self
            .tree
            .metadata(inode)
            .map_err(|_| Error::BadHandle)?
            .mode
            & 0o170000;
        if mode != 0o100000 && mode != 0o040000 {
            return Err(Error::NotSupported);
        }
        let fd = self.admit_fd(table, 0)?;
        let id = prepare(&mut self.descriptions, self.limits.descriptions, self.owner)?;
        publish(
            &mut self.descriptions,
            id,
            Description {
                inode,
                refs: 1,
                offset: 0,
                revision: 0,
            },
        );
        self.tables[table.0.slot]
            .value
            .as_mut()
            .unwrap()
            .slots
            .insert(
                fd,
                Slot {
                    description: id,
                    cloexec,
                },
            );
        self.live_slots += 1;
        Ok(fd)
    }
    pub(crate) fn dup(
        &mut self,
        table: &Table,
        fd: u32,
        from: u32,
        cloexec: bool,
    ) -> Result<u32, Error> {
        let id = self.description(table, fd)?;
        let refs = get(&self.descriptions, self.owner, id)?
            .refs
            .checked_add(1)
            .ok_or(Error::Overflow)?;
        let to = self.admit_fd(table, from)?;
        self.tables[table.0.slot]
            .value
            .as_mut()
            .unwrap()
            .slots
            .insert(
                to,
                Slot {
                    description: id,
                    cloexec,
                },
            );
        self.descriptions[id.slot].value.as_mut().unwrap().refs = refs;
        self.live_slots += 1;
        Ok(to)
    }
    pub(crate) fn fork(&mut self, table: &Table) -> Result<Table, Error> {
        let state = self.state(table)?;
        let total = self
            .live_slots
            .checked_add(state.slots.len())
            .ok_or(Error::Capacity)?;
        if total > self.limits.slots {
            return Err(Error::Capacity);
        }
        let mut slots = HashMap::new();
        let mut counts: HashMap<Id, u64> = HashMap::new();
        slots
            .try_reserve(state.slots.len())
            .map_err(|_| Error::Capacity)?;
        counts
            .try_reserve(state.slots.len())
            .map_err(|_| Error::Capacity)?;
        for (&fd, &slot) in &state.slots {
            slots.insert(fd, slot);
            let count = counts.entry(slot.description).or_default();
            *count = count.checked_add(1).ok_or(Error::Overflow)?;
        }
        for (&id, &count) in &counts {
            get(&self.descriptions, self.owner, id)?
                .refs
                .checked_add(count)
                .ok_or(Error::Overflow)?;
        }
        let limit = state.limit;
        let id = prepare(&mut self.tables, self.limits.tables, self.owner)?;
        for (description, count) in counts {
            self.descriptions[description.slot]
                .value
                .as_mut()
                .unwrap()
                .refs += count;
        }
        publish(
            &mut self.tables,
            id,
            TableState {
                slots,
                limit,
                holders: 1,
            },
        );
        self.live_slots = total;
        Ok(Table(id))
    }
    /// Internal holder accounting; each successful share requires one let_go.
    pub(crate) fn share(&mut self, table: &Table) -> Result<Table, Error> {
        let holders = self
            .state(table)?
            .holders
            .checked_add(1)
            .ok_or(Error::Overflow)?;
        self.tables[table.0.slot].value.as_mut().unwrap().holders = holders;
        Ok(Table(table.0))
    }
    fn release(&mut self, id: Id) {
        let cell = &mut self.descriptions[id.slot];
        let description = cell.value.as_mut().unwrap();
        description.refs -= 1;
        if description.refs == 0 {
            cell.value = None;
        }
    }
    pub(crate) fn close(&mut self, table: &Table, fd: u32) -> Result<(), Error> {
        let id = self.description(table, fd)?;
        self.tables[table.0.slot]
            .value
            .as_mut()
            .unwrap()
            .slots
            .remove(&fd);
        self.live_slots -= 1;
        self.release(id);
        Ok(())
    }
    pub(crate) fn let_go(&mut self, table: Table) -> Result<(), Error> {
        let holders = self.state(&table)?.holders;
        if holders > 1 {
            self.tables[table.0.slot].value.as_mut().unwrap().holders -= 1;
            return Ok(());
        }
        let state = self.tables[table.0.slot].value.take().unwrap();
        self.live_slots -= state.slots.len();
        for slot in state.slots.into_values() {
            self.release(slot.description);
        }
        Ok(())
    }
    pub(crate) fn offset(&self, table: &Table, fd: u32) -> Result<(u64, u64), Error> {
        let d = get(&self.descriptions, self.owner, self.description(table, fd)?)?;
        Ok((d.offset, d.revision))
    }
    pub(crate) fn set_offset(&mut self, table: &Table, fd: u32, offset: u64) -> Result<(), Error> {
        let id = self.description(table, fd)?;
        let revision = get(&self.descriptions, self.owner, id)?
            .revision
            .checked_add(1)
            .ok_or(Error::Overflow)?;
        let d = self.descriptions[id.slot].value.as_mut().unwrap();
        d.offset = offset;
        d.revision = revision;
        Ok(())
    }
    pub(crate) fn inode(&self, table: &Table, fd: u32) -> Result<Inode, Error> {
        Ok(get(&self.descriptions, self.owner, self.description(table, fd)?)?.inode)
    }
    pub(crate) fn cloexec(&self, table: &Table, fd: u32) -> Result<bool, Error> {
        Ok(self
            .state(table)?
            .slots
            .get(&fd)
            .ok_or(Error::BadFd)?
            .cloexec)
    }
    pub(crate) fn set_cloexec(&mut self, table: &Table, fd: u32, value: bool) -> Result<(), Error> {
        self.description(table, fd)?;
        self.tables[table.0.slot]
            .value
            .as_mut()
            .unwrap()
            .slots
            .get_mut(&fd)
            .unwrap()
            .cloexec = value;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup(slots: usize) -> (Files, Inode) {
        let mut tree = Tree::new(91, 4, 4, 16).unwrap();
        let file = tree
            .file_take(tree.root(), b"f", 0o600, &mut b"body".to_vec())
            .unwrap();
        (
            Files::new(
                92,
                tree,
                Limits {
                    tables: 4,
                    descriptions: 4,
                    slots,
                },
            ),
            file,
        )
    }
    #[test]
    fn separate_opens_and_shared_descriptions_have_distinct_semantics() {
        let (mut f, inode) = setup(16);
        let t = f.table(8).unwrap();
        let a = f.open(&t, inode, false).unwrap();
        let b = f.open(&t, inode, false).unwrap();
        let alias = f.dup(&t, a, 0, true).unwrap();
        f.set_offset(&t, a, 7).unwrap();
        assert_eq!(f.offset(&t, alias), Ok((7, 1)));
        assert_eq!(f.offset(&t, b), Ok((0, 0)));
        f.set_offset(&t, alias, 0).unwrap();
        assert_eq!(f.offset(&t, a), Ok((0, 2))); // ABA retains evidence.
        assert_eq!(f.cloexec(&t, alias), Ok(true));
        assert_eq!(f.cloexec(&t, a), Ok(false));
        f.set_cloexec(&t, alias, false).unwrap();
        let child = f.fork(&t).unwrap();
        f.set_offset(&child, a, 9).unwrap();
        assert_eq!(f.offset(&t, alias), Ok((9, 3)));
        f.close(&t, a).unwrap();
        assert_eq!(f.inode(&child, a), Ok(inode));
        let shared = f.share(&child).unwrap();
        f.close(&shared, a).unwrap();
        assert_eq!(f.inode(&child, a), Err(Error::BadFd));
        f.let_go(shared).unwrap();
        assert_eq!(f.inode(&child, alias), Ok(inode));
        f.let_go(child).unwrap();
        f.let_go(t).unwrap();
        assert_eq!(f.live_slots, 0);
        assert!(f.descriptions.iter().all(|c| c.value.is_none()));
    }
    #[test]
    fn fork_preflights_capacity_and_aggregate_reference_overflow() {
        let (mut f, inode) = setup(3);
        let t = f.table(8).unwrap();
        let a = f.open(&t, inode, true).unwrap();
        f.dup(&t, a, 0, false).unwrap();
        let id = f.description(&t, a).unwrap();
        assert_eq!(f.fork(&t), Err(Error::Capacity));
        assert_eq!(f.live_slots, 2);
        assert_eq!(get(&f.descriptions, f.owner, id).unwrap().refs, 2);
        f.limits.slots = 8;
        f.descriptions[id.slot].value.as_mut().unwrap().refs = u64::MAX - 1;
        assert_eq!(f.fork(&t), Err(Error::Overflow)); // two aliases, not just +1
        assert_eq!(
            get(&f.descriptions, f.owner, id).unwrap().refs,
            u64::MAX - 1
        );
        assert_eq!(f.live_slots, 2);
        assert_eq!(f.tables.len(), 1);
        f.descriptions[id.slot].value.as_mut().unwrap().refs = 2;
        f.let_go(t).unwrap();
    }
    #[test]
    fn stale_foreign_and_exhausted_generations_do_not_alias() {
        let (mut f, inode) = setup(8);
        let t = f.table(8).unwrap();
        let a = f.open(&t, inode, false).unwrap();
        let old = f.description(&t, a).unwrap();
        f.close(&t, a).unwrap();
        assert_eq!(f.open(&t, inode, false), Ok(a));
        assert!(matches!(
            get(&f.descriptions, f.owner, old),
            Err(Error::BadHandle)
        ));
        let stale_id = t.0;
        f.let_go(t).unwrap();
        let stale = Table(stale_id);
        let fresh = f.table(8).unwrap();
        assert_eq!(f.open(&stale, inode, false), Err(Error::BadHandle));
        let foreign = Table(Id {
            owner: 777,
            ..fresh.0
        });
        assert_eq!(f.share(&foreign), Err(Error::BadHandle));
        f.let_go(fresh).unwrap();
        f.tables[0].generation = u64::MAX;
        f.limits.tables = 1;
        assert_eq!(f.table(8), Err(Error::Capacity));
        assert_eq!(f.tables[0].generation, u64::MAX);
    }
    #[test]
    fn admission_and_revision_failures_preserve_existing_slots() {
        let (mut f, inode) = setup(8);
        let t = f.table(1).unwrap();
        let fd = f.open(&t, inode, false).unwrap();
        assert_eq!(f.open(&t, inode, true), Err(Error::Capacity));
        assert_eq!(f.dup(&t, fd, 1, true), Err(Error::Capacity));
        assert_eq!(f.live_slots, 1);
        let id = f.description(&t, fd).unwrap();
        f.descriptions[id.slot].value.as_mut().unwrap().revision = u64::MAX;
        assert_eq!(f.set_offset(&t, fd, 42), Err(Error::Overflow));
        assert_eq!(f.offset(&t, fd), Ok((0, u64::MAX)));
        f.tables[t.0.slot].value.as_mut().unwrap().holders = u64::MAX;
        assert_eq!(f.share(&t), Err(Error::Overflow));
        f.tables[t.0.slot].value.as_mut().unwrap().holders = 1;
        f.let_go(t).unwrap();
    }
    #[test]
    fn kinds_foreign_inodes_and_description_exhaustion_are_checked() {
        let mut tree = Tree::new(41, 4, 4, 8).unwrap();
        let root = tree.root();
        let link = tree.symlink(root, b"link", b"target").unwrap();
        let foreign = Tree::new(42, 1, 0, 0).unwrap().root();
        let mut f = Files::new(
            43,
            tree,
            Limits {
                tables: 1,
                descriptions: 1,
                slots: 8,
            },
        );
        let t = f.table(8).unwrap();
        assert_eq!(f.open(&t, foreign, false), Err(Error::BadHandle));
        assert_eq!(f.open(&t, link, false), Err(Error::NotSupported));
        let fd = f.open(&t, root, false).unwrap();
        assert_eq!(f.open(&t, root, false), Err(Error::Capacity));
        let id = f.description(&t, fd).unwrap();
        f.descriptions[id.slot].value.as_mut().unwrap().refs = u64::MAX;
        assert_eq!(f.dup(&t, fd, 0, false), Err(Error::Overflow));
        assert_eq!(f.live_slots, 1);
        f.descriptions[id.slot].value.as_mut().unwrap().refs = 1;
        assert_eq!(f.fork(&t), Err(Error::Capacity));
        assert_eq!(get(&f.descriptions, f.owner, id).unwrap().refs, 1);
        f.close(&t, fd).unwrap();
        f.descriptions[id.slot].generation = u64::MAX;
        assert_eq!(f.open(&t, root, false), Err(Error::Capacity));
        assert_eq!(f.live_slots, 0);
    }
    #[test]
    fn repeated_close_reuses_bounded_arena_and_keeps_tree_owned() {
        let (mut f, inode) = setup(1);
        f.limits.tables = 1;
        f.limits.descriptions = 1;
        for _ in 0..1000 {
            let t = f.table(1).unwrap();
            let fd = f.open(&t, inode, false).unwrap();
            assert_eq!(f.inode(&t, fd), Ok(inode));
            f.let_go(t).unwrap();
        }
        assert_eq!(f.tables.len(), 1);
        assert_eq!(f.descriptions.len(), 1);
        assert_eq!(f.tree.read(inode, 0, 16).unwrap(), b"body");
    }
}
