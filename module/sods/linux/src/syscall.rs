//! Private fixed-memory read-only open/openat/read/close/stdio/exit continuation,
//! NOT the complete Linux syscall ABI. Prepared regular files/directories only;
//! unsupported access/status flags, signals, mappings and multi-thread exit stay
//! outside the profile. Physical-range clipping is not virtual mapping authority
//! or a claim of normative Linux pointer-fault equivalence.
//! Only the sequenced Worker entrance additionally admits low-address SET_FS;
//! its physical register evidence is separate from byte access and run unwind.
//! Sequenced sendfile retains an exact source/output owner and capability ticket;
//! current production completes only rejection, never a physical output offer.
//! TS transports commands; syscall numbers, errors and resume register values
//! are decided here. The managed owner must not expose the owned ReadId for
//! independent retirement or manufacture source-failure evidence.
use crate::descriptor::{self, Files, OpenError, OpenOptions, OpenRoute, Table};
use crate::effect::{Completion, Token};
use crate::execution::{self, Execution, Invocation, Phase, Snapshot};
use crate::lease::{self, Domain};
use crate::read::{self, Reads};
#[cfg(not(feature = "capture-v1"))]
use crate::sendfile::{self, AccessEvidence, CapabilityReceipt, CapabilityRequest, Sendfile};
use crate::single_task::SingleTask;
use crate::{credentials::Credentials, fs_context::Ticket};
#[cfg(any(test, feature = "queued-worker-probe", feature = "capture-v1"))]
mod captured_write;
#[cfg(any(test, feature = "queued-worker-probe", feature = "capture-v1"))]
use descriptor::capture;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    State,
    ReadFailed,
    Execution(execution::Error),
    Read(read::Error),
    Lease(lease::Error),
    Files(descriptor::Error),
    #[cfg(not(feature = "capture-v1"))]
    Sendfile(sendfile::Error),
    #[cfg(any(test, feature = "queued-worker-probe", feature = "capture-v1"))]
    Capture(capture::Error),
}
impl From<execution::Error> for Error {
    fn from(e: execution::Error) -> Self {
        Self::Execution(e)
    }
}
impl From<read::Error> for Error {
    fn from(e: read::Error) -> Self {
        Self::Read(e)
    }
}
impl From<lease::Error> for Error {
    fn from(e: lease::Error) -> Self {
        Self::Lease(e)
    }
}
#[cfg(not(feature = "capture-v1"))]
impl From<sendfile::Error> for Error {
    fn from(e: sendfile::Error) -> Self {
        Self::Sendfile(e)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Resume {
    pub next: u64,
    pub rax: i64,
    pub rcx: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Return(i64),
    Read {
        id: u64,
        target: u64,
    },
    Stream {
        action: Token,
        endpoint: u64,
        target: u64,
        length: u64,
        write: bool,
    },
    Path {
        action: Token,
        target: u64,
        length: u64,
    },
    SetFs {
        action: Token,
        sequence: u32,
        base: u64,
    },
    #[cfg(not(feature = "capture-v1"))]
    SendfileCapability {
        action: Token,
        sequence: u32,
        endpoint: u64,
    },
    #[cfg(not(feature = "capture-v1"))]
    SendfileLoad {
        action: Token,
        sequence: u32,
    },
    #[cfg(not(feature = "capture-v1"))]
    SendfileOffer {
        action: Token,
        sequence: u32,
        endpoint: u64,
        length: u64,
    },
    #[cfg(any(test, feature = "queued-worker-probe", feature = "capture-v1"))]
    CaptureWrite {
        call: capture::CallId,
        at: u64,
        length: u64,
    },
    #[cfg(test)]
    CapturePressure {
        call: capture::CallId,
    },
    Exit,
    Unsupported(u64),
    Waiting,
    Resume(Resume),
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Progress {
    Reading,
    Applying,
    Uncertain,
}
struct Pending {
    invocation: Invocation,
    snapshot: Snapshot,
    read: u64,
    next: u64,
    source_failed: bool,
    progress: Progress,
}
/// Known errors certify zero effect and stopped host access. Unknown certifies
/// neither. The adapter must never classify an arbitrary throw as known zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PhysicalResult {
    Transferred,
    Again,
    Interrupted,
    BadFd,
    BrokenPipe,
    Io,
    Unknown,
}
struct StreamPending {
    hold: descriptor::StreamHold,
    invocation: Invocation,
    snapshot: Snapshot,
    action: Token,
    started: bool,
}
/// Trusted physical-register evidence, not a Linux syscall result. Unknown
/// certifies neither non-application nor ended access and must not be replayed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RegisterOutcome {
    AppliedStopped,
    NotAppliedStopped,
    Unknown,
}
struct RegisterPending {
    snapshot: Snapshot,
    invocation: Invocation,
    sequence: u32,
    action: Token,
    base: u64,
    started: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathOutcome {
    Captured,
    Failed,
    Unknown,
}
#[cfg(not(feature = "capture-v1"))]
struct SendfilePending {
    owner: Sendfile,
    cap_request: Option<CapabilityRequest>,
}
// The whole physical owner participates, including a terminal receipt whose
// capability ticket has not yet been observed. Ordinary builds retain their
// exact Option<SendfilePending> representation, with no additional tag.
#[cfg(all(not(feature = "capture-v1"), any(test, feature = "queued-worker-probe")))]
enum OutputOwner {
    Physical(SendfilePending),
    Captured(capture::WriteCall),
}
#[cfg(all(not(feature = "capture-v1"), not(any(test, feature = "queued-worker-probe"))))]
type OutputOwner = SendfilePending;
#[cfg(feature = "capture-v1")]
type OutputOwner = capture::WriteCall;
/// Private diagnostic scalars, not a physical capability or guest result.
#[cfg(not(feature = "capture-v1"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SendfileStatus {
    pub phase: sendfile::Phase,
    pub sequence: u32,
    pub action: Option<Token>,
    pub endpoint: u64,
    pub offered: u64,
    pub confirmed: u64,
    pub closed: bool,
    pub finished: bool,
}
struct Opening {
    original_nr: u64,
    invocation: Invocation,
    snapshot: Snapshot,
    route: OpenRoute,
    options: OpenOptions,
    action: Token,
    length: u64,
    started: bool,
    viewing: bool,
    cancelled: bool,
}
fn file_error(error: descriptor::Error) -> Result<i64, Error> {
    match error {
        descriptor::Error::BadFd => Ok(-9),
        descriptor::Error::FdLimit => Ok(-24),
        descriptor::Error::NotDirectory => Ok(-20),
        descriptor::Error::Capacity
        | descriptor::Error::Mount(crate::mount::Error::Capacity)
        | descriptor::Error::Fs(crate::fs_context::Error::Capacity)
        | descriptor::Error::Fs(crate::fs_context::Error::Mount(crate::mount::Error::Capacity)) => {
            Ok(-12)
        }
        other => Err(Error::Files(other)),
    }
}
/// Only callback-free, fully rolled-back sendfile begin errors reach here.
/// Keep this narrower than all file_error cases; Domain/Busy/identity/source
/// failures are transport/internal failures, never invented Linux errno.
#[cfg(not(feature = "capture-v1"))]
fn sendfile_admission_error(error: sendfile::Error) -> Result<Step, Error> {
    match error {
        sendfile::Error::Unsupported40
        | sendfile::Error::Files(descriptor::Error::NotSupported) => Ok(Step::Unsupported(40)),
        sendfile::Error::Files(
            error @ (descriptor::Error::BadFd | descriptor::Error::Capacity),
        ) => file_error(error).map(Step::Return),
        other => Err(Error::Sendfile(other)),
    }
}
fn open_error(nr: u64, error: OpenError) -> Result<Step, Error> {
    let value = match error {
        OpenError::Files(error) | OpenError::Path(crate::path::Error::Files(error)) => {
            file_error(error)?
        }
        OpenError::Path(crate::path::Error::NotFound) => -2,
        OpenError::NotDirectory | OpenError::Path(crate::path::Error::NotDirectory) => -20,
        OpenError::Access | OpenError::Path(crate::path::Error::Access) => -13,
        OpenError::Loop | OpenError::Path(crate::path::Error::Loop) => -40,
        OpenError::Path(crate::path::Error::NameTooLong) => -36,
        OpenError::Path(crate::path::Error::InvalidPath) => return Err(Error::State),
        OpenError::Unsupported => return Ok(Step::Unsupported(nr)),
    };
    Ok(Step::Return(value))
}
pub(crate) struct Continuation {
    owner: Snapshot,
    pending: Option<Pending>,
    stream: Option<StreamPending>,
    opening: Option<Opening>,
    register: Option<RegisterPending>,
    output: Option<OutputOwner>,
    path_input: Vec<u8>,
    closed: bool,
    last_sequence: u32,
    single_task: SingleTask,
}
impl Continuation {
    pub(crate) fn new(execution: &Execution) -> Result<Self, Error> {
        Ok(Self {
            owner: execution.stamp()?,
            pending: None,
            stream: None,
            opening: None,
            register: None,
            output: None,
            path_input: Vec::new(),
            closed: false,
            last_sequence: 0,
            single_task: SingleTask::new(execution)?,
        })
    }
    /// Only Reading retains a live Reads record; Applying/Uncertain owns the
    /// resume obligation after that record has already been retired.
    pub(crate) fn owns_read(&self, id: u64) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|p| p.read == id && p.progress == Progress::Reading)
    }
    fn owner(&self, execution: &Execution) -> Result<(), Error> {
        if !execution.owns_snapshot(self.owner) {
            return Err(Error::Execution(execution::Error::Identity));
        }
        Ok(())
    }

    #[inline(always)]
    pub(crate) fn has_byte_output(&self) -> bool {
        self.output.is_some()
    }

    #[cfg(not(feature = "capture-v1"))]
    #[inline(always)]
    fn sendfile(&self) -> Option<&SendfilePending> {
        #[cfg(any(test, feature = "queued-worker-probe"))]
        return match &self.output {
            Some(OutputOwner::Physical(owner)) => Some(owner),
            _ => None,
        };
        #[cfg(not(any(test, feature = "queued-worker-probe")))]
        self.output.as_ref()
    }

    #[cfg(not(feature = "capture-v1"))]
    #[inline(always)]
    fn sendfile_mut(&mut self) -> Option<&mut SendfilePending> {
        #[cfg(any(test, feature = "queued-worker-probe"))]
        return match &mut self.output {
            Some(OutputOwner::Physical(owner)) => Some(owner),
            _ => None,
        };
        #[cfg(not(any(test, feature = "queued-worker-probe")))]
        self.output.as_mut()
    }

    #[cfg(not(feature = "capture-v1"))]
    #[inline(always)]
    fn install_sendfile(&mut self, owner: SendfilePending) {
        #[cfg(any(test, feature = "queued-worker-probe"))]
        let owner = {
            assert!(self.output.is_none(), "admitted physical owner requires an empty slot");
            OutputOwner::Physical(owner)
        };
        self.output = Some(owner);
    }

    #[cfg(not(feature = "capture-v1"))]
    #[inline(always)]
    fn clear_sendfile(&mut self) {
        #[cfg(any(test, feature = "queued-worker-probe"))]
        assert!(matches!(&self.output, Some(OutputOwner::Physical(_))));
        self.output = None;
    }
    pub(crate) fn enter(
        &mut self,
        files: &mut Files,
        table: &Table,
        reads: &mut Reads,
        domain: &mut Domain,
        execution: &mut Execution,
        invocation: Invocation,
        nr: u64,
        args: [u64; 6],
        next: u64,
    ) -> Result<Step, Error> {
        self.enter_with_namespace(
            files, table, None, reads, domain, execution, invocation, nr, args, next,
        )
    }
    pub(crate) fn enter_with_namespace(
        &mut self,
        files: &mut Files,
        table: &Table,
        namespace: Option<(&Ticket, &Credentials)>,
        reads: &mut Reads,
        domain: &mut Domain,
        execution: &mut Execution,
        invocation: Invocation,
        nr: u64,
        args: [u64; 6],
        next: u64,
    ) -> Result<Step, Error> {
        self.enter_request(
            files, table, namespace, reads, domain, execution, invocation, None, nr, args, next,
        )
    }
    /// Actual Worker entrance: every request consumes the next sequence at
    /// admission, not at physical start. Unsupported/capacity failures also
    /// consume it once common owner/phase/pending/sequence checks pass. Such a
    /// failure publishes no action/hold/result, but transport must not retry it.
    pub(crate) fn enter_sequenced(
        &mut self,
        files: &mut Files,
        table: &Table,
        namespace: Option<(&Ticket, &Credentials)>,
        reads: &mut Reads,
        domain: &mut Domain,
        execution: &mut Execution,
        invocation: Invocation,
        sequence: u32,
        nr: u64,
        args: [u64; 6],
        next: u64,
    ) -> Result<Step, Error> {
        self.enter_request(
            files,
            table,
            namespace,
            reads,
            domain,
            execution,
            invocation,
            Some(sequence),
            nr,
            args,
            next,
        )
    }
    /// Shared sequenced admission, including explicit diagnostic producers.
    /// A successful admission consumes its sequence even if preparation fails.
    #[inline]
    pub(crate) fn admit_request(
        &mut self,
        domain: &Domain,
        execution: &Execution,
        invocation: Invocation,
        sequence: Option<u32>,
    ) -> Result<(), Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        execution.syscall_allowed(invocation)?;
        if self.closed
            || self.pending.is_some()
            || self.stream.is_some()
            || self.opening.is_some()
            || self.register.is_some()
            || self.has_byte_output()
        {
            return Err(Error::State);
        }
        if let Some(sequence) = sequence {
            if sequence == 0
                || sequence > i32::MAX as u32
                || self.last_sequence.checked_add(1) != Some(sequence)
            {
                return Err(Error::State);
            }
            self.last_sequence = sequence;
        }
        Ok(())
    }
    fn enter_request(
        &mut self,
        files: &mut Files,
        table: &Table,
        namespace: Option<(&Ticket, &Credentials)>,
        reads: &mut Reads,
        domain: &mut Domain,
        execution: &mut Execution,
        invocation: Invocation,
        sequence: Option<u32>,
        nr: u64,
        args: [u64; 6],
        next: u64,
    ) -> Result<Step, Error> {
        self.admit_request(domain, execution, invocation, sequence)?;
        #[cfg(feature = "capture-v1")]
        if nr == 40 {
            // The distinct captured ingress has not been selected yet.
            return Ok(Step::Unsupported(40));
        }
        #[cfg(not(feature = "capture-v1"))]
        if nr == 40 {
            let Some(sequence) = sequence else {
                return Ok(Step::Unsupported(40));
            };
            let mut owner = Sendfile::new(files);
            if let Err(error) =
                owner.begin(files, table, domain, execution, invocation, sequence, args)
            {
                if owner.phase() == sendfile::Phase::Idle
                    || (owner.finished()
                        && owner.result() == Some(sendfile::ResultValue::AdmissionFailed)
                        && !owner.closed())
                {
                    let mapped = sendfile_admission_error(error);
                    if mapped.is_err() {
                        self.closed = true;
                    }
                    return mapped;
                }
                self.install_sendfile(SendfilePending {
                    owner,
                    cap_request: None,
                });
                self.closed = true;
                return Err(error.into());
            }
            self.install_sendfile(SendfilePending {
                owner,
                cap_request: None,
            });
            return self.sendfile_step(execution);
        }
        if nr == 218 {
            if sequence.is_none() {
                return Ok(Step::Unsupported(nr));
            }
            return self
                .single_task
                .register(execution, invocation, args[0])
                .map(|tid| Step::Return(i64::from(tid)))
                .map_err(Into::into);
        }
        if nr == 231 {
            if sequence.is_none() {
                return Ok(Step::Unsupported(nr));
            }
            self.single_task
                .exit_group(execution, invocation, args[0])?;
            return Ok(Step::Exit);
        }
        if nr == 158 {
            let Some(sequence) = sequence else {
                return Ok(Step::Unsupported(nr));
            };
            // Explicit low-address ARCH_SET_FS only. The base is a register
            // value, not a buffer: no dereference or extent/range permission.
            if args[0] != 0x1002 || args[1] > u32::MAX as u64 {
                return Ok(Step::Unsupported(nr));
            }
            let snapshot = execution.stamp()?;
            let action = domain.effect(execution.binding(), 1)?;
            execution
                .hold_call(invocation)
                .expect("validated callback-free register admission");
            self.register = Some(RegisterPending {
                snapshot,
                invocation,
                sequence,
                action,
                base: args[1],
                started: false,
            });
            return Ok(Step::SetFs {
                action,
                sequence,
                base: args[1],
            });
        }
        if nr == 2 || nr == 257 {
            let Some((fs, credentials)) = namespace else {
                return Ok(Step::Unsupported(nr));
            };
            // open(path, flags, mode) is the same captured openat owner with
            // AT_FDCWD. Read-only admission never consumes the creation mode.
            let (dirfd, address, flags) = if nr == 2 {
                (-100, args[0], args[1] as u32)
            } else {
                (args[0] as u32 as i32, args[1], args[2] as u32)
            };
            // Only this explicit read-only regular/directory profile is admitted.
            const ADMITTED: u32 = 0x80000 | 0x10000 | 0x20000 | 0x100 | 0x8000;
            if flags & !ADMITTED != 0 {
                return Ok(Step::Unsupported(nr));
            }
            let extent = domain.extent(execution.binding())?;
            if address == 0 || address >= extent {
                return Ok(Step::Return(-14));
            }
            let length = 4096.min(extent - address);
            if self.path_input.is_empty() {
                if self.path_input.try_reserve_exact(4096).is_err() {
                    return Ok(Step::Return(-12));
                }
                self.path_input.resize(4096, 0);
            }
            let route = match files.prepare_open_route(table, fs, credentials, dirfd) {
                Ok(route) => route,
                Err(error) => return file_error(error).map(Step::Return),
            };
            let action = match domain.span(execution.binding(), address, length) {
                Ok(action) => action,
                Err(error) => {
                    files
                        .release_open_route(route)
                        .expect("same private lookup owner, no interleaving");
                    return if error == lease::Error::Capacity {
                        Ok(Step::Return(-12))
                    } else {
                        Err(error.into())
                    };
                }
            };
            let snapshot = execution
                .stamp()
                .expect("validated callback-free invocation");
            execution
                .hold_call(invocation)
                .expect("validated callback-free admission");
            self.opening = Some(Opening {
                original_nr: nr,
                invocation,
                snapshot,
                route,
                options: OpenOptions {
                    directory: flags & 0x10000 != 0,
                    follow_terminal: flags & 0x20000 == 0,
                    cloexec: flags & 0x80000 != 0,
                },
                action,
                length,
                started: false,
                viewing: false,
                cancelled: false,
            });
            return Ok(Step::Path {
                action,
                target: address,
                length,
            });
        }
        if nr == 3 {
            return match files.close(table, args[0] as u32) {
                Ok(()) => Ok(Step::Return(0)),
                Err(error) => file_error(error).map(Step::Return),
            };
        }
        if nr == 0 || nr == 1 {
            let fd = args[0] as u32;
            let target = match files.target(table, fd) {
                Ok(target) => target,
                Err(descriptor::Error::BadFd) => return Ok(Step::Return(-9)),
                Err(error) => return Err(Error::Files(error)),
            };
            // The staged captured target has no physical endpoint. Until a
            // real captured write route exists it cannot become a host command,
            // including zero-count writes. It is not readable.
            #[cfg(any(test, feature = "queued-output-probe", feature = "capture-v1"))]
            if target == descriptor::Target::CapturedOutput {
                return Ok(if nr == 0 {
                    Step::Return(-9)
                } else {
                    Step::Unsupported(nr)
                });
            }
            if let descriptor::Target::HostStream {
                endpoint,
                direction,
            } = target
            {
                let write = nr == 1;
                let wanted = if write {
                    descriptor::StreamDirection::Write
                } else {
                    descriptor::StreamDirection::Read
                };
                if direction != wanted {
                    return Ok(Step::Return(-9));
                }
                #[cfg(feature = "capture-v1")]
                if write {
                    // A malformed borrowed-output table cannot bypass capture.
                    // Stdin still needs the physical read transport below.
                    return Ok(Step::Unsupported(nr));
                }
                // Stream consumes irreversibly: unlike resident file clipping,
                // validate the full requested range before any host command.
                if args[1]
                    .checked_add(args[2])
                    .is_none_or(|end| end > 0x7ffffffff000)
                {
                    return Ok(Step::Return(-14));
                }
                if args[2] == 0 {
                    return Ok(Step::Return(0));
                }
                match domain.range(execution.binding(), args[1], args[2]) {
                    Ok(()) => (),
                    Err(lease::Error::Range) => return Ok(Step::Return(-14)),
                    Err(error) => return Err(error.into()),
                }
                if execution.phase() != Phase::Running {
                    return Err(Error::State);
                }
                let snapshot = execution.stamp()?;
                let length = args[2].min(0x7ffff000);
                let hold = files.hold_stream(table, fd, wanted).map_err(Error::Files)?;
                let action = match domain.span(execution.binding(), args[1], length) {
                    Ok(action) => action,
                    Err(error) => {
                        files.release_stream(hold).expect("same admitted owner");
                        return Err(error.into());
                    }
                };
                execution
                    .hold_call(invocation)
                    .expect("validated callback-free admission");
                self.stream = Some(StreamPending {
                    hold,
                    invocation,
                    snapshot,
                    action,
                    started: false,
                });
                return Ok(Step::Stream {
                    action,
                    endpoint,
                    target: args[1],
                    length,
                    write,
                });
            }
        }
        match nr {
            60 => {
                execution.request_exit(invocation, (args[0] & 255) as u32)?;
                Ok(Step::Exit)
            }
            0 => {
                // FD/access precedes numerical access_ok, then the file operation.
                // Physical mapping holes remain outside this fixed-memory profile.
                let fd = args[0] as u32; // Linux syscall argument uses int fd.
                match files.inode(table, fd) {
                    Ok(_) => {}
                    Err(descriptor::Error::BadFd) => return Ok(Step::Return(-9)),
                    Err(e) => return Err(Error::Files(e)),
                }
                let at = args[1];
                let requested = args[2];
                const TASK_SIZE: u64 = 0x7ffffffff000;
                if at.checked_add(requested).is_none_or(|end| end > TASK_SIZE) {
                    return Ok(Step::Return(-14));
                }
                if files.fd_kind(table, fd).map_err(Error::Files)? == 0o040000 {
                    return Ok(Step::Return(-21));
                }
                if requested == 0 {
                    return Ok(Step::Return(0));
                }
                let extent = domain.extent(execution.binding())?;
                if at >= extent {
                    return Ok(Step::Return(-14));
                }
                let length = requested.min(extent - at);
                let id = match reads.begin_managed(files, table, domain, execution, fd, at, length)
                {
                    Ok(id) => id,
                    Err(read::Error::Files(descriptor::Error::NotSupported)) => {
                        return Ok(Step::Unsupported(nr))
                    }
                    Err(e) => return Err(e.into()),
                };
                // No host callback or competing owner between admission and hold.
                execution
                    .hold_call(invocation)
                    .expect("validated syscall admission");
                self.pending = Some(Pending {
                    invocation,
                    snapshot: execution.stamp()?,
                    read: id,
                    next,
                    source_failed: false,
                    progress: Progress::Reading,
                });
                Ok(Step::Read { id, target: at })
            }
            _ => Ok(Step::Unsupported(nr)),
        }
    }
    pub(crate) fn owns(&self, token: Token) -> bool {
        #[cfg(feature = "capture-v1")]
        if self.output.as_ref().is_some_and(|owner| owner.id().action == token) {
            return true;
        }
        #[cfg(all(not(feature = "capture-v1"), any(test, feature = "queued-worker-probe")))]
        if let Some(OutputOwner::Captured(owner)) = &self.output {
            if owner.id().action == token {
                return true;
            }
        }
        self.stream.as_ref().is_some_and(|p| p.action == token)
            || self.opening.as_ref().is_some_and(|p| p.action == token)
            || self.register.as_ref().is_some_and(|p| p.action == token)
            || {
                #[cfg(not(feature = "capture-v1"))]
                { self.sendfile().is_some_and(|p| p.owner.owns(token)) }
                #[cfg(feature = "capture-v1")]
                { false }
            }
    }
    /// Includes terminal observations until removed; unfinished owners must not
    /// be dropped by execution retirement even if their core view has ended.
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_pending(&self) -> bool {
        #[cfg(any(test, feature = "queued-worker-probe"))]
        return matches!(&self.output, Some(OutputOwner::Physical(_)));
        #[cfg(not(any(test, feature = "queued-worker-probe")))]
        self.has_byte_output()
    }
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_references(&self, execution: &Execution) -> bool {
        self.sendfile()
            .is_some_and(|p| p.owner.references(execution))
    }
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_view(&self) -> Option<(u32, Token)> {
        self.sendfile()
            .filter(|p| p.owner.viewing())
            .and_then(|p| Some((p.owner.sequence()?, p.owner.action()?)))
    }
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_query(
        &self,
        execution: &Execution,
    ) -> Result<Option<SendfileStatus>, Error> {
        self.owner(execution)?;
        Ok(self.sendfile().map(|p| SendfileStatus {
            phase: p.owner.phase(),
            sequence: p.owner.sequence().unwrap_or(0),
            action: p.owner.action(),
            endpoint: p.owner.endpoint().unwrap_or(0),
            offered: p.owner.offered(),
            confirmed: p.owner.confirmed(),
            closed: self.closed || p.owner.closed(),
            finished: p.owner.finished(),
        }))
    }
    #[cfg(not(feature = "capture-v1"))]
    fn sync_sendfile_closed(&mut self) {
        if self
            .sendfile()
            .is_some_and(|p| p.owner.closed() || p.owner.phase() == sendfile::Phase::Closing)
        {
            self.closed = true;
        }
    }
    #[cfg(not(feature = "capture-v1"))]
    fn sendfile_step(&mut self, execution: &Execution) -> Result<Step, Error> {
        self.sync_sendfile_closed();
        let p = self.sendfile().ok_or(Error::State)?;
        if p.owner.finished() {
            if p.cap_request.is_some() {
                return Err(Error::State);
            }
            let result = p.owner.result().ok_or(Error::State)?;
            let command = match result {
                sendfile::ResultValue::Return(n)
                    if !self.closed && execution.phase() == Phase::Running =>
                {
                    Step::Return(n)
                }
                sendfile::ResultValue::Unsupported40 => {
                    self.closed = true;
                    Step::Unsupported(40)
                }
                sendfile::ResultValue::AdmissionFailed => {
                    self.closed = true;
                    return Err(Error::State);
                }
                _ => {
                    self.closed = true;
                    Step::Waiting
                }
            };
            self.clear_sendfile(); // Proven finished and no service ticket remains.
            return Ok(command);
        }
        let action = p.owner.action().ok_or(Error::State)?;
        let sequence = p.owner.sequence().ok_or(Error::State)?;
        let endpoint = p.owner.endpoint().ok_or(Error::State)?;
        Ok(match p.owner.phase() {
            sendfile::Phase::CapReady => Step::SendfileCapability {
                action,
                sequence,
                endpoint,
            },
            sendfile::Phase::LoadingReady => Step::SendfileLoad { action, sequence },
            sendfile::Phase::OfferReady => Step::SendfileOffer {
                action,
                sequence,
                endpoint,
                length: p.owner.offered(),
            },
            _ => Step::Waiting,
        })
    }
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_cap_start(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
    ) -> Result<u64, Error> {
        self.owner(execution)?;
        let p = self.sendfile_mut().ok_or(Error::State)?;
        if p.cap_request.is_some() {
            return Err(Error::State);
        }
        let result = p
            .owner
            .cap_start(files, domain, execution, sequence, action);
        self.sync_sendfile_closed();
        let request = result?;
        let endpoint = request.endpoint();
        self.sendfile_mut().unwrap().cap_request = Some(request);
        Ok(endpoint)
    }
    #[cfg(not(feature = "capture-v1"))]
    fn finish_sendfile_cap(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
        endpoint: u64,
        make: impl FnOnce(CapabilityRequest) -> CapabilityReceipt,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        let p = self.sendfile_mut().ok_or(Error::State)?;
        p.owner.check_capability(
            files,
            domain,
            execution,
            sequence,
            action,
            endpoint,
            p.cap_request.as_ref().ok_or(Error::State)?,
        )?;
        let request = p.cap_request.take().unwrap(); // Only after immutable validation.
        let result = p.owner.cap_finish(files, domain, execution, make(request));
        self.sync_sendfile_closed();
        result?;
        self.sendfile_step(execution)
    }
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_cap_finish_rejected(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
        endpoint: u64,
    ) -> Result<Step, Error> {
        self.finish_sendfile_cap(
            files,
            domain,
            execution,
            sequence,
            action,
            endpoint,
            CapabilityReceipt::rejected,
        )
    }
    #[cfg(any(test, feature = "sendfile-probe"))]
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_cap_finish_synthetic(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
        endpoint: u64,
    ) -> Result<Step, Error> {
        self.finish_sendfile_cap(
            files,
            domain,
            execution,
            sequence,
            action,
            endpoint,
            CapabilityReceipt::synthetic_accepted,
        )
    }
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_load_start(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
    ) -> Result<descriptor::LoadRequest, Error> {
        self.owner(execution)?;
        let result = self.sendfile_mut()
            .ok_or(Error::State)?
            .owner
            .load_start(files, domain, execution, sequence, action);
        self.sync_sendfile_closed();
        result.map_err(Into::into)
    }
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_load_finish(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
        load: descriptor::LoadRequest,
        success: bool,
        bytes: &mut Vec<u8>,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        let result = self.sendfile_mut()
            .ok_or(Error::State)?
            .owner
            .load_finish(
                files, domain, execution, sequence, action, load, success, bytes,
            );
        self.sync_sendfile_closed();
        result?;
        self.sendfile_step(execution)
    }
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_start(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
    ) -> Result<(usize, u64), Error> {
        self.owner(execution)?;
        let result = self.sendfile_mut()
            .ok_or(Error::State)?
            .owner
            .start(files, domain, execution, sequence, action);
        self.sync_sendfile_closed();
        result.map_err(Into::into)
    }
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_receipt(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
        confirmed: u64,
        outcome: sendfile::Outcome,
        access: AccessEvidence,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        let result = self.sendfile_mut()
            .ok_or(Error::State)?
            .owner
            .receipt_with_access(
                files, domain, execution, sequence, action, confirmed, outcome, access,
            );
        self.sync_sendfile_closed();
        result?;
        self.sendfile_step(execution)
    }
    #[cfg(any(test, feature = "sendfile-probe"))]
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_access_ended_synthetic(
        &mut self,
        files: &Files,
        domain: &Domain,
        execution: &Execution,
        sequence: u32,
        action: Token,
    ) -> Result<(), Error> {
        self.owner(execution)?;
        let p = self.sendfile_mut().ok_or(Error::State)?;
        if p.owner.sequence() != Some(sequence) || p.owner.action() != Some(action) {
            return Err(Error::State);
        }
        let receipt = p.owner.synthetic_access_ended()?;
        p.owner
            .access_ended(files, domain, execution, receipt)
            .map_err(Into::into)
    }
    #[cfg(not(feature = "capture-v1"))]
    pub(crate) fn sendfile_cleanup_retry(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        let p = self.sendfile_mut().ok_or(Error::State)?;
        if p.owner.sequence() != Some(sequence) || p.cap_request.is_some() {
            return Err(Error::State);
        }
        let result = p.owner.retry_cleanup(files, domain, execution);
        self.sync_sendfile_closed();
        result?;
        self.sendfile_step(execution)
    }
    pub(crate) fn task_registration(
        &self,
        execution: &Execution,
    ) -> Result<crate::single_task::Registration, Error> {
        self.single_task.registration(execution).map_err(Into::into)
    }
    /// First-effect admission only. The captured sequence must come from the
    /// current pending operation, not the admission watermark or transport.
    /// The caller separately checks that operation's identity and phase and
    /// starts the effect in this same callback-free turn.
    fn check_held_sequence_live(
        &self,
        execution: &Execution,
        invocation: Invocation,
        captured: u32,
        presented: u32,
    ) -> Result<(), Error> {
        if self.closed || captured != presented {
            return Err(Error::State);
        }
        execution
            .check_held_call_live(invocation)
            .map_err(Into::into)
    }
    /// Consume the exact admitted apply permission once, before physical work.
    pub(crate) fn register_start(
        &mut self,
        domain: &mut Domain,
        execution: &Execution,
        sequence: u32,
        action: Token,
        base: u64,
    ) -> Result<(), Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        let p = self.register.as_ref().ok_or(Error::State)?;
        if p.action != action || p.base != base || p.started {
            return Err(Error::State);
        }
        self.check_held_sequence_live(execution, p.invocation, p.sequence, sequence)?;
        domain.start(action)?;
        self.register.as_mut().expect("same register owner").started = true;
        Ok(())
    }
    /// Matching stopped evidence can settle an uncertain register action after
    /// unwind, but never resurrect guest success after Unknown/cancel/failure.
    /// Worker exit alone does not prove non-application: no synthetic 0-Stopped.
    pub(crate) fn register_receipt(
        &mut self,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
        base: u64,
        outcome: RegisterOutcome,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        let p = self.register.as_ref().ok_or(Error::State)?;
        if p.sequence != sequence
            || p.action != action
            || p.base != base
            || !p.started
            || !execution.owns_snapshot(p.snapshot)
        {
            return Err(Error::State);
        }
        domain.receipt(
            action,
            u64::from(outcome == RegisterOutcome::AppliedStopped),
            if outcome == RegisterOutcome::Unknown {
                Completion::Unknown
            } else {
                Completion::Stopped
            },
        )?;
        if outcome != RegisterOutcome::AppliedStopped {
            self.closed = true;
        }
        if outcome == RegisterOutcome::Unknown {
            return Ok(Step::Waiting);
        }
        domain
            .retire(action)
            .expect("matching stopped register effect");
        let p = self.register.take().unwrap();
        execution
            .finish_call(p.invocation)
            .expect("private register owner retains the exact pending call");
        Ok(if !self.closed && execution.phase() == Phase::Running {
            Step::Return(0)
        } else {
            Step::Waiting
        })
    }
    pub(crate) fn path_view(&self) -> Option<Token> {
        self.opening
            .as_ref()
            .filter(|p| p.viewing)
            .map(|p| p.action)
    }
    /// One private short input view. No allocating ABI call may interleave.
    pub(crate) fn path_start(
        &mut self,
        domain: &mut Domain,
        execution: &Execution,
        action: Token,
    ) -> Result<&mut [u8], Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        let p = self.opening.as_mut().ok_or(Error::State)?;
        if p.action != action || p.started || p.cancelled {
            return Err(Error::State);
        }
        execution.check(p.snapshot)?;
        if execution.phase() != Phase::Running {
            return Err(Error::State);
        }
        domain.start(action)?;
        p.started = true;
        p.viewing = true;
        Ok(&mut self.path_input[..p.length as usize])
    }
    /// Receipt ends the private input-view interval. Unknown still owns the
    /// physical memory span, lookup bases and invocation; it is never reissued.
    pub(crate) fn path_finish(
        &mut self,
        files: &mut Files,
        table: &Table,
        domain: &mut Domain,
        execution: &mut Execution,
        action: Token,
        actual: u64,
        outcome: PathOutcome,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        let p = self.opening.as_ref().ok_or(Error::State)?;
        if p.action != action
            || !p.started
            || !execution.owns_snapshot(p.snapshot)
            || actual > p.length
        {
            return Err(Error::State);
        }
        let nul = if outcome == PathOutcome::Captured {
            if actual == 0 {
                return Err(Error::State);
            }
            let nul = self.path_input[..actual as usize]
                .iter()
                .position(|&b| b == 0);
            if nul.is_none() && actual < p.length {
                return Err(Error::State);
            }
            nul
        } else {
            None
        };
        domain.receipt(
            action,
            actual,
            if outcome == PathOutcome::Unknown {
                Completion::Unknown
            } else {
                Completion::Stopped
            },
        )?;
        self.opening.as_mut().unwrap().viewing = false;
        if outcome == PathOutcome::Unknown {
            return Ok(Step::Waiting);
        }
        domain.retire(action).expect("matching stopped path span");
        let p = self.opening.take().unwrap();
        let response = if outcome == PathOutcome::Captured
            && !p.cancelled
            && execution.phase() == Phase::Running
        {
            match nul {
                Some(n) => match files.open_read(table, &p.route, &self.path_input[..n], p.options)
                {
                    Ok(fd) => Ok(Step::Return(fd as i64)),
                    Err(error) => open_error(p.original_nr, error),
                },
                None => Ok(Step::Return(if p.length < 4096 { -14 } else { -36 })),
            }
        } else {
            Ok(Step::Waiting)
        };
        self.closed |= p.cancelled || outcome == PathOutcome::Failed;
        files
            .release_open_route(p.route)
            .expect("same retained private lookup owner");
        execution
            .finish_call(p.invocation)
            .expect("path continuation owns pending call");
        response
    }
    pub(crate) fn stream_start(
        &mut self,
        files: &Files,
        domain: &mut Domain,
        execution: &Execution,
        action: Token,
    ) -> Result<(), Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        let p = self.stream.as_mut().ok_or(Error::State)?;
        if p.action != action || p.started {
            return Err(Error::State);
        }
        files.stream(&p.hold).map_err(Error::Files)?;
        execution.check(p.snapshot)?;
        if execution.phase() != Phase::Running {
            return Err(Error::State);
        }
        domain.start(action)?;
        p.started = true;
        Ok(())
    }
    pub(crate) fn stream_receipt(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        action: Token,
        count: u64,
        result: PhysicalResult,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        let p = self.stream.as_ref().ok_or(Error::State)?;
        if p.action != action || !p.started || !execution.owns_snapshot(p.snapshot) {
            return Err(Error::State);
        }
        files.stream(&p.hold).map_err(Error::Files)?;
        if execution.phase() == Phase::Suspended {
            return Err(Error::State);
        }
        if count != 0
            && !matches!(
                result,
                PhysicalResult::Transferred | PhysicalResult::Unknown
            )
        {
            return Err(Error::State);
        }
        let value = match result {
            PhysicalResult::Transferred => i64::try_from(count).map_err(|_| Error::State)?,
            PhysicalResult::Again => -11,
            PhysicalResult::Interrupted => -4,
            PhysicalResult::BadFd => -9,
            PhysicalResult::BrokenPipe => -32,
            PhysicalResult::Io => -5,
            PhysicalResult::Unknown => 0,
        };
        let completion = if result == PhysicalResult::Unknown {
            Completion::Unknown
        } else {
            Completion::Stopped
        };
        domain.receipt(action, count, completion)?;
        if completion == Completion::Unknown {
            return Ok(Step::Waiting);
        }
        domain.retire(action).expect("matching stopped span");
        let p = self.stream.take().unwrap();
        files
            .release_stream(p.hold)
            .expect("validated retained stream");
        execution
            .finish_call(p.invocation)
            .expect("private continuation owns pending call");
        Ok(if execution.phase() == Phase::Running {
            Step::Return(value)
        } else {
            Step::Waiting
        })
    }
    /// Explicit evidence from the trusted source dispatcher, not inferred from
    /// an arbitrary failed read state (which could be identity or cleanup loss).
    pub(crate) fn source_failed(&mut self, execution: &Execution, read: u64) -> Result<(), Error> {
        self.owner(execution)?;
        let p = self.pending.as_mut().ok_or(Error::State)?;
        if p.read != read || p.progress != Progress::Reading {
            return Err(Error::State);
        }
        execution.check(p.snapshot)?;
        p.source_failed = true;
        Ok(())
    }
    pub(crate) fn complete(
        &mut self,
        reads: &mut Reads,
        execution: &mut Execution,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        let p = self.pending.as_mut().ok_or(Error::State)?;
        execution.check(p.snapshot)?;
        if p.progress != Progress::Reading {
            return Err(Error::State);
        }
        let (confirmed, _, state) = reads.query(p.read)?;
        let result = match state & 255 {
            3 => i64::try_from(confirmed).map_err(|_| Error::State)?,
            7 if p.source_failed => -5,
            4 | 7 => return Err(Error::ReadFailed),
            _ => return Ok(Step::Waiting),
        };
        // Retire may fail when cleanup retained obligations: do not resume then.
        reads.retire(p.read)?;
        if execution.phase() == Phase::Running {
            execution.finish_call(p.invocation)?;
            self.pending = None;
            Ok(Step::Return(result))
        } else if execution.phase() == Phase::Suspended {
            p.progress = Progress::Applying;
            Ok(Step::Resume(Resume {
                next: p.next,
                rax: result,
                rcx: p.next,
            }))
        } else {
            Err(Error::State)
        }
    }
    /// Cancellation is not stopping evidence. The continuation remains owned
    /// while a loader/copy is outstanding, even if the execution already failed.
    pub(crate) fn abandon(
        &mut self,
        files: &mut Files,
        reads: &mut Reads,
        domain: &mut Domain,
        execution: &mut Execution,
    ) -> Result<bool, Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        #[cfg(feature = "capture-v1")]
        if self.output.is_some() {
            // Captured cancellation needs the exact lane/registry context.
            return Ok(false);
        }
        #[cfg(all(not(feature = "capture-v1"), any(test, feature = "queued-worker-probe")))]
        if matches!(&self.output, Some(OutputOwner::Captured(_))) {
            // Captured cancellation needs the exact lane/registry context.
            // This generic path cannot certify retirement of that owner.
            return Ok(false);
        }
        #[cfg(not(feature = "capture-v1"))]
        if self.output.is_some() {
            self.closed = true;
            #[cfg(not(any(test, feature = "queued-worker-probe")))]
            let p = self.output.as_mut().unwrap();
            #[cfg(any(test, feature = "queued-worker-probe"))]
            let p = self.sendfile_mut().unwrap();
            if !p.owner.finished() {
                if p.owner.phase() == sendfile::Phase::Closing {
                    p.owner.retry_cleanup(files, domain, execution)?;
                } else {
                    let sequence = p.owner.sequence().ok_or(Error::State)?;
                    let action = p.owner.action().ok_or(Error::State)?;
                    if !p.owner.cancel(files, domain, execution, sequence, action)? {
                        return Ok(false);
                    }
                }
            }
            if p.owner.finished() && p.cap_request.is_none() {
                self.output = None;
                return Ok(true);
            }
            return Ok(false);
        }
        if let Some(p) = self.register.as_ref() {
            self.closed = true;
            domain.cancel(p.action)?;
            if p.started {
                return Ok(false);
            }
            domain
                .retire(p.action)
                .expect("unstarted cancelled register effect");
            let p = self.register.take().unwrap();
            execution
                .finish_call(p.invocation)
                .expect("private register owner retains the exact pending call");
            return Ok(true);
        }
        if let Some(p) = self.opening.as_mut() {
            self.closed = true;
            p.cancelled = true;
            domain.cancel(p.action)?;
            if p.started {
                return Ok(false);
            }
            domain
                .retire(p.action)
                .expect("unstarted cancelled path span");
            let p = self.opening.take().unwrap();
            files
                .release_open_route(p.route)
                .expect("same private cancelled lookup owner");
            execution
                .finish_call(p.invocation)
                .expect("path continuation owns pending call");
            return Ok(true);
        }
        if let Some(p) = self.stream.as_ref() {
            files.stream(&p.hold).map_err(Error::Files)?;
            domain.cancel(p.action)?;
            if p.started {
                return Ok(false);
            }
            domain.retire(p.action).expect("unstarted cancelled span");
            let p = self.stream.take().unwrap();
            files
                .release_stream(p.hold)
                .expect("validated retained stream");
            execution
                .finish_call(p.invocation)
                .expect("private continuation owns pending call");
            return Ok(true);
        }
        let Some(p) = self.pending.as_ref() else {
            return Ok(true);
        };
        if p.progress != Progress::Reading {
            return Err(Error::State);
        }
        reads.cancel(files, domain, p.read)?;
        match reads.query(p.read)?.2 & 255 {
            3 | 4 | 7 => {
                reads.retire(p.read)?;
                execution.finish_call(p.invocation)?;
                self.pending = None;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
    /// The Resume command is one-shot. Unknown keeps the continuation and blocks
    /// another run; partial globals failure with stopped access fails the image.
    pub(crate) fn resumed(
        &mut self,
        execution: &mut Execution,
        stopped: Completion,
        success: bool,
    ) -> Result<(), Error> {
        self.owner(execution)?;
        let p = self.pending.as_mut().ok_or(Error::State)?;
        execution.check(p.snapshot)?;
        if !matches!(p.progress, Progress::Applying | Progress::Uncertain) {
            return Err(Error::State);
        }
        if stopped == Completion::Unknown {
            p.progress = Progress::Uncertain;
            return Ok(());
        }
        execution.finish_call(p.invocation)?;
        self.pending = None;
        if !success {
            execution.fail_suspended()?;
        }
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
    use crate::execution::{ImageResult, Unwind};
    use crate::inode::Tree;
    use crate::read::ReadCapacity;
    fn setup(
        lazy: bool,
    ) -> (
        Files,
        Table,
        Reads,
        Domain,
        Execution,
        Continuation,
        Invocation,
        u32,
    ) {
        let mut t = Tree::new(1, 4, 4, 32, root_owned(0o755)).unwrap();
        let root = t.root();
        let inode = if lazy {
            t.lazy_file(root, b"a", root_owned(0o644), 7, 1).unwrap()
        } else {
            t.file_take(root, b"a", root_owned(0o644), &mut b"abcd".to_vec())
                .unwrap()
        };
        let mut f = Files::new(
            2,
            t,
            descriptor::Limits {
                contexts: 0,
                tables: 2,
                descriptions: 4,
                slots: 8,
            },
        );
        let table = f.table(8).unwrap();
        let fd = f.open(&table, inode, false).unwrap();
        let r = Reads::new(&f, ReadCapacity::new(4).unwrap());
        let mut d = Domain::new(3, 1, 4).unwrap();
        let b = d.bind(16).unwrap();
        let mut e = Execution::new(4, b);
        e.image_begin(&mut d, 16).unwrap();
        e.image_finish(&mut d, ImageResult::Installed).unwrap();
        let c = Continuation::new(&e).unwrap();
        let i = e.start(&mut d).unwrap();
        (f, table, r, d, e, c, i, fd)
    }
    #[cfg(not(feature = "capture-v1"))]
    #[test]
    fn stream_admission_full_range_direction_and_zero() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, _) = setup(false);
        f.let_go(t).unwrap();
        let t = f.stdio([1, 2, 3], 8).unwrap();
        for (nr, args, result) in [
            (1, [0, 0, 1, 0, 0, 0], -9),
            (0, [0, 15, 2, 0, 0, 0], -14),
            (1, [1, u64::MAX, 0, 0, 0, 0], -14),
        ] {
            assert_eq!(
                c.enter(&mut f, &t, &mut r, &mut d, &mut e, i, nr, args, 100)
                    .unwrap(),
                Step::Return(result)
            );
        }
        let Step::Stream {
            action,
            endpoint,
            target,
            length,
            write,
        } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                1,
                [2, 2, 3, 0, 0, 0],
                100,
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!((endpoint, target, length, write), (3, 2, 3, true));
        assert!(c.owns(action));
        assert!(c.abandon(&mut f, &mut r, &mut d, &mut e).unwrap());
        assert!(!c.owns(action));
        assert!(c.stream_start(&f, &mut d, &e, action).is_err());
    }
    #[test]
    fn stream_unknown_retains_original_endpoint_after_close_and_worker_stop() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, _) = setup(false);
        f.let_go(t).unwrap();
        let t = f.stdio([1, 2, 3], 8).unwrap();
        let Step::Stream { action, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [0, 0, 4, 0, 0, 0],
                100,
            )
            .unwrap()
        else {
            panic!()
        };
        c.stream_start(&f, &mut d, &e, action).unwrap();
        assert!(c.stream_start(&f, &mut d, &e, action).is_err());
        assert!(c
            .stream_receipt(&mut f, &mut d, &mut e, action, 1, PhysicalResult::Io)
            .is_err());
        assert_eq!(
            c.stream_receipt(&mut f, &mut d, &mut e, action, 1, PhysicalResult::Unknown)
                .unwrap(),
            Step::Waiting
        );
        f.close(&t, 0).unwrap();
        assert_eq!(f.dup(&t, 1, 0, false), Ok(0));
        e.receipt(&mut d, i, Unwind::Fault).unwrap();
        assert!(!c.abandon(&mut f, &mut r, &mut d, &mut e).unwrap());
        assert!(d.change(e.binding(), 32).is_err());
        assert_eq!(
            c.stream_receipt(
                &mut f,
                &mut d,
                &mut e,
                action,
                2,
                PhysicalResult::Transferred
            )
            .unwrap(),
            Step::Waiting
        );
        assert!(c.abandon(&mut f, &mut r, &mut d, &mut e).unwrap());
        assert!(c
            .stream_receipt(
                &mut f,
                &mut d,
                &mut e,
                action,
                2,
                PhysicalResult::Transferred
            )
            .is_err());
        assert_eq!(
            f.target(&t, 0),
            Ok(descriptor::Target::HostStream {
                endpoint: 2,
                direction: descriptor::StreamDirection::Write
            })
        );
        assert!(d.change(e.binding(), 32).is_ok());
    }
    #[cfg(not(feature = "capture-v1"))]
    #[test]
    fn stream_known_zero_errors_and_short_success_are_rust_results() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, _) = setup(false);
        f.let_go(t).unwrap();
        let t = f.stdio([1, 2, 3], 8).unwrap();
        for (result, n, value) in [
            (PhysicalResult::Again, 0, -11),
            (PhysicalResult::Interrupted, 0, -4),
            (PhysicalResult::BadFd, 0, -9),
            (PhysicalResult::BrokenPipe, 0, -32),
            (PhysicalResult::Io, 0, -5),
            (PhysicalResult::Transferred, 2, 2),
        ] {
            let Step::Stream { action, .. } = c
                .enter(
                    &mut f,
                    &t,
                    &mut r,
                    &mut d,
                    &mut e,
                    i,
                    1,
                    [1, 0, 4, 0, 0, 0],
                    100,
                )
                .unwrap()
            else {
                panic!()
            };
            c.stream_start(&f, &mut d, &e, action).unwrap();
            assert_eq!(
                c.stream_receipt(&mut f, &mut d, &mut e, action, n, result)
                    .unwrap(),
                Step::Return(value)
            );
        }
    }
    #[test]
    fn read_copy_return_exit_needs_matching_unwind() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, fd) = setup(false);
        let Step::Read { id, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 0, 4, 0, 0, 0],
                100,
            )
            .unwrap()
        else {
            panic!()
        };
        assert!(c
            .enter(&mut f, &t, &mut r, &mut d, &mut e, i, 0, [0; 6], 100)
            .is_err());
        let (ptr, len) = r.start_managed(&mut f, &mut d, &e, id).unwrap();
        assert_eq!(
            unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) },
            b"abcd"
        );
        r.receipt(&mut f, &mut d, id, 4, Completion::Stopped)
            .unwrap();
        assert_eq!(c.complete(&mut r, &mut e), Ok(Step::Return(4)));
        assert_eq!(f.offset(&t, fd), Ok((4, 1)));
        assert_eq!(
            c.enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                60,
                [257, 0, 0, 0, 0, 0],
                110
            ),
            Ok(Step::Exit)
        );
        assert_eq!(e.phase(), Phase::Running);
        assert_eq!(d.change(e.binding(), 16), Err(lease::Error::Busy));
        e.receipt(&mut d, i, Unwind::Exit).unwrap();
        assert_eq!(e.status(), Some(1));
    }
    #[test]
    fn asynchronous_lazy_resume_is_one_shot_and_writes_rax_and_rcx() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, fd) = setup(true);
        let Step::Read { id, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 0, 4, 0, 0, 0],
                101,
            )
            .unwrap()
        else {
            panic!()
        };
        let (_, a) = r.load_start(&mut f, &e, id).unwrap();
        e.receipt(&mut d, i, Unwind::Yield(101)).unwrap();
        assert_eq!(e.start(&mut d), Err(execution::Error::State));
        assert!(e.image_begin(&mut d, 16).is_err());
        r.load_finish(&mut f, &mut d, &e, id, a, true, &mut b"abcd".to_vec())
            .unwrap();
        r.start_managed(&mut f, &mut d, &e, id).unwrap();
        r.receipt(&mut f, &mut d, id, 4, Completion::Stopped)
            .unwrap();
        assert_eq!(
            c.complete(&mut r, &mut e),
            Ok(Step::Resume(Resume {
                next: 101,
                rax: 4,
                rcx: 101
            }))
        );
        c.resumed(&mut e, Completion::Unknown, false).unwrap();
        assert!(c.complete(&mut r, &mut e).is_err());
        assert!(e.start(&mut d).is_err());
        c.resumed(&mut e, Completion::Stopped, true).unwrap();
        assert!(c.resumed(&mut e, Completion::Stopped, true).is_err());
        assert!(e.start(&mut d).is_ok());
    }
    #[test]
    fn fd_zero_range_and_unknown_syscall_are_rust_decisions() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, fd) = setup(false);
        assert_eq!(
            c.enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [999, u64::MAX, 0, 0, 0, 0],
                1
            ),
            Ok(Step::Return(-9))
        );
        assert_eq!(
            c.enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, u64::MAX, 0, 0, 0, 0],
                1
            ),
            Ok(Step::Return(-14))
        );
        assert_eq!(
            c.enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 16, 1, 0, 0, 0],
                1
            ),
            Ok(Step::Return(-14))
        );
        assert_eq!(
            c.enter(&mut f, &t, &mut r, &mut d, &mut e, i, 999, [0; 6], 1),
            Ok(Step::Unsupported(999))
        );
        let Step::Read { id, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 14, 4, 0, 0, 0],
                1,
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(r.query(id).unwrap().1, 2);
        assert!(c.abandon(&mut f, &mut r, &mut d, &mut e).unwrap());
    }
    #[test]
    fn source_failure_evidence_and_unknown_copy_are_not_interchangeable() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, fd) = setup(true);
        let Step::Read { id, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 0, 4, 0, 0, 0],
                1,
            )
            .unwrap()
        else {
            panic!()
        };
        let (_, a) = r.load_start(&mut f, &e, id).unwrap();
        c.source_failed(&e, id).unwrap();
        r.load_finish(&mut f, &mut d, &e, id, a, false, &mut Vec::new())
            .unwrap();
        assert_eq!(c.complete(&mut r, &mut e), Ok(Step::Return(-5)));
        let Step::Read { id, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 0, 4, 0, 0, 0],
                1,
            )
            .unwrap()
        else {
            panic!()
        };
        let (_, a) = r.load_start(&mut f, &e, id).unwrap();
        r.load_finish(&mut f, &mut d, &e, id, a, true, &mut b"abcd".to_vec())
            .unwrap();
        r.start_managed(&mut f, &mut d, &e, id).unwrap();
        r.receipt(&mut f, &mut d, id, 2, Completion::Unknown)
            .unwrap();
        assert_eq!(c.complete(&mut r, &mut e), Ok(Step::Waiting));
        assert!(!c.abandon(&mut f, &mut r, &mut d, &mut e).unwrap());
        r.receipt(&mut f, &mut d, id, 2, Completion::Stopped)
            .unwrap();
        assert_eq!(c.complete(&mut r, &mut e), Ok(Step::Return(2)));
    }
}

