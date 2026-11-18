//! Private finite publication of retained file prefixes and owned copies.
//! Not a guest pipe, cancellation gate, or external output/drain adapter.
use super::{Error as FilesError, Files, OutputHold, ReadHold, ReadPrefix, Table};
use std::marker::PhantomData;
use std::num::{NonZeroU64, NonZeroUsize};

pub(crate) mod capture;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Source(FilesError),
    Capacity,
    Full,
    Overflow,
    Closed,
    BadPin,
    BadReservation,
    BadDestination,
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
struct RegistryId {
    files: u64,
    serial: NonZeroU64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct DestinationId {
    registry: RegistryId,
    lane: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ticket {
    destination: DestinationId,
    key: Key,
}
#[derive(Debug)]
#[must_use = "release the pin with its owner or move it into one publication"]
pub(super) struct Pin(Ticket);
#[derive(Debug)]
#[must_use = "cancel the reservation with its owner or consume it in one publication"]
pub(super) struct Reservation(Ticket);

#[derive(Debug)]
pub(super) enum Unfilled {}
#[derive(Debug)]
pub(super) enum Filled {}
/// Initialized storage and the exact reservation it was admitted against.
/// Dropping the stage is not permission to restore the lane's credits.
#[derive(Debug)]
#[must_use = "publish filled bytes or cancel the exact reservation with its owner"]
pub(super) struct WriteStage<State> {
    reservation: Reservation,
    bytes: Vec<u8>,
    state: PhantomData<State>,
}
impl WriteStage<Unfilled> {
    /// Native trusted loan only. The caller separately owns invocation and
    /// cancel checks. There is no mutable host view or external stop proof.
    pub(super) fn copy_from(mut self, input: &[u8]) -> Result<WriteStage<Filled>, (Error, Self)> {
        if self.bytes.len() != input.len() {
            return Err((Error::Length, self));
        }
        self.bytes.copy_from_slice(input);
        Ok(WriteStage {
            reservation: self.reservation,
            bytes: self.bytes,
            state: PhantomData,
        })
    }
}

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
    fn live(&self, index: usize) -> &T {
        let State::Live(value) = &self.cells[index].state else {
            unreachable!("live arena index")
        };
        value
    }
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
    Queued { chunk: Chunk, next: Option<usize> },
}
enum Chunk {
    // An admitted, lane-local link, not the producer's ticket. A queued pin
    // cannot be released or reused until this record is removed.
    Pinned(usize),
    Copied(Vec<u8>),
}
enum HeadBytes<'a> {
    Pinned { pin: usize, prefix: &'a ReadPrefix },
    Copied(&'a [u8]),
}
impl<'a> HeadBytes<'a> {
    fn len(&self) -> NonZeroUsize {
        match self {
            Self::Pinned { prefix, .. } => prefix.length,
            Self::Copied(bytes) => NonZeroUsize::new(bytes.len()).expect("nonempty copied entry"),
        }
    }
    fn bytes(self, files: &'a mut Files) -> Result<&'a [u8], Error> {
        Ok(match self {
            Self::Pinned { prefix, .. } => files.prefix_bytes(prefix)?,
            Self::Copied(bytes) => bytes,
        })
    }
}
struct Head<'a> {
    index: usize,
    next: Option<usize>,
    bytes: HeadBytes<'a>,
}
struct Removal {
    index: usize,
    pin: Option<usize>,
    next: Option<usize>,
    remaining: usize,
}
impl Head<'_> {
    fn removal(&self, used: usize, length: NonZeroUsize) -> Removal {
        Removal {
            index: self.index,
            pin: match self.bytes {
                HeadBytes::Pinned { pin, .. } => Some(pin),
                HeadBytes::Copied(_) => None,
            },
            next: self.next,
            remaining: used.checked_sub(length.get()).expect("queued byte credit"),
        }
    }
}

// No lane or ticket owns backing by itself. Root retains Files and keeps
// queue records resolvable after an individual producer or OFD retires.
struct Queue {
    id: DestinationId,
    pins: Arena<Range>,
    entries: Arena<Entry>,
    head: Option<usize>,
    tail: Option<usize>,
    byte_limit: usize,
    used: usize,
    closed: bool,
}
impl Queue {
    fn new(id: DestinationId, limits: Limits) -> Result<Self, Error> {
        Ok(Self {
            id,
            pins: Arena::new(limits.pins)?,
            entries: Arena::new(limits.entries)?,
            head: None,
            tail: None,
            byte_limit: limits.bytes,
            used: 0,
            closed: false,
        })
    }
    fn pin_prefix(
        &mut self,
        files: &mut Files,
        source: &ReadHold,
        length: NonZeroUsize,
    ) -> Result<Pin, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        let prefix = files.read_prefix(source, length)?;
        let key = self
            .pins
            .add(Range {
                prefix,
                queued: false,
            })
            .ok_or(Error::Capacity)?;
        Ok(Pin(Ticket {
            destination: self.id,
            key,
        }))
    }
    fn release(&mut self, pin: Pin) -> Result<(), (Error, Pin)> {
        if pin.0.destination != self.id || !self.pins.get(pin.0.key).is_some_and(|p| !p.queued) {
            return Err((Error::BadPin, pin));
        }
        self.pins.remove(pin.0.key.index);
        Ok(())
    }
    fn reserve(&mut self, length: NonZeroUsize) -> Result<Reservation, Error> {
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
            destination: self.id,
            key,
        }))
    }
    fn reserved(&self, r: &Reservation) -> Result<NonZeroUsize, Error> {
        if r.0.destination == self.id {
            if let Some(Entry::Reserved(length)) = self.entries.get(r.0.key) {
                return Ok(*length);
            }
        }
        Err(Error::BadReservation)
    }
    fn cancel(&mut self, reservation: Reservation) -> Result<(), (Error, Reservation)> {
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
        if pin.0.destination != self.id {
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
    fn publish(
        &mut self,
        files: &mut Files,
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
        let pinned = pin.0.key.index;
        let range = self.pins.live_mut(pinned);
        let commit = match files.prepare_prefix_commit(source, &range.prefix) {
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
        range.queued = true;
        self.link(reservation, Chunk::Pinned(pinned));
        commit.commit();
        Ok(length)
    }
    /// Snapshots a stable loan, after the caller's execution/cancel checks.
    /// The exact reservation is returned on failure, without taking input
    /// ownership or keeping additional capacity. No file pin is required.
    fn publish_copy(
        &mut self,
        reservation: Reservation,
        input: &[u8],
    ) -> Result<NonZeroUsize, (Error, Reservation)> {
        let admission = self.copy_length(&reservation, input.len());
        let length = match admission {
            Ok(length) => length,
            Err(error) => return Err((error, reservation)),
        };
        let mut bytes = match Self::copy_storage(length) {
            Ok(bytes) => bytes,
            Err(error) => return Err((error, reservation)),
        };
        bytes.extend_from_slice(input);
        self.link(reservation, Chunk::Copied(bytes));
        Ok(length)
    }
    fn copy_storage(length: NonZeroUsize) -> Result<Vec<u8>, Error> {
        let length = length.get();
        let mut bytes = Vec::new();
        if bytes.try_reserve_exact(length).is_err() || bytes.capacity() != length {
            return Err(Error::Capacity);
        }
        Ok(bytes)
    }
    /// Allocate only after bounded admission. The zeros are not captured data.
    fn stage_write(&mut self, length: NonZeroUsize) -> Result<WriteStage<Unfilled>, Error> {
        let reservation = self.reserve(length)?;
        let mut bytes = match Self::copy_storage(length) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.cancel(reservation).expect("new staging reservation");
                return Err(error);
            }
        };
        bytes.resize(length.get(), 0);
        Ok(WriteStage {
            reservation,
            bytes,
            state: PhantomData,
        })
    }
    /// Ownership transfer only. Reject without destroying the filled storage
    /// or its reservation. The caller excludes cancellation before this turn.
    fn publish_staged(
        &mut self,
        stage: WriteStage<Filled>,
    ) -> Result<NonZeroUsize, (Error, WriteStage<Filled>)> {
        let length = match self.copy_length(&stage.reservation, stage.bytes.len()) {
            Ok(length) => length,
            Err(error) => return Err((error, stage)),
        };
        self.link(stage.reservation, Chunk::Copied(stage.bytes));
        Ok(length)
    }
    fn cancel_staged<State>(
        &mut self,
        stage: WriteStage<State>,
    ) -> Result<(), (Error, WriteStage<State>)> {
        let WriteStage {
            reservation,
            bytes,
            state,
        } = stage;
        self.cancel(reservation).map_err(|(error, reservation)| {
            (
                error,
                WriteStage {
                    reservation,
                    bytes,
                    state,
                },
            )
        })
    }
    fn copy_length(
        &self,
        reservation: &Reservation,
        offered: usize,
    ) -> Result<NonZeroUsize, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        let length = self.reserved(reservation)?;
        if length.get() != offered {
            return Err(Error::Length);
        }
        Ok(length)
    }
    // No allocation, callbacks or effects at this shared acceptance point.
    // FIFO links follow acceptance order, not reservation order.
    fn link(&mut self, reservation: Reservation, chunk: Chunk) {
        let index = reservation.0.key.index;
        *self.entries.live_mut(index) = Entry::Queued { chunk, next: None };
        if let Some(tail) = self.tail {
            let Entry::Queued { next, .. } = self.entries.live_mut(tail) else {
                unreachable!("queued tail")
            };
            *next = Some(index);
        } else {
            self.head = Some(index);
        }
        self.tail = Some(index);
    }
    fn head<'a>(
        index: Option<usize>,
        entries: &'a Arena<Entry>,
        pins: &'a Arena<Range>,
    ) -> Option<Head<'a>> {
        let index = index?;
        let State::Live(Entry::Queued { chunk, next }) = &entries.cells[index].state else {
            unreachable!("queued head")
        };
        let bytes = match chunk {
            Chunk::Pinned(pin) => {
                let range = pins.live(*pin);
                assert!(range.queued);
                HeadBytes::Pinned {
                    pin: *pin,
                    prefix: &range.prefix,
                }
            }
            Chunk::Copied(bytes) => HeadBytes::Copied(bytes),
        };
        Some(Head {
            index,
            next: *next,
            bytes,
        })
    }
    fn front_bytes<'a>(&'a self, files: &'a mut Files) -> Result<Option<&'a [u8]>, Error> {
        let Some(head) = Self::head(self.head, &self.entries, &self.pins) else {
            return Ok(None);
        };
        Ok(Some(head.bytes.bytes(files)?))
    }
    fn remove_head(&mut self, removal: Removal) {
        self.used = removal.remaining;
        self.head = removal.next;
        if self.head.is_none() {
            self.tail = None;
        }
        if let Some(pin) = removal.pin {
            self.pins.remove(pin);
        }
        self.entries.remove(removal.index);
    }
    /// Transfer one entire head to separate caller-owned Rust storage. The
    /// receiver must already have room; no allocation or zeroing pass here.
    /// Failure holds both sides unchanged. Empty is not EOF or a flush receipt.
    /// No view escapes and no external delivery or stopped-access is implied.
    fn take_front_into(
        &mut self,
        files: &mut Files,
        receiver: &mut Vec<u8>,
        logical_limit: usize,
    ) -> Result<Option<NonZeroUsize>, Error> {
        let Some(head) = Self::head(self.head, &self.entries, &self.pins) else {
            return Ok(None);
        };
        if !receiver.is_empty() {
            return Err(Error::ReceiverNotEmpty);
        }
        let length = head.bytes.len();
        if length.get() > logical_limit || length.get() > receiver.capacity() {
            return Err(Error::ReceiverCapacity);
        }
        let removal = head.removal(self.used, length);
        let bytes = head.bytes.bytes(files)?;
        receiver.extend_from_slice(bytes);
        self.remove_head(removal);
        Ok(Some(length))
    }
    /// Internal discard, not consumer delivery or stopped external access.
    fn discard_front(&mut self) -> bool {
        let Some(head) = Self::head(self.head, &self.entries, &self.pins) else {
            return false;
        };
        self.remove_head(head.removal(self.used, head.bytes.len()));
        true
    }
    /// Admission closure does not erase accepted data or cancel pending tickets.
    fn close_admission(&mut self) {
        self.closed = true;
    }
}

