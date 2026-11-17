//! Internal file ownership and resident read reservations, not guest syscalls.
//! Trees move into the private filesystem registry and cannot be independently
//! dropped or mutably borrowed. Mount topology is not part of this registry.
//! Sparse tables own slots; descriptions own shared offsets. Inodes remain owned
//! by their filesystem even after the last descriptor closes (no unlink/physical reclamation).
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
//! Slot and pending-read references keep descriptions alive. The read coordinator
//! commits a reserved offset only after stopped copy evidence. Source mutation,
//! lazy reads, mappings and process/image identity remain unconnected. Table tokens
//! are non-Copy owning holder tickets; share creates a new ticket, let_go consumes it.
//! Dropping a ticket without let_go retains its table until Files is dropped; this
//! cannot prematurely retire another holder, but domain cleanup must consume it.
use super::filesystem::{AdmissionError, Filesystems};
use super::inode::{Inode, Tree};
use super::mount::{self, Mounts, Place, Ticket};
use std::collections::HashMap;
use std::num::NonZeroUsize;

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
    Busy,
    Payload,
    Mount(mount::Error),
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
    place: Option<mount::Hold>,
    inode: Inode,
    refs: u64,
    offset: u64,
    revision: u64,
    reading: bool,
}
/// Owned pending reference to one OFD, not an fd number. Only Files resolves it.
#[must_use = "finish or abort the read reservation; dropping retains the OFD reference"]
pub(crate) struct ReadHold {
    description: Id,
    inode: Inode,
    offset: u64,
    length: usize,
    next_revision: u64,
}
impl ReadHold {
    pub(crate) fn length(&self) -> usize {
        self.length
    }
}

