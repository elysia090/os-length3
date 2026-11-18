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
use super::fs_context::{self, Base, Contexts};
use super::inode::{Inode, Tree};
use super::mount::{self, Mounts, Place, Ticket};
use std::collections::HashMap;
use std::num::{NonZeroU64, NonZeroUsize};

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
    FdLimit,
    NotDirectory,
    Capacity,
    Overflow,
    NotSupported,
    Busy,
    Payload,
    State,
    Source(super::inode::Error),
    Mount(mount::Error),
    Fs(fs_context::Error),
}
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub contexts: usize,
    pub tables: usize,
    pub descriptions: usize,
    pub slots: usize,
}
struct Cell<T> {
    generation: u64,
    value: Option<T>,
}
/// Exact namespace/credential inputs retained by one guest open operation.
/// Dropping this route is not release; the owning continuation must return it.
#[must_use = "release through Files::release_open_route after the operation ends"]
pub(crate) struct OpenRoute {
    owner: u64,
    fs: fs_context::Ticket,
    credentials: crate::credentials::Credentials,
    base: OpenBase,
}
enum OpenBase {
    Cwd,
    Held(mount::Hold),
    Failed(Error),
}
impl std::fmt::Debug for OpenRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenRoute")
            .field("owner", &self.owner)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct OpenOptions {
    pub directory: bool,
    pub follow_terminal: bool,
    pub cloexec: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OpenError {
    Path(crate::path::Error),
    Files(Error),
    Access,
    NotDirectory,
    Loop,
    Unsupported,
}
impl From<Error> for OpenError {
    fn from(error: Error) -> Self {
        Self::Files(error)
    }
}
impl From<crate::path::Error> for OpenError {
    fn from(error: crate::path::Error) -> Self {
        Self::Path(error)
    }
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StreamDirection {
    Read,
    Write,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    File(Inode),
    HostStream {
        endpoint: u64,
        direction: StreamDirection,
    },
}
#[derive(Debug)]
#[must_use = "release after host access has stopped; dropping retains the description"]
pub(crate) struct StreamHold(Id);
struct Description {
    refs: u64,
    target: DescriptionTarget,
}
enum DescriptionTarget {
    File(FileDescription),
    HostStream {
        endpoint: u64,
        direction: StreamDirection,
    },
}
struct FileDescription {
    place: Option<mount::Hold>,
    inode: Inode,
    offset: u64,
    revision: u64,
    reading: Option<NonZeroU64>,
}
impl Description {
    fn file(&self) -> Result<&FileDescription, Error> {
        match &self.target {
            DescriptionTarget::File(f) => Ok(f),
            _ => Err(Error::NotSupported),
        }
    }
    fn file_mut(&mut self) -> Result<&mut FileDescription, Error> {
        match &mut self.target {
            DescriptionTarget::File(f) => Ok(f),
            _ => Err(Error::NotSupported),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreparationPhase {
    Reserved,
    Loading(u32),
    Ready,
    Failed,
}
/// One OFD reservation before source materialization. Its phase describes this
/// request's command lifecycle, never a second inode source/loading authority.
#[must_use = "capture or abort after any dispatched loader has stopped"]
#[derive(Debug)]
pub(crate) struct ReadPreparation {
    reservation: NonZeroU64,
    description: Id,
    inode: Inode,
    offset: u64,
    requested: u64,
    next_revision: u64,
    phase: PreparationPhase,
}
/// Held executable selection, not committed execution credentials. No FD/OFD is
/// created. Storage remains owned by Files; the hold retains this precise view.
/// Dropping instead of release retains the mount until Files ends. Source writes,
/// replacement and eviction are not exposed; those require an additional pin gate.
#[must_use = "finish a dispatched source before releasing the program"]
pub(crate) struct Program {
    selected_path: Vec<u8>,
    owner: u64,
    place: mount::Hold,
    decision: crate::credentials::Decision,
    phase: PreparationPhase,
}
impl Program {
    /// Startup-only execfn proposal: exact selection bytes, not canonicalized or
    /// derived from argv[0]. The caller must not supply a replacement execfn.
    pub(crate) fn execfn(&self) -> &[u8] {
        &self.selected_path
    }
}
impl std::fmt::Debug for Program {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Program")
            .field("owner", &self.owner)
            .field("phase", &self.phase)
            .finish_non_exhaustive()
    }
}
/// Initial-startup proposal with completed source delivery. Not a published
/// execution identity. No mutable source/eviction API currently exists.
#[must_use = "publish into a live execution or release through Files"]
pub(crate) struct ReadyProgram {
    selected_path: Vec<u8>,
    owner: u64,
    place: mount::Hold,
    decision: crate::credentials::Decision,
}
/// Exact metadata-only selection. Payload residency/loading is not part of this
/// identity; the immutable Files owner retains the canonical source incarnation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProgramIdentity {
    pub inode: Inode,
    pub source: u32,
    pub size: usize,
}
/// Authorized program ready for image construction, NOT a claim that canonical
/// bytes are resident. Constructed from completed fresh delivery or an exact
/// prepared-artifact receipt; it cannot be used by ready_program_bytes.
#[must_use = "publish into an execution or release through Files"]
pub(crate) struct ImageProgram {
    selected_path: Vec<u8>,
    owner: u64,
    place: mount::Hold,
    decision: crate::credentials::Decision,
}
/// Live execution ownership. Dropping retains the hold until Files ends; the
/// execution coordinator must release only after its own stopped-use proof.
#[must_use = "retain for the live execution, then release through Files"]
pub(crate) struct Executable {
    owner: u64,
    place: mount::Hold,
}
impl std::fmt::Debug for ReadyProgram {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReadyProgram")
            .field("owner", &self.owner)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Debug for Executable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Executable")
            .field("owner", &self.owner)
            .finish_non_exhaustive()
    }
}
impl ReadyProgram {
    /// The same owned path used for selection, moved without another copy.
    pub(crate) fn execfn(&self) -> &[u8] {
        &self.selected_path
    }
    /// Aux-vector proposal only, not permission to change live credentials.
    pub(crate) fn stack_credentials(&self) -> crate::stack::Credentials {
        self.decision.stack_credentials()
    }
    /// Infallible ownership move for the coordinator's publication commit.
    /// No allocation, callback, source access or mount release occurs here.
    pub(crate) fn into_image(self) -> ImageProgram {
        ImageProgram {
            selected_path: self.selected_path,
            owner: self.owner,
            place: self.place,
            decision: self.decision,
        }
    }
    pub(crate) fn publish(self) -> (Executable, crate::credentials::Decision) {
        self.into_image().publish()
    }
}
impl ImageProgram {
    pub(crate) fn execfn(&self) -> &[u8] {
        &self.selected_path
    }
    pub(crate) fn stack_credentials(&self) -> crate::stack::Credentials {
        self.decision.stack_credentials()
    }
    pub(crate) fn publish(self) -> (Executable, crate::credentials::Decision) {
        (
            Executable {
                owner: self.owner,
                place: self.place,
            },
            self.decision,
        )
    }
}
#[derive(Debug)]
pub(crate) enum ProgramError {
    Path(crate::path::Error),
    Credentials(crate::credentials::Error),
    Files(Error),
}
/// Snapshot of a command issued by Store; not a separately mutable source state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LoadRequest {
    pub source: u32,
    pub attempt: u32,
}
/// Owned pending reference to one OFD, not an fd number. Only Files resolves it.
#[must_use = "finish or abort the read reservation; dropping retains the OFD reference"]
pub(crate) struct ReadHold {
    reservation: NonZeroU64,
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
    contexts: Contexts,
    limits: Limits,
    tables: Vec<Cell<TableState>>,
    descriptions: Vec<Cell<Description>>,
    live_slots: usize,
    // Every read admission, including a later abort/count0, gets a distinct
    // incarnation. Offset revision alone cannot identify an aborted attempt.
    next_read_reservation: Option<NonZeroU64>,
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
    /// Owner incarnation; never reuse while any operation or handle can reference it.
    pub(crate) fn owner(&self) -> u64 {
        self.owner
    }
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
            contexts: Contexts::new(owner, limits.contexts),
            limits,
            tables: Vec::new(),
            descriptions: Vec::new(),
            live_slots: 0,
            next_read_reservation: Some(NonZeroU64::MIN),
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
        if fd >= state.limit {
            return Err(Error::FdLimit);
        }
        if self.live_slots >= self.limits.slots {
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
    /// Internal context creation; bounds are independent of FD-table capacity.
    pub(crate) fn create_fs(
        &mut self,
        root: &Place,
        cwd: &Place,
        umask: u32,
    ) -> Result<fs_context::Ticket, Error> {
        self.directory_place(root)?;
        self.directory_place(cwd)?;
        self.contexts
            .create(
                self.mounts.as_mut().ok_or(Error::BadHandle)?,
                root,
                cwd,
                umask,
            )
            .map_err(Error::Fs)
    }
    fn directory_place(&self, place: &Place) -> Result<(), Error> {
        self.mounts
            .as_ref()
            .ok_or(Error::BadHandle)?
            .validate(place)
            .map_err(Error::Mount)?;
        if self
            .filesystems
            .metadata(place.inode())
            .map_err(|_| Error::BadHandle)?
            .mode
            & 0o170000
            != 0o040000
        {
            return Err(Error::NotSupported);
        }
        Ok(())
    }
    pub(crate) fn share_fs(
        &mut self,
        ticket: &fs_context::Ticket,
    ) -> Result<fs_context::Ticket, Error> {
        self.contexts.share(ticket).map_err(Error::Fs)
    }
    pub(crate) fn copy_fs(
        &mut self,
        ticket: &fs_context::Ticket,
    ) -> Result<fs_context::Ticket, Error> {
        self.contexts
            .copy(self.mounts.as_mut().ok_or(Error::BadHandle)?, ticket)
            .map_err(Error::Fs)
    }
    /// Select an existing prepared cwd. No implicit mkdir or host-path lookup.
    /// Resolve and authorize synchronously before the single position exchange;
    /// failure leaves the old cwd owned by this FsContext.
    pub(crate) fn select_cwd(
        &mut self,
        fs: &fs_context::Ticket,
        credentials: &crate::credentials::Credentials,
        path: &[u8],
    ) -> Result<(), crate::path::Error> {
        let place = crate::path::resolve(self, fs, credentials, path)?;
        let metadata = self.place_metadata(&place)?;
        if metadata.mode & 0o170000 != 0o040000 {
            return Err(crate::path::Error::NotDirectory);
        }
        if !credentials.may(&metadata, crate::credentials::Access::Search) {
            return Err(crate::path::Error::Access);
        }
        self.change_fs(fs, Base::Cwd, &place)?;
        Ok(())
    }
    /// Internal position exchange, not guest chdir/chroot authorization.
    pub(crate) fn change_fs(
        &mut self,
        ticket: &fs_context::Ticket,
        base: Base,
        place: &Place,
    ) -> Result<(), Error> {
        self.directory_place(place)?;
        self.contexts
            .change(
                self.mounts.as_mut().ok_or(Error::BadHandle)?,
                ticket,
                base,
                place,
            )
            .map_err(Error::Fs)
    }
    /// Owned nonholding position for a synchronous path walk. The Fs ticket
    /// keeps its starting view alive; callers must hold a resolved route before
    /// any asynchronous use. No namespace mutation/callback occurs in the walk.
    pub(crate) fn fs_start(&self, ticket: &fs_context::Ticket, base: Base) -> Result<Place, Error> {
        let mounts = self.mounts.as_ref().ok_or(Error::BadHandle)?;
        let place = self
            .contexts
            .position_ref(mounts, ticket, base)
            .map_err(Error::Fs)?;
        mounts.copy_position(place).map_err(Error::Mount)
    }
    /// A nonholding copy only within a callback-free synchronous path walk.
    pub(crate) fn copy_place(&self, place: &Place) -> Result<Place, Error> {
        self.mounts
            .as_ref()
            .ok_or(Error::BadHandle)?
            .copy_position(place)
            .map_err(Error::Mount)
    }
    fn pin_directory_fd(&mut self, table: &Table, fd: u32) -> Result<mount::Hold, Error> {
        let d = get(&self.descriptions, self.owner, self.description(table, fd)?)?;
        let DescriptionTarget::File(file) = &d.target else {
            return Err(Error::NotDirectory);
        };
        if self
            .filesystems
            .metadata(file.inode)
            .map_err(|_| Error::BadHandle)?
            .mode
            & 0o170000
            != 0o040000
        {
            return Err(Error::NotDirectory);
        }
        let hold = file.place.as_ref().ok_or(Error::NotSupported)?;
        self.mounts
            .as_mut()
            .ok_or(Error::BadHandle)?
            .copy_hold(hold)
            .map_err(Error::Mount)
    }
    /// Capture all mutable lookup bases before admitting physical pathname work.
    /// A bad/unsupported/capacity-limited dirfd candidate is not reported yet:
    /// an absolute pathname must ignore it, while a relative one uses this result.
    pub(crate) fn prepare_open_route(
        &mut self,
        table: &Table,
        fs: &fs_context::Ticket,
        credentials: &crate::credentials::Credentials,
        dirfd: i32,
    ) -> Result<OpenRoute, Error> {
        self.state(table)?;
        let fs = self.copy_fs(fs)?;
        let base = if dirfd == -100 {
            OpenBase::Cwd
        } else {
            match self.pin_directory_fd(table, dirfd as u32) {
                Ok(hold) => OpenBase::Held(hold),
                Err(error) => OpenBase::Failed(error),
            }
        };
        Ok(OpenRoute {
            owner: self.owner,
            fs,
            credentials: credentials.clone(),
            base,
        })
    }
    /// Resolve, authorize and publish one read-only OFD without a host callback.
    /// No canonical payload is demanded. The route remains owned on every result.
    pub(crate) fn open_read(
        &mut self,
        table: &Table,
        route: &OpenRoute,
        path: &[u8],
        options: OpenOptions,
    ) -> Result<u32, OpenError> {
        if route.owner != self.owner {
            return Err(Error::BadHandle.into());
        }
        // getname/empty/length precede FD admission; a full table precedes
        // relative dirfd, lookup and DAC errors. Capacity reservation has no
        // logical slot effect, and no callback can steal it before publication.
        if path.is_empty() {
            return Err(OpenError::Path(crate::path::Error::NotFound));
        }
        if path.len() > 4095 {
            return Err(OpenError::Path(crate::path::Error::NameTooLong));
        }
        let fd = self.admit_fd(table, 0)?;
        let relative = match &route.base {
            OpenBase::Cwd => Ok(None),
            OpenBase::Held(hold) => self
                .mounts
                .as_ref()
                .ok_or(Error::BadHandle)?
                .position_ref(hold)
                .map(Some)
                .map_err(Error::Mount),
            OpenBase::Failed(error) => Err(*error),
        };
        let place = crate::path::resolve_at(
            self,
            &route.fs,
            &route.credentials,
            path,
            relative,
            options.follow_terminal,
        )?;
        let metadata = self.place_metadata(&place)?;
        let kind = metadata.mode & 0o170000;
        if options.directory && kind != 0o040000 {
            return Err(OpenError::NotDirectory);
        }
        if kind == 0o120000 {
            return Err(OpenError::Loop);
        }
        if kind != 0o100000 && kind != 0o040000 {
            return Err(OpenError::Unsupported);
        }
        if !route
            .credentials
            .may(&metadata, crate::credentials::Access::Read)
        {
            return Err(OpenError::Access);
        }
        self.publish_file(table, fd, place.inode(), options.cloexec, Some(&place))
            .map_err(Into::into)
    }
    /// Release only the same Files owner's route. Validation failure returns its
    /// complete ownership; no mount/context ticket is silently dropped.
    pub(crate) fn release_open_route(
        &mut self,
        route: OpenRoute,
    ) -> Result<(), (Error, OpenRoute)> {
        if route.owner != self.owner {
            return Err((Error::BadHandle, route));
        }
        let OpenRoute {
            owner,
            fs,
            credentials,
            base,
        } = route;
        match self.release_fs(fs) {
            Ok(()) => {
                if let OpenBase::Held(hold) = base {
                    self.mounts.as_mut().unwrap().release_hold(hold);
                }
                Ok(())
            }
            Err((error, fs)) => Err((
                error,
                OpenRoute {
                    owner,
                    fs,
                    credentials,
                    base,
                },
            )),
        }
    }
    /// Metadata from the actual description source, not a pathname or TS shadow.
    pub(crate) fn fd_kind(&self, table: &Table, fd: u32) -> Result<u32, Error> {
        let inode = self.inode(table, fd)?;
        Ok(self
            .filesystems
            .metadata(inode)
            .map_err(|_| Error::BadHandle)?
            .mode
            & 0o170000)
    }
    pub(crate) fn place_metadata(&self, place: &Place) -> Result<crate::inode::Metadata, Error> {
        self.mounts
            .as_ref()
            .ok_or(Error::BadHandle)?
            .validate(place)
            .map_err(Error::Mount)?;
        self.filesystems
            .metadata(place.inode())
            .map_err(|_| Error::BadHandle)
    }
    pub(crate) fn symlink_target<'a>(&'a self, place: &Place) -> Result<&'a [u8], Error> {
        self.mounts
            .as_ref()
            .ok_or(Error::BadHandle)?
            .validate(place)
            .map_err(Error::Mount)?;
        self.filesystems
            .target(place.inode())
            .map_err(|_| Error::BadHandle)
    }
    pub(crate) fn fs_component(
        &self,
        ticket: &fs_context::Ticket,
        base: Base,
        name: &[u8],
    ) -> Result<Option<Place>, Error> {
        let position = self
            .contexts
            .position_ref(self.mounts.as_ref().ok_or(Error::BadHandle)?, ticket, base)
            .map_err(Error::Fs)?;
        self.component(position, name)
    }
    /// Internal mount-aware parent topology, clamped by this FsContext's root.
    /// Not a guest `..` operation: credentials/search and resolve-policy flags
    /// (BENEATH, IN_ROOT, NO_XDEV) are not implemented by this primitive.
    pub(crate) fn fs_parent(
        &self,
        ticket: &fs_context::Ticket,
        from: &Place,
    ) -> Result<Place, Error> {
        let mounts = self.mounts.as_ref().ok_or(Error::BadHandle)?;
        let boundary = self
            .contexts
            .position_ref(mounts, ticket, Base::Root)
            .map_err(Error::Fs)?;
        let mut current = from;
        loop {
            // Reject file/.. before root/detached clamping, and validate every
            // mountpoint crossed. No callback or mutable namespace access occurs.
            self.directory_place(current)?;
            match mounts
                .parent_step(current, boundary)
                .map_err(Error::Mount)?
            {
                mount::ParentStep::Fixed => {
                    return mounts.copy_position(current).map_err(Error::Mount)
                }
                mount::ParentStep::Across(point) => current = point,
                mount::ParentStep::TreeParent => {
                    let Some((parent, _)) = self
                        .filesystems
                        .directory_parent(current.inode())
                        .map_err(|_| Error::BadHandle)?
                    else {
                        return mounts.copy_position(current).map_err(Error::Mount);
                    };
                    let provenance = self
                        .filesystems
                        .directory_parent(parent)
                        .map_err(|_| Error::BadHandle)?;
                    return mounts
                        .parent_position(current, parent, provenance, boundary)
                        .map_err(Error::Mount);
                }
            }
        }
    }
    pub(crate) fn fs_umask(&self, ticket: &fs_context::Ticket) -> Result<u32, Error> {
        self.contexts.umask(ticket).map_err(Error::Fs)
    }
    pub(crate) fn set_fs_umask(
        &mut self,
        ticket: &fs_context::Ticket,
        mask: u32,
    ) -> Result<u32, Error> {
        self.contexts.set_umask(ticket, mask).map_err(Error::Fs)
    }
    pub(crate) fn release_fs(
        &mut self,
        ticket: fs_context::Ticket,
    ) -> Result<(), (Error, fs_context::Ticket)> {
        let Some(mounts) = &mut self.mounts else {
            return Err((Error::BadHandle, ticket));
        };
        self.contexts
            .release(mounts, ticket)
            .map_err(|(error, ticket)| (Error::Fs(error), ticket))
    }
    /// One bootstrap namespace. Existing bare-inode ABI validation stays separate.
    pub(crate) fn bootstrap_mount(
        &mut self,
        root: Inode,
        limits: mount::Limits,
        policy: mount::ViewPolicy,
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
        let (mounts, ticket) =
            Mounts::new(self.owner, root, limits, policy).map_err(Error::Mount)?;
        self.mounts = Some(mounts);
        Ok(ticket)
    }
    /// Query only: syscall/path/executable policy enforcement is not implied.
    pub(crate) fn view_policy(&self, place: &Place) -> Result<mount::ViewPolicy, Error> {
        self.mounts
            .as_ref()
            .ok_or(Error::BadHandle)?
            .policy(place)
            .map_err(Error::Mount)
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
    pub(crate) fn filesystem_view(
        &mut self,
        root: Inode,
        policy: mount::ViewPolicy,
    ) -> Result<Ticket, Error> {
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
            .filesystem_root(root, policy)
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
        self.publish_file(table, fd, inode, cloexec, place)
    }
    /// Caller has validated the inode/place and reserved this lowest free slot.
    /// Lookup/authorization between admission and this call is callback-free.
    fn publish_file(
        &mut self,
        table: &Table,
        fd: u32,
        inode: Inode,
        cloexec: bool,
        place: Option<&Place>,
    ) -> Result<u32, Error> {
        debug_assert_eq!(self.description(table, fd), Err(Error::BadFd));
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
                refs: 1,
                target: DescriptionTarget::File(FileDescription {
                    place,
                    inode,
                    offset: 0,
                    revision: 0,
                    reading: None,
                }),
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
            if let DescriptionTarget::File(FileDescription {
                place: Some(place), ..
            }) = description.target
            {
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
    /// Return ownership unchanged on validation failure. Once validated, release
    /// is infallible: no allocation or external callback occurs below.
    pub(crate) fn let_go(&mut self, table: Table) -> Result<(), (Error, Table)> {
        let holders = match self.state(&table) {
            Ok(state) => state.holders,
            Err(error) => return Err((error, table)),
        };
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
    /// New private table only: no partially initialized stdio table escapes.
    /// Endpoint IDs identify borrowed host resources, never host FD ownership.
    pub(crate) fn stdio(&mut self, endpoints: [u64; 3], limit: u32) -> Result<Table, Error> {
        if endpoints.contains(&0) {
            return Err(Error::BadHandle);
        }
        if limit < 3 {
            return Err(Error::Capacity);
        }
        let table = self.table(limit)?;
        for (i, endpoint) in endpoints.into_iter().enumerate() {
            let result = (|| {
                let fd = self.admit_fd(&table, 0)?;
                let id = prepare(&mut self.descriptions, self.limits.descriptions, self.owner)?;
                let direction = if i == 0 {
                    StreamDirection::Read
                } else {
                    StreamDirection::Write
                };
                publish(
                    &mut self.descriptions,
                    id,
                    Description {
                        refs: 1,
                        target: DescriptionTarget::HostStream {
                            endpoint,
                            direction,
                        },
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
                            cloexec: false,
                        },
                    );
                self.live_slots += 1;
                Ok::<(), Error>(())
            })();
            if let Err(error) = result {
                self.let_go(table).expect("private validated stdio table");
                return Err(error);
            }
        }
        Ok(table)
    }
    pub(crate) fn target(&self, table: &Table, fd: u32) -> Result<Target, Error> {
        let d = get(&self.descriptions, self.owner, self.description(table, fd)?)?;
        Ok(match &d.target {
            DescriptionTarget::File(f) => Target::File(f.inode),
            DescriptionTarget::HostStream {
                endpoint,
                direction,
            } => Target::HostStream {
                endpoint: *endpoint,
                direction: *direction,
            },
        })
    }
    pub(crate) fn hold_stream(
        &mut self,
        table: &Table,
        fd: u32,
        direction: StreamDirection,
    ) -> Result<StreamHold, Error> {
        let id = self.description(table, fd)?;
        let d = get(&self.descriptions, self.owner, id)?;
        match d.target {
            DescriptionTarget::HostStream {
                direction: actual, ..
            } if actual == direction => (),
            DescriptionTarget::HostStream { .. } => return Err(Error::BadFd),
            _ => return Err(Error::NotSupported),
        }
        let refs = d.refs.checked_add(1).ok_or(Error::Overflow)?;
        self.descriptions[id.slot].value.as_mut().unwrap().refs = refs;
        Ok(StreamHold(id))
    }
    pub(crate) fn stream(&self, hold: &StreamHold) -> Result<(u64, StreamDirection), Error> {
        match get(&self.descriptions, self.owner, hold.0)?.target {
            DescriptionTarget::HostStream {
                endpoint,
                direction,
            } => Ok((endpoint, direction)),
            _ => Err(Error::BadHandle),
        }
    }
    pub(crate) fn release_stream(&mut self, hold: StreamHold) -> Result<(), (Error, StreamHold)> {
        if let Err(error) = self.stream(&hold) {
            return Err((error, hold));
        }
        self.release(hold.0);
        Ok(())
    }
    pub(crate) fn offset(&self, table: &Table, fd: u32) -> Result<(u64, u64), Error> {
        let d = get(&self.descriptions, self.owner, self.description(table, fd)?)?;
        let d = d.file()?;
        Ok((d.offset, d.revision))
    }
    pub(crate) fn set_offset(&mut self, table: &Table, fd: u32, offset: u64) -> Result<(), Error> {
        let id = self.description(table, fd)?;
        if get(&self.descriptions, self.owner, id)?
            .file()?
            .reading
            .is_some()
        {
            return Err(Error::Busy);
        }
        let revision = get(&self.descriptions, self.owner, id)?
            .file()?
            .revision
            .checked_add(1)
            .ok_or(Error::Overflow)?;
        let d = self.descriptions[id.slot]
            .value
            .as_mut()
            .unwrap()
            .file_mut()?;
        d.offset = offset;
        d.revision = revision;
        Ok(())
    }
    pub(crate) fn inode(&self, table: &Table, fd: u32) -> Result<Inode, Error> {
        Ok(
            get(&self.descriptions, self.owner, self.description(table, fd)?)?
                .file()?
                .inode,
        )
    }
    pub(crate) fn begin_read(
        &mut self,
        table: &Table,
        fd: u32,
        requested: u64,
    ) -> Result<ReadPreparation, Error> {
        let id = self.description(table, fd)?;
        let d = get(&self.descriptions, self.owner, id)?;
        let refs = d.refs.checked_add(1).ok_or(Error::Overflow)?;
        let d = d.file()?;
        if d.reading.is_some() {
            return Err(Error::Busy);
        }
        let inode = d.inode;
        let offset = d.offset;
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
        let reservation = self.next_read_reservation.ok_or(Error::Overflow)?;
        let d = self.descriptions[id.slot].value.as_mut().unwrap();
        d.refs = refs;
        d.file_mut().expect("validated file admission").reading = Some(reservation);
        self.next_read_reservation = reservation.get().checked_add(1).and_then(NonZeroU64::new);
        Ok(ReadPreparation {
            reservation,
            description: id,
            inode,
            offset,
            requested,
            next_revision: revision,
            phase: PreparationPhase::Reserved,
        })
    }
    /// Resolve, authorize and acquire ownership without callbacks between them.
    /// The proposed credential Decision remains private until an execution commit
    /// protocol exists. No execution/loader attempt is created here.
    pub(crate) fn prepare_program(
        &mut self,
        fs: &fs_context::Ticket,
        credentials: &crate::credentials::Credentials,
        path: &[u8],
    ) -> Result<Program, ProgramError> {
        let place =
            crate::path::resolve(self, fs, credentials, path).map_err(ProgramError::Path)?;
        let metadata = self.place_metadata(&place).map_err(ProgramError::Files)?;
        let policy = self.view_policy(&place).map_err(ProgramError::Files)?;
        let decision = credentials
            .program(&metadata, policy.no_exec, policy.no_suid)
            .map_err(ProgramError::Credentials)?;
        // resolve already bounded the original path to 4095 bytes. Capture only
        // after authorization, before acquiring any hold/source; allocation
        // failure leaves both unchanged. Vec spare capacity is allocator-owned.
        let mut selected_path = Vec::new();
        selected_path
            .try_reserve_exact(path.len())
            .map_err(|_| ProgramError::Files(Error::Capacity))?;
        selected_path.extend_from_slice(path);
        let hold = self
            .mounts
            .as_mut()
            .ok_or(ProgramError::Files(Error::BadHandle))?
            .hold(&place)
            .map_err(|e| ProgramError::Files(Error::Mount(e)))?;
        Ok(Program {
            selected_path,
            owner: self.owner,
            place: hold,
            decision,
            phase: PreparationPhase::Reserved,
        })
    }
    fn program_inode(&self, program: &Program) -> Result<Inode, Error> {
        if program.owner != self.owner {
            return Err(Error::BadHandle);
        }
        self.mounts
            .as_ref()
            .ok_or(Error::BadHandle)?
            .position_ref(&program.place)
            .map(|p| p.inode())
            .map_err(Error::Mount)
    }
    /// Metadata only: never load_begin/read, never source-ready promotion.
    pub(crate) fn program_identity(&mut self, program: &Program) -> Result<ProgramIdentity, Error> {
        self.check_unstarted_program(program)?;
        let inode = self.program_inode(program)?;
        Ok(ProgramIdentity {
            inode,
            source: self.filesystems.source(inode).map_err(Error::Source)?,
            size: self.filesystems.size(inode).map_err(Error::Source)?,
        })
    }
    /// A trusted artifact coordinator has settled its exact preparation job.
    /// The source remains lazy; this is deliberately distinct from ready_program.
    pub(crate) fn prepared_image_program(
        &mut self,
        program: Program,
        expected: ProgramIdentity,
    ) -> Result<ImageProgram, (Error, Program)> {
        match self.program_identity(&program) {
            Ok(actual) if actual == expected => (),
            Ok(_) => return Err((Error::BadHandle, program)),
            Err(error) => return Err((error, program)),
        }
        Ok(ImageProgram {
            selected_path: program.selected_path,
            owner: program.owner,
            place: program.place,
            decision: program.decision,
        })
    }
    pub(crate) fn prepare_program_source(
        &mut self,
        program: &mut Program,
    ) -> Result<Option<LoadRequest>, Error> {
        let inode = self.program_inode(program)?;
        if program.phase != PreparationPhase::Reserved {
            return Err(Error::State);
        }
        program.phase = PreparationPhase::Failed;
        let source = self.filesystems.source(inode).map_err(Error::Source)?;
        let attempt = self.filesystems.load_begin(inode).map_err(Error::Source)?;
        if attempt == 0 {
            program.phase = PreparationPhase::Ready;
            return Ok(None);
        }
        program.phase = PreparationPhase::Loading(attempt);
        Ok(Some(LoadRequest { source, attempt }))
    }
    /// A matching completion attests the callback has stopped, not merely that
    /// cancellation was requested. BadCompletion preserves delivery ownership.
    pub(crate) fn finish_program_source(
        &mut self,
        program: &mut Program,
        attempt: u32,
        success: bool,
        bytes: &mut Vec<u8>,
    ) -> Result<(), Error> {
        let inode = self.program_inode(program)?;
        let PreparationPhase::Loading(expected) = program.phase else {
            return Err(Error::State);
        };
        if expected != attempt {
            return Err(Error::Source(super::inode::Error::Payload(
                sods_file_store::store::Error::BadCompletion,
            )));
        }
        let result = self.filesystems.load_finish(inode, attempt, success, bytes);
        if matches!(
            result,
            Err(super::inode::Error::Payload(
                sods_file_store::store::Error::BadCompletion
            ))
        ) {
            return result.map_err(Error::Source);
        }
        program.phase = if success && result.is_ok() {
            PreparationPhase::Ready
        } else {
            PreparationPhase::Failed
        };
        result.map_err(Error::Source)
    }
    /// Borrow canonical payload synchronously; no whole-program copy or hidden
    /// descriptor. The slice (or a derived raw pointer) must not be retained
    /// across callbacks/await. This is not a transferable translation/source pin.
    pub(crate) fn program_bytes<'a>(&'a mut self, program: &Program) -> Result<&'a [u8], Error> {
        let inode = self.program_inode(program)?;
        if program.phase != PreparationPhase::Ready {
            return Err(Error::State);
        }
        let size = self.filesystems.size(inode).map_err(Error::Source)?;
        self.filesystems.read(inode, 0, size).map_err(Error::Source)
    }
    pub(crate) fn release_program(&mut self, program: Program) -> Result<(), (Error, Program)> {
        if let Err(e) = self.program_inode(&program) {
            return Err((e, program));
        }
        if matches!(program.phase, PreparationPhase::Loading(_)) {
            return Err((Error::Busy, program));
        }
        self.mounts
            .as_mut()
            .expect("validated mount owner")
            .release_hold(program.place);
        Ok(())
    }
    /// Query the source obligation after a completion error; stale delivery
    /// retains Loading, whereas a matching failed attempt has already stopped.
    pub(crate) fn check_unstarted_program(&self, program: &Program) -> Result<(), Error> {
        self.check_program(program)?;
        if program.phase != PreparationPhase::Reserved {
            return Err(Error::State);
        }
        Ok(())
    }
    pub(crate) fn program_source_pending(&self, program: &Program) -> Result<bool, Error> {
        self.check_program(program)?;
        Ok(matches!(program.phase, PreparationPhase::Loading(_)))
    }
    pub(crate) fn check_program(&self, program: &Program) -> Result<(), Error> {
        self.program_inode(program).map(|_| ())
    }
    pub(crate) fn check_ready(&self, program: &ReadyProgram) -> Result<(), Error> {
        self.held_program_inode(program.owner, &program.place)
            .map(|_| ())
    }
    pub(crate) fn ready_program(&self, program: Program) -> Result<ReadyProgram, (Error, Program)> {
        if let Err(e) = self.program_inode(&program) {
            return Err((e, program));
        }
        if program.phase != PreparationPhase::Ready {
            return Err((Error::State, program));
        }
        Ok(ReadyProgram {
            selected_path: program.selected_path,
            owner: program.owner,
            place: program.place,
            decision: program.decision,
        })
    }
    fn held_program_inode(&self, owner: u64, place: &mount::Hold) -> Result<Inode, Error> {
        if owner != self.owner {
            return Err(Error::BadHandle);
        }
        self.mounts
            .as_ref()
            .ok_or(Error::BadHandle)?
            .position_ref(place)
            .map(|p| p.inode())
            .map_err(Error::Mount)
    }
    /// Short synchronous borrow only; no derived pointer may cross callback or
    /// await. The ReadyProgram owns the mount, not a transferable byte slice.
    pub(crate) fn ready_program_bytes<'a>(
        &'a mut self,
        program: &ReadyProgram,
    ) -> Result<&'a [u8], Error> {
        let inode = self.held_program_inode(program.owner, &program.place)?;
        let size = self.filesystems.size(inode).map_err(Error::Source)?;
        self.filesystems.read(inode, 0, size).map_err(Error::Source)
    }
    pub(crate) fn release_ready(
        &mut self,
        program: ReadyProgram,
    ) -> Result<(), (Error, ReadyProgram)> {
        if let Err(e) = self.held_program_inode(program.owner, &program.place) {
            return Err((e, program));
        }
        self.mounts
            .as_mut()
            .expect("validated mount owner")
            .release_hold(program.place);
        Ok(())
    }
    pub(crate) fn release_image_program(
        &mut self,
        program: ImageProgram,
    ) -> Result<(), (Error, ImageProgram)> {
        if let Err(error) = self.held_program_inode(program.owner, &program.place) {
            return Err((error, program));
        }
        self.mounts
            .as_mut()
            .expect("validated mount owner")
            .release_hold(program.place);
        Ok(())
    }
    pub(crate) fn release_executable(
        &mut self,
        executable: Executable,
    ) -> Result<(), (Error, Executable)> {
        if let Err(e) = self.held_program_inode(executable.owner, &executable.place) {
            return Err((e, executable));
        }
        self.mounts
            .as_mut()
            .expect("validated mount owner")
            .release_hold(executable.place);
        Ok(())
    }
    fn check_preparation(&self, prep: &ReadPreparation) -> Result<(), Error> {
        let d = get(&self.descriptions, self.owner, prep.description)?.file()?;
        if d.reading != Some(prep.reservation) || d.inode != prep.inode || d.offset != prep.offset {
            return Err(Error::State);
        }
        Ok(())
    }
    /// Dispatch at most once. Shared inode contention/poisoning is decided by
    /// Store::load_begin, not a cached per-description loading flag.
    pub(crate) fn prepare_read(
        &mut self,
        prep: &mut ReadPreparation,
    ) -> Result<Option<LoadRequest>, Error> {
        self.check_preparation(prep)?;
        if prep.phase != PreparationPhase::Reserved {
            return Err(Error::State);
        }
        if prep.requested == 0 {
            prep.phase = PreparationPhase::Ready;
            return Ok(None);
        }
        prep.phase = PreparationPhase::Failed;
        let source = self.filesystems.source(prep.inode).map_err(Error::Source)?;
        let attempt = self
            .filesystems
            .load_begin(prep.inode)
            .map_err(Error::Source)?;
        if attempt == 0 {
            prep.phase = PreparationPhase::Ready;
            return Ok(None);
        }
        prep.phase = PreparationPhase::Loading(attempt);
        Ok(Some(LoadRequest { source, attempt }))
    }
    /// Caller supplies stopped-loader completion, not merely a cancellation
    /// request. Matching failure leaves the OFD owned for explicit coordinator
    /// cleanup. Stale completions preserve both preparation and input bytes.
    pub(crate) fn finish_load(
        &mut self,
        prep: &mut ReadPreparation,
        attempt: u32,
        success: bool,
        bytes: &mut Vec<u8>,
    ) -> Result<(), Error> {
        self.check_preparation(prep)?;
        let PreparationPhase::Loading(expected) = prep.phase else {
            return Err(Error::State);
        };
        // Do not let a forged/stale command complete another inode attempt.
        if attempt != expected {
            return Err(Error::Source(super::inode::Error::Payload(
                sods_file_store::store::Error::BadCompletion,
            )));
        }
        let result = self
            .filesystems
            .load_finish(prep.inode, attempt, success, bytes);
        if matches!(
            result,
            Err(super::inode::Error::Payload(
                sods_file_store::store::Error::BadCompletion
            ))
        ) {
            return result.map_err(Error::Source);
        }
        prep.phase = if success && result.is_ok() {
            PreparationPhase::Ready
        } else {
            PreparationPhase::Failed
        };
        result.map_err(Error::Source)
    }
    /// Actual length is known only after materialization. Ownership is returned
    /// on failure; callers explicitly abort rather than losing the OFD pin.
    pub(crate) fn capture_read(
        &mut self,
        prep: ReadPreparation,
    ) -> Result<ReadHold, (Error, ReadPreparation)> {
        if let Err(error) = self.check_preparation(&prep) {
            return Err((error, prep));
        }
        if prep.phase != PreparationPhase::Ready {
            return Err((Error::State, prep));
        }
        let size = if prep.requested == 0 {
            0
        } else {
            match self.filesystems.size(prep.inode) {
                Ok(size) => size as u64,
                Err(e) => return Err((Error::Source(e), prep)),
            }
        };
        let length = if prep.offset >= size {
            0
        } else {
            prep.requested.min(size - prep.offset) as usize
        };
        if prep.offset.checked_add(length as u64).is_none() {
            return Err((Error::Overflow, prep));
        }
        Ok(ReadHold {
            reservation: prep.reservation,
            description: prep.description,
            inode: prep.inode,
            offset: prep.offset,
            length,
            next_revision: prep.next_revision,
        })
    }
    pub(crate) fn abort_preparation(
        &mut self,
        prep: ReadPreparation,
    ) -> Result<(), (Error, ReadPreparation)> {
        if let Err(error) = self.check_preparation(&prep) {
            return Err((error, prep));
        }
        if matches!(prep.phase, PreparationPhase::Loading(_)) {
            return Err((Error::Busy, prep));
        }
        self.descriptions[prep.description.slot]
            .value
            .as_mut()
            .unwrap()
            .file_mut()
            .expect("validated file preparation")
            .reading = None;
        self.release(prep.description);
        Ok(())
    }
    /// Compatibility entry for the existing sealed resident ABI; managed lazy
    /// reads use begin/prepare/finish/capture, never an implicit host callback.
    pub(crate) fn reserve_read(
        &mut self,
        table: &Table,
        fd: u32,
        requested: u64,
    ) -> Result<ReadHold, Error> {
        let mut prep = self.begin_read(table, fd, requested)?;
        let result = match self.filesystems.source(prep.inode) {
            Ok(0) => self.prepare_read(&mut prep).map(|request| {
                debug_assert!(request.is_none());
            }),
            Ok(_) => Err(Error::NotSupported),
            Err(_) => Err(Error::Payload),
        };
        if let Err(error) = result {
            self.abort_preparation(prep)
                .expect("undispatched resident preparation");
            return Err(error);
        }
        match self.capture_read(prep) {
            Ok(hold) => Ok(hold),
            Err((error, prep)) => {
                self.abort_preparation(prep)
                    .expect("resident capture failure");
                Err(error)
            }
        }
    }

    pub(crate) fn read_bytes(&mut self, hold: &ReadHold) -> &[u8] {
        self.check_read_hold(hold).expect("held read owner");
        if hold.length == 0 {
            return &[];
        }
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
        self.check_read_hold(&hold).expect("held read owner");
        let d = self.descriptions[hold.description.slot]
            .value
            .as_mut()
            .unwrap()
            .file_mut()
            .expect("held file description");
        assert_eq!(d.reading, Some(hold.reservation));
        d.offset = hold.offset + copied;
        d.revision = hold.next_revision;
        d.reading = None;
        self.release(hold.description);
    }

    pub(crate) fn abort_read(&mut self, hold: ReadHold) {
        self.check_read_hold(&hold).expect("held read owner");
        let d = self.descriptions[hold.description.slot]
            .value
            .as_mut()
            .unwrap()
            .file_mut()
            .expect("held file description");
        assert_eq!(d.reading, Some(hold.reservation));
        d.reading = None;
        self.release(hold.description);
    }

    fn check_read_hold(&self, hold: &ReadHold) -> Result<(), Error> {
        let d = get(&self.descriptions, self.owner, hold.description)?.file()?;
        if d.reading != Some(hold.reservation) || d.inode != hold.inode || d.offset != hold.offset {
            return Err(Error::State);
        }
        Ok(())
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
    // Prepared-root fixture ownership, not a production metadata default.
    fn root_owned(mode: u32) -> crate::inode::Creation {
        crate::inode::Creation {
            mode,
            uid: 0,
            gid: 0,
        }
    }

    use super::*;
    fn setup(slots: usize) -> (Files, Inode) {
        let mut tree = Tree::new(91, 4, 4, 16, root_owned(0o755)).unwrap();
        let file = tree
            .file_take(tree.root(), b"f", root_owned(0o600), &mut b"body".to_vec())
            .unwrap();
        (
            Files::new(
                92,
                tree,
                Limits {
                    contexts: 4,
                    tables: 4,
                    descriptions: 4,
                    slots,
                },
            ),
            file,
        )
    }
    #[test]
    fn stdio_target_direction_and_regular_exclusion() {
        let (mut f, inode) = setup(16);
        let t = f.stdio([11, 12, 13], 8).unwrap();
        assert_eq!(
            f.target(&t, 0),
            Ok(Target::HostStream {
                endpoint: 11,
                direction: StreamDirection::Read
            })
        );
        assert_eq!(
            f.target(&t, 2),
            Ok(Target::HostStream {
                endpoint: 13,
                direction: StreamDirection::Write
            })
        );
        assert_eq!(
            f.hold_stream(&t, 0, StreamDirection::Write).unwrap_err(),
            Error::BadFd
        );
        assert_eq!(f.inode(&t, 0), Err(Error::NotSupported));
        assert_eq!(f.offset(&t, 1), Err(Error::NotSupported));
        assert_eq!(f.set_offset(&t, 1, 10), Err(Error::NotSupported));
        assert_eq!(f.begin_read(&t, 0, 1).unwrap_err(), Error::NotSupported);
        let regular = f.open(&t, inode, false).unwrap();
        assert_eq!(f.target(&t, regular), Ok(Target::File(inode)));
        assert_eq!(
            f.hold_stream(&t, regular, StreamDirection::Read)
                .unwrap_err(),
            Error::NotSupported
        );
        f.let_go(t).unwrap();
        assert!(f.descriptions.iter().all(|c| c.value.is_none()));
    }
    #[test]
    fn stdio_pending_survives_dup_fork_close_and_reuse() {
        let (mut f, inode) = setup(32);
        let t = f.stdio([11, 12, 13], 8).unwrap();
        let alias = f.dup(&t, 0, 3, false).unwrap();
        let child = f.fork(&t).unwrap();
        let hold = f.hold_stream(&t, 0, StreamDirection::Read).unwrap();
        f.close(&t, 0).unwrap();
        assert_eq!(f.open(&t, inode, false), Ok(0));
        assert_eq!(f.target(&t, 0), Ok(Target::File(inode)));
        assert_eq!(
            f.target(&child, alias),
            Ok(Target::HostStream {
                endpoint: 11,
                direction: StreamDirection::Read
            })
        );
        f.let_go(t).unwrap();
        f.let_go(child).unwrap();
        assert_eq!(f.stream(&hold), Ok((11, StreamDirection::Read)));
        assert_eq!(
            f.descriptions.iter().filter(|c| c.value.is_some()).count(),
            1
        );
        let (mut foreign, _) = setup(16);
        foreign.owner = 999;
        let (error, hold) = foreign.release_stream(hold).unwrap_err();
        assert_eq!(error, Error::BadHandle);
        f.release_stream(hold).unwrap();
        assert!(f.descriptions.iter().all(|c| c.value.is_none()));
    }
    #[test]
    fn stdio_partial_admission_rolls_back_without_existing_owner_damage() {
        let (mut f, inode) = setup(3);
        let existing = f.table(8).unwrap();
        let fd = f.open(&existing, inode, false).unwrap();
        assert_eq!(f.stdio([1, 2, 3], 2).unwrap_err(), Error::Capacity);
        assert_eq!(f.stdio([0, 2, 3], 8).unwrap_err(), Error::BadHandle);
        assert_eq!(f.stdio([1, 2, 3], 8).unwrap_err(), Error::Capacity);
        assert_eq!(f.live_slots, 1);
        assert_eq!(f.inode(&existing, fd), Ok(inode));
        assert_eq!(f.tables.iter().filter(|c| c.value.is_some()).count(), 1);
        assert_eq!(
            f.descriptions.iter().filter(|c| c.value.is_some()).count(),
            1
        );
        f.close(&existing, fd).unwrap();
        let t = f.stdio([1, 2, 3], 8).unwrap();
        f.let_go(t).unwrap();
        f.let_go(existing).unwrap();
        // Description capacity also rolls back independently of slot capacity.
        let (mut f, _) = setup(16);
        f.limits.descriptions = 2;
        assert_eq!(f.stdio([1, 2, 3], 8).unwrap_err(), Error::Capacity);
        assert_eq!(f.live_slots, 0);
        assert!(f.descriptions.iter().all(|c| c.value.is_none()));
        assert!(f.tables.iter().all(|c| c.value.is_none()));
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
    fn rejected_table_release_returns_ticket_to_its_owner() {
        let (mut files, inode) = setup(4);
        let table = files.table(4).unwrap();
        let fd = files.open(&table, inode, false).unwrap();
        // Distinct live Files incarnations, as required by the embedding.
        let mut foreign = Files::new(
            93,
            Tree::new(94, 1, 0, 0, root_owned(0o755)).unwrap(),
            Limits {
                contexts: 0,
                tables: 1,
                descriptions: 0,
                slots: 0,
            },
        );
        let foreign_table = foreign.table(0).unwrap();
        let (error, table) = foreign.let_go(table).unwrap_err();
        assert_eq!(error, Error::BadHandle);
        assert_eq!(files.inode(&table, fd), Ok(inode));
        files.let_go(table).unwrap();
        assert_eq!(files.live_slots, 0);
        assert!(files.descriptions.iter().all(|cell| cell.value.is_none()));
        // The rejected operation did not consume the foreign owner's holder.
        foreign.let_go(foreign_table).unwrap();
    }
    #[test]
    fn shared_table_retirement_preserves_other_holder_and_pending_read() {
        let (mut files, inode) = setup(4);
        let table = files.table(4).unwrap();
        let fd = files.open(&table, inode, false).unwrap();
        let other = files.share(&table).unwrap();
        files.let_go(table).unwrap();
        assert_eq!(files.inode(&other, fd), Ok(inode));
        assert_eq!(files.live_slots, 1);
        let pending = files.reserve_read(&other, fd, 4).unwrap();
        files.let_go(other).unwrap();
        assert_eq!(files.live_slots, 0);
        assert_eq!(files.read_bytes(&pending), b"body");
        assert_eq!(
            files
                .descriptions
                .iter()
                .filter(|cell| cell.value.is_some())
                .count(),
            1
        );
        files.finish_read(pending, 4);
        assert!(files.descriptions.iter().all(|cell| cell.value.is_none()));
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
        assert_eq!(f.open(&t, inode, true), Err(Error::FdLimit));
        assert_eq!(f.dup(&t, fd, 1, true), Err(Error::FdLimit));
        assert_eq!(f.live_slots, 1);
        let id = f.description(&t, fd).unwrap();
        f.descriptions[id.slot]
            .value
            .as_mut()
            .unwrap()
            .file_mut()
            .unwrap()
            .revision = u64::MAX;
        assert_eq!(f.set_offset(&t, fd, 42), Err(Error::Overflow));
        assert_eq!(f.offset(&t, fd), Ok((0, u64::MAX)));
        f.tables[t.0.slot].value.as_mut().unwrap().holders = u64::MAX;
        assert_eq!(f.share(&t), Err(Error::Overflow));
        f.tables[t.0.slot].value.as_mut().unwrap().holders = 1;
        f.let_go(t).unwrap();
    }
    #[test]
    fn kinds_foreign_inodes_and_description_exhaustion_are_checked() {
        let mut tree = Tree::new(41, 4, 4, 8, root_owned(0o755)).unwrap();
        let root = tree.root();
        let link = tree
            .symlink(root, b"link", b"target", root_owned(0o777))
            .unwrap();
        let foreign = Tree::new(42, 1, 0, 0, root_owned(0o755)).unwrap().root();
        let mut f = Files::new(
            43,
            tree,
            Limits {
                contexts: 4,
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
        let mut tree = Tree::new(owner, 4, 4, 32, root_owned(0o755)).unwrap();
        let mut payload = bytes.to_vec();
        let pointer = payload.as_ptr();
        let inode = tree
            .file_take(tree.root(), b"same", root_owned(0o600), &mut payload)
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
                contexts: 4,
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
                contexts: 4,
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
                contexts: 4,
                tables: 1,
                descriptions: 2,
                slots: 2,
            },
        );
        // A malformed same-owner tree cannot supply an in-range proof for an
        // absent inode. Unique owner allocation remains an embedding invariant.
        let (mut malformed, _, _) = prepared(121, b"other");
        let absent = malformed
            .file_take(malformed.root(), b"absent", root_owned(0o600), &mut vec![1])
            .unwrap();
        let t = f.table(2).unwrap();
        assert_eq!(f.open(&t, absent, false), Err(Error::BadHandle));
        let mut pending = Tree::new(122, 2, 1, 16, root_owned(0o755)).unwrap();
        let lazy = pending
            .lazy_file(pending.root(), b"lazy", root_owned(0o600), 9, 4)
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
        let mut tree = Tree::new(301, 10, 12, 32, root_owned(0o755)).unwrap();
        let root = tree.root();
        let src = tree.directory(root, b"src", root_owned(0o755)).unwrap();
        tree.directory(root, b"dst", root_owned(0o755)).unwrap();
        tree.directory(root, b"dst2", root_owned(0o755)).unwrap();
        tree.directory(src, b"child", root_owned(0o755)).unwrap();
        tree.file_take(src, b"file", root_owned(0o600), &mut b"mounted".to_vec())
            .unwrap();
        let mut f = Files::new(
            302,
            tree,
            Limits {
                contexts: 4,
                tables: 3,
                descriptions: 8,
                slots: 16,
            },
        );
        let ticket = f
            .bootstrap_mount(
                root,
                mount::Limits { views: 8, holds },
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
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
        let mut tree = Tree::new(311, 5, 5, 32, root_owned(0o755)).unwrap();
        let root = tree.root();
        tree.file_take(root, b"source", root_owned(0o600), &mut b"source".to_vec())
            .unwrap();
        let original = tree
            .file_take(root, b"a", root_owned(0o600), &mut b"original".to_vec())
            .unwrap();
        tree.hardlink(root, b"b", original).unwrap();
        let mut f = Files::new(
            312,
            tree,
            Limits {
                contexts: 4,
                tables: 1,
                descriptions: 2,
                slots: 2,
            },
        );
        let ticket = f
            .bootstrap_mount(
                root,
                mount::Limits { views: 2, holds: 4 },
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
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
        let mut first = Tree::new(321, 3, 3, 8, root_owned(0o755)).unwrap();
        let root = first.root();
        first.directory(root, b"at", root_owned(0o755)).unwrap();
        let (second, file, pointer) = prepared(322, b"second");
        let second_root = second.root();
        let mut f = Files::with_filesystem_capacity(
            323,
            first,
            Limits {
                contexts: 4,
                tables: 1,
                descriptions: 2,
                slots: 2,
            },
            NonZeroUsize::new(2).unwrap(),
        );
        let bootstrap = f
            .bootstrap_mount(
                root,
                mount::Limits { views: 2, holds: 3 },
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
            .unwrap();
        assert!(matches!(
            f.filesystem_view(
                second_root,
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false
                }
            ),
            Err(Error::BadHandle)
        ));
        assert!(f.admit_tree(second).is_ok());
        assert!(matches!(
            f.filesystem_view(
                file,
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false
                }
            ),
            Err(Error::BadHandle)
        ));
        let ticket = f
            .filesystem_view(
                second_root,
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
            .unwrap();
        assert!(matches!(
            f.filesystem_view(
                second_root,
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false
                }
            ),
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
        let mut tree = Tree::new(331, 2, 1, 8, root_owned(0o755)).unwrap();
        let root = tree.root();
        let inode = tree
            .file_take(root, b"file", root_owned(0o600), &mut b"body".to_vec())
            .unwrap();
        let mut f = Files::new(
            332,
            tree,
            Limits {
                contexts: 4,
                tables: 1,
                descriptions: 2,
                slots: 2,
            },
        );
        let table = f.table(2).unwrap();
        let fd = f.open(&table, inode, false).unwrap();
        let limits = mount::Limits { views: 1, holds: 2 };
        assert!(matches!(
            f.bootstrap_mount(
                root,
                limits,
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false
                }
            ),
            Err(Error::Busy)
        ));
        let pending = f.reserve_read(&table, fd, 4).unwrap();
        f.close(&table, fd).unwrap();
        assert!(matches!(
            f.bootstrap_mount(
                root,
                limits,
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false
                }
            ),
            Err(Error::Busy)
        ));
        f.abort_read(pending);
        let ticket = f
            .bootstrap_mount(
                root,
                limits,
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
            .unwrap();
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
    fn fs_shared_and_copied_positions_drive_component_open_and_read() {
        let (mut f, root_ticket, root) = mounted_setup(20);
        let source = f.component(&root, b"src").unwrap().unwrap();
        let fs = f.create_fs(&root, &source, 0o022).unwrap();
        let shared = f.share_fs(&fs).unwrap();
        let copied = f.copy_fs(&fs).unwrap();
        f.change_fs(&shared, Base::Cwd, &root).unwrap();
        assert!(f.fs_component(&fs, Base::Cwd, b"file").unwrap().is_none());
        let file = f
            .fs_component(&copied, Base::Cwd, b"file")
            .unwrap()
            .unwrap();
        assert_eq!(f.set_fs_umask(&shared, 0o1077), Ok(0o022));
        assert_eq!(f.fs_umask(&fs), Ok(0o077));
        assert_eq!(f.fs_umask(&copied), Ok(0o022));
        f.change_fs(&shared, Base::Root, &source).unwrap();
        assert_eq!(
            f.fs_component(&fs, Base::Root, b"file")
                .unwrap()
                .unwrap()
                .inode(),
            file.inode()
        );
        assert!(f
            .fs_component(&copied, Base::Root, b"file")
            .unwrap()
            .is_none());
        assert_eq!(f.change_fs(&fs, Base::Cwd, &file), Err(Error::NotSupported));
        assert_eq!(f.create_fs(&file, &root, 0), Err(Error::NotSupported));
        assert_eq!(f.create_fs(&root, &file, 0), Err(Error::NotSupported));
        let table = f.table(2).unwrap();
        let fd = f.open_place(&table, &file, false).unwrap();
        let read = f.reserve_read(&table, fd, 32).unwrap();
        assert!(f.release_fs(copied).is_ok());
        assert_eq!(f.read_bytes(&read), b"mounted");
        f.finish_read(read, 7);
        f.let_go(table).unwrap();
        assert!(f.release_fs(shared).is_ok());
        assert_eq!(f.fs_umask(&fs), Ok(0o077));
        assert!(f.release_fs(fs).is_ok());
        // A fresh independent start needs no permanently retained seed context.
        let fresh = f.create_fs(&root, &root, 0o002).unwrap();
        assert_eq!(f.fs_umask(&fresh), Ok(0o002));
        assert!(f.release_fs(fresh).is_ok());
        assert!(f.release_view(root_ticket).is_ok());
    }
    #[test]
    fn fs_detached_view_holds_end_without_retiring_pending_read() {
        let (mut f, root_ticket, root) = mounted_setup(20);
        let source = f.component(&root, b"src").unwrap().unwrap();
        let at = f.component(&root, b"dst").unwrap().unwrap();
        let view = f.clone_view(&source).unwrap();
        f.attach_view(&view, &at).unwrap();
        let mounted = f.view_root(&view).unwrap();
        let fs = f.create_fs(&mounted, &mounted, 0).unwrap(); // two holds of same view
        assert!(f.release_view(view).is_ok());
        f.detach_view(&mounted).unwrap();
        let file = f.fs_component(&fs, Base::Cwd, b"file").unwrap().unwrap();
        let table = f.table(2).unwrap();
        let fd = f.open_place(&table, &file, false).unwrap();
        let read = f.reserve_read(&table, fd, 32).unwrap();
        f.close(&table, fd).unwrap();
        assert!(f.release_fs(fs).is_ok());
        assert_eq!(f.read_bytes(&read), b"mounted");
        f.abort_read(read);
        assert_eq!(
            f.open_place(&table, &file, false),
            Err(Error::Mount(mount::Error::BadPlace))
        );
        f.let_go(table).unwrap();
        assert!(f.release_view(root_ticket).is_ok());
    }
    #[test]
    fn fs_change_failure_keeps_old_position_and_same_place_needs_no_hold() {
        let (mut f, root_ticket, root) = mounted_setup(3);
        let source = f.component(&root, b"src").unwrap().unwrap();
        let fs = f.create_fs(&root, &source, 0o022).unwrap();
        assert_eq!(
            f.change_fs(&fs, Base::Cwd, &root),
            Err(Error::Fs(fs_context::Error::Mount(mount::Error::Capacity)))
        );
        assert_eq!(f.change_fs(&fs, Base::Cwd, &source), Ok(()));
        assert!(f.fs_component(&fs, Base::Cwd, b"file").unwrap().is_some());
        assert_eq!(f.fs_umask(&fs), Ok(0o022));
        assert!(f.release_fs(fs).is_ok());
        let retry = f.create_fs(&root, &root, 0).unwrap();
        assert!(f.release_fs(retry).is_ok());
        assert!(f.release_view(root_ticket).is_ok());
    }
    #[test]
    fn fs_same_inode_different_view_still_requires_new_hold() {
        let (mut f, root_ticket, root) = mounted_setup(5);
        let source = f.component(&root, b"src").unwrap().unwrap();
        let a = f.clone_view(&source).unwrap();
        let b = f.clone_view(&source).unwrap();
        let ar = f.view_root(&a).unwrap();
        let br = f.view_root(&b).unwrap();
        assert_eq!(ar.inode(), br.inode());
        let fs = f.create_fs(&root, &ar, 0).unwrap();
        assert_eq!(f.change_fs(&fs, Base::Cwd, &ar), Ok(()));
        assert_eq!(
            f.change_fs(&fs, Base::Cwd, &br),
            Err(Error::Fs(fs_context::Error::Mount(mount::Error::Capacity)))
        );
        assert!(
            f.contexts
                .position_ref(f.mounts.as_ref().unwrap(), &fs, Base::Cwd)
                .unwrap()
                == &ar
        );
        assert!(f.release_fs(fs).is_ok());
        assert!(f.release_view(a).is_ok());
        assert!(f.release_view(b).is_ok());
        assert!(f.release_view(root_ticket).is_ok());
    }
    #[test]
    fn fs_parent_clamps_bind_points_and_reads_through_the_correct_view() {
        let mut tree = Tree::new(911, 8, 8, 16, root_owned(0o755)).unwrap();
        let inode_root = tree.root();
        let src = tree
            .directory(inode_root, b"src", root_owned(0o755))
            .unwrap();
        tree.directory(src, b"child", root_owned(0o755)).unwrap();
        tree.file_take(src, b"file", root_owned(0o600), &mut b"mounted".to_vec())
            .unwrap();
        let jail = tree
            .directory(inode_root, b"jail", root_owned(0o755))
            .unwrap();
        tree.directory(jail, b"mnt", root_owned(0o755)).unwrap();
        let mut f = Files::new(
            912,
            tree,
            Limits {
                contexts: 4,
                tables: 2,
                descriptions: 4,
                slots: 8,
            },
        );
        let root_ticket = f
            .bootstrap_mount(
                inode_root,
                mount::Limits {
                    views: 8,
                    holds: 24,
                },
                crate::mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
            .unwrap();
        let root = f.view_root(&root_ticket).unwrap();
        let source = f.component(&root, b"src").unwrap().unwrap();
        let jail = f.component(&root, b"jail").unwrap().unwrap();
        let destination = f.component(&jail, b"mnt").unwrap().unwrap();
        let view = f.clone_view(&source).unwrap();
        let overlay = f.clone_view(&source).unwrap();
        f.attach_view(&view, &destination).unwrap();
        let mounted = f.view_root(&view).unwrap();
        let child = f.component(&mounted, b"child").unwrap().unwrap();
        let fs = f.create_fs(&root, &mounted, 0).unwrap();
        let parent = f.fs_parent(&fs, &child).unwrap();
        assert!(parent == mounted);
        assert!(f.fs_parent(&fs, &mounted).unwrap() == jail); // destination's parent, not src
        assert!(f.fs_parent(&fs, &root).unwrap() == root);
        let file = f.component(&parent, b"file").unwrap().unwrap();
        assert!(matches!(f.fs_parent(&fs, &file), Err(Error::NotSupported)));
        let table = f.table(2).unwrap();
        let fd = f.open_place(&table, &file, false).unwrap();
        let read = f.reserve_read(&table, fd, 32).unwrap();
        assert_eq!(f.read_bytes(&read), b"mounted");
        f.finish_read(read, 7);
        f.let_go(table).unwrap();
        // Boundary at the underlying attachment point clamps during Across,
        // before climbing another directory or descending into its covering view.
        let at_boundary = f.create_fs(&destination, &mounted, 0).unwrap();
        assert!(f.fs_parent(&at_boundary, &mounted).unwrap() == destination);
        // Same backing inode in a distinct view must NOT clamp.
        let same_inode = f.create_fs(&source, &mounted, 0).unwrap();
        assert_eq!(source.inode(), mounted.inode());
        assert!(f.fs_parent(&same_inode, &mounted).unwrap() == jail);
        assert!(f.release_fs(same_inode).is_ok());
        // When actual ascent reaches the boundary, coverage must not descend
        // back into the view mounted over that boundary.
        let underlying_child = f.component(&source, b"child").unwrap().unwrap();
        f.attach_view(&overlay, &source).unwrap();
        let overlay_root = f.view_root(&overlay).unwrap();
        assert!(f.fs_parent(&fs, &underlying_child).unwrap() == overlay_root);
        let source_boundary = f.create_fs(&source, &source, 0).unwrap();
        assert!(f.fs_parent(&source_boundary, &underlying_child).unwrap() == source);
        assert!(f.release_fs(source_boundary).is_ok());
        assert!(f.release_view(overlay).is_ok());
        f.detach_view(&overlay_root).unwrap();
        f.detach_view(&mounted).unwrap();
        assert!(f.fs_parent(&fs, &mounted).unwrap() == mounted); // detached root fixed
        assert!(f.release_fs(at_boundary).is_ok());
        assert!(f.release_fs(fs).is_ok());
        assert!(f.release_view(view).is_ok());
        let fresh = f.create_fs(&root, &root, 0).unwrap();
        assert!(matches!(
            f.fs_parent(&fresh, &mounted),
            Err(Error::Mount(mount::Error::BadPlace))
        ));
        assert!(f.release_fs(fresh).is_ok());
        assert!(f.release_view(root_ticket).is_ok());
    }
    fn lazy_setup() -> (Files, Table, u32, Inode) {
        let mut tree = Tree::new(1001, 3, 3, 32, root_owned(0o755)).unwrap();
        let file = tree
            .lazy_file(tree.root(), b"lazy", root_owned(0o600), 7, 2)
            .unwrap();
        let mut files = Files::new(
            1002,
            tree,
            Limits {
                contexts: 0,
                tables: 2,
                descriptions: 4,
                slots: 8,
            },
        );
        let table = files.table(8).unwrap();
        let fd = files.open(&table, file, false).unwrap();
        (files, table, fd, file)
    }
    #[test]
    fn lazy_read_owns_old_description_and_captures_actual_size_after_load() {
        let (mut f, table, fd, inode) = lazy_setup();
        let mut prep = f.begin_read(&table, fd, 16).unwrap();
        let request = f.prepare_read(&mut prep).unwrap().unwrap();
        assert_eq!(request.source, 7);
        assert_eq!(f.prepare_read(&mut prep), Err(Error::State));
        f.close(&table, fd).unwrap();
        let replacement = f.open(&table, inode, false).unwrap();
        assert_eq!(replacement, fd);
        let mut bytes = b"hello".to_vec();
        let pointer = bytes.as_ptr();
        assert!(matches!(
            f.finish_load(&mut prep, request.attempt + 1, true, &mut bytes),
            Err(Error::Source(super::super::inode::Error::Payload(
                sods_file_store::store::Error::BadCompletion
            )))
        ));
        assert_eq!(bytes, b"hello");
        assert_eq!(bytes.as_ptr(), pointer);
        f.finish_load(&mut prep, request.attempt, true, &mut bytes)
            .unwrap();
        assert!(bytes.is_empty());
        let hold = f.capture_read(prep).unwrap();
        assert_eq!(hold.length(), 5); // advertised size was only 2
        assert_eq!(f.read_bytes(&hold).as_ptr(), pointer);
        f.finish_read(hold, 5);
        assert_eq!(f.offset(&table, replacement), Ok((0, 0)));
        let mut warm = f.begin_read(&table, replacement, 16).unwrap();
        assert_eq!(f.prepare_read(&mut warm), Ok(None)); // Store loaded state, source still 7
        let hold = f.capture_read(warm).unwrap();
        assert_eq!(f.read_bytes(&hold), b"hello");
        f.finish_read(hold, 5);
        assert_eq!(f.offset(&table, replacement), Ok((5, 1)));
        f.let_go(table).unwrap();
    }
    #[test]
    fn loading_abort_requires_stopped_completion_and_stale_retry_preserves_input() {
        let (mut f, table, fd, _) = lazy_setup();
        let mut prep = f.begin_read(&table, fd, 8).unwrap();
        let first = f.prepare_read(&mut prep).unwrap().unwrap();
        let (error, mut prep) = f.abort_preparation(prep).unwrap_err();
        assert_eq!(error, Error::Busy);
        assert_eq!(f.set_offset(&table, fd, 1), Err(Error::Busy));
        let mut bytes = b"kept".to_vec();
        f.finish_load(&mut prep, first.attempt, false, &mut bytes)
            .unwrap();
        assert_eq!(bytes, b"kept");
        f.abort_preparation(prep).unwrap();
        assert_eq!(f.offset(&table, fd), Ok((0, 0)));
        let mut retry = f.begin_read(&table, fd, 8).unwrap();
        let next = f.prepare_read(&mut retry).unwrap().unwrap();
        assert_ne!(first.attempt, next.attempt);
        assert!(f
            .finish_load(&mut retry, first.attempt, true, &mut bytes)
            .is_err());
        assert_eq!(bytes, b"kept");
        f.finish_load(&mut retry, next.attempt, true, &mut bytes)
            .unwrap();
        let hold = f.capture_read(retry).unwrap();
        assert_eq!(f.read_bytes(&hold), b"kept");
        f.abort_read(hold);
        f.let_go(table).unwrap();
    }
    #[test]
    fn same_inode_loading_conflict_uses_store_poison_and_explicit_cleanup() {
        let (mut f, table, fd, inode) = lazy_setup();
        let second = f.open(&table, inode, false).unwrap();
        let mut a = f.begin_read(&table, fd, 4).unwrap();
        let request = f.prepare_read(&mut a).unwrap().unwrap();
        let mut b = f.begin_read(&table, second, 4).unwrap();
        assert_eq!(
            f.prepare_read(&mut b),
            Err(Error::Source(super::super::inode::Error::Payload(
                sods_file_store::store::Error::LoadConflict
            )))
        );
        assert_eq!(f.set_offset(&table, second, 1), Err(Error::Busy)); // no hidden ref cleanup
        f.abort_preparation(b).unwrap();
        let mut bytes = b"data".to_vec();
        assert_eq!(
            f.finish_load(&mut a, request.attempt, true, &mut bytes),
            Err(Error::Source(super::super::inode::Error::Payload(
                sods_file_store::store::Error::LoadConflict
            )))
        );
        assert_eq!(bytes, b"data");
        f.abort_preparation(a).unwrap();
        let mut retry = f.begin_read(&table, fd, 4).unwrap();
        let request = f.prepare_read(&mut retry).unwrap().unwrap();
        f.finish_load(&mut retry, request.attempt, true, &mut bytes)
            .unwrap();
        let hold = f.capture_read(retry).unwrap();
        f.abort_read(hold);
        f.let_go(table).unwrap();
    }
    #[test]
    fn zero_lazy_read_does_not_start_or_poison_another_load() {
        let (mut f, table, fd, inode) = lazy_setup();
        let second = f.open(&table, inode, false).unwrap();
        let mut loading = f.begin_read(&table, fd, 4).unwrap();
        let request = f.prepare_read(&mut loading).unwrap().unwrap();
        let mut zero = f.begin_read(&table, second, 0).unwrap();
        assert_eq!(f.prepare_read(&mut zero), Ok(None));
        let hold = f.capture_read(zero).unwrap();
        assert!(f.read_bytes(&hold).is_empty());
        f.finish_read(hold, 0);
        assert_eq!(f.offset(&table, second), Ok((0, 0)));
        let mut bytes = b"data".to_vec();
        f.finish_load(&mut loading, request.attempt, true, &mut bytes)
            .unwrap();
        f.abort_preparation(loading).unwrap();
        f.let_go(table).unwrap();
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

#[cfg(test)]
mod view_policy_tests {
    use super::*;
    use crate::inode::{Creation, Tree};
    use crate::mount::ViewPolicy;
    #[test]
    fn policies_belong_to_views_survive_holds_and_reject_stale_positions() {
        let metadata = Creation {
            mode: 0o755,
            uid: 11,
            gid: 12,
        };
        let mut tree = Tree::new(720, 4, 4, 16, metadata).unwrap();
        let root = tree.root();
        tree.directory(root, b"at", metadata).unwrap();
        tree.file_take(root, b"file", metadata, &mut b"body".to_vec())
            .unwrap();
        let mut f = Files::new(
            721,
            tree,
            Limits {
                contexts: 0,
                tables: 1,
                descriptions: 2,
                slots: 4,
            },
        );
        let restricted = ViewPolicy {
            no_exec: true,
            no_suid: true,
            no_symfollow: true,
        };
        let allowed = ViewPolicy {
            no_exec: false,
            no_suid: false,
            no_symfollow: false,
        };
        let first = f
            .bootstrap_mount(root, mount::Limits { views: 4, holds: 8 }, restricted)
            .unwrap();
        let first_root = f.view_root(&first).unwrap();
        let second = f.filesystem_view(root, allowed).unwrap();
        let second_root = f.view_root(&second).unwrap();
        assert_eq!(first_root.inode(), second_root.inode());
        assert_eq!(f.view_policy(&first_root), Ok(restricted));
        assert_eq!(f.view_policy(&second_root), Ok(allowed));
        let clone = f.clone_view(&second_root).unwrap();
        let clone_root = f.view_root(&clone).unwrap();
        assert_eq!(f.view_policy(&clone_root), Ok(allowed));
        assert!(f.release_view(clone).is_ok());
        assert_eq!(
            f.view_policy(&clone_root),
            Err(Error::Mount(mount::Error::BadPlace))
        );
        let point = f.component(&first_root, b"at").unwrap().unwrap();
        f.attach_view(&second, &point).unwrap();
        let covered = f.component(&first_root, b"at").unwrap().unwrap();
        assert_eq!(f.view_policy(&covered), Ok(allowed));
        let file = f.component(&covered, b"file").unwrap().unwrap();
        let table = f.table(4).unwrap();
        let fd = f.open_place(&table, &file, false).unwrap();
        assert!(f.release_view(second).is_ok());
        f.detach_view(&covered).unwrap();
        assert_eq!(f.view_policy(&file), Ok(allowed));
        let hold = f.reserve_read(&table, fd, 4).unwrap();
        f.close(&table, fd).unwrap();
        assert_eq!(f.view_policy(&file), Ok(allowed));
        assert_eq!(f.read_bytes(&hold), b"body");
        f.finish_read(hold, 4);
        assert_eq!(
            f.view_policy(&file),
            Err(Error::Mount(mount::Error::BadPlace))
        );
        let foreign = Tree::new(722, 1, 0, 0, metadata).unwrap();
        let root2 = foreign.root();
        let mut other = Files::new(
            723,
            foreign,
            Limits {
                contexts: 0,
                tables: 0,
                descriptions: 0,
                slots: 0,
            },
        );
        let ticket = other
            .bootstrap_mount(root2, mount::Limits { views: 1, holds: 1 }, allowed)
            .unwrap();
        let foreign_place = other.view_root(&ticket).unwrap();
        assert_eq!(
            f.view_policy(&foreign_place),
            Err(Error::Mount(mount::Error::BadPlace))
        );
    }
}

#[cfg(test)]
mod program_tests {
    use super::*;
    use crate::credentials::Credentials;
    use crate::inode::Creation;
    fn setup(owner: u64, policy: mount::ViewPolicy) -> (Files, fs_context::Ticket) {
        let creation = |mode| Creation {
            mode,
            uid: 0,
            gid: 0,
        };
        let mut tree = Tree::new(owner, 8, 8, 64, creation(0o755)).unwrap();
        let root = tree.root();
        tree.lazy_file(root, b"program", creation(0o4755), 7, 2)
            .unwrap();
        tree.lazy_file(root, b"second", creation(0o755), 8, 2)
            .unwrap();
        tree.directory(root, b"point", creation(0o755)).unwrap();
        tree.file_take(root, b"resident", creation(0o755), &mut b"elf".to_vec())
            .unwrap();
        tree.file_take(root, b"denied", creation(0o644), &mut vec![])
            .unwrap();
        tree.symlink(root, b"alias", b"resident", creation(0o777))
            .unwrap();
        tree.symlink(root, &[255, 254], b"resident", creation(0o777))
            .unwrap();
        let mut files = Files::new(
            owner + 1,
            tree,
            Limits {
                contexts: 1,
                tables: 0,
                descriptions: 0,
                slots: 0,
            },
        );
        let view = files
            .bootstrap_mount(root, mount::Limits { views: 2, holds: 8 }, policy)
            .unwrap();
        let position = files.view_root(&view).unwrap();
        let fs = files.create_fs(&position, &position, 0o022).unwrap();
        assert!(files.release_view(view).is_ok());
        (files, fs)
    }
    fn allowed() -> mount::ViewPolicy {
        mount::ViewPolicy {
            no_exec: false,
            no_suid: false,
            no_symfollow: false,
        }
    }
    #[test]
    fn program_direct_payload_and_warm_lazy_need_no_descriptor() {
        let (mut f, fs) = setup(3101, allowed());
        let c = Credentials::initial_root();
        let mut resident = f.prepare_program(&fs, &c, b"/resident").unwrap();
        assert_eq!(f.prepare_program_source(&mut resident), Ok(None));
        assert_eq!(f.program_bytes(&resident).unwrap(), b"elf");
        f.release_program(resident).unwrap();
        let mut p = f.prepare_program(&fs, &c, b"/program").unwrap();
        let request = f.prepare_program_source(&mut p).unwrap().unwrap();
        assert_eq!(request.source, 7);
        let mut bytes = b"actual program".to_vec();
        let pointer = bytes.as_ptr();
        f.finish_program_source(&mut p, request.attempt, true, &mut bytes)
            .unwrap();
        assert!(bytes.is_empty());
        assert_eq!(f.program_bytes(&p).unwrap(), b"actual program");
        assert_eq!(f.program_bytes(&p).unwrap().as_ptr(), pointer);
        f.release_program(p).unwrap();
        let mut warm = f.prepare_program(&fs, &c, b"/program").unwrap();
        assert_eq!(f.prepare_program_source(&mut warm), Ok(None));
        assert_eq!(f.program_bytes(&warm).unwrap().as_ptr(), pointer);
        f.release_program(warm).unwrap();
        assert!(f.tables.is_empty() && f.descriptions.is_empty());
    }
    #[test]
    fn program_stale_foreign_and_pending_release_preserve_callback_ownership() {
        let (mut f, fs) = setup(3201, allowed());
        let (mut other, _) = setup(3301, allowed());
        let mut p = f
            .prepare_program(&fs, &Credentials::initial_root(), b"program")
            .unwrap();
        let request = f.prepare_program_source(&mut p).unwrap().unwrap();
        let mut bytes = b"kept".to_vec();
        assert_eq!(
            other.finish_program_source(&mut p, request.attempt, true, &mut bytes),
            Err(Error::BadHandle)
        );
        assert!(f
            .finish_program_source(&mut p, request.attempt + 1, true, &mut bytes)
            .is_err());
        assert_eq!(bytes, b"kept");
        assert_eq!(p.phase, PreparationPhase::Loading(request.attempt));
        let (error, p) = other.release_program(p).unwrap_err();
        assert_eq!(error, Error::BadHandle);
        let (error, mut p) = f.release_program(p).unwrap_err();
        assert_eq!(error, Error::Busy);
        f.release_fs(fs).unwrap(); // Program alone still holds the view.
        f.finish_program_source(&mut p, request.attempt, true, &mut bytes)
            .unwrap();
        assert_eq!(f.program_bytes(&p).unwrap(), b"kept");
        f.release_program(p).unwrap();
    }
    #[test]
    fn program_matching_failure_and_same_inode_poison_retire_only_after_completion() {
        let (mut f, fs) = setup(3401, allowed());
        let c = Credentials::initial_root();
        let mut a = f.prepare_program(&fs, &c, b"program").unwrap();
        let mut b = f.prepare_program(&fs, &c, b"program").unwrap();
        let request = f.prepare_program_source(&mut a).unwrap().unwrap();
        assert!(f.prepare_program_source(&mut b).is_err());
        assert_eq!(b.phase, PreparationPhase::Failed);
        f.release_program(b).unwrap();
        let mut bytes = b"poisoned input".to_vec();
        assert!(f
            .finish_program_source(&mut a, request.attempt, true, &mut bytes)
            .is_err());
        assert_eq!(bytes, b"poisoned input");
        assert_eq!(a.phase, PreparationPhase::Failed);
        f.release_program(a).unwrap();
        let mut retry = f.prepare_program(&fs, &c, b"program").unwrap();
        let request = f.prepare_program_source(&mut retry).unwrap().unwrap();
        f.finish_program_source(&mut retry, request.attempt, false, &mut bytes)
            .unwrap();
        assert_eq!(bytes, b"poisoned input");
        assert_eq!(retry.phase, PreparationPhase::Failed);
        f.release_program(retry).unwrap();
    }
    #[test]
    fn program_authorization_precedes_source_and_has_no_published_credentials() {
        let (mut f, fs) = setup(3501, allowed());
        let c = Credentials::initial_root();
        assert!(matches!(
            f.prepare_program(&fs, &c, b"/"),
            Err(ProgramError::Credentials(
                crate::credentials::Error::NotRegular
            ))
        ));
        assert!(matches!(
            f.prepare_program(&fs, &c, b"denied"),
            Err(ProgramError::Credentials(crate::credentials::Error::Access))
        ));
        assert!(matches!(
            f.prepare_program(&fs, &c, b"missing"),
            Err(ProgramError::Path(crate::path::Error::NotFound))
        ));
        let p = f.prepare_program(&fs, &c, b"program").unwrap();
        assert_eq!(p.phase, PreparationPhase::Reserved);
        assert_eq!(p.decision.credentials.user().effective, 0);
        f.release_program(p).unwrap();
        let (mut f, fs) = setup(
            3601,
            mount::ViewPolicy {
                no_exec: true,
                ..allowed()
            },
        );
        assert!(matches!(
            f.prepare_program(&fs, &c, b"program"),
            Err(ProgramError::Credentials(crate::credentials::Error::Access))
        ));
    }
    #[test]
    fn program_holds_detached_view_after_cwd_moves_until_explicit_release() {
        let (mut f, fs) = setup(3701, allowed());
        let root = f.fs_start(&fs, Base::Root).unwrap();
        let point = f.component(&root, b"point").unwrap().unwrap();
        let view = f.clone_view(&root).unwrap();
        f.attach_view(&view, &point).unwrap();
        let mounted = f.component(&root, b"point").unwrap().unwrap();
        f.change_fs(&fs, Base::Cwd, &mounted).unwrap();
        let mut program = f
            .prepare_program(&fs, &Credentials::initial_root(), b"program")
            .unwrap();
        let held_inode = f.program_inode(&program).unwrap();
        f.change_fs(&fs, Base::Cwd, &root).unwrap();
        f.detach_view(&mounted).unwrap();
        assert!(f.release_view(view).is_ok());
        assert!(f.view_policy(&mounted).is_ok());
        assert_eq!(f.program_inode(&program), Ok(held_inode));
        let request = f.prepare_program_source(&mut program).unwrap().unwrap();
        assert_eq!(request.source, 7);
        f.finish_program_source(&mut program, request.attempt, true, &mut b"held".to_vec())
            .unwrap();
        assert_eq!(f.program_bytes(&program).unwrap(), b"held");
        f.release_program(program).unwrap();
        assert!(f.view_policy(&mounted).is_err());
        assert_eq!(f.fs_start(&fs, Base::Cwd).unwrap().inode(), root.inode());
    }
    #[test]
    fn distinct_inode_loads_and_duplicate_completions_are_independent() {
        let (mut f, fs) = setup(3801, allowed());
        let c = Credentials::initial_root();
        let mut a = f.prepare_program(&fs, &c, b"program").unwrap();
        let mut b = f.prepare_program(&fs, &c, b"second").unwrap();
        let ar = f.prepare_program_source(&mut a).unwrap().unwrap();
        let br = f.prepare_program_source(&mut b).unwrap().unwrap();
        assert_eq!((ar.source, br.source), (7, 8));
        f.finish_program_source(&mut b, br.attempt, true, &mut b"second bytes".to_vec())
            .unwrap();
        f.finish_program_source(&mut a, ar.attempt, true, &mut b"first bytes".to_vec())
            .unwrap();
        let mut duplicate = b"duplicate".to_vec();
        assert_eq!(
            f.finish_program_source(&mut a, ar.attempt, true, &mut duplicate),
            Err(Error::State)
        );
        assert_eq!(duplicate, b"duplicate");
        assert_eq!(f.program_bytes(&a).unwrap(), b"first bytes");
        assert_eq!(f.program_bytes(&b).unwrap(), b"second bytes");
        f.release_program(a).unwrap();
        f.release_program(b).unwrap();
    }
    #[test]
    fn oversized_and_failed_completion_preserve_input_and_allow_new_program_retry() {
        let (mut f, fs) = setup(3901, allowed());
        let c = Credentials::initial_root();
        let mut p = f.prepare_program(&fs, &c, b"program").unwrap();
        let request = f.prepare_program_source(&mut p).unwrap().unwrap();
        let mut bytes = vec![9; 65];
        assert_eq!(
            f.finish_program_source(&mut p, request.attempt, true, &mut bytes),
            Err(Error::Source(crate::inode::Error::Payload(
                sods_file_store::store::Error::TooLarge
            )))
        );
        assert_eq!(bytes, vec![9; 65]);
        assert_eq!(p.phase, PreparationPhase::Failed);
        assert_eq!(
            f.finish_program_source(&mut p, request.attempt, false, &mut bytes),
            Err(Error::State)
        );
        assert_eq!(bytes, vec![9; 65]);
        f.release_program(p).unwrap();
        let mut p = f.prepare_program(&fs, &c, b"program").unwrap();
        let retry = f.prepare_program_source(&mut p).unwrap().unwrap();
        assert_ne!(retry.attempt, request.attempt);
        f.finish_program_source(&mut p, retry.attempt, false, &mut bytes)
            .unwrap();
        assert_eq!(
            f.finish_program_source(&mut p, retry.attempt, true, &mut bytes),
            Err(Error::State)
        );
        assert_eq!(bytes, vec![9; 65]);
        f.release_program(p).unwrap();
        let mut p = f.prepare_program(&fs, &c, b"program").unwrap();
        let retry = f.prepare_program_source(&mut p).unwrap().unwrap();
        f.finish_program_source(&mut p, retry.attempt, true, &mut b"ok".to_vec())
            .unwrap();
        assert_eq!(f.program_bytes(&p).unwrap(), b"ok");
        f.release_program(p).unwrap();
    }
    #[test]
    fn rejected_program_admission_neither_consumes_holds_nor_starts_source() {
        let (mut f, fs) = setup(4001, allowed());
        let c = Credentials::initial_root();
        for _ in 0..16 {
            assert!(f.prepare_program(&fs, &c, b"denied").is_err());
        }
        let mut programs = Vec::new();
        // Two Fs holds plus six Program holds exactly fill the configured cap.
        for _ in 0..6 {
            programs.push(f.prepare_program(&fs, &c, b"program").unwrap());
        }
        for _ in 0..16 {
            assert!(matches!(
                f.prepare_program(&fs, &c, b"program"),
                Err(ProgramError::Files(Error::Mount(_)))
            ));
        }
        f.release_program(programs.pop().unwrap()).unwrap();
        let replacement = f.prepare_program(&fs, &c, b"program").unwrap();
        programs.push(replacement);
        let mut p = programs.pop().unwrap();
        let request = f.prepare_program_source(&mut p).unwrap().unwrap();
        // If any rejected preparation had started this source, this would
        // conflict/poison instead of producing its first loader command.
        assert_eq!(request.source, 7);
        f.finish_program_source(&mut p, request.attempt, true, &mut b"ok".to_vec())
            .unwrap();
        f.release_program(p).unwrap();
        for p in programs {
            f.release_program(p).unwrap();
        }
    }
    #[test]
    fn readiness_rejects_loading_and_foreign_without_losing_source_ownership() {
        let (mut f, fs) = setup(4101, allowed());
        let (other, _) = setup(4201, allowed());
        let mut p = f
            .prepare_program(&fs, &Credentials::initial_root(), b"program")
            .unwrap();
        let request = f.prepare_program_source(&mut p).unwrap().unwrap();
        assert_eq!(other.check_program(&p), Err(Error::BadHandle));
        assert_eq!(f.check_program(&p), Ok(()));
        let (error, p) = other.ready_program(p).unwrap_err();
        assert_eq!(error, Error::BadHandle);
        let (error, mut p) = f.ready_program(p).unwrap_err();
        assert_eq!(error, Error::State);
        assert_eq!(p.phase, PreparationPhase::Loading(request.attempt));
        f.finish_program_source(&mut p, request.attempt, true, &mut b"elf".to_vec())
            .unwrap();
        let ready = f.ready_program(p).unwrap();
        assert_eq!(f.ready_program_bytes(&ready).unwrap(), b"elf");
        f.release_ready(ready).unwrap();
    }
    #[test]
    fn ready_and_executable_transfer_keep_hold_until_final_release() {
        let (mut f, fs) = setup(4301, allowed());
        let (mut other, _) = setup(4401, allowed());
        let root = f.fs_start(&fs, Base::Root).unwrap();
        let point = f.component(&root, b"point").unwrap().unwrap();
        let view = f.clone_view(&root).unwrap();
        f.attach_view(&view, &point).unwrap();
        let mounted = f.component(&root, b"point").unwrap().unwrap();
        let mut p = f
            .prepare_program(&fs, &Credentials::initial_root(), b"/point/resident")
            .unwrap();
        assert_eq!(f.prepare_program_source(&mut p), Ok(None));
        let ready = f.ready_program(p).unwrap();
        f.detach_view(&mounted).unwrap();
        assert!(f.release_view(view).is_ok());
        assert!(f.view_policy(&mounted).is_ok());
        assert_eq!(other.check_ready(&ready), Err(Error::BadHandle));
        assert_eq!(f.check_ready(&ready), Ok(()));
        assert_eq!(other.ready_program_bytes(&ready), Err(Error::BadHandle));
        let (error, ready) = other.release_ready(ready).unwrap_err();
        assert_eq!(error, Error::BadHandle);
        assert_eq!(ready.stack_credentials().uid, 0);
        assert_eq!(f.ready_program_bytes(&ready).unwrap(), b"elf");
        let (executable, decision) = ready.publish();
        assert_eq!(decision.credentials.user().effective, 0);
        assert!(f.view_policy(&mounted).is_ok());
        let (error, executable) = other.release_executable(executable).unwrap_err();
        assert_eq!(error, Error::BadHandle);
        assert!(f.view_policy(&mounted).is_ok());
        f.release_executable(executable).unwrap();
        assert!(f.view_policy(&mounted).is_err());
    }
    #[test]
    fn selected_path_snapshot_survives_caller_changes_and_ready_move() {
        let (mut f, fs) = setup(4501, allowed());
        let c = Credentials::initial_root();
        for original in [b"./alias".as_slice(), b"/alias", &[255, 254]] {
            let mut caller_path = original.to_vec();
            let mut p = f.prepare_program(&fs, &c, &caller_path).unwrap();
            let stored = p.execfn().as_ptr();
            caller_path.fill(b'x');
            assert_eq!(p.execfn(), original);
            assert_eq!(f.prepare_program_source(&mut p), Ok(None));
            let ready = f.ready_program(p).unwrap();
            assert_eq!(ready.execfn(), original);
            assert_eq!(ready.execfn().as_ptr(), stored); // ownership move, no copy
            assert_eq!(f.ready_program_bytes(&ready).unwrap(), b"elf");
            let (executable, _) = ready.publish();
            f.release_executable(executable).unwrap();
        }
    }
}

#[cfg(test)]
mod cwd_selection_tests {
    use super::*;
    use crate::credentials::Credentials;
    use crate::inode::{Creation, Metadata};
    fn setup() -> (Files, fs_context::Ticket, Inode) {
        let metadata = Creation {
            mode: 0o755,
            uid: 0,
            gid: 0,
        };
        let mut tree = Tree::new(990, 8, 8, 64, metadata).unwrap();
        let root = tree.root();
        let dir = tree.directory(root, b"work", metadata).unwrap();
        tree.directory(
            root,
            b"private",
            Creation {
                mode: 0o700,
                ..metadata
            },
        )
        .unwrap();
        tree.file_take(dir, b"program", metadata, &mut b"ELF".to_vec())
            .unwrap();
        tree.symlink(root, b"alias", b"work", metadata).unwrap();
        let mut files = Files::new(
            991,
            tree,
            Limits {
                contexts: 2,
                tables: 1,
                descriptions: 1,
                slots: 1,
            },
        );
        let view = files
            .bootstrap_mount(
                root,
                mount::Limits { views: 2, holds: 8 },
                mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
            .unwrap();
        let place = files.view_root(&view).unwrap();
        let fs = files.create_fs(&place, &place, 0o022).unwrap();
        assert!(files.release_view(view).is_ok());
        (files, fs, dir)
    }
    #[test]
    fn selected_symlink_cwd_resolves_relative_program_and_failures_preserve_it() {
        let (mut f, fs, dir) = setup();
        let cred = Credentials::initial_root();
        f.select_cwd(&fs, &cred, b"/alias").unwrap();
        assert_eq!(f.fs_start(&fs, Base::Cwd).unwrap().inode(), dir);
        let p = f.prepare_program(&fs, &cred, b"program").unwrap();
        assert_eq!(p.execfn(), b"program");
        f.release_program(p).unwrap();
        assert!(matches!(
            f.select_cwd(&fs, &cred, b"absent"),
            Err(crate::path::Error::NotFound)
        ));
        assert!(matches!(
            f.select_cwd(&fs, &cred, b"program"),
            Err(crate::path::Error::NotDirectory)
        ));
        assert_eq!(f.fs_start(&fs, Base::Cwd).unwrap().inode(), dir);
        f.release_fs(fs).unwrap();
    }
    #[test]
    fn final_search_uses_actual_credentials_and_root_boundary_is_retained() {
        let (mut f, fs, dir) = setup();
        let user = Credentials::initial_root()
            .program(
                &Metadata {
                    mode: 0o104755,
                    uid: 1000,
                    gid: 1000,
                    nlink: 1,
                },
                false,
                false,
            )
            .unwrap()
            .credentials;
        assert!(matches!(
            f.select_cwd(&fs, &user, b"/private"),
            Err(crate::path::Error::Access)
        ));
        let before = f.fs_start(&fs, Base::Cwd).unwrap().inode();
        assert_ne!(before, dir);
        f.select_cwd(&fs, &user, b"/work").unwrap();
        let root = f.fs_start(&fs, Base::Cwd).unwrap();
        f.change_fs(&fs, Base::Root, &root).unwrap();
        f.select_cwd(&fs, &user, b"../../..").unwrap();
        assert_eq!(f.fs_start(&fs, Base::Cwd).unwrap().inode(), dir);
        f.release_fs(fs).unwrap();
    }
}

#[cfg(test)]
mod open_route_tests {
    use super::*;
    use crate::credentials::Credentials;
    use crate::inode::{Creation, Metadata};
    fn made(mode: u32) -> Creation {
        Creation {
            mode,
            uid: 0,
            gid: 0,
        }
    }
    fn setup(holds: usize) -> (Files, Table, fs_context::Ticket, Place) {
        let mut t = Tree::new(1101, 20, 20, 64, made(0o755)).unwrap();
        let root = t.root();
        let a = t.directory(root, b"a", made(0o755)).unwrap();
        let b = t.directory(root, b"b", made(0o755)).unwrap();
        t.directory(root, b"readable", made(0o444)).unwrap();
        t.file_take(a, b"file", made(0o644), &mut b"first".to_vec())
            .unwrap();
        t.file_take(b, b"file", made(0o644), &mut b"other".to_vec())
            .unwrap();
        t.file_take(root, b"private", made(0o400), &mut vec![1])
            .unwrap();
        t.symlink(root, b"dirlink", b"a", made(0o777)).unwrap();
        t.symlink(root, b"filelink", b"a/file", made(0o777))
            .unwrap();
        t.lazy_file(root, b"lazy", made(0o644), 91, 4).unwrap();
        let mut f = Files::new(
            1102,
            t,
            Limits {
                contexts: 2,
                tables: 1,
                descriptions: 8,
                slots: 8,
            },
        );
        let view = f
            .bootstrap_mount(
                root,
                mount::Limits { views: 2, holds },
                mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
            .unwrap();
        let root = f.view_root(&view).unwrap();
        // The sealed root owner deliberately retains its bootstrap ticket.
        let fs = f.create_fs(&root, &root, 0o022).unwrap();
        let table = f.table(8).unwrap();
        (f, table, fs, root)
    }
    fn options() -> OpenOptions {
        OpenOptions {
            directory: false,
            follow_terminal: true,
            cloexec: false,
        }
    }
    fn selected(f: &Files, fs: &fs_context::Ticket, path: &[u8]) -> Place {
        crate::path::resolve(f, fs, &Credentials::initial_root(), path).unwrap()
    }
    #[test]
    fn captured_directory_and_cwd_cannot_retarget_after_fd_reuse_or_fs_change() {
        let (mut f, table, fs, root) = setup(20);
        let a = selected(&f, &fs, b"/a");
        let b = selected(&f, &fs, b"/b");
        let dirfd = f.open_place(&table, &a, false).unwrap();
        let route = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), dirfd as i32)
            .unwrap();
        f.close(&table, dirfd).unwrap();
        assert_eq!(f.open_place(&table, &b, false).unwrap(), dirfd);
        f.change_fs(&fs, Base::Cwd, &b).unwrap();
        f.change_fs(&fs, Base::Root, &b).unwrap();
        let fd = f.open_read(&table, &route, b"file", options()).unwrap();
        let read = f.reserve_read(&table, fd, 5).unwrap();
        assert_eq!(f.read_bytes(&read), b"first");
        f.finish_read(read, 5);
        f.close(&table, fd).unwrap();
        let absolute = f.open_read(&table, &route, b"/a/file", options()).unwrap();
        f.close(&table, absolute).unwrap();
        f.release_open_route(route).unwrap();
        f.change_fs(&fs, Base::Root, &root).unwrap();
        let cwd = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), -100)
            .unwrap();
        f.change_fs(&fs, Base::Cwd, &a).unwrap();
        let fd = f.open_read(&table, &cwd, b"file", options()).unwrap();
        let read = f.reserve_read(&table, fd, 5).unwrap();
        assert_eq!(f.read_bytes(&read), b"other");
        f.abort_read(read);
        f.release_open_route(cwd).unwrap();
    }
    #[test]
    fn bad_dirfd_and_nondirectory_results_are_captured_but_absolute_path_ignores_them() {
        let (mut f, table, fs, _) = setup(20);
        let route = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), 0)
            .unwrap();
        let a = selected(&f, &fs, b"/a");
        assert_eq!(f.open_place(&table, &a, false), Ok(0));
        assert_eq!(
            f.open_read(&table, &route, b"file", options()),
            Err(OpenError::Path(crate::path::Error::Files(Error::BadFd)))
        );
        assert_eq!(
            f.open_read(&table, &route, b"", options()),
            Err(OpenError::Path(crate::path::Error::NotFound))
        );
        assert_eq!(
            f.open_read(&table, &route, &vec![b'x'; 4096], options()),
            Err(OpenError::Path(crate::path::Error::NameTooLong))
        );
        let fd = f.open_read(&table, &route, b"/a/file", options()).unwrap();
        f.release_open_route(route).unwrap();
        let route = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), fd as i32)
            .unwrap();
        f.close(&table, fd).unwrap();
        assert_eq!(f.open_place(&table, &a, false), Ok(fd));
        assert_eq!(
            f.open_read(&table, &route, b"file", options()),
            Err(OpenError::Path(crate::path::Error::Files(
                Error::NotDirectory
            )))
        );
        f.release_open_route(route).unwrap();
    }
    #[test]
    fn terminal_symlink_directory_and_trailing_rules_match_native_counterexamples() {
        let (mut f, table, fs, _) = setup(20);
        let route = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), -100)
            .unwrap();
        let nofollow = OpenOptions {
            follow_terminal: false,
            ..options()
        };
        assert_eq!(
            f.open_read(&table, &route, b"/dirlink", nofollow),
            Err(OpenError::Loop)
        );
        assert_eq!(
            f.open_read(
                &table,
                &route,
                b"/dirlink",
                OpenOptions {
                    directory: true,
                    ..nofollow
                }
            ),
            Err(OpenError::NotDirectory)
        );
        for path in [b"/dirlink/".as_slice(), b"/dirlink/.", b"/dirlink/../a"] {
            let fd = f
                .open_read(
                    &table,
                    &route,
                    path,
                    OpenOptions {
                        directory: true,
                        ..nofollow
                    },
                )
                .unwrap();
            assert_eq!(f.fd_kind(&table, fd), Ok(0o040000));
            f.close(&table, fd).unwrap();
        }
        assert_eq!(
            f.open_read(&table, &route, b"/filelink/", nofollow),
            Err(OpenError::Path(crate::path::Error::NotDirectory))
        );
        let fd = f
            .open_read(&table, &route, b"/filelink", options())
            .unwrap();
        f.close(&table, fd).unwrap();
        f.release_open_route(route).unwrap();
    }
    #[test]
    fn search_and_final_read_permissions_are_distinct() {
        let (mut f, table, fs, _) = setup(20);
        let credentials = Credentials::initial_root()
            .program(
                &Metadata {
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
        let route = f
            .prepare_open_route(&table, &fs, &credentials, -100)
            .unwrap();
        assert_eq!(
            f.open_read(&table, &route, b"/private", options()),
            Err(OpenError::Access)
        );
        let fd = f
            .open_read(
                &table,
                &route,
                b"/readable",
                OpenOptions {
                    directory: true,
                    ..options()
                },
            )
            .unwrap();
        f.release_open_route(route).unwrap();
        let route = f
            .prepare_open_route(&table, &fs, &credentials, fd as i32)
            .unwrap();
        assert_eq!(
            f.open_read(&table, &route, b".", options()),
            Err(OpenError::Path(crate::path::Error::Access))
        );
        f.release_open_route(route).unwrap();
    }
    #[test]
    fn lazy_source_independent_offsets_cloexec_and_read_hold_survive_close() {
        let (mut f, table, fs, _) = setup(20);
        let route = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), -100)
            .unwrap();
        let lazy = f.open_read(&table, &route, b"/lazy", options()).unwrap();
        assert_eq!(f.offset(&table, lazy), Ok((0, 0)));
        let mut p = f.begin_read(&table, lazy, 4).unwrap();
        let source = f.prepare_read(&mut p).unwrap().unwrap();
        assert_eq!(source.source, 91);
        f.finish_load(&mut p, source.attempt, false, &mut Vec::new())
            .unwrap();
        f.abort_preparation(p).unwrap();
        f.close(&table, lazy).unwrap();
        let first = f
            .open_read(
                &table,
                &route,
                b"/a/file",
                OpenOptions {
                    cloexec: true,
                    ..options()
                },
            )
            .unwrap();
        let second = f.open_read(&table, &route, b"/a/file", options()).unwrap();
        assert_eq!(f.cloexec(&table, first), Ok(true));
        assert_eq!(f.cloexec(&table, second), Ok(false));
        let read = f.reserve_read(&table, first, 2).unwrap();
        f.close(&table, first).unwrap();
        assert_eq!(
            f.open_read(&table, &route, b"/b/file", options()),
            Ok(first)
        );
        assert_eq!(f.read_bytes(&read), b"fi");
        f.finish_read(read, 2);
        assert_eq!(f.offset(&table, second), Ok((0, 0)));
        assert_eq!(f.offset(&table, first), Ok((0, 0)));
        f.release_open_route(route).unwrap();
    }
    #[test]
    fn failed_snapshot_rolls_back_every_acquired_hold_and_context() {
        let (mut f, table, fs, _) = setup(4);
        for _ in 0..32 {
            assert!(matches!(
                f.prepare_open_route(&table, &fs, &Credentials::initial_root(), -100),
                Err(Error::Fs(fs_context::Error::Mount(mount::Error::Capacity)))
            ));
        }
        let place = selected(&f, &fs, b"/a/file");
        let fd = f.open_place(&table, &place, false).unwrap();
        f.close(&table, fd).unwrap();
    }
    #[test]
    fn captured_dirfd_hold_failure_is_ignored_only_by_absolute_path() {
        let (mut f, table, fs, _) = setup(6);
        let place = selected(&f, &fs, b"/a");
        let fd = f.open_place(&table, &place, false).unwrap();
        let route = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), fd as i32)
            .unwrap();
        f.close(&table, fd).unwrap();
        let new = f.open_read(&table, &route, b"/a/file", options()).unwrap();
        assert_eq!(
            f.open_read(&table, &route, b"file", options()),
            Err(OpenError::Path(crate::path::Error::Files(Error::Mount(
                mount::Error::Capacity
            ))))
        );
        f.close(&table, new).unwrap();
        f.release_open_route(route).unwrap();
    }
    #[test]
    fn full_fd_table_precedes_lookup_and_dirfd_but_not_empty_or_length() {
        let (mut f, table, fs, _) = setup(24);
        let route = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), 99)
            .unwrap();
        for expected in 0..8 {
            assert_eq!(
                f.open_read(&table, &route, b"/a/file", options()),
                Ok(expected)
            );
        }
        for path in [b"/missing".as_slice(), b"file", b"/a/file"] {
            assert_eq!(
                f.open_read(&table, &route, path, options()),
                Err(OpenError::Files(Error::FdLimit))
            );
        }
        assert_eq!(
            f.open_read(&table, &route, b"", options()),
            Err(OpenError::Path(crate::path::Error::NotFound))
        );
        assert_eq!(
            f.open_read(&table, &route, &vec![b'x'; 4096], options()),
            Err(OpenError::Path(crate::path::Error::NameTooLong))
        );
        f.close(&table, 3).unwrap();
        assert_eq!(
            f.open_read(&table, &route, b"/missing", options()),
            Err(OpenError::Path(crate::path::Error::NotFound))
        );
        assert_eq!(
            f.open_read(&table, &route, b"file", options()),
            Err(OpenError::Path(crate::path::Error::Files(Error::BadFd)))
        );
        assert_eq!(f.open_read(&table, &route, b"/a/file", options()), Ok(3));
        f.release_open_route(route).unwrap();
    }
    #[test]
    fn detached_route_and_new_ofd_keep_the_same_view_until_last_read_ends() {
        let (mut f, table, fs, root) = setup(24);
        let a = selected(&f, &fs, b"/a");
        let b = selected(&f, &fs, b"/b");
        let view = f.clone_view(&a).unwrap();
        f.attach_view(&view, &b).unwrap();
        let mounted = f.component(&root, b"b").unwrap().unwrap();
        let file = f.component(&mounted, b"file").unwrap().unwrap();
        let fd = f.open_place(&table, &mounted, false).unwrap();
        let route = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), fd as i32)
            .unwrap();
        assert!(f.release_view(view).is_ok());
        f.detach_view(&mounted).unwrap();
        f.close(&table, fd).unwrap();
        let fd = f.open_read(&table, &route, b"file", options()).unwrap();
        let read = f.reserve_read(&table, fd, 5).unwrap();
        f.release_open_route(route).unwrap();
        f.close(&table, fd).unwrap();
        assert_eq!(f.read_bytes(&read), b"first");
        f.finish_read(read, 5);
        assert_eq!(
            f.open_place(&table, &file, false),
            Err(Error::Mount(mount::Error::BadPlace))
        );
    }
    #[test]
    fn slot_description_and_final_hold_failure_publish_no_fd_and_keep_route_owned() {
        let (mut f, table, fs, _) = setup(5);
        let route = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), -100)
            .unwrap();
        assert_eq!(
            f.open_read(&table, &route, b"/a/file", options()),
            Err(OpenError::Files(Error::Mount(mount::Error::Capacity)))
        );
        assert_eq!(f.live_slots, 0);
        assert_eq!(f.description(&table, 0), Err(Error::BadFd));
        f.release_open_route(route).unwrap();
        let place = selected(&f, &fs, b"/a/file");
        assert_eq!(f.open_place(&table, &place, false), Ok(0));
        let (mut f, table, fs, _) = setup(20);
        let route = f
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), -100)
            .unwrap();
        f.limits.slots = 0;
        assert_eq!(
            f.open_read(&table, &route, b"/a/file", options()),
            Err(OpenError::Files(Error::Capacity))
        );
        f.limits.slots = 8;
        f.limits.descriptions = 0;
        assert_eq!(
            f.open_read(&table, &route, b"/a/file", options()),
            Err(OpenError::Files(Error::Capacity))
        );
        assert_eq!(f.live_slots, 0);
        assert_eq!(f.description(&table, 0), Err(Error::BadFd));
        f.limits.descriptions = 8;
        assert_eq!(f.open_read(&table, &route, b"/a/file", options()), Ok(0));
        f.release_open_route(route).unwrap();
    }
    #[test]
    fn route_release_rejects_foreign_owner_without_losing_ticket() {
        let (mut a, table, fs, _) = setup(20);
        let route = a
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), -100)
            .unwrap();
        let tree = Tree::new(2201, 1, 1, 1, made(0o755)).unwrap();
        let mut b = Files::new(
            2202,
            tree,
            Limits {
                contexts: 1,
                tables: 1,
                descriptions: 1,
                slots: 1,
            },
        );
        let (error, route) = b.release_open_route(route).unwrap_err();
        assert_eq!(error, Error::BadHandle);
        a.release_open_route(route).unwrap();
        let route = a
            .prepare_open_route(&table, &fs, &Credentials::initial_root(), -100)
            .unwrap();
        a.release_open_route(route).unwrap();
    }
}