/// Authority for a single destination's admission, not source ownership or
/// permission to consume. Dropping this ticket does not mean producer stop.
#[derive(Debug)]
pub(super) struct Producer(DestinationId);
/// Authority to take or discard exactly one lane's accepted work. Independent
/// of any producer's current call/table/Execution. Not a stopped host receipt.
#[derive(Debug)]
pub(super) struct Consumer(DestinationId);

// The existing Core and disconnected Root can each own one registry *beside*
// one Files. The registry acquires no separately replaceable backing.
struct LaneRegistry {
    id: RegistryId,
    lanes: Vec<Queue>,
    limit: usize,
}
impl LaneRegistry {
    fn new(files: &mut Files, limit: usize) -> Result<Self, Error> {
        let mut lanes = Vec::new();
        lanes
            .try_reserve_exact(limit)
            .map_err(|_| Error::Capacity)?;
        Ok(Self {
            id: RegistryId {
                files: files.owner(),
                serial: files.issue_output_registry()?,
            },
            lanes,
            limit,
        })
    }
    fn destination(&mut self, limits: Limits) -> Result<(Producer, Consumer), Error> {
        let lane = self.lanes.len();
        if lane == self.limit {
            return Err(Error::Capacity);
        }
        let id = DestinationId {
            registry: self.id,
            lane,
        };
        let queue = Queue::new(id, limits)?;
        // Index storage was reserved at registry construction. Failure above
        // changes neither lane admission nor source ownership.
        self.lanes.push(queue);
        Ok((Producer(id), Consumer(id)))
    }
    fn lane<'a>(
        &'a mut self,
        files: &'a mut Files,
        id: DestinationId,
    ) -> Result<(&'a mut Files, &'a mut Queue), Error> {
        if !self.owns(files, id) {
            return Err(Error::BadDestination);
        }
        let queue = self.lanes.get_mut(id.lane).ok_or(Error::BadDestination)?;
        Ok((files, queue))
    }
    fn owns(&self, files: &Files, id: DestinationId) -> bool {
        id.registry == self.id && self.id.files == files.owner()
    }
    fn queued_stdio(
        &self,
        files: &mut Files,
        stdin: u64,
        outputs: [&Producer; 2],
        limit: u32,
    ) -> Result<Table, Error> {
        let destinations = outputs.map(|producer| producer.0);
        for destination in destinations {
            if !self.owns(files, destination) || self.lanes.get(destination.lane).is_none() {
                return Err(Error::BadDestination);
            }
        }
        Ok(files.queued_stdio(stdin, destinations, limit)?)
    }
    fn held_writer<'a>(
        &'a mut self,
        files: &'a mut Files,
        hold: &'a OutputHold,
    ) -> Result<Writer<'a>, Error> {
        let id = files.held_output(hold)?;
        let (files, queue) = self.lane(files, id)?;
        Ok(Writer { files, queue })
    }
    fn writer<'a>(
        &'a mut self,
        files: &'a mut Files,
        producer: &'a Producer,
    ) -> Result<Writer<'a>, Error> {
        let (files, queue) = self.lane(files, producer.0)?;
        Ok(Writer { files, queue })
    }
    fn reader<'a>(
        &'a mut self,
        files: &'a mut Files,
        consumer: &'a Consumer,
    ) -> Result<Reader<'a>, Error> {
        let (files, queue) = self.lane(files, consumer.0)?;
        Ok(Reader { files, queue })
    }
}