#[cfg(test)]
mod register_tests {
    use super::*;
    use crate::execution::{ImageResult, Unwind};
    use crate::inode::{Creation, Tree};
    use crate::read::ReadCapacity;

    struct Guest {
        files: Files,
        table: Table,
        reads: Reads,
        domain: Domain,
        execution: Execution,
        call: Continuation,
        invocation: Invocation,
        fd: u32,
    }
    impl Guest {
        fn new(owner: u64, actions: usize) -> Self {
            let metadata = Creation {
                mode: 0o755,
                uid: 0,
                gid: 0,
            };
            let mut tree = Tree::new(owner + 1, 2, 1, 4, metadata).unwrap();
            let inode = tree
                .file_take(tree.root(), b"data", metadata, &mut b"abcd".to_vec())
                .unwrap();
            let mut files = Files::new(
                owner + 2,
                tree,
                descriptor::Limits {
                    contexts: 0,
                    tables: 1,
                    descriptions: 1,
                    slots: 1,
                },
            );
            let table = files.table(1).unwrap();
            let fd = files.open(&table, inode, false).unwrap();
            let reads = Reads::new(&files, ReadCapacity::new(1).unwrap());
            let mut domain = Domain::new(owner + 3, 1, actions).unwrap();
            let binding = domain.bind(16).unwrap();
            let mut execution = Execution::new(owner + 4, binding);
            execution.image_begin(&mut domain, 16).unwrap();
            execution
                .image_finish(&mut domain, ImageResult::Installed)
                .unwrap();
            let call = Continuation::new(&execution).unwrap();
            let invocation = execution.start(&mut domain).unwrap();
            Self {
                files,
                table,
                reads,
                domain,
                execution,
                call,
                invocation,
                fd,
            }
        }
        fn request(&mut self, sequence: u32, nr: u64, args: [u64; 6]) -> Result<Step, Error> {
            self.call.enter_sequenced(
                &mut self.files,
                &self.table,
                None,
                &mut self.reads,
                &mut self.domain,
                &mut self.execution,
                self.invocation,
                sequence,
                nr,
                args,
                123,
            )
        }
        fn admit(&mut self, sequence: u32, base: u64) -> Token {
            let Step::SetFs {
                action,
                sequence: actual_sequence,
                base: actual_base,
            } = self
                .request(sequence, 158, [0x1002, base, 0, 0, 0, 0])
                .unwrap()
            else {
                panic!("expected the private register command, never success at admission")
            };
            assert_eq!((actual_sequence, actual_base), (sequence, base));
            action
        }
        fn start(&mut self, sequence: u32, action: Token, base: u64) -> Result<(), Error> {
            self.call
                .register_start(&mut self.domain, &self.execution, sequence, action, base)
        }
        fn receipt(
            &mut self,
            sequence: u32,
            action: Token,
            base: u64,
            outcome: RegisterOutcome,
        ) -> Result<Step, Error> {
            self.call.register_receipt(
                &mut self.domain,
                &mut self.execution,
                sequence,
                action,
                base,
                outcome,
            )
        }
        fn abandon(&mut self) -> Result<bool, Error> {
            self.call.abandon(
                &mut self.files,
                &mut self.reads,
                &mut self.domain,
                &mut self.execution,
            )
        }
        fn fault(&mut self) {
            // Synthetic trusted unwind receipt for owner-unit testing, not
            // evidence of a physical Worker or FS setter in this native suite.
            self.execution
                .receipt(&mut self.domain, self.invocation, Unwind::Fault)
                .unwrap();
        }
    }