pub(crate) struct Files {
    owner: u64,
    filesystems: Filesystems,
    mounts: Option<Mounts>,
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
        Self::with_filesystem_capacity(owner, tree, limits, NonZeroUsize::MIN)
    }
    /// Internal multi-filesystem construction; the bootstrap counts toward capacity.
    pub(crate) fn with_filesystem_capacity(
        owner: u64,
        tree: Tree,
        limits: Limits,
        capacity: NonZeroUsize,
    ) -> Self {
        Self {
            owner,
            filesystems: Filesystems::new(tree, capacity),
            mounts: None,
            limits,
            tables: Vec::new(),
            descriptions: Vec::new(),
            live_slots: 0,
        }
    }
    /// Transfer storage only after admission; failure returns its entire ownership.
    pub(crate) fn admit_tree(&mut self, tree: Tree) -> Result<Inode, (AdmissionError, Tree)> {
        self.filesystems.admit(tree)
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
    /// One bootstrap namespace. Existing bare-inode ABI validation stays separate.
    pub(crate) fn bootstrap_mount(
        &mut self,
        root: Inode,
        limits: mount::Limits,
    ) -> Result<Ticket, Error> {
        if self.mounts.is_some() || self.descriptions.iter().any(|cell| cell.value.is_some()) {
            return Err(Error::Busy);
        }
        if !self
            .filesystems
            .is_root(root)
            .map_err(|_| Error::BadHandle)?
        {
            return Err(Error::BadHandle);
        }
        let (mounts, ticket) = Mounts::new(self.owner, root, limits).map_err(Error::Mount)?;
        self.mounts = Some(mounts);
        Ok(ticket)
    }
    pub(crate) fn view_root(&self, ticket: &Ticket) -> Result<Place, Error> {
        self.mounts
            .as_ref()
            .ok_or(Error::BadHandle)?
            .root(ticket)
            .map_err(Error::Mount)
    }
    pub(crate) fn component(&self, from: &Place, name: &[u8]) -> Result<Option<Place>, Error> {
        let mounts = self.mounts.as_ref().ok_or(Error::BadHandle)?;
        mounts.validate(from).map_err(Error::Mount)?;
        let Some(inode) = self
            .filesystems
            .lookup(from.inode(), name)
            .map_err(|_| Error::BadHandle)?
        else {
            return Ok(None);
        };
        mounts
            .component(from, name, inode)
            .map(Some)
            .map_err(Error::Mount)
    }
    /// Only an admitted filesystem root can introduce a new storage view.
    pub(crate) fn filesystem_view(&mut self, root: Inode) -> Result<Ticket, Error> {
        if !self
            .filesystems
            .is_root(root)
            .map_err(|_| Error::BadHandle)?
        {
            return Err(Error::BadHandle);
        }
        self.mounts
            .as_mut()
            .ok_or(Error::BadHandle)?
            .filesystem_root(root)
            .map_err(Error::Mount)
    }
    pub(crate) fn clone_view(&mut self, source: &Place) -> Result<Ticket, Error> {
        let kind = self
            .filesystems
            .metadata(source.inode())
            .map_err(|_| Error::BadHandle)?
            .mode
            & 0o170000;
        if kind != 0o040000 && kind != 0o100000 {
            return Err(Error::NotSupported);
        }
        self.mounts
            .as_mut()
            .ok_or(Error::BadHandle)?
            .clone_view(source, kind == 0o040000)
            .map_err(Error::Mount)
    }
    pub(crate) fn attach_view(&mut self, ticket: &Ticket, to: &Place) -> Result<(), Error> {
        let kind = self
            .filesystems
            .metadata(to.inode())
            .map_err(|_| Error::BadHandle)?
            .mode
            & 0o170000;
        if kind != 0o040000 && kind != 0o100000 {
            return Err(Error::NotSupported);
        }
        self.mounts
            .as_mut()
            .ok_or(Error::BadHandle)?
            .attach(ticket, to, kind == 0o040000)
            .map_err(Error::Mount)
    }
    pub(crate) fn detach_view(&mut self, place: &Place) -> Result<(), Error> {
        self.mounts
            .as_mut()
            .ok_or(Error::BadHandle)?
            .detach(place)
            .map_err(Error::Mount)
    }
    pub(crate) fn release_view(&mut self, ticket: Ticket) -> Result<(), (Error, Ticket)> {
        let Some(mounts) = self.mounts.as_mut() else {
            return Err((Error::BadHandle, ticket));
        };
        mounts
            .release_ticket(ticket)
            .map_err(|(error, ticket)| (Error::Mount(error), ticket))
    }
    /// Borrowed Place; failure retains both its position and the existing FD table.
    pub(crate) fn open_place(
        &mut self,
        table: &Table,
        place: &Place,
        cloexec: bool,
    ) -> Result<u32, Error> {
        self.open_inner(table, place.inode(), cloexec, Some(place))
    }
    /// Existing sealed-resident private ABI entry, not implicit default-mount open.
    pub(crate) fn open(
        &mut self,
        table: &Table,
        inode: Inode,
        cloexec: bool,
    ) -> Result<u32, Error> {
        if self.mounts.is_some() {
            return Err(Error::NotSupported);
        }
        self.open_inner(table, inode, cloexec, None)
    }
    fn open_inner(
        &mut self,
        table: &Table,
        inode: Inode,
        cloexec: bool,
        place: Option<&Place>,
    ) -> Result<u32, Error> {
        self.state(table)?;
        if let Some(place) = place {
            self.mounts
                .as_ref()
                .ok_or(Error::BadHandle)?
                .validate(place)
                .map_err(Error::Mount)?;
        }
        let mode = self
            .filesystems
            .metadata(inode)
            .map_err(|_| Error::BadHandle)?
            .mode
            & 0o170000;
        if mode != 0o100000 && mode != 0o040000 {
            return Err(Error::NotSupported);
        }
        let fd = self.admit_fd(table, 0)?;
        let id = prepare(&mut self.descriptions, self.limits.descriptions, self.owner)?;
        // Last fallible acquisition; publication below is reserved and callback-free.
        let place = match place {
            Some(place) => Some(
                self.mounts
                    .as_mut()
                    .unwrap()
                    .hold(place)
                    .map_err(Error::Mount)?,
            ),
            None => None,
        };
        publish(
            &mut self.descriptions,
            id,
            Description {
                place,
                inode,
                refs: 1,
                offset: 0,
                revision: 0,
                reading: false,
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
            let description = cell.value.take().unwrap();
            if let Some(place) = description.place {
                self.mounts.as_mut().unwrap().release_hold(place);
            }
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
        if get(&self.descriptions, self.owner, id)?.reading {
            return Err(Error::Busy);
        }
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
    pub(crate) fn reserve_read(
        &mut self,
        table: &Table,
        fd: u32,
        requested: u64,
    ) -> Result<ReadHold, Error> {
        let id = self.description(table, fd)?;
        let d = get(&self.descriptions, self.owner, id)?;
        if d.reading {
            return Err(Error::Busy);
        }
        let inode = d.inode;
        let offset = d.offset;
        let refs = d.refs.checked_add(1).ok_or(Error::Overflow)?;
        let revision = if requested == 0 {
            d.revision
        } else {
            d.revision.checked_add(1).ok_or(Error::Overflow)?
        };
        if self
            .filesystems
            .metadata(inode)
            .map_err(|_| Error::BadHandle)?
            .mode
            & 0o170000
            != 0o100000
        {
            return Err(Error::NotSupported);
        }
        if self.filesystems.source(inode).map_err(|_| Error::Payload)? != 0 {
            return Err(Error::NotSupported);
        }
        let size = self.filesystems.size(inode).map_err(|_| Error::Payload)? as u64;
        let length = if offset >= size {
            0
        } else {
            requested.min(size - offset) as usize
        };
        offset.checked_add(length as u64).ok_or(Error::Overflow)?;
        // No mutation/export is exposed for this sealed resident source.
        let d = self.descriptions[id.slot].value.as_mut().unwrap();
        d.refs = refs;
        d.reading = true;
        Ok(ReadHold {
            description: id,
            inode,
            offset,
            length,
            next_revision: revision,
        })
    }

    pub(crate) fn read_bytes(&mut self, hold: &ReadHold) -> &[u8] {
        // EOF at an arbitrary u64 offset does not narrow that offset to usize.
        let at = if hold.length == 0 {
            0
        } else {
            hold.offset as usize
        };
        self.filesystems
            .read(hold.inode, at, hold.length)
            .expect("pinned resident source")
    }

    /// Infallible after receipt validation: refs, revision and maximal offset
    /// were reserved before any copy; no conflicting offset writer is admitted.
    pub(crate) fn finish_read(&mut self, hold: ReadHold, copied: u64) {
        assert!(copied <= hold.length as u64);
        let d = self.descriptions[hold.description.slot]
            .value
            .as_mut()
            .unwrap();
        assert!(d.reading);
        d.offset = hold.offset + copied;
        d.revision = hold.next_revision;
        d.reading = false;
        self.release(hold.description);
    }

    pub(crate) fn abort_read(&mut self, hold: ReadHold) {
        let d = self.descriptions[hold.description.slot]
            .value
            .as_mut()
            .unwrap();
        assert!(d.reading);
        d.reading = false;
        self.release(hold.description);
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
    fn prepared(owner: u64, bytes: &[u8]) -> (Tree, Inode, *const u8) {
        let mut tree = Tree::new(owner, 4, 4, 32).unwrap();
        let mut payload = bytes.to_vec();
        let pointer = payload.as_ptr();
        let inode = tree
            .file_take(tree.root(), b"same", 0o600, &mut payload)
            .unwrap();
        (tree, inode, pointer)
    }
    #[test]
    fn filesystem_identity_routes_same_number_through_real_read_holds() {
        let (first, a, pa) = prepared(101, b"first");
        let (second, b, pb) = prepared(102, b"second");
        let (third, c, pc) = prepared(103, b"third");
        let mut f = Files::with_filesystem_capacity(
            200,
            first,
            Limits {
                tables: 1,
                descriptions: 4,
                slots: 4,
            },
            NonZeroUsize::new(3).unwrap(),
        );
        let t = f.table(4).unwrap();
        let fa = f.open(&t, a, false).unwrap();
        let ha = f.reserve_read(&t, fa, 32).unwrap();
        assert!(f.admit_tree(second).is_ok());
        let fb = f.open(&t, b, false).unwrap();
        let hb = f.reserve_read(&t, fb, 32).unwrap();
        // Additional registry growth while two descriptions independently retain reads.
        assert!(f.admit_tree(third).is_ok());
        let fc = f.open(&t, c, false).unwrap();
        let hc = f.reserve_read(&t, fc, 32).unwrap();
        f.close(&t, fa).unwrap();
        f.close(&t, fb).unwrap();
        assert_eq!(f.read_bytes(&ha), b"first");
        assert_eq!(f.read_bytes(&ha).as_ptr(), pa);
        assert_eq!(f.read_bytes(&hb), b"second");
        assert_eq!(f.read_bytes(&hb).as_ptr(), pb);
        assert_eq!(f.read_bytes(&hc), b"third");
        assert_eq!(f.read_bytes(&hc).as_ptr(), pc);
        f.finish_read(ha, 5);
        f.abort_read(hb);
        f.finish_read(hc, 3);
        assert_eq!(f.offset(&t, fc), Ok((3, 1)));
        f.let_go(t).unwrap();
    }
    #[test]
    fn registry_rejection_returns_unchanged_payload_and_checks_owner_before_capacity() {
        let (first, original, _) = prepared(111, b"original");
        let mut f = Files::new(
            210,
            first,
            Limits {
                tables: 1,
                descriptions: 2,
                slots: 2,
            },
        );
        let (duplicate, duplicate_inode, pointer) = prepared(111, b"duplicate");
        let mut returned = match f.admit_tree(duplicate) {
            Err((AdmissionError::DuplicateOwner, tree)) => tree,
            _ => panic!("duplicate owner must precede full capacity"),
        };
        assert_eq!(returned.read(duplicate_inode, 0, 32).unwrap(), b"duplicate");
        assert_eq!(
            returned.read(duplicate_inode, 0, 32).unwrap().as_ptr(),
            pointer
        );
        let (extra, extra_inode, extra_pointer) = prepared(112, b"extra");
        let mut returned = match f.admit_tree(extra) {
            Err((AdmissionError::Capacity, tree)) => tree,
            _ => panic!("bootstrap capacity must reject additional storage"),
        };
        assert_eq!(
            returned.read(extra_inode, 0, 32).unwrap().as_ptr(),
            extra_pointer
        );
        let t = f.table(2).unwrap();
        assert_eq!(f.open(&t, extra_inode, false), Err(Error::BadHandle));
        let fd = f.open(&t, original, false).unwrap();
        let hold = f.reserve_read(&t, fd, 32).unwrap();
        assert_eq!(f.read_bytes(&hold), b"original");
        f.abort_read(hold);
        f.let_go(t).unwrap();
    }
    #[test]
    fn registry_checks_inode_range_and_preserves_rejected_pending_source() {
        let (first, _, _) = prepared(121, b"stored");
        let mut f = Files::new(
            220,
            first,
            Limits {
                tables: 1,
                descriptions: 2,
                slots: 2,
            },
        );
        // A malformed same-owner tree cannot supply an in-range proof for an
        // absent inode. Unique owner allocation remains an embedding invariant.
        let (mut malformed, _, _) = prepared(121, b"other");
        let absent = malformed
            .file_take(malformed.root(), b"absent", 0o600, &mut vec![1])
            .unwrap();
        let t = f.table(2).unwrap();
        assert_eq!(f.open(&t, absent, false), Err(Error::BadHandle));
        let mut pending = Tree::new(122, 2, 1, 16).unwrap();
        let lazy = pending
            .lazy_file(pending.root(), b"lazy", 0o600, 9, 4)
            .unwrap();
        let attempt = pending.load_begin(lazy).unwrap();
        let mut pending = match f.admit_tree(pending) {
            Err((AdmissionError::Capacity, tree)) => tree,
            _ => panic!("full registry must return pending storage"),
        };
        assert_eq!(pending.source(lazy), Ok(9));
        let mut bytes = b"load".to_vec();
        pending
            .load_finish(lazy, attempt, true, &mut bytes)
            .unwrap();
        assert!(bytes.is_empty());
        assert_eq!(pending.read(lazy, 0, 16).unwrap(), b"load");
        f.let_go(t).unwrap();
    }
    fn mounted_setup(holds: usize) -> (Files, Ticket, Place) {
        let mut tree = Tree::new(301, 10, 12, 32).unwrap();
        let root = tree.root();
        let src = tree.directory(root, b"src", 0o755).unwrap();
        tree.directory(root, b"dst", 0o755).unwrap();
        tree.directory(root, b"dst2", 0o755).unwrap();
        tree.directory(src, b"child", 0o755).unwrap();
        tree.file_take(src, b"file", 0o600, &mut b"mounted".to_vec())
            .unwrap();
        let mut f = Files::new(
            302,
            tree,
            Limits {
                tables: 3,
                descriptions: 8,
                slots: 16,
            },
        );
        let ticket = f
            .bootstrap_mount(root, mount::Limits { views: 8, holds })
            .unwrap();
        let place = f.view_root(&ticket).unwrap();
        (f, ticket, place)
    }
    #[test]
    fn mount_views_survive_detach_all_fd_close_and_pending_reads() {
        let (mut f, root_ticket, root) = mounted_setup(12);
        let src = f.component(&root, b"src").unwrap().unwrap();
        let dst = f.component(&root, b"dst").unwrap().unwrap();
        let dst2 = f.component(&root, b"dst2").unwrap().unwrap();
        let a = f.clone_view(&src).unwrap();
        let b = f.clone_view(&src).unwrap();
        f.attach_view(&a, &dst).unwrap();
        f.attach_view(&b, &dst2).unwrap();
        let ar = f.component(&root, b"dst").unwrap().unwrap();
        let br = f.component(&root, b"dst2").unwrap().unwrap();
        let ap = f.component(&ar, b"file").unwrap().unwrap();
        let bp = f.component(&br, b"file").unwrap().unwrap();
        assert_eq!(ap.inode(), bp.inode());
        let table = f.table(8).unwrap();
        let af = f.open_place(&table, &ap, false).unwrap();
        let bf = f.open_place(&table, &bp, false).unwrap();
        let alias = f.dup(&table, af, 0, false).unwrap();
        let fork = f.fork(&table).unwrap();
        let read = f.reserve_read(&table, af, 32).unwrap();
        let pointer = f.read_bytes(&read).as_ptr();
        assert!(f.release_view(a).is_ok()); // attachment/description still retain it
        f.detach_view(&ar).unwrap();
        assert!(f.component(&dst, b"file").unwrap().is_none());
        f.close(&table, af).unwrap();
        f.close(&table, alias).unwrap();
        f.let_go(fork).unwrap(); // pending read is the only A description ref
        assert_eq!(f.read_bytes(&read), b"mounted");
        let other = f.reserve_read(&table, bf, 32).unwrap();
        assert_eq!(f.read_bytes(&other).as_ptr(), pointer);
        f.finish_read(read, 3);
        assert_eq!(
            f.open_place(&table, &ap, false),
            Err(Error::Mount(mount::Error::BadPlace))
        );
        f.finish_read(other, 1);
        assert_eq!(f.offset(&table, bf), Ok((1, 1)));
        f.let_go(table).unwrap();
        assert!(f.release_view(b).is_ok());
        f.detach_view(&br).unwrap();
        assert!(f.release_view(root_ticket).is_ok());
    }
    #[test]
    fn mount_admission_and_children_rejections_preserve_topology() {
        let (mut f, root_ticket, root) = mounted_setup(3);
        let src = f.component(&root, b"src").unwrap().unwrap();
        let dst = f.component(&root, b"dst").unwrap().unwrap();
        let a = f.clone_view(&src).unwrap();
        let b = f.clone_view(&src).unwrap();
        let ar = f.view_root(&a).unwrap();
        let br = f.view_root(&b).unwrap();
        f.attach_view(&a, &dst).unwrap();
        assert_eq!(
            f.attach_view(&b, &dst),
            Err(Error::Mount(mount::Error::Attached))
        );
        assert_eq!(
            f.attach_view(&b, &root),
            Err(Error::Mount(mount::Error::Unsupported))
        );
        let table = f.table(8).unwrap();
        assert_eq!(
            f.open_place(&table, &ar, false),
            Err(Error::Mount(mount::Error::Capacity))
        );
        assert_eq!(f.live_slots, 0);
        let child = f.component(&ar, b"child").unwrap().unwrap();
        f.attach_view(&b, &child).unwrap();
        assert!(f.release_view(a).is_ok());
        assert!(f.release_view(b).is_ok());
        assert_eq!(
            f.detach_view(&ar),
            Err(Error::Mount(mount::Error::Unsupported))
        );
        let fd = f.open_place(&table, &ar, false).unwrap();
        f.close(&table, fd).unwrap();
        f.detach_view(&br).unwrap();
        f.detach_view(&ar).unwrap();
        assert_eq!(
            f.open_place(&table, &ar, false),
            Err(Error::Mount(mount::Error::BadPlace))
        );
        f.let_go(table).unwrap();
        assert!(f.release_view(root_ticket).is_ok());
    }
    #[test]
    fn file_bind_covers_a_name_not_every_hardlink_of_the_inode() {
        let mut tree = Tree::new(311, 5, 5, 32).unwrap();
        let root = tree.root();
        tree.file_take(root, b"source", 0o600, &mut b"source".to_vec())
            .unwrap();
        let original = tree
            .file_take(root, b"a", 0o600, &mut b"original".to_vec())
            .unwrap();
        tree.hardlink(root, b"b", original).unwrap();
        let mut f = Files::new(
            312,
            tree,
            Limits {
                tables: 1,
                descriptions: 2,
                slots: 2,
            },
        );
        let ticket = f
            .bootstrap_mount(root, mount::Limits { views: 2, holds: 4 })
            .unwrap();
        let root = f.view_root(&ticket).unwrap();
        let src = f.component(&root, b"source").unwrap().unwrap();
        let at = f.component(&root, b"a").unwrap().unwrap();
        let view = f.clone_view(&src).unwrap();
        f.attach_view(&view, &at).unwrap();
        let a = f.component(&root, b"a").unwrap().unwrap();
        let b = f.component(&root, b"b").unwrap().unwrap();
        assert_eq!(a.inode(), src.inode());
        assert_eq!(b.inode(), original);
        let table = f.table(2).unwrap();
        let fd = f.open_place(&table, &a, false).unwrap();
        let read = f.reserve_read(&table, fd, 32).unwrap();
        assert_eq!(f.read_bytes(&read), b"source");
        f.abort_read(read);
        f.let_go(table).unwrap();
        assert!(f.release_view(view).is_ok());
        f.detach_view(&a).unwrap();
        assert_eq!(f.component(&root, b"a").unwrap().unwrap().inode(), original);
        assert!(f.release_view(ticket).is_ok());
    }
    #[test]
    fn admitted_second_filesystem_root_mounts_without_arbitrary_inode_conversion() {
        let mut first = Tree::new(321, 3, 3, 8).unwrap();
        let root = first.root();
        first.directory(root, b"at", 0o755).unwrap();
        let (second, file, pointer) = prepared(322, b"second");
        let second_root = second.root();
        let mut f = Files::with_filesystem_capacity(
            323,
            first,
            Limits {
                tables: 1,
                descriptions: 2,
                slots: 2,
            },
            NonZeroUsize::new(2).unwrap(),
        );
        let bootstrap = f
            .bootstrap_mount(root, mount::Limits { views: 2, holds: 3 })
            .unwrap();
        assert!(matches!(
            f.filesystem_view(second_root),
            Err(Error::BadHandle)
        ));
        assert!(f.admit_tree(second).is_ok());
        assert!(matches!(f.filesystem_view(file), Err(Error::BadHandle)));
        let ticket = f.filesystem_view(second_root).unwrap();
        assert!(matches!(
            f.filesystem_view(second_root),
            Err(Error::Mount(mount::Error::Capacity))
        ));
        let top = f.view_root(&bootstrap).unwrap();
        let at = f.component(&top, b"at").unwrap().unwrap();
        f.attach_view(&ticket, &at).unwrap();
        let mounted = f.component(&top, b"at").unwrap().unwrap();
        let position = f.component(&mounted, b"same").unwrap().unwrap();
        let table = f.table(2).unwrap();
        let fd = f.open_place(&table, &position, false).unwrap();
        let hold = f.reserve_read(&table, fd, 32).unwrap();
        assert_eq!(f.read_bytes(&hold), b"second");
        assert_eq!(f.read_bytes(&hold).as_ptr(), pointer);
        f.close(&table, fd).unwrap();
        assert!(f.release_view(ticket).is_ok());
        f.detach_view(&mounted).unwrap();
        assert_eq!(f.read_bytes(&hold), b"second");
        f.finish_read(hold, 6);
        assert!(matches!(
            f.open_place(&table, &position, false),
            Err(Error::Mount(mount::Error::BadPlace))
        ));
        f.let_go(table).unwrap();
        assert!(f.release_view(bootstrap).is_ok());
    }
    #[test]
    fn bare_builder_and_mount_open_modes_cannot_mix_even_after_fd_close() {
        let mut tree = Tree::new(331, 2, 1, 8).unwrap();
        let root = tree.root();
        let inode = tree
            .file_take(root, b"file", 0o600, &mut b"body".to_vec())
            .unwrap();
        let mut f = Files::new(
            332,
            tree,
            Limits {
                tables: 1,
                descriptions: 2,
                slots: 2,
            },
        );
        let table = f.table(2).unwrap();
        let fd = f.open(&table, inode, false).unwrap();
        let limits = mount::Limits { views: 1, holds: 2 };
        assert!(matches!(f.bootstrap_mount(root, limits), Err(Error::Busy)));
        let pending = f.reserve_read(&table, fd, 4).unwrap();
        f.close(&table, fd).unwrap();
        assert!(matches!(f.bootstrap_mount(root, limits), Err(Error::Busy)));
        f.abort_read(pending);
        let ticket = f.bootstrap_mount(root, limits).unwrap();
        assert_eq!(f.open(&table, inode, false), Err(Error::NotSupported));
        let top = f.view_root(&ticket).unwrap();
        let file = f.component(&top, b"file").unwrap().unwrap();
        let fd = f.open_place(&table, &file, false).unwrap();
        f.close(&table, fd).unwrap();
        assert_eq!(f.open(&table, inode, false), Err(Error::NotSupported));
        f.let_go(table).unwrap();
        assert!(f.release_view(ticket).is_ok());
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
        assert_eq!(f.filesystems.read(inode, 0, 16).unwrap(), b"body");
    }
}