/// One coarse Files owner shared by bounded independent queues. Lanes append
/// without replacement, so the index identifies a unique lifetime in this
/// root. No queue or consumer can take Files out or replace its backing.
pub(super) struct Root {
    files: Files,
    registry: LaneRegistry,
}
impl Root {
    pub(super) fn new(mut files: Files, limit: usize) -> Result<Self, (Error, Files)> {
        let registry = match LaneRegistry::new(&mut files, limit) {
            Ok(registry) => registry,
            Err(error) => return Err((error, files)),
        };
        Ok(Self { files, registry })
    }
    pub(super) fn destination(&mut self, limits: Limits) -> Result<(Producer, Consumer), Error> {
        self.registry.destination(limits)
    }
    pub(super) fn writer<'a>(&'a mut self, producer: &'a Producer) -> Result<Writer<'a>, Error> {
        self.registry.writer(&mut self.files, producer)
    }
    pub(super) fn queued_stdio(
        &mut self,
        stdin: u64,
        outputs: [&Producer; 2],
        limit: u32,
    ) -> Result<Table, Error> {
        self.registry
            .queued_stdio(&mut self.files, stdin, outputs, limit)
    }
    pub(super) fn held_writer<'a>(&'a mut self, hold: &'a OutputHold) -> Result<Writer<'a>, Error> {
        self.registry.held_writer(&mut self.files, hold)
    }
    pub(super) fn reader<'a>(&'a mut self, consumer: &'a Consumer) -> Result<Reader<'a>, Error> {
        self.registry.reader(&mut self.files, consumer)
    }
}

/// Short synchronous loan of matching storage and destination. No writer
/// method grants consumer authority; retaining the producer is not needed
/// once accepted records have moved to the lane.
pub(super) struct Writer<'a> {
    files: &'a mut Files,
    queue: &'a mut Queue,
}
impl Writer<'_> {
    pub(super) fn pin_prefix(
        &mut self,
        source: &ReadHold,
        length: NonZeroUsize,
    ) -> Result<Pin, Error> {
        self.queue.pin_prefix(self.files, source, length)
    }
    pub(super) fn reserve(&mut self, length: NonZeroUsize) -> Result<Reservation, Error> {
        self.queue.reserve(length)
    }
    pub(super) fn release(&mut self, pin: Pin) -> Result<(), (Error, Pin)> {
        self.queue.release(pin)
    }
    pub(super) fn cancel(&mut self, reservation: Reservation) -> Result<(), (Error, Reservation)> {
        self.queue.cancel(reservation)
    }
    pub(super) fn publish(
        &mut self,
        reservation: Reservation,
        pin: Pin,
        source: ReadHold,
    ) -> Result<NonZeroUsize, Rejected> {
        self.queue.publish(self.files, reservation, pin, source)
    }
    pub(super) fn publish_copy(
        &mut self,
        reservation: Reservation,
        input: &[u8],
    ) -> Result<NonZeroUsize, (Error, Reservation)> {
        self.queue.publish_copy(reservation, input)
    }
    pub(super) fn stage_write(
        &mut self,
        length: NonZeroUsize,
    ) -> Result<WriteStage<Unfilled>, Error> {
        self.queue.stage_write(length)
    }
    pub(super) fn publish_staged(
        &mut self,
        stage: WriteStage<Filled>,
    ) -> Result<NonZeroUsize, (Error, WriteStage<Filled>)> {
        self.queue.publish_staged(stage)
    }
    pub(super) fn cancel_staged<State>(
        &mut self,
        stage: WriteStage<State>,
    ) -> Result<(), (Error, WriteStage<State>)> {
        self.queue.cancel_staged(stage)
    }
    pub(super) fn close_admission(&mut self) {
        self.queue.close_admission();
    }
}

/// Short synchronous loan. One live peek view prevents another operation on
/// this Root. No raw view crosses an ABI, callback or await.
pub(super) struct Reader<'a> {
    files: &'a mut Files,
    queue: &'a mut Queue,
}
impl Reader<'_> {
    pub(super) fn front_bytes(&mut self) -> Result<Option<&[u8]>, Error> {
        self.queue.front_bytes(self.files)
    }
    pub(super) fn take_front_into(
        &mut self,
        receiver: &mut Vec<u8>,
        logical_limit: usize,
    ) -> Result<Option<NonZeroUsize>, Error> {
        self.queue
            .take_front_into(self.files, receiver, logical_limit)
    }
    pub(super) fn discard_front(&mut self) -> bool {
        self.queue.discard_front()
    }
}