#[cfg(test)]
mod read_reservation_tests {
    use super::*;

    fn setup(owner: u64, slots: usize) -> (Files, Inode) {
        let made = |mode| crate::inode::Creation {
            mode,
            uid: 0,
            gid: 0,
        };
        let mut tree = Tree::new(owner - 1, 4, 4, 16, made(0o755)).unwrap();
        let inode = tree
            .file_take(tree.root(), b"f", made(0o600), &mut b"body".to_vec())
            .unwrap();
        (
            Files::new(
                owner,
                tree,
                Limits {
                    contexts: 2,
                    tables: 2,
                    descriptions: 4,
                    slots,
                },
            ),
            inode,
        )
    }

    #[test]
    fn read_reservation_identity_survives_capture_but_not_abort_and_same_offset_readmission() {
        let (mut f, inode) = setup(1402, 8);
        let table = f.table(8).unwrap();
        let fd = f.open(&table, inode, false).unwrap();
        let alias = f.dup(&table, fd, 0, false).unwrap();
        let first = f.reserve_read(&table, fd, 2).unwrap();
        let old = (first.reservation, first.offset, first.next_revision);
        f.abort_read(first);
        let mut next = f.reserve_read(&table, alias, 2).unwrap();
        assert_eq!((next.offset, next.next_revision), (old.1, old.2));
        assert_ne!(
            next.reservation, old.0,
            "abort is not a reusable reservation"
        );
        let exact = next.reservation;
        next.reservation = old.0; // Test-only stale A presented while B is live.
        assert_eq!(f.check_read_hold(&next), Err(Error::State));
        next.reservation = exact;
        assert_eq!(f.check_read_hold(&next), Ok(()));
        assert_eq!(f.set_offset(&table, fd, 0), Err(Error::Busy));
        let nonempty_id = next.reservation;
        f.finish_read(next, 1);
        assert_eq!(f.offset(&table, fd).unwrap(), (1, 1));
        let zero = f.reserve_read(&table, fd, 0).unwrap();
        assert_eq!(zero.length(), 0);
        assert_ne!(zero.reservation, nonempty_id);
        let zero_id = zero.reservation;
        f.finish_read(zero, 0);
        assert_eq!(f.offset(&table, alias).unwrap(), (1, 1));
        let last = f.reserve_read(&table, fd, 1).unwrap();
        assert_ne!(last.reservation, zero_id);
        f.abort_read(last);
    }