    #[test]
    fn scoped_low_fs_bases_are_values_not_guest_byte_ranges_and_success_is_receipted() {
        let mut g = Guest::new(1400, 1);
        for (sequence, base) in [(1, 0), (2, 17), (3, u32::MAX as u64)] {
            let action = g.admit(sequence, base);
            assert!(g.call.owns(action));
            assert!(g.execution.syscall_allowed(g.invocation).is_err());
            assert_eq!(g.domain.extent(g.execution.binding()), Ok(16));
            g.start(sequence, action, base).unwrap();
            assert_eq!(
                g.receipt(sequence, action, base, RegisterOutcome::AppliedStopped),
                Ok(Step::Return(0))
            );
            assert!(!g.call.owns(action));
            assert!(g.execution.syscall_allowed(g.invocation).is_ok());
            assert_eq!(
                g.receipt(sequence, action, base, RegisterOutcome::AppliedStopped),
                Err(Error::State)
            );
        }
    }

    #[test]
    fn unsequenced_tls_and_other_arch_operations_or_high_bases_remain_unsupported() {
        let mut g = Guest::new(1420, 1);
        assert_eq!(
            g.call.enter(
                &mut g.files,
                &g.table,
                &mut g.reads,
                &mut g.domain,
                &mut g.execution,
                g.invocation,
                158,
                [0x1002, 0, 0, 0, 0, 0],
                123
            ),
            Ok(Step::Unsupported(158))
        );
        assert_eq!(
            g.call.enter_with_namespace(
                &mut g.files,
                &g.table,
                None,
                &mut g.reads,
                &mut g.domain,
                &mut g.execution,
                g.invocation,
                158,
                [0x1002, 0, 0, 0, 0, 0],
                123
            ),
            Ok(Step::Unsupported(158))
        );
        assert_eq!(g.call.last_sequence, 0);
        for (sequence, operation, base) in [
            (1, 0x1001, 0),
            (2, 0x1003, 0),
            (3, 0x1004, 0),
            (4, 0x100001002, 0),
            (5, 0x1002, u32::MAX as u64 + 1),
            (6, 0x1002, u64::MAX),
        ] {
            assert_eq!(
                g.request(sequence, 158, [operation, base, 0, 0, 0, 0]),
                Ok(Step::Unsupported(158))
            );
            assert_eq!(g.call.last_sequence, sequence);
            assert!(g.call.register.is_none());
            assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        }
        assert_eq!(
            g.request(6, 158, [0x1002, 0, 0, 0, 0, 0]),
            Err(Error::State)
        );
    }