/// Isolated raw Core diagnostic only, deliberately not a producer syscall or
/// host drain. Fixed small lanes keep this probe independent of runtime limits.
#[cfg(feature = "queued-output-probe")]
pub(crate) struct QueueProbe {
    registry: LaneRegistry,
    producers: [Producer; 2],
    consumers: [Consumer; 2],
}
#[cfg(feature = "queued-output-probe")]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum QueueProbeError {
    Capacity,
    Range,
    Owner,
}
#[cfg(feature = "queued-output-probe")]
impl From<Error> for QueueProbeError {
    fn from(error: Error) -> Self {
        match error {
            Error::Capacity | Error::Full => Self::Capacity,
            Error::Length => Self::Range,
            _ => Self::Owner,
        }
    }
}
#[cfg(feature = "queued-output-probe")]
impl QueueProbe {
    pub(crate) fn new(files: &mut Files) -> Result<Self, QueueProbeError> {
        let mut registry = LaneRegistry::new(files, 2)?;
        let limits = || Limits {
            pins: 1,
            entries: 1,
            bytes: 4,
        };
        let (a, read_a) = registry.destination(limits())?;
        let (b, read_b) = registry.destination(limits())?;
        Ok(Self {
            registry,
            producers: [a, b],
            consumers: [read_a, read_b],
        })
    }
    pub(crate) fn stdio(&self, files: &mut Files, limit: u32) -> Result<Table, QueueProbeError> {
        Ok(self
            .registry
            .queued_stdio(files, 1, self.producers.each_ref(), limit)?)
    }
    #[cfg(all(target_arch = "wasm32", feature = "queued-worker-probe"))]
    pub(crate) fn capture_context<'a>(
        &'a mut self,
        files: &'a mut Files,
        domain: &'a mut crate::lease::Domain,
        execution: &'a mut crate::execution::Execution,
    ) -> capture::Context<'a> {
        capture::Context {
            files,
            lanes: &mut self.registry,
            domain,
            execution,
        }
    }
    pub(crate) fn publish(
        &mut self,
        files: &mut Files,
        table: &Table,
        fd: u32,
        lane: usize,
        count: usize,
    ) -> Result<usize, QueueProbeError> {
        let length = NonZeroUsize::new(count)
            .filter(|n| n.get() <= 4)
            .ok_or(QueueProbeError::Range)?;
        let producer = self.producers.get(lane).ok_or(QueueProbeError::Range)?;
        let (files, queue) = self.registry.lane(files, producer.0)?;
        let source = files
            .reserve_read(table, fd, count as u64)
            .map_err(Error::Source)?;
        if source.length() != count {
            files.abort_read(source);
            return Err(QueueProbeError::Range);
        }
        let reservation = match queue.reserve(length) {
            Ok(reservation) => reservation,
            Err(error) => {
                files.abort_read(source);
                return Err(error.into());
            }
        };
        let pin = match queue.pin_prefix(files, &source, length) {
            Ok(pin) => pin,
            Err(error) => {
                queue.cancel(reservation).expect("same private reservation");
                files.abort_read(source);
                return Err(error.into());
            }
        };
        match queue.publish(files, reservation, pin, source) {
            Ok(accepted) => Ok(accepted.get()),
            Err(Rejected {
                error,
                reservation,
                pin,
                source,
            }) => {
                queue.cancel(reservation).expect("same private reservation");
                queue.release(pin).expect("same private prepared pin");
                files.abort_read(source);
                Err(error.into())
            }
        }
    }
    pub(crate) fn peek(
        &mut self,
        files: &mut Files,
        lane: usize,
        index: usize,
    ) -> Result<(usize, u8), QueueProbeError> {
        let consumer = self.consumers.get(lane).ok_or(QueueProbeError::Range)?;
        let mut reader = self.registry.reader(files, consumer)?;
        let Some(bytes) = reader.front_bytes()? else {
            return Ok((0, 0));
        };
        let byte = *bytes.get(index).ok_or(QueueProbeError::Range)?;
        Ok((bytes.len(), byte))
    }
    pub(crate) fn discard(
        &mut self,
        files: &mut Files,
        lane: usize,
    ) -> Result<bool, QueueProbeError> {
        let consumer = self.consumers.get(lane).ok_or(QueueProbeError::Range)?;
        Ok(self.registry.reader(files, consumer)?.discard_front())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::descriptor::Limits as FilesLimits;
    use crate::inode::{Creation, Inode, Tree};

    // Legacy one-lane counterexamples exercise the same private Queue. The
    // multi-lane cases below use Root's actual Writer/Reader separation.
    struct Owner {
        files: Files,
        queue: Queue,
    }
    impl std::ops::Deref for Owner {
        type Target = Queue;
        fn deref(&self) -> &Queue {
            &self.queue
        }
    }
    impl std::ops::DerefMut for Owner {
        fn deref_mut(&mut self) -> &mut Queue {
            &mut self.queue
        }
    }
    impl Owner {
        fn new(files: Files, limits: Limits) -> Result<Self, (Error, Files)> {
            let id = DestinationId {
                registry: RegistryId {
                    files: files.owner(),
                    serial: NonZeroU64::MIN,
                },
                lane: 0,
            };
            match Queue::new(id, limits) {
                Ok(queue) => Ok(Self { files, queue }),
                Err(error) => Err((error, files)),
            }
        }
        fn begin_resident(
            &mut self,
            table: &Table,
            fd: u32,
            requested: u64,
        ) -> Result<ReadHold, Error> {
            Ok(self.files.reserve_read(table, fd, requested)?)
        }
        fn abort_source(&mut self, source: ReadHold) -> Result<(), (Error, ReadHold)> {
            if let Err(error) = self.files.check_read_hold(&source) {
                return Err((error.into(), source));
            }
            self.files.abort_read(source);
            Ok(())
        }
        fn pin_prefix(&mut self, source: &ReadHold, length: NonZeroUsize) -> Result<Pin, Error> {
            self.queue.pin_prefix(&mut self.files, source, length)
        }
        fn publish(
            &mut self,
            reservation: Reservation,
            pin: Pin,
            source: ReadHold,
        ) -> Result<NonZeroUsize, Rejected> {
            self.queue
                .publish(&mut self.files, reservation, pin, source)
        }
        fn front_bytes(&mut self) -> Result<Option<&[u8]>, Error> {
            self.queue.front_bytes(&mut self.files)
        }
        fn take_front_into(
            &mut self,
            receiver: &mut Vec<u8>,
            logical_limit: usize,
        ) -> Result<Option<NonZeroUsize>, Error> {
            self.queue
                .take_front_into(&mut self.files, receiver, logical_limit)
        }
    }

    pub(super) fn n(length: usize) -> NonZeroUsize {
        NonZeroUsize::new(length).unwrap()
    }
    fn made(mode: u32) -> Creation {
        Creation {
            mode,
            uid: 0,
            gid: 0,
        }
    }
    pub(super) fn files(owner: u64) -> (Files, Inode, Inode, Table, u32) {
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
    fn copied_writes_and_a_pinned_prefix_share_acceptance_order_after_producer_retirement() {
        let (files, _, _, table, fd) = files(502);
        let mut root = Root::new(files, 2).ok().unwrap();
        let (producer, consumer) = root
            .destination(Limits {
                bytes: 3,
                entries: 3,
                pins: 1,
            })
            .unwrap();
        let (other, other_consumer) = root
            .destination(Limits {
                bytes: 1,
                entries: 1,
                pins: 0,
            })
            .unwrap();
        let source = root.files.reserve_read(&table, fd, 1).unwrap();
        let canonical = root.files.read_bytes(&source).as_ptr();
        let other_reservation = root.writer(&other).unwrap().reserve(n(1)).unwrap();
        let mut writer = root.writer(&producer).unwrap();
        // Reservations are deliberately opposite to publication order.
        let last = writer.reserve(n(1)).unwrap();
        assert_eq!(last.0.key, other_reservation.0.key);
        let middle = writer.reserve(n(1)).unwrap();
        let first = writer.reserve(n(1)).unwrap();
        let pin = writer.pin_prefix(&source, n(1)).unwrap();
        let mut guest = [b'A'];
        let (error, other_reservation) =
            writer.publish_copy(other_reservation, &guest).unwrap_err();
        assert_eq!(error, Error::BadReservation);
        assert_eq!(writer.publish_copy(first, &guest).unwrap(), n(1));
        guest[0] = b'C';
        assert_eq!(writer.publish(middle, pin, source).unwrap(), n(1));
        assert_eq!(writer.publish_copy(last, &guest).unwrap(), n(1));
        guest[0] = b'!';
        assert_eq!(writer.reserve(n(1)).unwrap_err(), Error::Full);

        root.writer(&other)
            .unwrap()
            .publish_copy(other_reservation, &guest)
            .unwrap();
        assert_eq!(root.files.offset(&table, fd), Ok((1, 1)));
        root.files.let_go(table).unwrap();
        drop(producer);
        drop(other);

        let mut reader = root.reader(&consumer).unwrap();
        let at = reader.front_bytes().unwrap().unwrap();
        assert_eq!(at, b"A");
        assert_ne!(at.as_ptr(), guest.as_ptr());
        assert!(reader.discard_front());
        let at = reader.front_bytes().unwrap().unwrap();
        assert_eq!(at, b"b");
        assert_eq!(at.as_ptr(), canonical);
        assert!(reader.discard_front());
        assert_eq!(reader.front_bytes(), Ok(Some(&b"C"[..])));
        assert!(reader.discard_front());
        assert_eq!(reader.front_bytes(), Ok(None));
        assert_eq!(
            root.reader(&other_consumer).unwrap().front_bytes(),
            Ok(Some(&b"!"[..])),
        );
    }

    #[test]
    fn rejected_copies_check_the_exact_ticket_length_and_close_before_owning_bytes() {
        let (mut a, table, fd) = owner(502, 4, 1, 1);
        let (mut b, _, _) = owner(504, 4, 1, 1);
        let first = a.reserve(n(2)).unwrap();
        let old = first.0;
        a.cancel(first).unwrap();
        let live = a.reserve(n(2)).unwrap();
        assert_eq!(old.key.index, live.0.key.index);
        let their = b.reserve(n(2)).unwrap();
        let guest = [b'X', b'Y'];
        let (error, their) = a.publish_copy(their, &guest).unwrap_err();
        assert_eq!(error, Error::BadReservation);
        b.cancel(their).unwrap();
        let (error, _) = a.publish_copy(Reservation(old), &guest).unwrap_err();
        assert_eq!(error, Error::BadReservation);
        let (error, live) = a.publish_copy(live, &guest[..1]).unwrap_err();
        assert_eq!(error, Error::Length);
        let (error, live) = a.publish_copy(live, &[]).unwrap_err();
        assert_eq!(error, Error::Length);
        assert_eq!(a.reserve(n(1)).unwrap_err(), Error::Full);
        a.close_admission();
        let (error, live) = a.publish_copy(live, &guest).unwrap_err();
        assert_eq!(error, Error::Closed);
        assert_eq!(a.used, 2);
        assert_eq!(a.front_bytes(), Ok(None));
        assert_eq!(a.files.offset(&table, fd), Ok((0, 0)));
        a.cancel(live).unwrap();
        assert_eq!(a.used, 0);
    }

    #[test]
    fn owned_head_releases_q_and_k_not_the_pinned_heads_r() {
        let (mut out, table, fd) = owner(502, 3, 2, 1);
        let mut guest = Vec::with_capacity(4096);
        guest.extend_from_slice(b"hi");
        let copied = out.reserve(n(2)).unwrap();
        let key = copied.0.key;
        out.publish_copy(copied, &guest).unwrap();
        drop(guest);
        let State::Live(Entry::Queued {
            chunk: Chunk::Copied(bytes),
            ..
        }) = &out.entries.cells[key.index].state
        else {
            panic!("copied record")
        };
        assert_eq!((bytes.len(), bytes.capacity()), (2, 2));
        let source = out.begin_resident(&table, fd, 1).unwrap();
        let pin = out.pin_prefix(&source, n(1)).unwrap();
        let pinned = pin.0.key;
        let reservation = out.reserve(n(1)).unwrap();
        let pinned_entry = reservation.0.key;
        out.publish(reservation, pin, source).unwrap();
        assert_eq!(out.reserve(n(1)).unwrap_err(), Error::Full);

        let mut receiver = Vec::with_capacity(2);
        let address = receiver.as_ptr();
        assert_eq!(
            out.take_front_into(&mut receiver, 1),
            Err(Error::ReceiverCapacity)
        );
        assert!(receiver.is_empty());
        assert_eq!(out.used, 3);
        assert!(out.entries.get(key).is_some());
        assert!(out.pins.get(pinned).is_some());
        assert_eq!(out.take_front_into(&mut receiver, 2), Ok(Some(n(2))));
        assert_eq!(receiver.as_ptr(), address);
        assert_eq!(out.used, 1);
        assert!(out.entries.get(key).is_none());
        assert!(out.pins.get(pinned).is_some());
        let allowed = out.reserve(n(2)).unwrap();
        out.cancel(allowed).unwrap();
        assert_eq!(out.files.offset(&table, fd), Ok((1, 1)));
        assert_eq!(out.front_bytes(), Ok(Some(&b"b"[..])));
        assert!(out.discard_front());
        assert!(out.pins.get(pinned).is_none());
        assert_eq!(out.used, 0);

        let source = out.begin_resident(&table, fd, 1).unwrap();
        let pin = out.pin_prefix(&source, n(1)).unwrap();
        assert_eq!(pin.0.key.index, pinned.index);
        assert_ne!(pin.0.key.generation, pinned.generation);
        let reservation = out.reserve(n(1)).unwrap();
        assert_eq!(reservation.0.key.index, pinned_entry.index);
        assert_ne!(reservation.0.key.generation, pinned_entry.generation);
        out.publish(reservation, pin, source).unwrap();
        let reservation = out.reserve(n(2)).unwrap();
        assert_eq!(reservation.0.key.index, key.index);
        out.publish_copy(reservation, b"ok").unwrap();
        assert_eq!(out.front_bytes(), Ok(Some(&b"o"[..])));
        assert!(out.discard_front());
        assert_eq!(out.front_bytes(), Ok(Some(&b"ok"[..])));
        assert!(out.discard_front());
        assert_eq!(out.used, 0);
        drop(out);
        assert_eq!(receiver, b"hi");
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
    fn two_destinations_share_source_storage_but_not_tickets_credits_or_consumer() {
        let (files, _, _, table, fd) = files(502);
        let mut root = Root::new(files, 2).ok().unwrap();
        let limits = || Limits {
            pins: 1,
            entries: 1,
            bytes: 2,
        };
        let (a, read_a) = root.destination(limits()).unwrap();
        let (b, read_b) = root.destination(limits()).unwrap();
        assert_eq!(root.destination(limits()).unwrap_err(), Error::Capacity);

        let source = root.files.reserve_read(&table, fd, 2).unwrap();
        let mut lane = root.writer(&a).unwrap();
        let ra = lane.reserve(n(2)).unwrap();
        let pa = lane.pin_prefix(&source, n(2)).unwrap();
        assert_eq!(lane.reserve(n(1)).unwrap_err(), Error::Full);
        let mut lane = root.writer(&b).unwrap();
        let rb = lane.reserve(n(2)).unwrap();
        assert_eq!(ra.0.key, rb.0.key, "equal local slots in two queues");
        let rejected = lane.publish(ra, pa, source).unwrap_err();
        assert_eq!(rejected.error, Error::BadReservation);
        let Rejected {
            reservation: ra,
            pin: pa,
            source,
            ..
        } = rejected;
        let rejected = lane.publish(rb, pa, source).unwrap_err();
        assert_eq!(rejected.error, Error::BadPin);
        let Rejected {
            reservation: rb,
            pin: pa,
            source,
            ..
        } = rejected;
        assert_eq!(root.files.offset(&table, fd), Ok((0, 0)));
        assert_eq!(root.reader(&read_a).unwrap().front_bytes(), Ok(None));
        assert_eq!(root.reader(&read_b).unwrap().front_bytes(), Ok(None));

        let mut lane = root.writer(&a).unwrap();
        lane.publish(ra, pa, source).unwrap();
        lane.close_admission();
        assert_eq!(lane.reserve(n(1)).unwrap_err(), Error::Closed);
        let source = root.files.reserve_read(&table, fd, 2).unwrap();
        let mut lane = root.writer(&b).unwrap();
        let pb = lane.pin_prefix(&source, n(2)).unwrap();
        lane.publish(rb, pb, source).unwrap();
        assert_eq!(root.files.offset(&table, fd), Ok((4, 2)));
        root.files.let_go(table).unwrap();

        let mut result_b = Vec::with_capacity(2);
        assert_eq!(
            root.reader(&read_b)
                .unwrap()
                .take_front_into(&mut result_b, 2),
            Ok(Some(n(2)))
        );
        assert_eq!(
            root.reader(&read_a).unwrap().front_bytes(),
            Ok(Some(&b"bo"[..]))
        );
        let b_credit = root.writer(&b).unwrap().reserve(n(2)).unwrap();
        root.writer(&b).unwrap().cancel(b_credit).unwrap();
        let mut result_a = Vec::with_capacity(2);
        assert_eq!(
            root.reader(&read_a)
                .unwrap()
                .take_front_into(&mut result_a, 2),
            Ok(Some(n(2)))
        );
        assert!(!root.reader(&read_a).unwrap().discard_front());
        drop(root);
        assert_eq!(result_a, b"bo");
        assert_eq!(result_b, b"dy");
    }

    #[test]
    fn failed_lane_allocation_does_not_spend_an_incarnation_and_foreign_root_rejects_access() {
        let (a_files, _, _, a_table, a_fd) = files(502);
        let Err((error, mut a_files)) = Root::new(a_files, usize::MAX) else {
            panic!("oversized lane arena must return Files")
        };
        assert_eq!(error, Error::Capacity);
        let hold = a_files.reserve_read(&a_table, a_fd, 1).unwrap();
        a_files.abort_read(hold);
        let mut a = Root::new(a_files, 1).ok().unwrap();
        let (b_files, _, _, b_table, b_fd) = files(504);
        let mut b = Root::new(b_files, 1).ok().unwrap();
        assert_eq!(
            a.destination(Limits {
                pins: 1,
                entries: usize::MAX,
                bytes: 1
            })
            .unwrap_err(),
            Error::Capacity
        );
        assert!(a.registry.lanes.is_empty());
        let limits = || Limits {
            pins: 1,
            entries: 1,
            bytes: 1,
        };
        let (ap, ac) = a.destination(limits()).unwrap();
        let (bp, bc) = b.destination(limits()).unwrap();
        assert_eq!(ap.0.lane, bp.0.lane);
        assert_eq!(a.writer(&bp).err().unwrap(), Error::BadDestination);
        assert_eq!(b.reader(&ac).err().unwrap(), Error::BadDestination);
        let foreign = b.files.reserve_read(&b_table, b_fd, 1).unwrap();
        assert_eq!(
            a.writer(&ap)
                .unwrap()
                .pin_prefix(&foreign, n(1))
                .unwrap_err(),
            Error::Source(FilesError::BadHandle)
        );
        b.files.abort_read(foreign);
        assert_eq!(a.reader(&ac).unwrap().front_bytes(), Ok(None));
        assert_eq!(b.reader(&bc).unwrap().front_bytes(), Ok(None));
        a.files.let_go(a_table).unwrap();
        b.files.let_go(b_table).unwrap();
    }

    #[cfg(feature = "queued-output-probe")]
    #[test]
    fn a_probe_registry_cannot_be_paired_with_foreign_files_even_at_equal_slots() {
        let (mut a, _, _, at, af) = files(502);
        let (mut b, _, _, bt, bf) = files(504);
        let mut probe = QueueProbe::new(&mut a).unwrap();
        assert_eq!(af, bf);
        assert_eq!(
            probe.publish(&mut b, &bt, bf, 0, 2),
            Err(QueueProbeError::Owner)
        );
        assert_eq!(b.offset(&bt, bf), Ok((0, 0)));
        assert_eq!(probe.publish(&mut a, &at, af, 0, 2), Ok(2));
        assert_eq!(probe.peek(&mut b, 0, 0), Err(QueueProbeError::Owner));
        assert_eq!(probe.discard(&mut b, 0), Err(QueueProbeError::Owner));
        assert_eq!(probe.peek(&mut a, 0, 0), Ok((2, b'b')));
        assert_eq!(probe.discard(&mut a, 0), Ok(true));
        assert_eq!(a.offset(&at, af), Ok((2, 1)));
    }

    #[test]
    fn same_files_registries_do_not_share_destinations_even_at_equal_local_slots() {
        let (mut files, _, _, table, _) = files(502);
        let mut first = LaneRegistry::new(&mut files, 1).unwrap();
        let mut second = LaneRegistry::new(&mut files, 1).unwrap();
        let limits = || Limits {
            bytes: 1,
            entries: 1,
            pins: 1,
        };
        let (old, old_reader) = first.destination(limits()).unwrap();
        let (live, live_reader) = second.destination(limits()).unwrap();
        assert_eq!(old.0.lane, live.0.lane);
        assert!(matches!(
            second.writer(&mut files, &old),
            Err(Error::BadDestination)
        ));
        assert!(matches!(
            first.reader(&mut files, &live_reader),
            Err(Error::BadDestination)
        ));

        let old_r = first
            .writer(&mut files, &old)
            .unwrap()
            .reserve(n(1))
            .unwrap();
        let live_r = second
            .writer(&mut files, &live)
            .unwrap()
            .reserve(n(1))
            .unwrap();
        assert_eq!(old_r.0.key, live_r.0.key);
        let mut write = second.writer(&mut files, &live).unwrap();
        let (error, old_r) = write.publish_copy(old_r, b"Z").unwrap_err();
        assert_eq!(error, Error::BadReservation);
        write.publish_copy(live_r, b"A").unwrap();
        first
            .writer(&mut files, &old)
            .unwrap()
            .cancel(old_r)
            .unwrap();
        assert_eq!(
            first.reader(&mut files, &old_reader).unwrap().front_bytes(),
            Ok(None)
        );
        drop(first);
        assert!(matches!(
            second.reader(&mut files, &old_reader),
            Err(Error::BadDestination)
        ));
        assert_eq!(
            second
                .reader(&mut files, &live_reader)
                .unwrap()
                .front_bytes(),
            Ok(Some(&b"A"[..])),
        );
        files.let_go(table).unwrap();
    }

    #[test]
    fn registry_issuance_does_not_wrap_or_spend_serial_on_allocation_rejection() {
        let (mut files, _, _, table, _) = files(502);
        files.next_output_registry = NonZeroU64::new(u64::MAX);
        assert!(matches!(
            LaneRegistry::new(&mut files, usize::MAX),
            Err(Error::Capacity)
        ));
        let last = LaneRegistry::new(&mut files, 1).unwrap();
        assert_eq!(last.id.serial.get(), u64::MAX);
        drop(last);
        for _ in 0..2 {
            assert!(matches!(
                LaneRegistry::new(&mut files, 1),
                Err(Error::Source(FilesError::Overflow))
            ));
        }
        files.let_go(table).unwrap();
    }

    #[test]
    fn held_captured_output_survives_aliases_and_fd_reuse_without_becoming_physical() {
        use super::super::{StreamDirection, Target};
        let (mut files, _, _, old_table, _) = files(502);
        files.let_go(old_table).unwrap();
        let mut root = Root::new(files, 2).ok().unwrap();
        let limits = || Limits {
            bytes: 2,
            entries: 2,
            pins: 0,
        };
        let (stdout, consumer) = root.destination(limits()).unwrap();
        let (stderr, error_consumer) = root.destination(limits()).unwrap();
        let mut other = LaneRegistry::new(&mut root.files, 1).unwrap();
        let (foreign, _) = other.destination(limits()).unwrap();
        assert_eq!(stdout.0.lane, foreign.0.lane);
        let table = root.queued_stdio(1, [&stdout, &stderr], 8).unwrap();
        assert_eq!(root.files.target(&table, 1), Ok(Target::CapturedOutput));
        assert_eq!(
            root.files
                .hold_stream(&table, 1, StreamDirection::Write)
                .unwrap_err(),
            FilesError::NotSupported,
        );
        assert_eq!(
            root.files.hold_output(&table, 0).unwrap_err(),
            FilesError::NotSupported
        );
        let alias = root.files.dup(&table, 1, 3, false).unwrap();
        let forked = root.files.fork(&table).unwrap();
        let held = root.files.hold_output(&table, 1).unwrap();
        let via_alias = root.files.hold_output(&forked, alias).unwrap();
        let different = root.files.hold_output(&forked, 2).unwrap();
        assert!(matches!(
            other.held_writer(&mut root.files, &held),
            Err(Error::BadDestination)
        ));

        root.files.close(&table, 1).unwrap();
        assert_eq!(root.files.dup(&table, 0, 1, false), Ok(1));
        assert_eq!(
            root.files.target(&table, 1),
            Ok(Target::HostStream {
                endpoint: 1,
                direction: StreamDirection::Read
            }),
        );
        assert_eq!(
            root.files.hold_output(&table, 1).unwrap_err(),
            FilesError::NotSupported
        );
        root.files.let_go(table).unwrap();
        root.files.let_go(forked).unwrap();
        drop((stdout, stderr));
        for (hold, byte) in [(&held, b"A"), (&via_alias, b"B"), (&different, b"!")] {
            let mut writer = root.held_writer(hold).unwrap();
            let reservation = writer.reserve(n(1)).unwrap();
            writer.publish_copy(reservation, byte).unwrap();
        }
        let (mut foreign_files, _, _, other_table, _) = self::files(504);
        let (error, held) = foreign_files.release_output(held).unwrap_err();
        assert_eq!(error, FilesError::BadHandle);
        foreign_files.let_go(other_table).unwrap();
        for hold in [held, via_alias, different] {
            root.files.release_output(hold).unwrap();
        }
        let mut reader = root.reader(&consumer).unwrap();
        for expected in [b"A", b"B"] {
            assert_eq!(reader.front_bytes(), Ok(Some(&expected[..])));
            assert!(reader.discard_front());
        }
        assert_eq!(reader.front_bytes(), Ok(None));
        assert_eq!(
            root.reader(&error_consumer).unwrap().front_bytes(),
            Ok(Some(&b"!"[..]))
        );
    }

    #[test]
    fn captured_stdio_refuses_foreign_or_partial_install_and_can_explicitly_share_a_lane() {
        let (mut files, _, _, old_table, _) = files(502);
        files.let_go(old_table).unwrap();
        let mut root = Root::new(files, 1).ok().unwrap();
        let spec = || Limits {
            bytes: 2,
            entries: 2,
            pins: 0,
        };
        let (a, consumer) = root.destination(spec()).unwrap();
        let mut second = LaneRegistry::new(&mut root.files, 1).unwrap();
        let (b, _) = second.destination(spec()).unwrap();
        assert_eq!(
            root.queued_stdio(1, [&a, &b], 8).unwrap_err(),
            Error::BadDestination
        );
        assert_eq!(
            root.queued_stdio(0, [&a, &a], 8).unwrap_err(),
            Error::Source(FilesError::BadHandle)
        );
        assert_eq!(
            root.queued_stdio(1, [&a, &a], 2).unwrap_err(),
            Error::Source(FilesError::Capacity)
        );
        root.files.limits.descriptions = 2;
        assert_eq!(
            root.queued_stdio(1, [&a, &a], 8).unwrap_err(),
            Error::Source(FilesError::Capacity)
        );
        assert_eq!(root.files.live_slots, 0);
        assert!(root.files.descriptions.iter().all(|c| c.value.is_none()));
        assert!(root.files.tables.iter().all(|c| c.value.is_none()));
        root.files.limits.descriptions = 8;
        let table = root.queued_stdio(1, [&a, &a], 8).unwrap();
        let stdout = root.files.hold_output(&table, 1).unwrap();
        let stderr = root.files.hold_output(&table, 2).unwrap();
        for (hold, byte) in [(stdout, b"1"), (stderr, b"2")] {
            let mut writer = root.held_writer(&hold).unwrap();
            let reservation = writer.reserve(n(1)).unwrap();
            writer.publish_copy(reservation, byte).unwrap();
            root.files.release_output(hold).unwrap();
        }
        let mut reader = root.reader(&consumer).unwrap();
        assert_eq!(reader.front_bytes(), Ok(Some(&b"1"[..])));
        assert!(reader.discard_front());
        assert_eq!(reader.front_bytes(), Ok(Some(&b"2"[..])));
        root.files.let_go(table).unwrap();
    }

    #[test]
    fn captured_output_continuation_never_issues_a_physical_command_or_source_preparation() {
        use crate::execution::{Execution, ImageResult};
        use crate::lease::Domain;
        use crate::read::{ReadCapacity, Reads};
        use crate::syscall::{Continuation, Step};
        let mut tree = Tree::new(501, 8, 8, 32, made(0o755)).unwrap();
        let input = tree
            .lazy_file(tree.root(), b"lazy", made(0o600), 7, 2)
            .unwrap();
        let files = Files::new(
            502,
            tree,
            FilesLimits {
                contexts: 0,
                tables: 4,
                descriptions: 8,
                slots: 12,
            },
        );
        let mut root = Root::new(files, 1).ok().unwrap();
        let (producer, consumer) = root
            .destination(Limits {
                bytes: 2,
                entries: 1,
                pins: 1,
            })
            .unwrap();
        let captured = root.queued_stdio(1, [&producer, &producer], 8).unwrap();
        let input_fd = root.files.open(&captured, input, false).unwrap() as u64;
        let alias = root.files.dup(&captured, 1, 4, false).unwrap() as u64;
        let physical = root.files.stdio([1, 2, 3], 8).unwrap();
        let before = root.files.next_read_reservation;
        let mut reads = Reads::new(&root.files, ReadCapacity::new(1).unwrap());
        let mut domain = Domain::new(503, 1, 4).unwrap();
        let binding = domain.bind(16).unwrap();
        let mut execution = Execution::new(1, binding);
        execution.image_begin(&mut domain, 16).unwrap();
        execution
            .image_finish(&mut domain, ImageResult::Installed)
            .unwrap();
        let mut continuation = Continuation::new(&execution).unwrap();
        let invocation = execution.start(&mut domain).unwrap();
        let marker = domain.effect(execution.binding(), 0).unwrap();
        domain.cancel(marker).unwrap();
        domain.retire(marker).unwrap();
        let cases = [
            (0, [alias, 0, 1, 0, 0, 0], Step::Return(-9)),
            (1, [alias, 0, 1, 0, 0, 0], Step::Unsupported(1)),
            (1, [alias, 0, 0, 0, 0, 0], Step::Unsupported(1)),
            (20, [alias, 0, 1, 0, 0, 0], Step::Unsupported(20)),
            (18, [alias, 0, 1, 0, 0, 0], Step::Unsupported(18)),
            (40, [alias, input_fd, 0, 1, 0, 0], Step::Unsupported(40)),
            (40, [alias, input_fd, 0, 0, 0, 0], Step::Unsupported(40)),
        ];
        let mut sequence = 1;
        for (nr, args, expected) in cases {
            assert_eq!(
                continuation.enter_sequenced(
                    &mut root.files,
                    &captured,
                    None,
                    &mut reads,
                    &mut domain,
                    &mut execution,
                    invocation,
                    sequence,
                    nr,
                    args,
                    0,
                ),
                Ok(expected)
            );
            assert!(!continuation.sendfile_pending());
            assert!(execution.syscall_allowed(invocation).is_ok());
            sequence += 1;
        }
        assert_eq!(root.files.next_read_reservation, before);
        assert_eq!(root.files.offset(&captured, input_fd as u32), Ok((0, 0)));
        assert_eq!(root.reader(&consumer).unwrap().front_bytes(), Ok(None));
        assert!(continuation
            .enter_sequenced(
                &mut root.files,
                &captured,
                None,
                &mut reads,
                &mut domain,
                &mut execution,
                invocation,
                sequence - 1,
                1,
                [1, 0, 1, 0, 0, 0],
                0,
            )
            .is_err());
        let Step::Stream {
            endpoint,
            action,
            write,
            ..
        } = continuation
            .enter_sequenced(
                &mut root.files,
                &physical,
                None,
                &mut reads,
                &mut domain,
                &mut execution,
                invocation,
                sequence,
                1,
                [1, 0, 1, 0, 0, 0],
                0,
            )
            .unwrap()
        else {
            panic!("physical control");
        };
        assert_eq!(
            (endpoint, write, action.sequence()),
            (2, true, marker.sequence() + 1)
        );
        assert!(continuation
            .abandon(&mut root.files, &mut reads, &mut domain, &mut execution)
            .unwrap());
        root.files.let_go(captured).unwrap();
        root.files.let_go(physical).unwrap();
    }

    #[test]
    fn staged_capture_moves_its_exact_allocation_in_mixed_acceptance_order() {
        let (mut files, _, inode, old, _) = files(502);
        files.let_go(old).unwrap();
        let mut root = Root::new(files, 1).ok().unwrap();
        let (producer, consumer) = root
            .destination(Limits {
                bytes: 3,
                entries: 3,
                pins: 1,
            })
            .unwrap();
        let table = root.queued_stdio(1, [&producer, &producer], 8).unwrap();
        let source_fd = root.files.open(&table, inode, false).unwrap();
        let first = root.files.hold_output(&table, 1).unwrap();
        let alias = root.files.hold_output(&table, 2).unwrap();
        let source = root.files.reserve_read(&table, source_fd, 1).unwrap();
        let mut writer = root.held_writer(&alias).unwrap();
        let last = writer.stage_write(n(1)).unwrap();
        let middle = writer.reserve(n(1)).unwrap();
        let mut writer = root.held_writer(&first).unwrap();
        let early = writer.stage_write(n(1)).unwrap();
        let pointer = early.bytes.as_ptr();
        assert_eq!(early.bytes, b"\0");
        assert_eq!(root.reader(&consumer).unwrap().front_bytes(), Ok(None));
        let mut input = [b'A'];
        let ready = early.copy_from(&input).unwrap();
        input[0] = b'C';
        root.held_writer(&first)
            .unwrap()
            .publish_staged(ready)
            .unwrap();
        let mut writer = root.held_writer(&alias).unwrap();
        let pin = writer.pin_prefix(&source, n(1)).unwrap();
        writer.publish(middle, pin, source).unwrap();
        writer
            .publish_staged(last.copy_from(&input).unwrap())
            .unwrap();
        input[0] = b'!';
        assert_eq!(root.files.offset(&table, source_fd), Ok((1, 1)));
        root.files.let_go(table).unwrap();
        root.files.release_output(first).unwrap();
        root.files.release_output(alias).unwrap();
        drop(producer);
        let mut reader = root.reader(&consumer).unwrap();
        assert_eq!(reader.front_bytes().unwrap().unwrap().as_ptr(), pointer);
        for expected in [b"A", b"b", b"C"] {
            assert_eq!(reader.front_bytes(), Ok(Some(&expected[..])));
            assert!(reader.discard_front());
        }
        assert_eq!(reader.front_bytes(), Ok(None));
        assert_eq!(input, b"!"[..]);
    }

    #[test]
    fn staged_capture_rejects_short_input_foreign_owner_and_closed_publication() {
        let (mut a, _, _) = owner(502, 2, 1, 0);
        let (mut b, _, _) = owner(504, 2, 1, 0);
        let stage = a.stage_write(n(2)).unwrap();
        let key = stage.reservation.0.key;
        assert_eq!(a.reserve(n(1)).unwrap_err(), Error::Full);
        let (error, stage) = stage.copy_from(b"A").unwrap_err();
        assert_eq!(error, Error::Length);
        assert_eq!(stage.bytes, b"\0\0");
        let local = b.stage_write(n(2)).unwrap();
        assert_eq!(local.reservation.0.key, key);
        let (error, ready) = b
            .publish_staged(stage.copy_from(b"AB").unwrap())
            .unwrap_err();
        assert_eq!(error, Error::BadReservation);
        let (error, ready) = b.cancel_staged(ready).unwrap_err();
        assert_eq!(error, Error::BadReservation);
        assert_eq!(b.used, 2);
        b.cancel_staged(local).unwrap();

        a.close_admission();
        let (error, ready) = a.publish_staged(ready).unwrap_err();
        assert_eq!(error, Error::Closed);
        assert_eq!(ready.bytes, b"AB");
        assert_eq!(a.front_bytes(), Ok(None));
        a.cancel_staged(ready).unwrap();
        assert_eq!(a.used, 0);
        assert!(a.entries.get(key).is_none());
    }

    #[test]
    fn staged_capture_keeps_credits_reusable_after_allocation_failure_and_guest_lost() {
        use crate::execution::{Execution, ImageResult, Unwind};
        use crate::lease::Domain;
        let (mut out, _, _) = owner(502, usize::MAX, 1, 0);
        assert_eq!(
            out.stage_write(n(isize::MAX as usize + 1)).unwrap_err(),
            Error::Capacity
        );
        assert_eq!(out.used, 0);
        assert_eq!(out.front_bytes(), Ok(None));
        let mut domain = Domain::new(505, 1, 4).unwrap();
        let mut execution = Execution::new(1, domain.bind(16).unwrap());
        execution.image_begin(&mut domain, 16).unwrap();
        execution
            .image_finish(&mut domain, ImageResult::Installed)
            .unwrap();
        let invocation = execution.start(&mut domain).unwrap();
        execution.hold_call(invocation).unwrap();
        let stage = out.stage_write(n(1)).unwrap();
        let old = stage.reservation.0.key;
        assert_eq!((old.index, old.generation), (0, 2));
        execution.check_held_call_live(invocation).unwrap();
        let ready = stage.copy_from(b"A").unwrap();
        execution.request_exit(invocation, 0).unwrap();
        assert!(execution.check_held_call_live(invocation).is_err());
        // The future caller's before-publish gate rejects after an actual
        // capture too. No bytes were accepted and credits can be reclaimed.
        out.cancel_staged(ready).unwrap();
        execution.finish_call(invocation).unwrap();
        execution
            .receipt(&mut domain, invocation, Unwind::Exit)
            .unwrap();
        assert_eq!(out.front_bytes(), Ok(None));
        let fresh = out.stage_write(n(1)).unwrap();
        assert_eq!(fresh.reservation.0.key.index, old.index);
        assert_ne!(fresh.reservation.0.key.generation, old.generation);
        assert_eq!(
            out.publish_staged(fresh.copy_from(b"Z").unwrap()).unwrap(),
            n(1)
        );
        assert_eq!(out.front_bytes(), Ok(Some(&b"Z"[..])));
    }

    #[test]
    fn guest_exit_before_first_input_cannot_publish_and_exit_after_acceptance_cannot_erase() {
        use crate::execution::{Execution, ImageResult, Unwind};
        use crate::lease::Domain;
        for accepted in [false, true] {
            let (mut out, _, _) = owner(502, 1, 1, 0);
            let mut domain = Domain::new(505, 1, 4).unwrap();
            let mut execution = Execution::new(1, domain.bind(16).unwrap());
            execution.image_begin(&mut domain, 16).unwrap();
            execution
                .image_finish(&mut domain, ImageResult::Installed)
                .unwrap();
            let invocation = execution.start(&mut domain).unwrap();
            execution.hold_call(invocation).unwrap();
            let stage = out.stage_write(n(1)).unwrap();
            if accepted {
                execution.check_held_call_live(invocation).unwrap();
                let ready = stage.copy_from(b"A").unwrap();
                execution.check_held_call_live(invocation).unwrap();
                out.publish_staged(ready).unwrap();
                execution.request_exit(invocation, 0).unwrap();
            } else {
                execution.request_exit(invocation, 0).unwrap();
                assert!(execution.check_held_call_live(invocation).is_err());
                out.cancel_staged(stage).unwrap();
            }
            assert!(!execution.invocation_accepts_result(invocation));
            execution.finish_call(invocation).unwrap();
            execution
                .receipt(&mut domain, invocation, Unwind::Exit)
                .unwrap();
            assert_eq!(out.front_bytes(), Ok(accepted.then_some(&b"A"[..])),);
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
