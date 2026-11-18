//! Private coarse source retention and finite prefix publication. Not a guest
//! pipe, an execution/cancellation gate, or an external output/drain adapter.
use super::{Error as FilesError, Files, ReadHold, ReadPrefix, Table};
use std::num::NonZeroUsize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Error {
    Source(FilesError),
    Capacity,
    Full,
    Overflow,
    Closed,
    BadPin,
    BadReservation,
    Length,
    ReceiverNotEmpty,
    ReceiverCapacity,
}
impl From<FilesError> for Error {
    fn from(error: FilesError) -> Self {
        Self::Source(error)
    }
}

pub(super) struct Limits {
    pub pins: usize,
    pub entries: usize,
    pub bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Key {
    index: usize,
    generation: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ticket {
    owner: u64,
    key: Key,
}
#[derive(Debug)]
#[must_use = "release the pin with its owner or move it into one publication"]
pub(super) struct Pin(Ticket);
#[derive(Debug)]
#[must_use = "cancel the reservation with its owner or consume it in one publication"]
pub(super) struct Reservation(Ticket);

pub(super) struct Rejected {
    pub error: Error,
    pub reservation: Reservation,
    pub pin: Pin,
    pub source: ReadHold,
}
impl std::fmt::Debug for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Rejected")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

struct Cell<T> {
    generation: u64,
    state: State<T>,
}
enum State<T> {
    Live(T),
    Free(Option<usize>),
    Retired,
}
struct Arena<T> {
    cells: Vec<Cell<T>>,
    free: Option<usize>,
    limit: usize,
}
impl<T> Arena<T> {
    fn new(limit: usize) -> Result<Self, Error> {
        let mut cells = Vec::new();
        cells
            .try_reserve_exact(limit)
            .map_err(|_| Error::Capacity)?;
        Ok(Self {
            cells,
            free: None,
            limit,
        })
    }
    fn add(&mut self, value: T) -> Option<Key> {
        if let Some(index) = self.free {
            let cell = &mut self.cells[index];
            let State::Free(next) = cell.state else {
                unreachable!("free arena index")
            };
            let generation = cell.generation.checked_add(1).expect("free generation");
            self.free = next;
            *cell = Cell {
                generation,
                state: State::Live(value),
            };
            return Some(Key { index, generation });
        }
        let index = self.cells.len();
        if index == self.limit {
            return None;
        }
        // new reserves the entire record limit, without initializing spare slots.
        self.cells.push(Cell {
            generation: 1,
            state: State::Live(value),
        });
        Some(Key {
            index,
            generation: 1,
        })
    }
    fn get(&self, key: Key) -> Option<&T> {
        let cell = self.cells.get(key.index)?;
        match &cell.state {
            State::Live(value) if cell.generation == key.generation => Some(value),
            _ => None,
        }
    }
    // Internal links cannot outlive their live cells. Call only after checked
    // external handle admission or following a link owned by this arena user.
    fn live_mut(&mut self, index: usize) -> &mut T {
        let State::Live(value) = &mut self.cells[index].state else {
            unreachable!("live arena index")
        };
        value
    }
    fn remove(&mut self, index: usize) {
        let cell = &mut self.cells[index];
        assert!(matches!(cell.state, State::Live(_)));
        if cell.generation == u64::MAX {
            cell.state = State::Retired;
        } else {
            cell.state = State::Free(self.free);
            self.free = Some(index);
        }
    }
}

struct Range {
    prefix: ReadPrefix,
    queued: bool,
}
enum Entry {
    Reserved(NonZeroUsize),
    Queued { pin: Pin, next: Option<usize> },
}
struct Head<'a> {
    index: usize,
    pin: usize,
    next: Option<usize>,
    prefix: &'a ReadPrefix,
}
struct Removal {
    index: usize,
    pin: usize,
    next: Option<usize>,
    remaining: usize,
}
impl Head<'_> {
    fn removal(&self, used: usize) -> Removal {
        Removal {
            index: self.index,
            pin: self.pin,
            next: self.next,
            remaining: used
                .checked_sub(self.prefix.length.get())
                .expect("queued byte credit"),
        }
    }
}