    #[test]
    fn sequenced_ordinary_requests_keep_errno_read_close_and_exit_ownership() {
        let mut g = Guest::new(1440, 2);
        assert_eq!(
            g.request(1, 0, [99, u64::MAX, 0, 0, 0, 0]),
            Ok(Step::Return(-9))
        );
        assert_eq!(
            g.request(1, 158, [0x1002, 0, 0, 0, 0, 0]),
            Err(Error::State)
        );
        assert_eq!(g.request(3, 999, [0; 6]), Err(Error::State));
        assert_eq!(g.request(2, 999, [0; 6]), Ok(Step::Unsupported(999)));
        let action = g.admit(3, 0);
        g.start(3, action, 0).unwrap();
        assert_eq!(
            g.receipt(3, action, 0, RegisterOutcome::AppliedStopped),
            Ok(Step::Return(0))
        );
        let Step::Read { id, target } = g.request(4, 0, [g.fd as u64, 0, 1, 0, 0, 0]).unwrap()
        else {
            panic!()
        };
        assert_eq!(target, 0);
        g.reads
            .start_managed(&mut g.files, &mut g.domain, &g.execution, id)
            .unwrap();
        g.reads
            .receipt(&mut g.files, &mut g.domain, id, 1, Completion::Stopped)
            .unwrap();
        assert_eq!(
            g.call.complete(&mut g.reads, &mut g.execution),
            Ok(Step::Return(1))
        );
        assert_eq!(g.files.offset(&g.table, g.fd), Ok((1, 1)));
        assert_eq!(
            g.request(5, 3, [g.fd as u64, 0, 0, 0, 0, 0]),
            Ok(Step::Return(0))
        );
        assert_eq!(g.request(6, 60, [0; 6]), Ok(Step::Exit));
        g.execution
            .receipt(&mut g.domain, g.invocation, Unwind::Exit)
            .unwrap();
        assert_eq!(g.execution.status(), Some(0));
    }

    #[test]
    fn sequence_zero_gap_overflow_and_foreign_invocation_do_not_consume_admission() {
        let mut g = Guest::new(1460, 1);
        let other = Guest::new(1480, 1);
        for sequence in [0, 2, i32::MAX as u32 + 1, u32::MAX] {
            assert_eq!(
                g.request(sequence, 158, [0x1002, 0, 0, 0, 0, 0]),
                Err(Error::State)
            );
            assert_eq!(g.call.last_sequence, 0);
        }
        assert_eq!(
            g.call.enter_sequenced(
                &mut g.files,
                &g.table,
                None,
                &mut g.reads,
                &mut g.domain,
                &mut g.execution,
                other.invocation,
                1,
                158,
                [0x1002, 0, 0, 0, 0, 0],
                123
            ),
            Err(Error::Execution(execution::Error::Identity))
        );
        assert_eq!(g.call.last_sequence, 0);
        assert!(g.call.register.is_none());
        g.call.last_sequence = i32::MAX as u32 - 1;
        assert_eq!(
            g.request(i32::MAX as u32, 999, [0; 6]),
            Ok(Step::Unsupported(999))
        );
        assert_eq!(g.request(i32::MAX as u32, 999, [0; 6]), Err(Error::State));
        assert_eq!(
            g.request(i32::MAX as u32 + 1, 999, [0; 6]),
            Err(Error::State)
        );
        assert_eq!(g.request(0, 999, [0; 6]), Err(Error::State));
        assert_eq!(g.call.last_sequence, i32::MAX as u32);
    }

    #[test]
    fn register_start_and_receipt_require_exact_owner_sequence_action_base_and_start() {
        let mut g = Guest::new(1500, 2);
        let mut foreign = Guest::new(1520, 1);
        let action = g.admit(1, 8);
        let other = foreign.admit(1, 8);
        // Image initialization consumed sequence0 in this actual Domain. It is
        // rejected as a stale action, not as an empty/invalid Token sentinel.
        let stale_zero = Token::from_parts(g.domain.id(), 0);
        assert!(!g.call.owns(other));
        for (sequence, token, base) in [
            (0, action, 8),
            (2, action, 8),
            (1, other, 8),
            (1, stale_zero, 8),
            (1, action, 9),
        ] {
            assert_eq!(g.start(sequence, token, base), Err(Error::State));
        }
        for outcome in [
            RegisterOutcome::AppliedStopped,
            RegisterOutcome::NotAppliedStopped,
            RegisterOutcome::Unknown,
        ] {
            assert_eq!(g.receipt(1, action, 8, outcome), Err(Error::State));
        }
        assert_eq!(
            g.call
                .register_start(&mut g.domain, &foreign.execution, 1, action, 8),
            Err(Error::Execution(execution::Error::Identity))
        );
        assert_eq!(
            g.call
                .register_start(&mut foreign.domain, &g.execution, 1, action, 8),
            Err(Error::Execution(execution::Error::Identity))
        );
        assert!(g.call.owns(action));
        assert!(!g.call.closed);
        assert_eq!(g.domain.retire(action), Err(lease::Error::Incomplete));
        g.start(1, action, 8).unwrap();
        assert_eq!(g.start(1, action, 8), Err(Error::State));
        for (sequence, token, base) in [
            (0, action, 8),
            (2, action, 8),
            (1, other, 8),
            (1, stale_zero, 8),
            (1, action, 9),
        ] {
            assert_eq!(
                g.receipt(sequence, token, base, RegisterOutcome::AppliedStopped),
                Err(Error::State)
            );
        }
        assert_eq!(
            g.call.register_receipt(
                &mut g.domain,
                &mut foreign.execution,
                1,
                action,
                8,
                RegisterOutcome::AppliedStopped
            ),
            Err(Error::Execution(execution::Error::Identity))
        );
        assert_eq!(
            g.call.register_receipt(
                &mut foreign.domain,
                &mut g.execution,
                1,
                action,
                8,
                RegisterOutcome::AppliedStopped
            ),
            Err(Error::Execution(execution::Error::Identity))
        );
        assert_eq!(
            g.receipt(1, action, 8, RegisterOutcome::AppliedStopped),
            Ok(Step::Return(0))
        );
        assert_eq!(
            g.receipt(1, action, 8, RegisterOutcome::AppliedStopped),
            Err(Error::State)
        );
        assert_eq!(g.domain.retire(action), Err(lease::Error::UnknownAction));
        assert!(foreign.abandon().unwrap());
    }

    #[test]
    fn effect_capacity_failure_consumes_sequence_but_no_action_call_hold_or_result() {
        let mut g = Guest::new(1540, 1);
        let busy = g.domain.span(g.execution.binding(), 0, 1).unwrap();
        assert_eq!(
            g.request(1, 158, [0x1002, 8, 0, 0, 0, 0]),
            Err(Error::Lease(lease::Error::Capacity))
        );
        assert_eq!(g.call.last_sequence, 1);
        assert!(g.call.register.is_none());
        assert!(!g.call.owns(busy));
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        assert_eq!(g.files.offset(&g.table, g.fd), Ok((0, 0)));
        assert_eq!(
            g.request(1, 158, [0x1002, 8, 0, 0, 0, 0]),
            Err(Error::State)
        );
        g.domain.cancel(busy).unwrap();
        g.domain.retire(busy).unwrap();
        let action = g.admit(2, 8);
        assert_eq!(g.call.register.as_ref().unwrap().sequence, 2);
        assert_eq!(g.start(1, action, 8), Err(Error::State));
        assert!(g.abandon().unwrap());
    }

    #[test]
    fn unknown_late_applied_or_not_applied_can_settle_but_never_restore_guest_success() {
        for late in [
            RegisterOutcome::AppliedStopped,
            RegisterOutcome::NotAppliedStopped,
        ] {
            let mut g = Guest::new(1560, 1);
            let action = g.admit(1, 8);
            g.start(1, action, 8).unwrap();
            assert_eq!(
                g.receipt(1, action, 8, RegisterOutcome::Unknown),
                Ok(Step::Waiting)
            );
            assert_eq!(
                g.receipt(1, action, 8, RegisterOutcome::Unknown),
                Ok(Step::Waiting)
            );
            assert!(g.call.closed);
            assert!(g.call.owns(action));
            assert_eq!(g.start(1, action, 8), Err(Error::State));
            assert_eq!(g.domain.retire(action), Err(lease::Error::Incomplete));
            assert!(g.request(2, 3, [g.fd as u64, 0, 0, 0, 0, 0]).is_err());
            assert_eq!(g.call.last_sequence, 1);
            assert_eq!(g.receipt(1, action, 8, late), Ok(Step::Waiting));
            assert!(!g.call.owns(action));
            assert!(g.execution.syscall_allowed(g.invocation).is_ok());
            assert_eq!(
                g.request(2, 3, [g.fd as u64, 0, 0, 0, 0, 0]),
                Err(Error::State)
            );
            assert_eq!(g.receipt(1, action, 8, late), Err(Error::State));
            g.fault();
            assert!(g.execution.retireable());
            assert!(g.domain.change(g.execution.binding(), 16).is_ok());
        }
    }

    #[test]
    fn not_applied_stopped_is_transport_failure_not_a_success_or_linux_errno() {
        let mut g = Guest::new(1580, 1);
        let action = g.admit(1, 8);
        g.start(1, action, 8).unwrap();
        assert_eq!(
            g.receipt(1, action, 8, RegisterOutcome::NotAppliedStopped),
            Ok(Step::Waiting)
        );
        assert!(g.call.closed);
        assert!(!g.call.owns(action));
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        assert_eq!(g.request(2, 3, [0; 6]), Err(Error::State));
        assert_eq!(g.files.offset(&g.table, g.fd), Ok((0, 0)));
        g.fault();
        assert!(g.execution.retireable());
    }