    #[test]
    fn wrong_preparation_reservation_cannot_dispatch_or_capture_another_live_read() {
        let (mut f, inode) = setup(1402, 8);
        let table = f.table(8).unwrap();
        let fd = f.open(&table, inode, false).unwrap();
        let mut prep = f.begin_read(&table, fd, 2).unwrap();
        let exact = prep.reservation;
        prep.reservation = NonZeroU64::new(exact.get() + 1).unwrap();
        assert_eq!(f.prepare_read(&mut prep), Err(Error::State));
        let (error, mut prep) = f.capture_read(prep).err().unwrap();
        assert_eq!(error, Error::State);
        assert_eq!(f.offset(&table, fd).unwrap(), (0, 0));
        assert_eq!(f.set_offset(&table, fd, 0), Err(Error::Busy));
        prep.reservation = exact;
        assert_eq!(f.prepare_read(&mut prep), Ok(None));
        let hold = f.capture_read(prep).ok().unwrap();
        assert_eq!(hold.reservation, exact);
        f.abort_read(hold);
        assert_eq!(f.offset(&table, fd).unwrap(), (0, 0));
    }

    #[test]
    fn read_reservation_exhaustion_never_wraps_or_leaks_admission() {
        let (mut f, inode) = setup(1402, 8);
        let table = f.table(8).unwrap();
        let fd = f.open(&table, inode, false).unwrap();
        f.next_read_reservation = NonZeroU64::new(u64::MAX);
        assert!(matches!(
            f.begin_read(&table, u32::MAX, 1),
            Err(Error::BadFd)
        ));
        assert_eq!(f.next_read_reservation.unwrap().get(), u64::MAX);
        let last = f.reserve_read(&table, fd, 1).unwrap();
        assert_eq!(last.reservation.get(), u64::MAX);
        assert_eq!(f.next_read_reservation, None);
        assert!(matches!(f.begin_read(&table, fd, 1), Err(Error::Busy)));
        f.abort_read(last);
        assert!(matches!(f.begin_read(&table, fd, 1), Err(Error::Overflow)));
        assert_eq!(f.offset(&table, fd).unwrap(), (0, 0));
        // Failed exhaustion did not keep a description ref or a reading lock.
        f.set_offset(&table, fd, 0).unwrap();
        let id = f.description(&table, fd).unwrap();
        assert_eq!(get(&f.descriptions, f.owner, id).unwrap().refs, 1);
        f.close(&table, fd).unwrap();
        assert_eq!(f.open(&table, inode, false).unwrap(), fd);
    }

    #[test]
    fn equal_local_read_numbers_never_validate_a_foreign_files_hold() {
        let (mut a, ai) = setup(1402, 8);
        let at = a.table(8).unwrap();
        let af = a.open(&at, ai, false).unwrap();
        let ah = a.reserve_read(&at, af, 2).unwrap();
        let (mut b, bi) = setup(1404, 8);
        let bt = b.table(8).unwrap();
        let bf = b.open(&bt, bi, false).unwrap();
        let bh = b.reserve_read(&bt, bf, 2).unwrap();
        assert_eq!(ah.reservation, bh.reservation);
        assert_eq!(ah.description.slot, bh.description.slot);
        assert_eq!(a.check_read_hold(&bh), Err(Error::BadHandle));
        assert_eq!(b.check_read_hold(&ah), Err(Error::BadHandle));
        assert_eq!(a.check_read_hold(&ah), Ok(()));
        assert_eq!(b.check_read_hold(&bh), Ok(()));
        a.abort_read(ah);
        b.finish_read(bh, 1);
        assert_eq!(a.offset(&at, af).unwrap(), (0, 0));
        assert_eq!(b.offset(&bt, bf).unwrap(), (1, 1));
    }
}