/// Coarse ownership: Files is moved in and cannot be taken back or replaced.
/// No pin owns an OFD or a pointer. A live borrowed slice prevents concurrent
/// discard or owner destruction. Leaked tickets retain finite credits, not an
/// extra host-visible lifetime. The entire destination must stay reachable for
/// as long as accepted data is needed.
pub(super) struct Owner {
    files: Files,
    pins: Arena<Range>,
    entries: Arena<Entry>,
    head: Option<usize>,
    tail: Option<usize>,
    byte_limit: usize,
    used: usize,
    closed: bool,
}
impl Owner {
    pub(super) fn new(files: Files, limits: Limits) -> Result<Self, (Error, Files)> {
        let storage = (|| Ok((Arena::new(limits.pins)?, Arena::new(limits.entries)?)))();
        let (pins, entries) = match storage {
            Ok(storage) => storage,
            Err(error) => return Err((error, files)),
        };
        Ok(Self {
            files,
            pins,
            entries,
            head: None,
            tail: None,
            byte_limit: limits.bytes,
            used: 0,
            closed: false,
        })
    }
    pub(super) fn begin_resident(
        &mut self,
        table: &Table,
        fd: u32,
        requested: u64,
    ) -> Result<ReadHold, Error> {
        Ok(self.files.reserve_read(table, fd, requested)?)
    }
    pub(super) fn abort_source(&mut self, source: ReadHold) -> Result<(), (Error, ReadHold)> {
        if let Err(error) = self.files.check_read_hold(&source) {
            return Err((error.into(), source));
        }
        self.files.abort_read(source);
        Ok(())
    }
    pub(super) fn pin_prefix(
        &mut self,
        source: &ReadHold,
        length: NonZeroUsize,
    ) -> Result<Pin, Error> {
        let prefix = self.files.read_prefix(source, length)?;
        let key = self
            .pins
            .add(Range {
                prefix,
                queued: false,
            })
            .ok_or(Error::Capacity)?;
        Ok(Pin(Ticket {
            owner: self.files.owner(),
            key,
        }))
    }
    pub(super) fn release(&mut self, pin: Pin) -> Result<(), (Error, Pin)> {
        if pin.0.owner != self.files.owner() || !self.pins.get(pin.0.key).is_some_and(|p| !p.queued)
        {
            return Err((Error::BadPin, pin));
        }
        self.pins.remove(pin.0.key.index);
        Ok(())
    }
    pub(super) fn reserve(&mut self, length: NonZeroUsize) -> Result<Reservation, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        let used = self.used.checked_add(length.get()).ok_or(Error::Overflow)?;
        if used > self.byte_limit {
            return Err(Error::Full);
        }
        let key = self
            .entries
            .add(Entry::Reserved(length))
            .ok_or(Error::Full)?;
        self.used = used;
        Ok(Reservation(Ticket {
            owner: self.files.owner(),
            key,
        }))
    }
    fn reserved(&self, r: &Reservation) -> Result<NonZeroUsize, Error> {
        if r.0.owner == self.files.owner() {
            if let Some(Entry::Reserved(length)) = self.entries.get(r.0.key) {
                return Ok(*length);
            }
        }
        Err(Error::BadReservation)
    }
    pub(super) fn cancel(&mut self, reservation: Reservation) -> Result<(), (Error, Reservation)> {
        let length = match self.reserved(&reservation) {
            Ok(length) => length,
            Err(error) => return Err((error, reservation)),
        };
        self.used = self
            .used
            .checked_sub(length.get())
            .expect("reserved byte credit");
        self.entries.remove(reservation.0.key.index);
        Ok(())
    }
    fn publish_length(&self, reservation: &Reservation, pin: &Pin) -> Result<NonZeroUsize, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        let length = self.reserved(reservation)?;
        if pin.0.owner != self.files.owner() {
            return Err(Error::BadPin);
        }
        let range = self
            .pins
            .get(pin.0.key)
            .filter(|p| !p.queued)
            .ok_or(Error::BadPin)?;
        if range.prefix.length != length {
            return Err(Error::Length);
        }
        Ok(length)
    }
    /// An outer coordinator must exclude cancelled/lost guest calls before this
    /// transition. All errors return the source and both tickets unchanged.
    pub(super) fn publish(
        &mut self,
        reservation: Reservation,
        pin: Pin,
        source: ReadHold,
    ) -> Result<NonZeroUsize, Rejected> {
        let length = match self.publish_length(&reservation, &pin) {
            Ok(length) => length,
            Err(error) => {
                return Err(Rejected {
                    error,
                    reservation,
                    pin,
                    source,
                })
            }
        };
        let range = self.pins.live_mut(pin.0.key.index);
        let commit = match self.files.prepare_prefix_commit(source, &range.prefix) {
            Ok(commit) => commit,
            Err((error, source)) => {
                return Err(Rejected {
                    error: error.into(),
                    reservation,
                    pin,
                    source,
                })
            }
        };
        // No allocation, optional admission, callbacks, or external effects
        // here. FIFO links follow acceptance order, not reservation order.
        let index = reservation.0.key.index;
        range.queued = true;
        *self.entries.live_mut(index) = Entry::Queued { pin, next: None };
        if let Some(tail) = self.tail {
            let Entry::Queued { next, .. } = self.entries.live_mut(tail) else {
                unreachable!("queued tail")
            };
            *next = Some(index);
        } else {
            self.head = Some(index);
        }
        self.tail = Some(index);
        commit.commit();
        Ok(length)
    }
    fn head<'a>(
        index: Option<usize>,
        entries: &Arena<Entry>,
        pins: &'a Arena<Range>,
    ) -> Option<Head<'a>> {
        let index = index?;
        let State::Live(Entry::Queued { pin, next }) = &entries.cells[index].state else {
            unreachable!("queued head")
        };
        let range = pins.get(pin.0.key).expect("queued pin");
        assert!(range.queued);
        Some(Head {
            index,
            pin: pin.0.key.index,
            next: *next,
            prefix: &range.prefix,
        })
    }
    pub(super) fn front_bytes(&mut self) -> Result<Option<&[u8]>, Error> {
        let Some(head) = Self::head(self.head, &self.entries, &self.pins) else {
            return Ok(None);
        };
        Ok(Some(self.files.prefix_bytes(head.prefix)?))
    }
    fn remove_head(&mut self, removal: Removal) {
        self.used = removal.remaining;
        self.head = removal.next;
        if self.head.is_none() {
            self.tail = None;
        }
        self.pins.remove(removal.pin);
        self.entries.remove(removal.index);
    }
    /// Transfer one entire head to separate caller-owned Rust storage. The
    /// receiver must already have room; no allocation or zeroing pass here.
    /// Failure holds both sides unchanged. Empty is not EOF or a flush receipt.
    /// No view escapes and no external delivery or stopped-access is implied.
    pub(super) fn take_front_into(
        &mut self,
        receiver: &mut Vec<u8>,
        logical_limit: usize,
    ) -> Result<Option<NonZeroUsize>, Error> {
        let Some(head) = Self::head(self.head, &self.entries, &self.pins) else {
            return Ok(None);
        };
        if !receiver.is_empty() {
            return Err(Error::ReceiverNotEmpty);
        }
        let length = head.prefix.length;
        if length.get() > logical_limit || length.get() > receiver.capacity() {
            return Err(Error::ReceiverCapacity);
        }
        let removal = head.removal(self.used);
        let bytes = self.files.prefix_bytes(head.prefix)?;
        receiver.extend_from_slice(bytes);
        self.remove_head(removal);
        Ok(Some(length))
    }
    /// Internal discard, not consumer delivery or stopped external access.
    pub(super) fn discard_front(&mut self) -> bool {
        let Some(head) = Self::head(self.head, &self.entries, &self.pins) else {
            return false;
        };
        self.remove_head(head.removal(self.used));
        true
    }
    /// Admission closure does not erase accepted data or cancel pending tickets.
    pub(super) fn close_admission(&mut self) {
        self.closed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::descriptor::Limits as FilesLimits;
    use crate::inode::{Creation, Inode, Tree};

    fn n(length: usize) -> NonZeroUsize {
        NonZeroUsize::new(length).unwrap()
    }
    fn made(mode: u32) -> Creation {
        Creation {
            mode,
            uid: 0,
            gid: 0,
        }
    }
    fn files(owner: u64) -> (Files, Inode, Inode, Table, u32) {
        let mut tree = Tree::new(owner - 1, 8, 8, 32, made(0o755)).unwrap();
        let root = tree.root();
        let file = tree
            .file_take(root, b"body", made(0o600), &mut b"body".to_vec())
            .unwrap();
        let mut files = Files::new(
            owner,
            tree,
            FilesLimits {
                contexts: 4,
                tables: 4,
                descriptions: 8,
                slots: 8,
            },
        );
        let table = files.table(8).unwrap();
        let fd = files.open(&table, file, false).unwrap();
        (files, root, file, table, fd)
    }
    fn owner(incarnation: u64, bytes: usize, entries: usize, pins: usize) -> (Owner, Table, u32) {
        let (files, _, _, table, fd) = files(incarnation);
        (
            Owner::new(
                files,
                Limits {
                    bytes,
                    entries,
                    pins,
                },
            )
            .ok()
            .unwrap(),
            table,
            fd,
        )
    }
    fn settle(owner: &mut Owner, rejected: Rejected) {
        owner.abort_source(rejected.source).ok().unwrap();
        owner.release(rejected.pin).unwrap();
        owner.cancel(rejected.reservation).unwrap();
    }

    #[test]
    fn publish_advances_the_captured_ofd_once_and_bytes_outlive_its_table_and_context() {
        let (mut files, root, _, table, original) = files(502);
        files.close(&table, original).unwrap();
        let view = files
            .bootstrap_mount(
                root,
                crate::mount::Limits { views: 4, holds: 8 },
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
            .unwrap();
        let at = files.view_root(&view).unwrap();
        let fs = files.create_fs(&at, &at, 0o022).unwrap();
        let place = files.component(&at, b"body").unwrap().unwrap();
        let fd = files.open_place(&table, &place, false).unwrap();
        assert_eq!(fd, original);
        let alias = files.dup(&table, fd, 0, false).unwrap();
        assert_eq!(files.set_offset(&table, fd, 1), Ok(()));
        let mut out = Owner::new(
            files,
            Limits {
                bytes: 2,
                entries: 1,
                pins: 1,
            },
        )
        .ok()
        .unwrap();
        let source = out.begin_resident(&table, fd, 3).unwrap();
        let address = out.files.read_bytes(&source).as_ptr();
        let pin = out.pin_prefix(&source, n(2)).unwrap();
        let r = out.reserve(n(2)).unwrap();
        assert_eq!(out.front_bytes(), Ok(None));
        assert_eq!(out.files.offset(&table, alias), Ok((1, 1)));
        out.files.close(&table, fd).unwrap();
        assert_eq!(out.files.open_place(&table, &place, false), Ok(fd));
        assert_eq!(out.publish(r, pin, source).unwrap(), n(2));
        assert_eq!(out.files.offset(&table, fd), Ok((0, 0)));
        assert_eq!(out.files.offset(&table, alias), Ok((3, 2)));
        out.files.set_offset(&table, alias, 0).unwrap();
        out.files.let_go(table).unwrap();
        out.files.release_fs(fs).unwrap();
        out.files.release_view(view).ok().unwrap();
        let resident = out.front_bytes().unwrap().unwrap();
        assert_eq!(resident, b"od");
        assert_eq!(resident.as_ptr(), address, "queue did not copy the backing");
        assert!(out.discard_front());
        assert!(!out.discard_front());
        assert_eq!(out.used, 0);
    }

    #[test]
    fn publishing_retires_the_last_read_ref_and_detached_view_without_retiring_bytes() {
        let (mut files, root, _, table, original) = files(502);
        files.close(&table, original).unwrap();
        let root_ticket = files
            .bootstrap_mount(
                root,
                crate::mount::Limits { views: 4, holds: 8 },
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
            .unwrap();
        let root = files.view_root(&root_ticket).unwrap();
        let place = files.component(&root, b"body").unwrap().unwrap();
        let detached = files.clone_view(&place).unwrap();
        let old_place = files.view_root(&detached).unwrap();
        let fd = files.open_place(&table, &old_place, false).unwrap();
        files.release_view(detached).ok().unwrap();
        let mut out = Owner::new(
            files,
            Limits {
                bytes: 2,
                entries: 1,
                pins: 1,
            },
        )
        .ok()
        .unwrap();
        let source = out.begin_resident(&table, fd, 2).unwrap();
        let pin = out.pin_prefix(&source, n(2)).unwrap();
        let r = out.reserve(n(2)).unwrap();
        out.files.close(&table, fd).unwrap();
        let metadata = out.files.place_metadata(&old_place).unwrap();
        assert_eq!(metadata.nlink, 1);
        assert_eq!(out.publish(r, pin, source).unwrap(), n(2));
        assert_eq!(
            out.files.place_metadata(&old_place),
            Err(FilesError::Mount(crate::mount::Error::BadPlace)),
        );
        out.files.let_go(table).unwrap();
        out.files.release_view(root_ticket).ok().unwrap();
        assert_eq!(out.front_bytes(), Ok(Some(&b"bo"[..])));
        assert!(out.discard_front());
    }

    #[test]
    fn publication_order_is_not_reservation_order_and_reused_slots_do_not_retarget() {
        let (mut out, table, fd) = owner(502, 3, 3, 3);
        let first_reserved = out.reserve(n(1)).unwrap();
        let second_reserved = out.reserve(n(1)).unwrap();
        let third_reserved = out.reserve(n(1)).unwrap();
        let stale = second_reserved.0;
        for (i, reservation) in [second_reserved, first_reserved, third_reserved]
            .into_iter()
            .enumerate()
        {
            let source = out.begin_resident(&table, fd, 1).unwrap();
            let pin = out.pin_prefix(&source, n(1)).unwrap();
            out.publish(reservation, pin, source).unwrap();
            assert_eq!(out.front_bytes(), Ok(Some(&b"b"[..])));
            assert_eq!(out.files.offset(&table, fd).unwrap().0, i as u64 + 1);
        }
        assert!(out.discard_front());
        let reused = out.reserve(n(1)).unwrap();
        assert_eq!(reused.0.key.index, stale.key.index);
        assert_ne!(reused.0.key.generation, stale.key.generation);
        assert_eq!(
            out.cancel(Reservation(stale)).unwrap_err().0,
            Error::BadReservation
        );
        let source = out.begin_resident(&table, fd, 1).unwrap();
        let pin = out.pin_prefix(&source, n(1)).unwrap();
        out.publish(reused, pin, source).unwrap();
        for bytes in [b"o", b"d", b"y"] {
            assert_eq!(out.front_bytes(), Ok(Some(&bytes[..])));
            assert!(out.discard_front());
        }
        assert_eq!(out.front_bytes(), Ok(None));
        assert_eq!(out.used, 0);
        assert_eq!(out.files.offset(&table, fd), Ok((4, 4)));
    }

    #[test]
    fn q_k_and_r_are_independent_and_precommit_failures_preserve_credits() {
        // K full despite byte room, and cancellation returns its exact credits.
        let (mut out, table, fd) = owner(502, 9, 1, 1);
        let r = out.reserve(n(2)).unwrap();
        assert_eq!(out.reserve(n(1)).unwrap_err(), Error::Full);
        let source = out.begin_resident(&table, fd, 4).unwrap();
        let pin = out.pin_prefix(&source, n(1)).unwrap();
        assert_eq!(out.pin_prefix(&source, n(1)).unwrap_err(), Error::Capacity);
        let pin_id = pin.0;
        let rejected = out.publish(r, pin, source).unwrap_err();
        assert_eq!(rejected.error, Error::Length);
        assert_eq!(out.used, 2);
        assert_eq!(out.front_bytes(), Ok(None));
        assert_eq!(out.files.offset(&table, fd), Ok((0, 0)));
        settle(&mut out, rejected);
        let source = out.begin_resident(&table, fd, 4).unwrap();
        let pin = out.pin_prefix(&source, n(1)).unwrap();
        assert_eq!(pin.0.key.index, pin_id.key.index);
        assert_eq!(out.release(Pin(pin_id)).unwrap_err().0, Error::BadPin);
        out.release(pin).unwrap();
        out.abort_source(source).ok().unwrap();
        assert_eq!(out.used, 0);
        // Q full despite spare K records; an accepted entry still charges Q.
        let (mut out, table, fd) = owner(504, 2, 2, 1);
        let r = out.reserve(n(2)).unwrap();
        let source = out.begin_resident(&table, fd, 2).unwrap();
        let pin = out.pin_prefix(&source, n(2)).unwrap();
        let pin_id = pin.0;
        let reservation_id = r.0;
        assert_eq!(out.publish(r, pin, source).unwrap(), n(2));
        assert_eq!(out.reserve(n(1)).unwrap_err(), Error::Full);
        assert_eq!(out.release(Pin(pin_id)).unwrap_err().0, Error::BadPin);
        assert_eq!(
            out.cancel(Reservation(reservation_id)).unwrap_err().0,
            Error::BadReservation
        );
        assert_eq!(out.front_bytes(), Ok(Some(&b"bo"[..])));
        assert!(out.discard_front());
        let admitted = out.reserve(n(2)).unwrap();
        out.cancel(admitted).unwrap();
        assert_eq!(out.used, 0);
    }

    #[test]
    fn stale_source_or_foreign_ticket_does_not_consume_a_live_reservation() {
        let (mut a, table, fd) = owner(502, 2, 1, 1);
        let (mut b, foreign_table, foreign_fd) = owner(504, 2, 1, 1);
        let first = a.begin_resident(&table, fd, 2).unwrap();
        let stale_pin = a.pin_prefix(&first, n(2)).unwrap();
        a.abort_source(first).ok().unwrap();
        let source = a.begin_resident(&table, fd, 2).unwrap();
        let r = a.reserve(n(2)).unwrap();
        let foreign_source = b.begin_resident(&foreign_table, foreign_fd, 2).unwrap();
        let foreign_pin = b.pin_prefix(&foreign_source, n(2)).unwrap();
        let foreign_r = b.reserve(n(2)).unwrap();
        let rejected = a.publish(foreign_r, stale_pin, source).unwrap_err();
        assert_eq!(rejected.error, Error::BadReservation);
        let Rejected {
            reservation: foreign_r,
            pin: stale_pin,
            source,
            ..
        } = rejected;
        let rejected = a.publish(r, foreign_pin, source).unwrap_err();
        assert_eq!(rejected.error, Error::BadPin);
        let Rejected {
            reservation: r,
            pin: foreign_pin,
            source,
            ..
        } = rejected;
        // The still-owned stale pin can be released, never used to commit this
        // live attempt (same inode/start/length and same cursor revision).
        let rejected = a.publish(r, stale_pin, source).unwrap_err();
        assert_eq!(rejected.error, Error::Source(FilesError::State));
        settle(&mut a, rejected);
        b.release(foreign_pin).unwrap();
        b.abort_source(foreign_source).ok().unwrap();
        // Foreigners could not disturb the original held B reservation.
        assert_eq!(b.used, 2);
        b.cancel(foreign_r).unwrap();
        assert_eq!(a.files.offset(&table, fd), Ok((0, 0)));
        assert_eq!(b.files.offset(&foreign_table, foreign_fd), Ok((0, 0)));
        assert_eq!(a.front_bytes(), Ok(None));
    }

    #[test]
    fn closing_admission_returns_inflight_tickets_but_retains_accepted_bytes() {
        let (mut out, table, fd) = owner(502, 4, 2, 2);
        let source = out.begin_resident(&table, fd, 2).unwrap();
        let pin = out.pin_prefix(&source, n(2)).unwrap();
        let r = out.reserve(n(2)).unwrap();
        out.publish(r, pin, source).unwrap();
        let source = out.begin_resident(&table, fd, 2).unwrap();
        let pin = out.pin_prefix(&source, n(2)).unwrap();
        let r = out.reserve(n(2)).unwrap();
        out.close_admission();
        assert_eq!(out.reserve(n(1)).unwrap_err(), Error::Closed);
        let rejected = out.publish(r, pin, source).unwrap_err();
        assert_eq!(rejected.error, Error::Closed);
        assert_eq!(out.used, 4);
        settle(&mut out, rejected);
        assert_eq!(out.used, 2);
        assert_eq!(out.files.offset(&table, fd), Ok((2, 1)));
        assert_eq!(out.front_bytes(), Ok(Some(&b"bo"[..])));
        assert!(out.discard_front());
        assert_eq!(out.used, 0);
        assert_eq!(out.reserve(n(1)).unwrap_err(), Error::Closed);
    }

    #[test]
    fn a_reserved_entry_is_not_consumable_and_rejected_receivers_preserve_the_head() {
        let (mut out, table, fd) = owner(502, 4, 2, 2);
        let reservation = out.reserve(n(2)).unwrap();
        let mut receiver = Vec::new();
        assert_eq!(out.take_front_into(&mut receiver, 0), Ok(None));
        assert_eq!(out.used, 2);
        let source = out.begin_resident(&table, fd, 2).unwrap();
        let pin = out.pin_prefix(&source, n(2)).unwrap();
        let pin_key = pin.0.key;
        let entry_key = reservation.0.key;
        out.publish(reservation, pin, source).unwrap();

        assert_eq!(
            out.take_front_into(&mut receiver, 2),
            Err(Error::ReceiverCapacity),
        );
        receiver.reserve_exact(4);
        assert_eq!(
            out.take_front_into(&mut receiver, 1),
            Err(Error::ReceiverCapacity),
        );
        receiver.push(97);
        assert_eq!(
            out.take_front_into(&mut receiver, 4),
            Err(Error::ReceiverNotEmpty),
        );
        assert_eq!(receiver, b"a");
        receiver.clear();
        // Use a test-only inconsistent witness to simulate a short Store read.
        // The backing contract forbids this in conforming code.
        out.pins.live_mut(pin_key.index).prefix.start = 3;
        assert_eq!(
            out.take_front_into(&mut receiver, 4),
            Err(Error::Source(FilesError::Payload)),
        );
        assert!(receiver.is_empty());
        assert_eq!(out.used, 2);
        assert!(out.entries.get(entry_key).is_some());
        assert!(out.pins.get(pin_key).is_some());
        assert_eq!(out.files.offset(&table, fd), Ok((2, 1)));
        out.pins.live_mut(pin_key.index).prefix.start = 0;
        assert_eq!(out.take_front_into(&mut receiver, 2), Ok(Some(n(2))));
        assert_eq!(receiver, b"bo");
        assert!(out.entries.get(entry_key).is_none());
        assert!(out.pins.get(pin_key).is_none());
        assert_eq!(out.used, 0);
        assert_eq!(out.files.offset(&table, fd), Ok((2, 1)));
        assert_eq!(out.take_front_into(&mut receiver, 0), Ok(None));
        assert_eq!(receiver, b"bo");
    }

    #[test]
    fn copied_head_frees_exact_credits_and_independently_owns_bytes_after_owner_drop() {
        let (mut out, table, fd) = owner(502, 4, 2, 2);
        for _ in 0..2 {
            let source = out.begin_resident(&table, fd, 2).unwrap();
            let pin = out.pin_prefix(&source, n(2)).unwrap();
            let reservation = out.reserve(n(2)).unwrap();
            out.publish(reservation, pin, source).unwrap();
        }
        assert_eq!(out.reserve(n(1)).unwrap_err(), Error::Full);
        let mut receiver = Vec::with_capacity(2);
        let allocation = receiver.as_ptr();
        assert_ne!(out.front_bytes().unwrap().unwrap().as_ptr(), allocation);
        assert_eq!(out.take_front_into(&mut receiver, 2), Ok(Some(n(2))));
        assert_eq!(receiver.as_ptr(), allocation);
        assert_eq!(out.used, 2);
        assert_eq!(out.front_bytes(), Ok(Some(&b"dy"[..])));
        assert_eq!(out.files.offset(&table, fd), Ok((4, 2)));
        let available = out.reserve(n(2)).unwrap();
        out.cancel(available).unwrap();

        out.close_admission();
        assert_eq!(out.reserve(n(1)).unwrap_err(), Error::Closed);
        let mut second = Vec::with_capacity(2);
        assert_eq!(out.take_front_into(&mut second, 2), Ok(Some(n(2))));
        assert_eq!(out.files.offset(&table, fd), Ok((4, 2)));
        out.files.let_go(table).unwrap();
        drop(out);
        assert_eq!(receiver, b"bo");
        assert_eq!(second, b"dy");
    }

    #[test]
    fn lost_invocation_cannot_admit_first_publication_or_undo_an_accepted_head() {
        use crate::execution::{Execution, ImageResult, Unwind};
        use crate::lease::Domain;

        for lost_first in [true, false] {
            let (mut out, table, fd) = owner(502, 2, 1, 1);
            let mut domain = Domain::new(504, 1, 4).unwrap();
            let binding = domain.bind(65536).unwrap();
            let mut producer = Execution::new(1, binding);
            producer.image_begin(&mut domain, 65536).unwrap();
            producer
                .image_finish(&mut domain, ImageResult::Installed)
                .unwrap();
            let invocation = producer.start(&mut domain).unwrap();
            producer.hold_call(invocation).unwrap();
            let source = out.begin_resident(&table, fd, 2).unwrap();
            let pin = out.pin_prefix(&source, n(2)).unwrap();
            let reservation = out.reserve(n(2)).unwrap();
            // Exercise the proposed caller order in a Rust fixture, not an
            // active Worker, continuation cancellation or transport adapter.
            if lost_first {
                producer
                    .receipt(&mut domain, invocation, Unwind::Unknown)
                    .unwrap();
                assert!(producer.check_held_call_live(invocation).is_err());
                out.abort_source(source).ok().unwrap();
                out.release(pin).unwrap();
                out.cancel(reservation).unwrap();
                assert_eq!(out.files.offset(&table, fd), Ok((0, 0)));
            } else {
                producer.check_held_call_live(invocation).unwrap();
                out.publish(reservation, pin, source).unwrap();
                assert_eq!(out.files.offset(&table, fd), Ok((2, 1)));
            }
            producer
                .receipt(&mut domain, invocation, Unwind::Fault)
                .unwrap();
            assert!(!producer.retireable());
            assert!(producer.check_held_call_live(invocation).is_err());
            producer.finish_call(invocation).unwrap();
            assert!(producer.retireable());
            out.files.let_go(table).unwrap();
            let mut receiver = Vec::with_capacity(2);
            assert_eq!(
                out.take_front_into(&mut receiver, 2),
                Ok((!lost_first).then(|| n(2)))
            );
            if lost_first {
                assert!(receiver.is_empty());
            } else {
                assert_eq!(receiver, b"bo");
            }
        }
    }

    #[test]
    fn allocation_overflow_preserves_files_and_capability_generation_never_wraps() {
        for limits in [
            Limits {
                bytes: 1,
                entries: 1,
                pins: usize::MAX,
            },
            Limits {
                bytes: 1,
                entries: usize::MAX,
                pins: 1,
            },
        ] {
            let (files, _, _, table, fd) = files(502);
            let Err((error, mut files)) = Owner::new(files, limits) else {
                panic!("overlarge arena must reject")
            };
            assert_eq!(error, Error::Capacity);
            let source = files.reserve_read(&table, fd, 1).unwrap();
            assert_eq!(files.read_bytes(&source), b"b");
            files.abort_read(source);
            files.let_go(table).unwrap();
        }
        let (mut out, table, fd) = owner(502, usize::MAX, 2, 1);
        let r = out.reserve(n(usize::MAX)).unwrap();
        assert_eq!(out.reserve(n(1)).unwrap_err(), Error::Overflow);
        out.cancel(r).unwrap();
        let source = out.begin_resident(&table, fd, 1).unwrap();
        let mut pin = out.pin_prefix(&source, n(1)).unwrap();
        out.pins.cells[0].generation = u64::MAX - 1;
        pin.0.key.generation = u64::MAX - 1;
        out.release(pin).unwrap();
        let terminal = out.pin_prefix(&source, n(1)).unwrap();
        assert_eq!(terminal.0.key.generation, u64::MAX);
        out.release(terminal).unwrap();
        assert_eq!(out.pin_prefix(&source, n(1)).unwrap_err(), Error::Capacity);
        out.abort_source(source).ok().unwrap();
        assert_eq!(out.files.offset(&table, fd), Ok((0, 0)));
        let mut r = out.reserve(n(1)).unwrap();
        out.entries.cells[r.0.key.index].generation = u64::MAX;
        r.0.key.generation = u64::MAX;
        let old_index = r.0.key.index;
        out.cancel(r).unwrap();
        let next = out.reserve(n(1)).unwrap();
        assert_ne!(next.0.key.index, old_index);
        assert_eq!(next.0.key.generation, 1);
        assert_eq!(out.reserve(n(1)).unwrap_err(), Error::Full);
        out.cancel(next).unwrap();
        assert_eq!(out.used, 0);
    }
}