    #[test]
    fn applied_after_run_fault_or_unknown_is_not_success_even_without_prior_cancel() {
        for unwind in [Unwind::Fault, Unwind::Unknown] {
            let mut g = Guest::new(1590, 1);
            let action = g.admit(1, 8);
            g.start(1, action, 8).unwrap();
            g.execution
                .receipt(&mut g.domain, g.invocation, unwind)
                .unwrap();
            assert!(
                !g.call.closed,
                "exercise phase rejection independently of closed admission"
            );
            assert!(!g.execution.retireable());
            assert_eq!(
                g.receipt(1, action, 8, RegisterOutcome::AppliedStopped),
                Ok(Step::Waiting)
            );
            assert!(!g.call.owns(action));
            if unwind == Unwind::Unknown {
                assert!(!g.execution.stopped());
                assert_eq!(
                    g.domain.change(g.execution.binding(), 16),
                    Err(lease::Error::Busy)
                );
                g.fault();
            }
            assert!(g.execution.retireable());
            assert!(g.domain.change(g.execution.binding(), 16).is_ok());
        }
    }

    #[test]
    fn ready_abandon_never_dispatches_and_closes_even_after_fault_before_start() {
        for fault_before in [false, true] {
            let mut g = Guest::new(1600, 1);
            let action = g.admit(1, 8);
            if fault_before {
                g.fault();
                assert!(g.start(1, action, 8).is_err());
            }
            assert!(g.abandon().unwrap());
            assert!(g.call.closed);
            assert!(!g.call.owns(action));
            assert_eq!(g.start(1, action, 8), Err(Error::State));
            assert_eq!(
                g.receipt(1, action, 8, RegisterOutcome::AppliedStopped),
                Err(Error::State)
            );
            assert_eq!(g.domain.retire(action), Err(lease::Error::UnknownAction));
            if !fault_before {
                assert!(g.execution.syscall_allowed(g.invocation).is_ok());
                assert_eq!(g.request(2, 999, [0; 6]), Err(Error::State));
                g.fault();
            }
            assert!(g.execution.retireable());
            assert!(g.domain.change(g.execution.binding(), 16).is_ok());
        }
    }

    #[test]
    fn exit_requested_with_exact_held_sequence_does_not_authorize_first_effect() {
        let mut g = Guest::new(1605, 1);
        let action = g.admit(1, 8);
        g.execution.request_exit(g.invocation, 7).unwrap();
        assert_eq!(g.execution.phase(), Phase::Running);
        assert!(g.call.owns(action));
        assert!(!g.call.closed);
        assert_eq!(
            g.start(1, action, 8),
            Err(Error::Execution(execution::Error::State))
        );
        assert!(g.abandon().unwrap(), "rejected start left the action Ready");
        assert_eq!(g.domain.retire(action), Err(lease::Error::UnknownAction));
        g.execution
            .receipt(&mut g.domain, g.invocation, Unwind::Exit)
            .unwrap();
        assert_eq!(g.execution.status(), Some(7));
        assert!(g.execution.retireable());
    }

    #[test]
    fn started_abandon_and_synthetic_fault_retain_effect_until_one_late_stop() {
        for unknown_first in [false, true] {
            let mut g = Guest::new(1620, 1);
            let action = g.admit(1, 8);
            g.start(1, action, 8).unwrap();
            if unknown_first {
                assert_eq!(
                    g.receipt(1, action, 8, RegisterOutcome::Unknown),
                    Ok(Step::Waiting)
                );
            }
            assert!(!g.abandon().unwrap());
            assert!(!g.abandon().unwrap());
            g.fault();
            assert!(g.execution.stopped());
            assert!(!g.execution.retireable());
            assert!(g.call.owns(action));
            assert_eq!(g.domain.retire(action), Err(lease::Error::Incomplete));
            assert_eq!(
                g.domain.change(g.execution.binding(), 16),
                Err(lease::Error::Busy)
            );
            assert_eq!(
                g.domain.effect(g.execution.binding(), 1),
                Err(lease::Error::Capacity)
            );
            assert_eq!(
                g.receipt(1, action, 8, RegisterOutcome::AppliedStopped),
                Ok(Step::Waiting)
            );
            assert!(g.execution.retireable());
            assert!(!g.call.owns(action));
            assert_eq!(
                g.receipt(1, action, 8, RegisterOutcome::AppliedStopped),
                Err(Error::State)
            );
            assert!(g.abandon().unwrap());
            assert!(g.domain.change(g.execution.binding(), 16).is_ok());
        }
    }
    mod task_cases {
        use super::*;

        fn observed(g: &Guest) -> (u32, u64) {
            let record = g.call.task_registration(&g.execution).unwrap();
            (record.tid, record.clear_child_tid)
        }

        #[test]
        fn sequenced_set_tid_address_preserves_full_u64_values_without_access_or_effect_admission()
        {
            let mut g = Guest::new(2000, 1);
            assert_eq!(observed(&g), (1, 0));
            for (i, pointer) in [0, 1, 3, 16, 0x1_0000_0003, u64::MAX]
                .into_iter()
                .enumerate()
            {
                assert_eq!(
                    g.request(
                        i as u32 + 1,
                        218,
                        [pointer, u64::MAX, u64::MAX, u64::MAX, u64::MAX, u64::MAX]
                    ),
                    Ok(Step::Return(1))
                );
                assert_eq!(observed(&g), (1, pointer));
                assert!(g.execution.syscall_allowed(g.invocation).is_ok());
                assert_eq!(g.domain.extent(g.execution.binding()), Ok(16));
                assert_eq!(g.files.offset(&g.table, g.fd), Ok((0, 0)));
            }
            let effect = g.domain.effect(g.execution.binding(), 1).unwrap();
            g.domain.cancel(effect).unwrap();
            g.domain.retire(effect).unwrap();
            assert_eq!(g.call.last_sequence, 6);
            assert_eq!(observed(&g), (1, u64::MAX));
        }

        #[test]
        fn duplicate_gap_unsequenced_and_foreign_task_requests_cannot_replace_the_record() {
            let mut g = Guest::new(2020, 1);
            let mut foreign = Guest::new(2040, 1);
            for nr in [218, 231] {
                assert_eq!(
                    g.call.enter(
                        &mut g.files,
                        &g.table,
                        &mut g.reads,
                        &mut g.domain,
                        &mut g.execution,
                        g.invocation,
                        nr,
                        [u64::MAX; 6],
                        123
                    ),
                    Ok(Step::Unsupported(nr))
                );
                assert_eq!(
                    g.call.enter_with_namespace(
                        &mut g.files,
                        &g.table,
                        None,
                        &mut g.reads,
                        &mut g.domain,
                        &mut g.execution,
                        g.invocation,
                        nr,
                        [u64::MAX; 6],
                        123
                    ),
                    Ok(Step::Unsupported(nr))
                );
            }
            assert_eq!(g.call.last_sequence, 0);
            assert_eq!(observed(&g), (1, 0));
            assert_eq!(
                g.request(1, 218, [u64::MAX, 0, 0, 0, 0, 0]),
                Ok(Step::Return(1))
            );
            for sequence in [0, 1, 3, u32::MAX] {
                assert_eq!(
                    g.request(sequence, 218, [77, 0, 0, 0, 0, 0]),
                    Err(Error::State)
                );
                assert_eq!(observed(&g), (1, u64::MAX));
                assert_eq!(g.call.last_sequence, 1);
            }
            assert_eq!(
                g.call.enter_sequenced(
                    &mut g.files,
                    &g.table,
                    None,
                    &mut g.reads,
                    &mut g.domain,
                    &mut g.execution,
                    foreign.invocation,
                    2,
                    218,
                    [77, 0, 0, 0, 0, 0],
                    123
                ),
                Err(Error::Execution(execution::Error::Identity))
            );
            assert_eq!(
                g.call.enter_sequenced(
                    &mut g.files,
                    &g.table,
                    None,
                    &mut g.reads,
                    &mut foreign.domain,
                    &mut foreign.execution,
                    foreign.invocation,
                    2,
                    218,
                    [77, 0, 0, 0, 0, 0],
                    123
                ),
                Err(Error::Execution(execution::Error::Identity))
            );
            assert_eq!(g.call.last_sequence, 1);
            assert_eq!(observed(&g), (1, u64::MAX));
            assert_eq!(g.request(2, 218, [77, 0, 0, 0, 0, 0]), Ok(Step::Return(1)));
            assert_eq!(observed(&g), (1, 77));
        }

        #[test]
        fn pending_register_or_read_keeps_task_observable_but_blocks_new_task_operations() {
            let mut g = Guest::new(2060, 1);
            assert_eq!(g.request(1, 218, [77, 0, 0, 0, 0, 0]), Ok(Step::Return(1)));
            let action = g.admit(2, 8);
            for nr in [218, 231] {
                assert!(g.request(3, nr, [88, 0, 0, 0, 0, 0]).is_err());
                assert_eq!(observed(&g), (1, 77));
                assert_eq!(g.call.last_sequence, 2);
            }
            g.start(2, action, 8).unwrap();
            assert_eq!(
                g.receipt(2, action, 8, RegisterOutcome::AppliedStopped),
                Ok(Step::Return(0))
            );
            let Step::Read { id, .. } = g.request(3, 0, [g.fd as u64, 0, 1, 0, 0, 0]).unwrap()
            else {
                panic!()
            };
            for nr in [218, 231] {
                assert!(g.request(4, nr, [88, 0, 0, 0, 0, 0]).is_err());
                assert_eq!(observed(&g), (1, 77));
                assert_eq!(g.call.last_sequence, 3);
            }
            g.reads
                .start_managed(&mut g.files, &mut g.domain, &g.execution, id)
                .unwrap();
            g.reads
                .receipt(&mut g.files, &mut g.domain, id, 1, Completion::Stopped)
                .unwrap();
            assert_eq!(
                g.call.complete(&mut g.reads, &mut g.execution),
                Ok(Step::Return(1))
            );
            assert_eq!(g.request(4, 218, [88, 0, 0, 0, 0, 0]), Ok(Step::Return(1)));
            assert_eq!(observed(&g), (1, 88));
        }

        #[test]
        fn unknown_register_abandon_and_unwind_do_not_clear_the_task_registration() {
            let mut g = Guest::new(2080, 1);
            assert_eq!(
                g.request(1, 218, [u64::MAX, 0, 0, 0, 0, 0]),
                Ok(Step::Return(1))
            );
            let action = g.admit(2, 8);
            g.start(2, action, 8).unwrap();
            assert_eq!(
                g.receipt(2, action, 8, RegisterOutcome::Unknown),
                Ok(Step::Waiting)
            );
            assert_eq!(observed(&g), (1, u64::MAX));
            assert!(!g.abandon().unwrap());
            g.fault();
            assert_eq!(observed(&g), (1, u64::MAX));
            assert!(!g.execution.retireable());
            assert_eq!(
                g.receipt(2, action, 8, RegisterOutcome::AppliedStopped),
                Ok(Step::Waiting)
            );
            assert!(g.execution.retireable());
            assert_eq!(observed(&g), (1, u64::MAX));
            // The native test still retains the Continuation. A real resource
            // slot drops this metadata only when it drops that owner, not here.
        }

        #[test]
        fn stopped_or_uncertain_task_observation_is_not_permission_for_a_late_registration() {
            for unwind in [Unwind::Fault, Unwind::Unknown, Unwind::Exit] {
                let mut g = Guest::new(2100, 1);
                assert_eq!(
                    g.request(1, 218, [0x1_0000_0003, 0, 0, 0, 0, 0]),
                    Ok(Step::Return(1))
                );
                if unwind == Unwind::Exit {
                    assert_eq!(g.request(2, 231, [257, 0, 0, 0, 0, 0]), Ok(Step::Exit));
                }
                let last_sequence = g.call.last_sequence;
                g.execution
                    .receipt(&mut g.domain, g.invocation, unwind)
                    .unwrap();
                assert_eq!(observed(&g), (1, 0x1_0000_0003));
                assert!(g.request(last_sequence + 1, 218, [0; 6]).is_err());
                assert_eq!(g.call.last_sequence, last_sequence);
                assert!(g.abandon().unwrap());
                assert_eq!(observed(&g), (1, 0x1_0000_0003));
                if unwind == Unwind::Unknown {
                    g.fault();
                    assert_eq!(observed(&g), (1, 0x1_0000_0003));
                }
            }
        }

        #[test]
        fn task_observer_and_admission_retain_untouched_but_reject_installed_reimages() {
            let mut g = Guest::new(2120, 1);
            assert_eq!(g.request(1, 218, [91, 0, 0, 0, 0, 0]), Ok(Step::Return(1)));
            g.execution
                .receipt(&mut g.domain, g.invocation, Unwind::Yield(123))
                .unwrap();
            g.execution.image_begin(&mut g.domain, 16).unwrap();
            assert_eq!(
                g.call.task_registration(&g.execution).err(),
                Some(Error::Execution(execution::Error::Identity))
            );
            g.execution
                .image_finish(&mut g.domain, ImageResult::Untouched)
                .unwrap();
            assert_eq!(observed(&g), (1, 91));
            g.invocation = g.execution.start(&mut g.domain).unwrap();
            assert_eq!(g.request(2, 218, [92, 0, 0, 0, 0, 0]), Ok(Step::Return(1)));
            g.fault();
            g.execution.image_begin(&mut g.domain, 16).unwrap();
            g.execution
                .image_finish(&mut g.domain, ImageResult::Installed)
                .unwrap();
            assert_eq!(
                g.call.task_registration(&g.execution).err(),
                Some(Error::Execution(execution::Error::Identity))
            );
            g.invocation = g.execution.start(&mut g.domain).unwrap();
            assert_eq!(
                g.request(3, 218, [93, 0, 0, 0, 0, 0]),
                Err(Error::Execution(execution::Error::Identity))
            );
            assert_eq!(
                g.call.task_registration(&g.execution).err(),
                Some(Error::Execution(execution::Error::Identity))
            );
            let mut fresh = Continuation::new(&g.execution).unwrap();
            assert_eq!(
                fresh.enter_sequenced(
                    &mut g.files,
                    &g.table,
                    None,
                    &mut g.reads,
                    &mut g.domain,
                    &mut g.execution,
                    g.invocation,
                    1,
                    218,
                    [0; 6],
                    123
                ),
                Ok(Step::Return(1))
            );
            let record = fresh.task_registration(&g.execution).unwrap();
            assert_eq!((record.tid, record.clear_child_tid), (1, 0));
        }

        #[test]
        fn sequenced_group_exit_masks_status_waits_for_unwind_and_is_execution_local() {
            for status in [0, 255, 256, 279, u64::MAX, 0x123456] {
                let mut g = Guest::new(2140, 1);
                assert_eq!(g.request(1, 218, [3, 0, 0, 0, 0, 0]), Ok(Step::Return(1)));
                assert_eq!(
                    g.execution
                        .receipt(&mut g.domain, g.invocation, Unwind::Exit),
                    Err(execution::Error::State)
                );
                assert_eq!(g.request(2, 231, [status, 0, 0, 0, 0, 0]), Ok(Step::Exit));
                assert_eq!(g.execution.status(), None);
                assert!(!g.execution.stopped());
                assert_eq!(
                    g.domain.change(g.execution.binding(), 16),
                    Err(lease::Error::Busy)
                );
                for nr in [218, 231] {
                    assert!(g.request(3, nr, [0; 6]).is_err());
                }
                assert_eq!(g.call.last_sequence, 2);
                g.execution
                    .receipt(&mut g.domain, g.invocation, Unwind::Exit)
                    .unwrap();
                assert_eq!(g.execution.status(), Some((status & 255) as u32));
                assert_eq!(observed(&g), (1, 3));
                assert!(g.request(3, 218, [4, 0, 0, 0, 0, 0]).is_err());
            }
            let mut a = Guest::new(2160, 1);
            let mut b = Guest::new(2180, 1);
            assert_eq!(a.request(1, 218, [11, 0, 0, 0, 0, 0]), Ok(Step::Return(1)));
            assert_eq!(b.request(1, 218, [22, 0, 0, 0, 0, 0]), Ok(Step::Return(1)));
            assert_eq!(
                a.call.task_registration(&b.execution).err(),
                Some(Error::Execution(execution::Error::Identity))
            );
            assert_eq!(a.request(2, 231, [0; 6]), Ok(Step::Exit));
            a.execution
                .receipt(&mut a.domain, a.invocation, Unwind::Exit)
                .unwrap();
            assert_eq!(observed(&a), (1, 11));
            assert_eq!(b.request(2, 218, [33, 0, 0, 0, 0, 0]), Ok(Step::Return(1)));
            assert_eq!(observed(&b), (1, 33));
            assert_eq!(b.execution.status(), None);
        }
    }
}

#[cfg(test)]
mod open_tests {
    use super::*;
    use crate::execution::{ImageResult, Unwind};
    use crate::inode::{Creation, Tree};
    use crate::mount;
    use crate::read::ReadCapacity;
    struct Guest {
        files: Files,
        table: Table,
        fs: Ticket,
        reads: Reads,
        domain: Domain,
        execution: Execution,
        call: Continuation,
        invocation: Invocation,
    }
    impl Guest {
        fn new(actions: usize) -> Self {
            let metadata = Creation {
                mode: 0o755,
                uid: 0,
                gid: 0,
            };
            let mut tree = Tree::new(1301, 8, 8, 8, metadata).unwrap();
            let root = tree.root();
            tree.file_take(root, b"program", metadata, &mut b"abcd".to_vec())
                .unwrap();
            Self::from_tree(actions, tree)
        }
        fn from_tree(actions: usize, tree: Tree) -> Self {
            let root = tree.root();
            let mut files = Files::new(
                1302,
                tree,
                descriptor::Limits {
                    contexts: 2,
                    tables: 1,
                    descriptions: 8,
                    slots: 8,
                },
            );
            let view = files
                .bootstrap_mount(
                    root,
                    mount::Limits {
                        views: 2,
                        holds: 24,
                    },
                    mount::ViewPolicy {
                        no_exec: false,
                        no_suid: false,
                        no_symfollow: false,
                    },
                )
                .unwrap();
            let root = files.view_root(&view).unwrap();
            let fs = files.create_fs(&root, &root, 0o022).unwrap();
            let table = files.table(8).unwrap();
            let reads = Reads::new(&files, ReadCapacity::new(1).unwrap());
            let mut domain = Domain::new(1303, 1, actions).unwrap();
            let binding = domain.bind(8192).unwrap();
            let mut execution = Execution::new(1304, binding);
            execution.image_begin(&mut domain, 8192).unwrap();
            execution
                .image_finish(&mut domain, ImageResult::Installed)
                .unwrap();
            let call = Continuation::new(&execution).unwrap();
            let invocation = execution.start(&mut domain).unwrap();
            Self {
                files,
                table,
                fs,
                reads,
                domain,
                execution,
                call,
                invocation,
            }
        }
        fn enter(&mut self, nr: u64, args: [u64; 6]) -> Result<Step, Error> {
            self.call.enter_with_namespace(
                &mut self.files,
                &self.table,
                Some((&self.fs, &Credentials::initial_root())),
                &mut self.reads,
                &mut self.domain,
                &mut self.execution,
                self.invocation,
                nr,
                args,
                100,
            )
        }
        fn admit(&mut self, address: u64, flags: u64) -> Token {
            let Step::Path {
                action,
                target,
                length,
            } = self
                .enter(257, [(-100i64) as u64, address, flags, 0, 0, 0])
                .unwrap()
            else {
                panic!()
            };
            assert_eq!(target, address);
            assert_eq!(length, 4096.min(8192 - address));
            action
        }
        fn capture(&mut self, token: Token, bytes: &[u8]) {
            let input = self
                .call
                .path_start(&mut self.domain, &self.execution, token)
                .unwrap();
            input[..bytes.len()].copy_from_slice(bytes);
        }
        fn finish(
            &mut self,
            token: Token,
            count: u64,
            outcome: PathOutcome,
        ) -> Result<Step, Error> {
            self.call.path_finish(
                &mut self.files,
                &self.table,
                &mut self.domain,
                &mut self.execution,
                token,
                count,
                outcome,
            )
        }
        fn open(&mut self, path: &[u8]) -> i64 {
            let token = self.admit(16, 0);
            let mut bytes = path.to_vec();
            bytes.push(0);
            self.capture(token, &bytes);
            let Step::Return(fd) = self
                .finish(token, bytes.len() as u64, PathOutcome::Captured)
                .unwrap()
            else {
                panic!()
            };
            fd
        }
    }
    #[test]
    fn actual_open_read_close_uses_one_description_and_reuses_only_the_slot() {
        let mut g = Guest::new(1);
        let fd = g.open(b"/program");
        assert_eq!(fd, 0);
        let Step::Read { id, .. } = g.enter(0, [fd as u64, 64, 2, 0, 0, 0]).unwrap() else {
            panic!()
        };
        let (pointer, length) = g
            .reads
            .start_managed(&mut g.files, &mut g.domain, &g.execution, id)
            .unwrap();
        assert_eq!(
            unsafe { std::slice::from_raw_parts(pointer as *const u8, length as usize) },
            b"ab"
        );
        g.reads
            .receipt(&mut g.files, &mut g.domain, id, 2, Completion::Stopped)
            .unwrap();
        assert_eq!(
            g.call.complete(&mut g.reads, &mut g.execution),
            Ok(Step::Return(2))
        );
        assert_eq!(g.files.offset(&g.table, fd as u32), Ok((2, 1)));
        assert_eq!(g.enter(3, [fd as u64, 0, 0, 0, 0, 0]), Ok(Step::Return(0)));
        assert_eq!(
            g.enter(0, [fd as u64, 64, 2, 0, 0, 0]),
            Ok(Step::Return(-9))
        );
        assert_eq!(g.open(b"/program"), fd);
        assert_eq!(g.files.offset(&g.table, fd as u32), Ok((0, 0)));
        assert_eq!(g.enter(3, [999, 0, 0, 0, 0, 0]), Ok(Step::Return(-9)));
    }
    #[test]
    fn captured_count_zero_and_stale_tail_cannot_manufacture_a_path() {
        let mut g = Guest::new(1);
        assert_eq!(g.open(b"/program"), 0);
        let token = g.admit(16, 0);
        g.capture(token, b"/p");
        assert_eq!(g.finish(token, 0, PathOutcome::Captured), Err(Error::State));
        assert_eq!(g.finish(token, 2, PathOutcome::Captured), Err(Error::State));
        assert_eq!(g.call.path_view(), Some(token));
        assert!(g.call.owns(token));
        assert_eq!(g.files.target(&g.table, 1), Err(descriptor::Error::BadFd));
        assert_eq!(g.finish(token, 0, PathOutcome::Failed), Ok(Step::Waiting));
        assert!(g.enter(257, [(-100i64) as u64, 16, 0, 0, 0, 0]).is_err());
        assert_eq!(g.files.target(&g.table, 1), Err(descriptor::Error::BadFd));
    }
    #[test]
    fn bounded_capture_distinguishes_empty_nul_at_tail_and_missing_nul() {
        let mut g = Guest::new(1);
        let token = g.admit(8191, 0);
        g.capture(token, b"\0");
        assert_eq!(
            g.finish(token, 1, PathOutcome::Captured),
            Ok(Step::Return(-2))
        );
        let token = g.admit(8190, 0);
        g.capture(token, b"/\0");
        assert_eq!(
            g.finish(token, 2, PathOutcome::Captured),
            Ok(Step::Return(0))
        );
        let token = g.admit(8189, 0);
        g.capture(token, b"xxx");
        assert_eq!(
            g.finish(token, 3, PathOutcome::Captured),
            Ok(Step::Return(-14))
        );
        let token = g.admit(16, 0);
        g.capture(token, &vec![b'x'; 4096]);
        assert_eq!(
            g.finish(token, 4096, PathOutcome::Captured),
            Ok(Step::Return(-36))
        );
    }
    #[test]
    fn wrong_duplicate_and_unstarted_capture_receipts_do_not_end_the_owner() {
        let mut g = Guest::new(1);
        let token = g.admit(16, 0);
        let wrong = Token::from_parts(1303, token.sequence() + 1);
        assert!(g
            .call
            .path_start(&mut g.domain, &g.execution, wrong)
            .is_err());
        assert_eq!(g.finish(token, 1, PathOutcome::Captured), Err(Error::State));
        g.capture(token, b"/program\0");
        assert!(g
            .call
            .path_start(&mut g.domain, &g.execution, token)
            .is_err());
        assert_eq!(g.finish(wrong, 9, PathOutcome::Captured), Err(Error::State));
        assert_eq!(
            g.finish(token, 4097, PathOutcome::Captured),
            Err(Error::State)
        );
        assert_eq!(g.call.path_view(), Some(token));
        assert_eq!(
            g.finish(token, 9, PathOutcome::Captured),
            Ok(Step::Return(0))
        );
        assert_eq!(g.finish(token, 9, PathOutcome::Captured), Err(Error::State));
        assert!(!g.call.owns(token));
    }
    #[test]
    fn ready_cancellation_releases_bases_but_never_claims_guest_stop() {
        let mut g = Guest::new(1);
        let token = g.admit(16, 0);
        assert!(g
            .call
            .abandon(&mut g.files, &mut g.reads, &mut g.domain, &mut g.execution)
            .unwrap());
        assert!(!g.call.owns(token));
        assert!(!g.execution.stopped());
        assert!(g.enter(3, [0; 6]).is_err());
        assert!(g.domain.change(g.execution.binding(), 8192).is_err());
        g.execution
            .receipt(&mut g.domain, g.invocation, Unwind::Fault)
            .unwrap();
        assert!(g.domain.change(g.execution.binding(), 8192).is_ok());
        let route = g
            .files
            .prepare_open_route(&g.table, &g.fs, &Credentials::initial_root(), -100)
            .unwrap();
        g.files.release_open_route(route).unwrap();
    }
    #[test]
    fn unknown_capture_is_not_restarted_and_late_stopped_after_cancel_opens_nothing() {
        let mut g = Guest::new(1);
        let token = g.admit(16, 0);
        g.capture(token, b"/program\0");
        assert_eq!(g.finish(token, 9, PathOutcome::Unknown), Ok(Step::Waiting));
        assert_eq!(g.call.path_view(), None);
        assert!(g
            .call
            .path_start(&mut g.domain, &g.execution, token)
            .is_err());
        assert!(!g
            .call
            .abandon(&mut g.files, &mut g.reads, &mut g.domain, &mut g.execution)
            .unwrap());
        g.execution
            .receipt(&mut g.domain, g.invocation, Unwind::Fault)
            .unwrap();
        assert!(g.domain.change(g.execution.binding(), 8192).is_err());
        assert_eq!(g.finish(token, 9, PathOutcome::Captured), Ok(Step::Waiting));
        assert_eq!(g.files.target(&g.table, 0), Err(descriptor::Error::BadFd));
        assert!(g.domain.change(g.execution.binding(), 8192).is_ok());
    }
    #[test]
    fn matching_late_stopped_evidence_publishes_at_most_one_fd_without_recopy() {
        let mut g = Guest::new(1);
        let token = g.admit(16, 0);
        g.capture(token, b"/program\0");
        assert_eq!(g.finish(token, 4, PathOutcome::Unknown), Ok(Step::Waiting));
        assert_eq!(
            g.finish(token, 3, PathOutcome::Unknown),
            Err(Error::Lease(lease::Error::Effect(
                crate::effect::Error::InvalidProgress
            )))
        );
        assert!(g.call.owns(token));
        assert_eq!(
            g.finish(token, 9, PathOutcome::Captured),
            Ok(Step::Return(0))
        );
        assert_eq!(g.finish(token, 9, PathOutcome::Captured), Err(Error::State));
        assert_eq!(g.files.target(&g.table, 1), Err(descriptor::Error::BadFd));
    }
    #[test]
    fn span_admission_failure_returns_every_namespace_hold_before_retry() {
        let mut g = Guest::new(1);
        let busy = g.domain.span(g.execution.binding(), 0, 1).unwrap();
        assert_eq!(
            g.enter(257, [(-100i64) as u64, 16, 0, 0, 0, 0]),
            Ok(Step::Return(-12))
        );
        assert!(g.call.opening.is_none());
        assert!(!g.call.owns(busy));
        g.domain.cancel(busy).unwrap();
        g.domain.retire(busy).unwrap();
        assert_eq!(g.open(b"/program"), 0);
    }
    #[test]
    fn failed_capture_releases_inputs_closes_admission_and_requires_real_stop() {
        let mut g = Guest::new(1);
        let token = g.admit(16, 0);
        g.capture(token, b"partial");
        assert_eq!(g.finish(token, 0, PathOutcome::Failed), Ok(Step::Waiting));
        assert!(!g.call.owns(token));
        assert!(!g.execution.stopped());
        assert!(g.enter(3, [0; 6]).is_err());
        assert_eq!(g.files.target(&g.table, 0), Err(descriptor::Error::BadFd));
        assert!(g.domain.change(g.execution.binding(), 8192).is_err());
        g.execution
            .receipt(&mut g.domain, g.invocation, Unwind::Fault)
            .unwrap();
        assert!(g.domain.change(g.execution.binding(), 8192).is_ok());
    }
    #[test]
    fn flags_int_abi_cloexec_and_pointer_admission_are_rust_decisions() {
        let mut g = Guest::new(1);
        for flags in [1, 2, 0x40, 0x200000, 0x800] {
            assert_eq!(
                g.enter(257, [(-100i64) as u64, 0, flags, 0, 0, 0]),
                Ok(Step::Unsupported(257))
            );
        }
        for at in [0, 8192, u64::MAX] {
            assert_eq!(
                g.enter(257, [(-100i64) as u64, at, 0, 0, 0, 0]),
                Ok(Step::Return(-14))
            );
        }
        assert!(g.call.path_input.is_empty());
        let token = g.admit(16, (1u64 << 32) | 0x80000 | 0x100 | 0x8000);
        g.capture(token, b"/program\0");
        assert_eq!(
            g.finish(token, 9, PathOutcome::Captured),
            Ok(Step::Return(0))
        );
        assert_eq!(g.files.cloexec(&g.table, 0), Ok(true));
    }
    #[test]
    fn directory_read_and_zero_address_order_match_native_profile_cases() {
        let mut g = Guest::new(1);
        assert_eq!(g.open(b"/"), 0);
        assert_eq!(g.open(b"/program"), 1);
        for at in [0, 16] {
            for length in [0, 1] {
                assert_eq!(g.enter(0, [0, at, length, 0, 0, 0]), Ok(Step::Return(-21)));
            }
        }
        for fd in [0, 1] {
            assert_eq!(
                g.enter(0, [fd, u64::MAX, 0, 0, 0, 0]),
                Ok(Step::Return(-14))
            );
        }
        assert_eq!(g.enter(0, [1, 0, 0, 0, 0, 0]), Ok(Step::Return(0)));
        assert_eq!(
            g.enter(0, [999, u64::MAX, 0, 0, 0, 0]),
            Ok(Step::Return(-9))
        );
    }

    mod open2_cases {
        use super::*;

        fn tree_guest() -> Guest {
            let metadata = Creation {
                mode: 0o755,
                uid: 0,
                gid: 0,
            };
            let mut tree = Tree::new(1301, 8, 8, 8, metadata).unwrap();
            let root = tree.root();
            tree.file_take(root, b"program", metadata, &mut b"abcd".to_vec())
                .unwrap();
            let work = tree.directory(root, b"work", metadata).unwrap();
            tree.file_take(work, b"program", metadata, &mut b"wxyz".to_vec())
                .unwrap();
            tree.symlink(root, b"link", b"program", metadata).unwrap();
            tree.symlink(root, b"dirlink", b"work", metadata).unwrap();
            Guest::from_tree(1, tree)
        }
        fn admit(g: &mut Guest, address: u64, flags: u64, sequenced: bool) -> Token {
            // mode deliberately contains every bit: it must not become flags,
            // an openat address/dirfd, or a creation request in this profile.
            let args = [address, flags, u64::MAX, 0, 0, 0];
            let step = if sequenced {
                g.call.enter_sequenced(
                    &mut g.files,
                    &g.table,
                    Some((&g.fs, &Credentials::initial_root())),
                    &mut g.reads,
                    &mut g.domain,
                    &mut g.execution,
                    g.invocation,
                    1,
                    2,
                    args,
                    100,
                )
            } else {
                g.enter(2, args)
            };
            let Step::Path {
                action,
                target,
                length,
            } = step.unwrap()
            else {
                panic!()
            };
            assert_eq!(target, address);
            assert_eq!(length, 4096.min(8192 - address));
            assert_eq!(g.call.opening.as_ref().unwrap().original_nr, 2);
            action
        }
        fn open(g: &mut Guest, path: &[u8], flags: u64) -> i64 {
            let token = admit(g, 16, flags, false);
            let mut input = path.to_vec();
            input.push(0);
            g.capture(token, &input);
            let Step::Return(value) = g
                .finish(token, input.len() as u64, PathOutcome::Captured)
                .unwrap()
            else {
                panic!()
            };
            value
        }
        fn read_bytes(g: &mut Guest, fd: u32, length: u64) -> Vec<u8> {
            let Step::Read { id, .. } = g.enter(0, [fd as u64, 64, length, 0, 0, 0]).unwrap()
            else {
                panic!()
            };
            let (pointer, actual) = g
                .reads
                .start_managed(&mut g.files, &mut g.domain, &g.execution, id)
                .unwrap();
            let bytes =
                unsafe { std::slice::from_raw_parts(pointer as *const u8, actual as usize) }
                    .to_vec();
            g.reads
                .receipt(&mut g.files, &mut g.domain, id, actual, Completion::Stopped)
                .unwrap();
            assert_eq!(
                g.call.complete(&mut g.reads, &mut g.execution),
                Ok(Step::Return(actual as i64))
            );
            bytes
        }

        #[test]
        fn open2_argument_layout_uses_cwd_and_low32_flags_in_both_entrances() {
            for sequenced in [false, true] {
                let mut g = Guest::new(1);
                let token = admit(
                    &mut g,
                    16,
                    (1u64 << 32) | 0x80000 | 0x100 | 0x8000,
                    sequenced,
                );
                g.capture(token, b"program\0");
                assert_eq!(
                    g.finish(token, 8, PathOutcome::Captured),
                    Ok(Step::Return(0))
                );
                assert_eq!(g.files.cloexec(&g.table, 0), Ok(true));
                // A relative path exposes an accidental address-as-dirfd bug;
                // an absolute path alone would ignore that erroneous dirfd.
                let openat = g.open(b"/program") as u32;
                let absolute = open(&mut g, b"/program", 0) as u32;
                assert_eq!(g.files.inode(&g.table, 0), g.files.inode(&g.table, openat));
                assert_eq!(
                    g.files.inode(&g.table, 0),
                    g.files.inode(&g.table, absolute)
                );
                assert_eq!(g.files.cloexec(&g.table, absolute), Ok(false));
            }
        }

        #[test]
        fn unsupported_flags_missing_namespace_and_late_error_keep_the_original_number() {
            let mut g = Guest::new(1);
            for nr in [2, 257] {
                let plain = if nr == 2 {
                    [16, 0, u64::MAX, 0, 0, 0]
                } else {
                    [(-100i64) as u64, 16, 0, u64::MAX, 0, 0]
                };
                assert_eq!(
                    g.call.enter(
                        &mut g.files,
                        &g.table,
                        &mut g.reads,
                        &mut g.domain,
                        &mut g.execution,
                        g.invocation,
                        nr,
                        plain,
                        100
                    ),
                    Ok(Step::Unsupported(nr))
                );
                for flags in [1, 2, 0x40, 0x200000, 0x800] {
                    let args = if nr == 2 {
                        [0, flags, u64::MAX, 0, 0, 0]
                    } else {
                        [(-100i64) as u64, 0, flags, u64::MAX, 0, 0]
                    };
                    assert_eq!(g.enter(nr, args), Ok(Step::Unsupported(nr)));
                }
                // Selected Tree has no device/FIFO constructor; exercise the
                // final unsupported-kind mapper directly, without a test hook.
                assert_eq!(
                    open_error(nr, OpenError::Unsupported),
                    Ok(Step::Unsupported(nr))
                );
            }
            assert!(g.call.path_input.is_empty());
            assert!(g.call.opening.is_none());
            assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        }

        #[test]
        fn open2_nofollow_and_directory_options_use_the_existing_terminal_rules() {
            let mut g = tree_guest();
            for (path, flags, result) in [
                (&b"/link"[..], 0x20000, -40),
                (&b"/link"[..], 0x20000 | 0x10000, -20),
                (&b"/program"[..], 0x10000, -20),
                (&b"/dirlink"[..], 0x20000, -40),
                (&b"/dirlink"[..], 0x20000 | 0x10000, -20),
            ] {
                assert_eq!(open(&mut g, path, flags), result);
            }
            let direct = open(&mut g, b"/work", 0x10000) as u32;
            let trailing = open(&mut g, b"/dirlink/", 0x20000 | 0x10000) as u32;
            assert_eq!(g.files.fd_kind(&g.table, direct), Ok(0o040000));
            assert_eq!(
                g.files.inode(&g.table, direct),
                g.files.inode(&g.table, trailing)
            );
        }

        #[test]
        fn open2_pending_capture_pins_cwd_and_reuses_canonical_ofds_not_fd_numbers() {
            let mut g = tree_guest();
            let token = admit(&mut g, 16, 0, false);
            // Mutate the live cwd after admission but before opening the core
            // view. Real ABI allocation guards remain intact during that view.
            g.files
                .select_cwd(&g.fs, &Credentials::initial_root(), b"/work")
                .unwrap();
            g.capture(token, b"program\0");
            assert_eq!(
                g.finish(token, 8, PathOutcome::Captured),
                Ok(Step::Return(0))
            );
            let relative = open(&mut g, b"program", 0) as u32;
            let absolute = open(&mut g, b"/program", 0) as u32;
            assert_ne!(
                g.files.inode(&g.table, 0),
                g.files.inode(&g.table, relative)
            );
            assert_eq!(
                g.files.inode(&g.table, 0),
                g.files.inode(&g.table, absolute)
            );
            assert_eq!(read_bytes(&mut g, 0, 2), b"ab");
            assert_eq!(read_bytes(&mut g, relative, 2), b"wx");
            assert_eq!(g.files.offset(&g.table, absolute), Ok((0, 0)));
            assert_eq!(g.enter(3, [0; 6]), Ok(Step::Return(0)));
            assert_eq!(open(&mut g, b"/program", 0), 0);
            assert_eq!(g.files.offset(&g.table, 0), Ok((0, 0)));
            assert_eq!(g.files.offset(&g.table, relative), Ok((2, 1)));
        }

        #[test]
        fn open2_path_pointer_empty_and_nul_limits_are_shared_with_openat() {
            let mut g = Guest::new(1);
            for address in [0, 8192, u64::MAX] {
                assert_eq!(
                    g.enter(2, [address, 0, u64::MAX, 0, 0, 0]),
                    Ok(Step::Return(-14))
                );
            }
            assert!(g.call.path_input.is_empty());
            let token = admit(&mut g, 8191, 0, false);
            g.capture(token, b"\0");
            assert_eq!(
                g.finish(token, 1, PathOutcome::Captured),
                Ok(Step::Return(-2))
            );
            let token = admit(&mut g, 8183, 0, false);
            g.capture(token, b"/program\0");
            assert_eq!(
                g.finish(token, 9, PathOutcome::Captured),
                Ok(Step::Return(0))
            );
            let token = admit(&mut g, 8191, 0, false);
            g.capture(token, b"x");
            assert_eq!(
                g.finish(token, 1, PathOutcome::Captured),
                Ok(Step::Return(-14))
            );
            let token = admit(&mut g, 16, 0, false);
            g.capture(token, &[b'x'; 4096]);
            assert_eq!(
                g.finish(token, 4096, PathOutcome::Captured),
                Ok(Step::Return(-36))
            );
        }

        #[test]
        fn open2_unknown_late_capture_publishes_once_or_not_at_all_after_cancellation() {
            let mut g = Guest::new(1);
            let token = admit(&mut g, 16, 0, false);
            g.capture(token, b"/program\0");
            assert_eq!(g.finish(token, 4, PathOutcome::Unknown), Ok(Step::Waiting));
            assert_eq!(g.call.path_view(), None);
            assert!(g
                .call
                .path_start(&mut g.domain, &g.execution, token)
                .is_err());
            assert!(g.finish(token, 3, PathOutcome::Unknown).is_err());
            assert_eq!(
                g.finish(token, 9, PathOutcome::Captured),
                Ok(Step::Return(0))
            );
            assert_eq!(g.finish(token, 9, PathOutcome::Captured), Err(Error::State));
            assert_eq!(g.files.target(&g.table, 1), Err(descriptor::Error::BadFd));

            let token = admit(&mut g, 16, 0, false);
            g.capture(token, b"/program\0");
            assert_eq!(g.finish(token, 9, PathOutcome::Unknown), Ok(Step::Waiting));
            assert!(!g
                .call
                .abandon(&mut g.files, &mut g.reads, &mut g.domain, &mut g.execution)
                .unwrap());
            g.execution
                .receipt(&mut g.domain, g.invocation, Unwind::Fault)
                .unwrap();
            assert_eq!(g.finish(token, 9, PathOutcome::Captured), Ok(Step::Waiting));
            assert_eq!(g.files.target(&g.table, 1), Err(descriptor::Error::BadFd));
            assert!(g.domain.change(g.execution.binding(), 8192).is_ok());
        }
    }
}

#[cfg(all(test, not(feature = "capture-v1")))]
mod sendfile_continuation_tests {
    // SYNTHETIC capability/access receipts only. These are Continuation owner
    // probes, not native endpoint, Wasm global guard, Worker or syscall40 proof.
    use super::*;
    use crate::descriptor::{Limits, LoadRequest};
    use crate::execution::{ImageResult, Unwind};
    use crate::inode::{Creation, Inode, Tree};
    use crate::read::ReadCapacity;
    use crate::sendfile::{AccessEvidence as Access, Outcome, Phase as SendPhase};

    fn creation(mode: u32) -> Creation {
        Creation {
            mode,
            uid: 0,
            gid: 0,
        }
    }
    struct Guest {
        files: Files,
        table: Table,
        reads: Reads,
        domain: Domain,
        execution: Execution,
        call: Continuation,
        invocation: Invocation,
        fd: u32,
        other: Inode,
    }
    impl Guest {
        fn new(lazy: bool) -> Self {
            let mut tree = Tree::new(71, 8, 8, 64, creation(0o755)).unwrap();
            let inode = if lazy {
                tree.lazy_file(tree.root(), b"a", creation(0o444), 7, 0)
                    .unwrap()
            } else {
                tree.file_take(tree.root(), b"a", creation(0o444), &mut b"abcdef".to_vec())
                    .unwrap()
            };
            let other = tree
                .file_take(tree.root(), b"b", creation(0o444), &mut b"xyz".to_vec())
                .unwrap();
            let mut files = Files::new(
                72,
                tree,
                Limits {
                    contexts: 0,
                    tables: 2,
                    descriptions: 8,
                    slots: 16,
                },
            );
            let table = files.stdio([10, 20, 30], 16).unwrap();
            let fd = files.open(&table, inode, false).unwrap();
            let reads = Reads::new(&files, ReadCapacity::new(4).unwrap());
            let mut domain = Domain::new(73, 2, 8).unwrap();
            let binding = domain.bind(1).unwrap();
            let mut execution = Execution::new(74, binding);
            execution.image_begin(&mut domain, 1).unwrap();
            execution
                .image_finish(&mut domain, ImageResult::Installed)
                .unwrap();
            let call = Continuation::new(&execution).unwrap();
            let invocation = execution.start(&mut domain).unwrap();
            Self {
                files,
                table,
                reads,
                domain,
                execution,
                call,
                invocation,
                fd,
                other,
            }
        }
        fn request(&mut self, sequence: u32, nr: u64, args: [u64; 6]) -> Result<Step, Error> {
            self.call.enter_sequenced(
                &mut self.files,
                &self.table,
                None,
                &mut self.reads,
                &mut self.domain,
                &mut self.execution,
                self.invocation,
                sequence,
                nr,
                args,
                100,
            )
        }
        fn admit(&mut self, count: u64) -> Token {
            match self
                .request(1, 40, [1, self.fd as u64, 0, count, 0x55, 0x66])
                .unwrap()
            {
                Step::SendfileCapability {
                    action,
                    sequence: 1,
                    endpoint: 20,
                } => action,
                other => panic!("unexpected step {other:?}"),
            }
        }
        fn cap_start(&mut self, action: Token) -> Result<u64, Error> {
            self.call.sendfile_cap_start(
                &mut self.files,
                &mut self.domain,
                &mut self.execution,
                1,
                action,
            )
        }
        fn cap(&mut self, action: Token) -> Step {
            assert_eq!(self.cap_start(action).unwrap(), 20);
            self.call
                .sendfile_cap_finish_synthetic(
                    &mut self.files,
                    &mut self.domain,
                    &mut self.execution,
                    1,
                    action,
                    20,
                )
                .unwrap()
        }
        fn load_start(&mut self, action: Token) -> LoadRequest {
            self.call
                .sendfile_load_start(
                    &mut self.files,
                    &mut self.domain,
                    &mut self.execution,
                    1,
                    action,
                )
                .unwrap()
        }
        fn load_finish(
            &mut self,
            action: Token,
            load: LoadRequest,
            bytes: &mut Vec<u8>,
        ) -> Result<Step, Error> {
            self.call.sendfile_load_finish(
                &mut self.files,
                &mut self.domain,
                &mut self.execution,
                1,
                action,
                load,
                true,
                bytes,
            )
        }
        fn start(&mut self, action: Token) -> (usize, u64) {
            self.call
                .sendfile_start(
                    &mut self.files,
                    &mut self.domain,
                    &mut self.execution,
                    1,
                    action,
                )
                .unwrap()
        }
        fn receipt(
            &mut self,
            action: Token,
            n: u64,
            outcome: Outcome,
            access: Access,
        ) -> Result<Step, Error> {
            self.call.sendfile_receipt(
                &mut self.files,
                &mut self.domain,
                &mut self.execution,
                1,
                action,
                n,
                outcome,
                access,
            )
        }
        fn abandon(&mut self) -> bool {
            self.call
                .abandon(
                    &mut self.files,
                    &mut self.reads,
                    &mut self.domain,
                    &mut self.execution,
                )
                .unwrap()
        }
        fn status(&self) -> SendfileStatus {
            self.call.sendfile_query(&self.execution).unwrap().unwrap()
        }
    }
    #[test]
    fn sequenced_only_typed_rollback_and_common_sequence_consumption() {
        let mut g = Guest::new(true);
        assert_eq!(
            g.call.enter(
                &mut g.files,
                &g.table,
                &mut g.reads,
                &mut g.domain,
                &mut g.execution,
                g.invocation,
                40,
                [1, g.fd as u64, 0, 6, 0, 0],
                100
            ),
            Ok(Step::Unsupported(40))
        );
        assert!(!g.call.sendfile_pending());
        for sequence in [0, 2, i32::MAX as u32 + 1] {
            assert!(g
                .request(sequence, 40, [1, g.fd as u64, 0, 6, 0, 0])
                .is_err());
            assert_eq!(g.call.last_sequence, 0);
        }
        assert_eq!(
            g.request(1, 40, [1, g.fd as u64, 8, 6, 0, 0]),
            Ok(Step::Unsupported(40))
        );
        assert_eq!(g.call.last_sequence, 1);
        assert!(g.request(1, 40, [1, g.fd as u64, 0, 6, 0, 0]).is_err());
        assert_eq!(g.request(2, 40, [1, 99, 0, 6, 0, 0]), Ok(Step::Return(-9)));
        assert!(!g.call.closed);
        assert!(!g.call.sendfile_pending());
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        assert_eq!(
            g.request(3, 40, [0, g.fd as u64, 0, 6, 0, 0]),
            Ok(Step::Return(-9))
        );
        assert_eq!(
            g.request(4, 40, [1, 0, 0, 6, 0, 0]),
            Ok(Step::Unsupported(40))
        );
        let args = [
            (99u64 << 32) | 1,
            (88u64 << 32) | g.fd as u64,
            0,
            u64::MAX,
            0x55,
            0x66,
        ];
        let Step::SendfileCapability {
            action,
            sequence: 5,
            endpoint: 20,
        } = g.request(5, 40, args).unwrap()
        else {
            panic!()
        };
        assert!(g.call.owns(action));
        assert!(g.call.sendfile_references(&g.execution));
        assert_eq!(g.call.sendfile_view(), None);
        assert_eq!(
            g.call.sendfile().unwrap().owner.arguments(),
            Some(args)
        );
        assert!(g.execution.hold_call(g.invocation).is_err()); // No second parent hold.
        assert!(g.request(6, 3, [g.fd as u64, 0, 0, 0, 0, 0]).is_err());
        assert_eq!(g.call.last_sequence, 5); // Busy request didn't consume next sequence.
        assert!(g.abandon());
        assert!(!g.call.sendfile_pending());
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
    }
    #[test]
    fn negative_capability_is_opaque_one_shot_and_precedes_any_source_attempt() {
        let mut g = Guest::new(true);
        let action = g.admit(6);
        assert_eq!(g.cap_start(action), Ok(20));
        assert!(g.call.sendfile().unwrap().cap_request.is_some());
        assert!(g.cap_start(action).is_err());
        for (seq, endpoint) in [(2, 20), (1, 21)] {
            assert!(g
                .call
                .sendfile_cap_finish_rejected(
                    &mut g.files,
                    &mut g.domain,
                    &mut g.execution,
                    seq,
                    action,
                    endpoint
                )
                .is_err());
            assert!(g.call.sendfile().unwrap().cap_request.is_some());
            assert_eq!(g.status().phase, SendPhase::CapChecking);
        }
        assert_eq!(
            g.call.sendfile_cap_finish_rejected(
                &mut g.files,
                &mut g.domain,
                &mut g.execution,
                1,
                action,
                20
            ),
            Ok(Step::Unsupported(40))
        );
        assert!(g.call.closed);
        assert!(!g.call.sendfile_pending());
        assert!(!g.call.owns(action));
        assert!(!g.call.sendfile_references(&g.execution));
        assert!(g
            .call
            .sendfile_cap_finish_rejected(
                &mut g.files,
                &mut g.domain,
                &mut g.execution,
                1,
                action,
                20
            )
            .is_err());
        assert!(g.request(2, 40, [1, g.fd as u64, 0, 6, 0, 0]).is_err());
        let mut prep = g.files.begin_read(&g.table, g.fd, 6).unwrap();
        let load = g.files.prepare_read(&mut prep).unwrap().unwrap();
        assert_eq!(load.attempt, 1);
        g.files
            .finish_load(&mut prep, load.attempt, false, &mut Vec::new())
            .unwrap();
        g.files.abort_preparation(prep).unwrap();
    }
    #[test]
    fn ready_cancel_and_dispatched_cap_cancel_have_distinct_ticket_lifetimes() {
        for dispatched in [false, true] {
            let mut g = Guest::new(true);
            let action = g.admit(6);
            if dispatched {
                g.cap_start(action).unwrap();
            }
            assert_eq!(g.abandon(), !dispatched);
            assert!(g.call.closed);
            if dispatched {
                assert!(g.call.sendfile_pending());
                assert!(g.call.owns(action));
                assert!(g.call.sendfile().unwrap().cap_request.is_some());
                assert!(g.execution.syscall_allowed(g.invocation).is_err());
                assert_eq!(
                    g.call.sendfile_cap_finish_synthetic(
                        &mut g.files,
                        &mut g.domain,
                        &mut g.execution,
                        1,
                        action,
                        20
                    ),
                    Ok(Step::Waiting)
                );
            }
            assert!(!g.call.sendfile_pending());
            assert!(g.execution.syscall_allowed(g.invocation).is_ok());
            assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (0, 0));
            let mut prep = g.files.begin_read(&g.table, g.fd, 1).unwrap();
            let load = g.files.prepare_read(&mut prep).unwrap().unwrap();
            assert_eq!(load.attempt, 1);
            g.files
                .finish_load(&mut prep, load.attempt, false, &mut Vec::new())
                .unwrap();
            g.files.abort_preparation(prep).unwrap();
        }
    }
    #[test]
    fn synthetic_loader_pending_both_fd_reuse_then_short_result_uses_sole_call_owner() {
        let mut g = Guest::new(true);
        let alias = g.files.dup(&g.table, g.fd, 0, false).unwrap();
        let action = g.admit(u64::MAX);
        assert_eq!(
            g.cap(action),
            Step::SendfileLoad {
                action,
                sequence: 1
            }
        );
        let load = g.load_start(action);
        g.files.close(&g.table, 1).unwrap();
        g.files.close(&g.table, g.fd).unwrap();
        assert_eq!(g.files.open(&g.table, g.other, false).unwrap(), 1);
        assert_eq!(g.files.open(&g.table, g.other, false).unwrap(), g.fd);
        let mut bytes = b"abcdef".to_vec();
        for wrong in [
            LoadRequest { source: 8, ..load },
            LoadRequest {
                attempt: load.attempt + 1,
                ..load
            },
        ] {
            assert!(g.load_finish(action, wrong, &mut bytes).is_err());
            assert_eq!(bytes, b"abcdef");
            assert_eq!(g.status().phase, SendPhase::Loading);
        }
        assert_eq!(
            g.load_finish(action, load, &mut bytes),
            Ok(Step::SendfileOffer {
                action,
                sequence: 1,
                endpoint: 20,
                length: 6
            })
        );
        assert!(bytes.is_empty());
        let mut duplicate = b"duplicate".to_vec();
        assert!(g.load_finish(action, load, &mut duplicate).is_err());
        assert_eq!(duplicate, b"duplicate");
        let (pointer, length) = g.start(action);
        assert_eq!(length, 6);
        assert_eq!(
            unsafe { std::slice::from_raw_parts(pointer as *const u8, length as usize) },
            b"abcdef"
        );
        assert_eq!(g.call.sendfile_view(), Some((1, action)));
        assert_eq!(
            g.receipt(action, 3, Outcome::Transferred, Access::Ended),
            Ok(Step::Return(3))
        );
        assert!(!g.call.sendfile_pending());
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        assert_eq!(g.files.offset(&g.table, alias).unwrap(), (3, 1));
        assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (0, 0));
        assert_eq!(g.files.offset(&g.table, 1).unwrap(), (0, 0));
        assert!(g
            .receipt(action, 4, Outcome::Transferred, Access::Ended)
            .is_err());
        assert_eq!(g.files.offset(&g.table, alias).unwrap(), (3, 1));
        assert!(!g.call.closed);
    }
    #[test]
    fn synthetic_loader_cancel_before_dispatch_settles_attempt_and_after_dispatch_rejects_bytes() {
        for dispatched in [false, true] {
            let mut g = Guest::new(true);
            let action = g.admit(6);
            g.cap(action);
            let load = if dispatched {
                Some(g.load_start(action))
            } else {
                None
            };
            assert_eq!(g.abandon(), !dispatched);
            if let Some(load) = load {
                assert_eq!(g.status().phase, SendPhase::Loading);
                assert!(g.call.owns(action));
                assert_eq!(
                    g.files.set_offset(&g.table, g.fd, 0),
                    Err(descriptor::Error::Busy)
                );
                let mut bytes = b"abcdef".to_vec();
                assert_eq!(g.load_finish(action, load, &mut bytes), Ok(Step::Waiting));
                assert_eq!(bytes, b"abcdef");
            }
            assert!(!g.call.sendfile_pending());
            assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (0, 0));
            let mut prep = g.files.begin_read(&g.table, g.fd, 1).unwrap();
            let next = g.files.prepare_read(&mut prep).unwrap().unwrap();
            assert_eq!(next.attempt, 2);
            g.files
                .finish_load(&mut prep, next.attempt, false, &mut Vec::new())
                .unwrap();
            g.files.abort_preparation(prep).unwrap();
        }
    }
    #[test]
    fn synthetic_combined_receipt_preflights_before_guard_and_keeps_unknown_closed() {
        let mut g = Guest::new(false);
        let action = g.admit(20);
        g.cap(action);
        g.start(action);
        for (count, outcome, access) in [
            (7, Outcome::Unknown, Access::Ended),
            (1, Outcome::Again, Access::Ended),
            (2, Outcome::Transferred, Access::NotEnded),
        ] {
            assert!(g.receipt(action, count, outcome, access).is_err());
            assert_eq!(g.call.sendfile_view(), Some((1, action)));
            assert_eq!(g.status().confirmed, 0);
        }
        assert_eq!(
            g.receipt(action, 2, Outcome::Unknown, Access::NotEnded),
            Ok(Step::Waiting)
        );
        assert!(g.call.closed);
        assert_eq!(g.call.sendfile_view(), Some((1, action)));
        assert!(g
            .receipt(action, 1, Outcome::Unknown, Access::Ended)
            .is_err());
        assert_eq!(g.call.sendfile_view(), Some((1, action)));
        assert_eq!(
            g.receipt(action, 3, Outcome::Unknown, Access::Ended),
            Ok(Step::Waiting)
        );
        assert_eq!(g.call.sendfile_view(), None);
        assert!(g.call.owns(action));
        assert!(g.call.sendfile_references(&g.execution));
        assert!(g.call.sendfile_pending());
        assert_eq!(g.domain.retire(action), Err(lease::Error::Incomplete));
        assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (0, 0));
        assert!(g
            .call
            .sendfile_start(&mut g.files, &mut g.domain, &mut g.execution, 1, action)
            .is_err());
        assert_eq!(
            g.receipt(action, 4, Outcome::Transferred, Access::Ended),
            Ok(Step::Waiting)
        );
        assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (4, 1));
        assert!(!g.call.sendfile_pending());
        assert!(!g.call.owns(action));
        assert_eq!(g.call.sendfile_query(&g.execution), Ok(None));
        assert!(g.request(2, 3, [g.fd as u64, 0, 0, 0, 0, 0]).is_err());
        assert_eq!(g.call.last_sequence, 1);
    }
    #[test]
    fn synthetic_fault_or_cancel_after_start_never_releases_before_late_prefix_or_returns_to_guest()
    {
        for fault in [false, true] {
            let mut g = Guest::new(false);
            let action = g.admit(6);
            g.cap(action);
            g.start(action);
            if fault {
                g.execution
                    .receipt(&mut g.domain, g.invocation, Unwind::Fault)
                    .unwrap();
            }
            assert!(!g.abandon());
            assert!(g.call.sendfile_references(&g.execution));
            assert_eq!(g.call.sendfile_view(), Some((1, action)));
            assert!(g.execution.hold_call(g.invocation).is_err());
            assert_eq!(
                g.receipt(action, 2, Outcome::Transferred, Access::Ended),
                Ok(Step::Waiting)
            );
            assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (2, 1));
            assert!(!g.call.sendfile_pending());
            if fault {
                assert!(g.execution.retireable());
            } else {
                assert!(g.execution.syscall_allowed(g.invocation).is_ok());
            }
        }
    }
    #[test]
    fn finite_domain_failure_rolls_back_but_closes_instead_of_fabricating_errno() {
        let mut g = Guest::new(true);
        let mut occupied = Vec::new();
        for _ in 0..8 {
            occupied.push(g.domain.effect(g.execution.binding(), 0).unwrap());
        }
        assert_eq!(
            g.request(1, 40, [1, g.fd as u64, 0, 6, 0, 0]),
            Err(Error::Sendfile(sendfile::Error::Lease(
                lease::Error::Capacity
            )))
        );
        assert!(g.call.closed);
        assert!(!g.call.sendfile_pending());
        assert_eq!(g.call.last_sequence, 1);
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        g.files.set_offset(&g.table, g.fd, 0).unwrap();
        assert!(g.request(2, 40, [1, g.fd as u64, 0, 6, 0, 0]).is_err());
        for action in occupied {
            g.domain.cancel(action).unwrap();
            g.domain.retire(action).unwrap();
        }
    }
    #[test]
    fn synthetic_closing_retry_after_committed_source_never_double_finishes_call_or_exposes_return()
    {
        let mut g = Guest::new(false);
        let action = g.admit(6);
        g.cap(action);
        g.start(action);
        // Internal sole-owner contract violation, injected only to test retained
        // cleanup recovery. Generic production callers must never steal this.
        g.execution.finish_call(g.invocation).unwrap();
        assert!(g
            .receipt(action, 3, Outcome::Transferred, Access::Ended)
            .is_err());
        assert!(g.call.closed);
        assert_eq!(g.status().phase, SendPhase::Closing);
        assert!(!g.status().finished);
        assert_eq!(g.status().action, None);
        assert!(g.call.sendfile_references(&g.execution));
        assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (3, 1));
        assert_eq!(g.call.sendfile_view(), None);
        g.execution.hold_call(g.invocation).unwrap();
        assert!(g
            .call
            .sendfile_cleanup_retry(&mut g.files, &mut g.domain, &mut g.execution, 2)
            .is_err());
        assert_eq!(
            g.call
                .sendfile_cleanup_retry(&mut g.files, &mut g.domain, &mut g.execution, 1),
            Ok(Step::Waiting)
        );
        assert!(!g.call.sendfile_pending());
        assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (3, 1));
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
    }
    #[test]
    fn synthetic_zero_does_not_load_and_all_physical_errors_close_without_errno() {
        let mut g = Guest::new(true);
        let action = g.admit(0);
        assert_eq!(
            g.cap(action),
            Step::SendfileOffer {
                action,
                sequence: 1,
                endpoint: 20,
                length: 0
            }
        );
        assert_eq!(g.start(action), (0, 0));
        assert_eq!(
            g.receipt(action, 0, Outcome::Transferred, Access::Ended),
            Ok(Step::Return(0))
        );
        for outcome in [
            Outcome::Again,
            Outcome::Interrupted,
            Outcome::Io,
            Outcome::BadFd,
            Outcome::BrokenPipe,
            Outcome::PreparationFailed,
        ] {
            let mut g = Guest::new(false);
            let action = g.admit(6);
            g.cap(action);
            g.start(action);
            assert_eq!(
                g.receipt(action, 0, outcome, Access::Ended),
                Ok(Step::Waiting)
            );
            assert!(g.call.closed);
            assert!(!g.call.sendfile_pending());
            assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (0, 1));
        }
    }

    #[test]
    fn typed_capacity_mapping_is_narrow_and_not_domain_or_busy_errno() {
        // Direct typed-error classifier probe: current begin only increments
        // existing description refs, so no false Files-capacity failure is
        // manufactured from the independently tested finite Domain arena.
        assert_eq!(
            sendfile_admission_error(sendfile::Error::Files(descriptor::Error::Capacity)),
            Ok(Step::Return(-12))
        );
        for error in [
            sendfile::Error::Files(descriptor::Error::Busy),
            sendfile::Error::Files(descriptor::Error::BadHandle),
            sendfile::Error::Lease(lease::Error::Capacity),
            sendfile::Error::Execution(execution::Error::Identity),
        ] {
            assert!(sendfile_admission_error(error).is_err());
        }
    }
    #[test]
    fn synthetic_valid_foreign_continuation_cannot_misdeliver_a_late_receipt_to_live_view() {
        let mut g = Guest::new(false);
        let action_a = g.admit(6);
        g.cap(action_a);
        let inode = g.files.inode(&g.table, g.fd).unwrap();
        let fd_b = g.files.open(&g.table, inode, false).unwrap();
        let binding_b = g.domain.bind(1).unwrap();
        let mut execution_b = Execution::new(99, binding_b);
        execution_b.image_begin(&mut g.domain, 1).unwrap();
        execution_b
            .image_finish(&mut g.domain, ImageResult::Installed)
            .unwrap();
        let mut call_b = Continuation::new(&execution_b).unwrap();
        let invocation_b = execution_b.start(&mut g.domain).unwrap();
        let Step::SendfileCapability {
            action: action_b, ..
        } = call_b
            .enter_sequenced(
                &mut g.files,
                &g.table,
                None,
                &mut g.reads,
                &mut g.domain,
                &mut execution_b,
                invocation_b,
                1,
                40,
                [1, fd_b as u64, 0, 6, 0, 0],
                100,
            )
            .unwrap()
        else {
            panic!()
        };
        assert_ne!(action_a, action_b);
        call_b
            .sendfile_cap_start(&mut g.files, &mut g.domain, &mut execution_b, 1, action_b)
            .unwrap();
        call_b
            .sendfile_cap_finish_synthetic(
                &mut g.files,
                &mut g.domain,
                &mut execution_b,
                1,
                action_b,
                20,
            )
            .unwrap();
        call_b
            .sendfile_start(&mut g.files, &mut g.domain, &mut execution_b, 1, action_b)
            .unwrap();
        call_b
            .sendfile_receipt(
                &mut g.files,
                &mut g.domain,
                &mut execution_b,
                1,
                action_b,
                0,
                Outcome::Unknown,
                Access::Ended,
            )
            .unwrap();
        // Both owners/tokens are real admitted values. B could validly accept
        // late Stopped; synthetic access-ended evidence ends B's view FIRST.
        // This tests misdelivery, NOT the not-yet-connected global ABI guard.
        assert_eq!(call_b.sendfile_view(), None);
        g.start(action_a);
        assert!(g
            .call
            .sendfile_receipt(
                &mut g.files,
                &mut g.domain,
                &mut g.execution,
                1,
                action_b,
                2,
                Outcome::Transferred,
                Access::Ended
            )
            .is_err());
        assert!(g
            .call
            .sendfile_receipt(
                &mut g.files,
                &mut g.domain,
                &mut execution_b,
                1,
                action_a,
                2,
                Outcome::Transferred,
                Access::Ended
            )
            .is_err());
        assert_eq!(g.call.sendfile_view(), Some((1, action_a)));
        assert!(g.call.owns(action_a));
        assert!(call_b.owns(action_b));
        assert_eq!(g.status().confirmed, 0);
        assert_eq!(
            call_b
                .sendfile_query(&execution_b)
                .unwrap()
                .unwrap()
                .confirmed,
            0
        );
        assert_eq!(
            g.receipt(action_a, 3, Outcome::Transferred, Access::Ended),
            Ok(Step::Return(3))
        );
        assert_eq!(
            call_b.sendfile_receipt(
                &mut g.files,
                &mut g.domain,
                &mut execution_b,
                1,
                action_b,
                2,
                Outcome::Transferred,
                Access::Ended
            ),
            Ok(Step::Waiting)
        );
        assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (3, 1));
        assert_eq!(g.files.offset(&g.table, fd_b).unwrap(), (2, 1));
    }
    #[test]
    fn synthetic_combined_unknown_domain_failure_does_not_clear_view_or_advance_prefix() {
        let mut g = Guest::new(false);
        let action = g.admit(6);
        g.cap(action);
        g.start(action);
        // Synthetic internal owner-contract violation to force Domain receipt
        // failure AFTER component preflight. Generic ABI must prohibit this.
        g.domain.receipt(action, 0, Completion::Stopped).unwrap();
        assert!(g
            .receipt(action, 2, Outcome::Unknown, Access::Ended)
            .is_err());
        assert_eq!(g.call.sendfile_view(), Some((1, action)));
        assert_eq!(g.status().confirmed, 0);
        assert_eq!(g.files.offset(&g.table, g.fd).unwrap(), (0, 0));
        assert!(g.call.owns(action));
        // Retain quarantined owner to fixture end; no fabricated recovery or
        // inference that this mismatch stopped source-buffer access.
    }

    #[test]
    fn synthetic_nonempty_stopped_zero_closes_without_guest_resume_but_settles_real_zero_effect() {
        let mut g = Guest::new(false);
        let alias = g.files.dup(&g.table, g.fd, 0, false).unwrap();
        let action = g.admit(6);
        g.cap(action);
        g.start(action);
        assert_eq!(g.status().offered, 6);
        assert_eq!(
            g.files.set_offset(&g.table, alias, 0),
            Err(descriptor::Error::Busy)
        );
        assert_eq!(
            g.receipt(action, 0, Outcome::Transferred, Access::Ended),
            Ok(Step::Waiting)
        );
        assert!(g.call.closed);
        assert!(!g.call.sendfile_pending());
        assert!(!g.call.sendfile_references(&g.execution));
        assert_eq!(g.call.sendfile_view(), None);
        assert!(!g.call.owns(action));
        assert_eq!(g.call.sendfile_query(&g.execution), Ok(None));
        assert_eq!(g.files.offset(&g.table, alias).unwrap(), (0, 1));
        assert_eq!(g.domain.retire(action), Err(lease::Error::UnknownAction));
        assert_eq!(g.domain.start(action), Err(lease::Error::UnknownAction));
        assert_eq!(
            g.domain.receipt(action, 0, Completion::Stopped),
            Err(lease::Error::UnknownAction)
        );
        assert!(g
            .receipt(action, 0, Outcome::Transferred, Access::Ended)
            .is_err());
        assert!(g
            .call
            .sendfile_start(&mut g.files, &mut g.domain, &mut g.execution, 1, action)
            .is_err());
        assert_eq!(g.files.offset(&g.table, alias).unwrap(), (0, 1));
        let prep = g.files.begin_read(&g.table, alias, 1).unwrap();
        g.files.abort_preparation(prep).unwrap();
        // No artificial pending-call Busy keeps this safe: the call really was
        // finished. The closed Continuation itself refuses a new guest call.
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        assert_eq!(
            g.request(2, 40, [1, g.fd as u64, 0, 6, 0, 0]),
            Err(Error::State)
        );
        assert_eq!(g.call.last_sequence, 1);
        g.execution
            .receipt(&mut g.domain, g.invocation, Unwind::Fault)
            .unwrap();
        assert!(g.execution.retireable());
        assert!(g.abandon());
        let change = g.domain.change(g.execution.binding(), 1).unwrap();
        g.domain.cancel(change).unwrap();
        g.domain.retire(change).unwrap();
    }
    #[test]
    fn synthetic_qualified_empty_offers_and_positive_prefix_keep_their_success_results() {
        for (count, offset, offered, prefix, expected) in [
            (0, 0, 0, 0, Step::Return(0)),
            (6, 6, 0, 0, Step::Return(0)), // Actual resident EOF, not provisional metadata.
            (6, 0, 6, 3, Step::Return(3)),
        ] {
            let mut g = Guest::new(false);
            if offset != 0 {
                g.files.set_offset(&g.table, g.fd, offset).unwrap();
            }
            let action = g.admit(count);
            assert_eq!(
                g.cap(action),
                Step::SendfileOffer {
                    action,
                    sequence: 1,
                    endpoint: 20,
                    length: offered
                }
            );
            assert_eq!(g.start(action).1, offered);
            assert_eq!(
                g.receipt(action, prefix, Outcome::Transferred, Access::Ended),
                Ok(expected)
            );
            assert!(!g.call.closed);
            assert!(!g.call.sendfile_pending());
            assert!(g.execution.syscall_allowed(g.invocation).is_ok());
            assert_eq!(g.files.offset(&g.table, g.fd).unwrap().0, offset + prefix);
        }
    }
}
