//! Private wasm32 ABI7, one managed domain per instance. The read-only caller
//! is a limited fixed-memory profile, not the full Linux runtime.
//! Prepared resident Tree is sealed once into Files; no source mutation afterward.
//! The host reads result fields before making a fresh core view. Between read_start
//! and read_receipt it performs only intrinsic synchronous copy, no callback/await.
use crate::descriptor::{self, Files, Table};
use crate::effect::{Completion, Token};
use crate::execution::{Execution, ImageResult, Unwind};
use crate::inode::{Inode, Tree};
use crate::lease::{Domain, Error};
use crate::prepared_root::{Limits as RootLimits, RootCatalog, RootImage};
use crate::read::{ReadCapacity, Reads};
use crate::syscall::{Continuation, PathOutcome, PhysicalResult, RegisterOutcome, Step};
use crate::{
    credentials::Credentials,
    fs_context, mount,
    startup::{Facts, Startup},
};
use std::cell::RefCell;
#[cfg(feature = "capture-v1")]
mod capture_candidate;
#[cfg(feature = "queued-worker-probe")]
mod capture_receiver;
#[cfg(feature = "queued-worker-probe")]
mod capture_worker;
#[cfg(feature = "queued-worker-probe")]
pub(crate) use capture_worker::FinishEvidence;
const DOMAIN: u64 = 1;
const TREE: u64 = 2;
const FILES: u64 = 3;
const WASM32_BYTES: u64 = 1u64 << 32;
struct Builder {
    tree: Option<Tree>,
    sealing: Option<Files>,
    limits: descriptor::Limits,
    capacity: Option<ReadCapacity>,
    file_limit: usize,
    profile: Option<Profile>,
    root_view: Option<mount::Ticket>,
    name: Vec<u8>,
    input: Vec<u8>,
}
struct Sealed {
    files: Files,
    #[cfg(feature = "queued-output-probe")]
    queue_probe: Option<descriptor::QueueProbe>,
    table: Option<Table>,
    root: Option<mount::Place>,
    root_view: Option<mount::Ticket>,
    fd_limit: u32,
    reads: Reads,
    input: Vec<u8>,
    file_limit: usize,
}
enum Resources {
    MemoryOnly,
    Diagnostic(Table),
    Normal {
        table: Option<Table>,
        fs: Option<fs_context::Ticket>,
        executable: Option<descriptor::Executable>,
        decision: crate::credentials::Decision,
        facts: Facts,
    },
    Retired,
}
impl Resources {
    fn table(&self) -> Result<&Table, i32> {
        match self {
            Self::Diagnostic(table) => Ok(table),
            Self::Normal {
                table: Some(table), ..
            } => Ok(table),
            _ => Err(-11),
        }
    }
}
struct ExecutionSlot {
    normal: bool,
    resources: Resources,
    execution: Execution,
    continuation: Option<Continuation>,
}
struct Profile {
    views: usize,
    holds: usize,
    policy: mount::ViewPolicy,
}
struct Preparing {
    startup: Option<Startup>,
    program: Option<descriptor::Program>,
    failed_image: Option<Execution>,
    fs: Option<fs_context::Ticket>,
    table: Option<Table>,
    random: [u8; 16],
}
enum Slot {
    Preparing(Preparing),
    Live(ExecutionSlot),
    Retired(Option<Execution>),
}
impl Slot {
    fn live(&self) -> Result<&ExecutionSlot, i32> {
        match self {
            Self::Live(v) => Ok(v),
            _ => Err(-11),
        }
    }
    fn live_mut(&mut self) -> Result<&mut ExecutionSlot, i32> {
        match self {
            Self::Live(v) => Ok(v),
            _ => Err(-11),
        }
    }
    fn preparing_mut(&mut self) -> Result<&mut Preparing, i32> {
        match self {
            Self::Preparing(v) => Ok(v),
            _ => Err(-11),
        }
    }
    fn binding(&self) -> Option<u64> {
        match self {
            Self::Preparing(p) => p
                .startup
                .as_ref()
                .and_then(|v| v.binding())
                .or_else(|| p.failed_image.as_ref().map(|v| v.binding())),
            Self::Live(v) => Some(v.execution.binding()),
            Self::Retired(v) => v.as_ref().map(|e| e.binding()),
        }
    }
    fn owns(&self, t: Token) -> bool {
        match self {
            Self::Preparing(p) => p.startup.as_ref().is_some_and(|v| v.owns(t)),
            Self::Live(v) => {
                v.execution.owns(t) || v.continuation.as_ref().is_some_and(|c| c.owns(t))
            }
            Self::Retired(_) => false,
        }
    }
    fn normal_binding(&self, b: u64) -> bool {
        match self {
            Self::Preparing(p) => {
                p.startup
                    .as_ref()
                    .and_then(|v| v.binding())
                    .or_else(|| p.failed_image.as_ref().map(|v| v.binding()))
                    == Some(b)
            }
            Self::Live(v) => v.normal && v.execution.binding() == b,
            Self::Retired(v) => v.as_ref().is_some_and(|e| e.binding() == b),
        }
    }
}
struct StackTransport {
    owner: u64,
    generation: u64,
    input: Vec<u8>,
    output: Option<crate::stack::Stack>,
}
struct State {
    startup_input: Vec<u8>,
    root_input: Vec<u8>,
    root_catalog: Option<RootCatalog>,
    artifact_info: [u8; 160],
    stack: Option<StackTransport>,
    domain: Domain,
    executions: Vec<Slot>,
    execution_limit: usize,
    result: u64,
    length: u64,
    auxiliary: u64,
    endpoint: u64,
    state: u32,
    builder: Option<Builder>,
    sealed: Option<Sealed>,
    #[cfg(feature = "capture-v1")]
    capture_selected: bool,
    #[cfg(feature = "queued-worker-probe")]
    capture_write: Option<capture_worker::Active>,
    #[cfg(feature = "queued-worker-probe")]
    capture_receiver: capture_receiver::Receiver,
}
thread_local! { static STATE: RefCell<Option<State>> = const { RefCell::new(None) }; }
fn code(error: Error) -> i32 {
    match error {
        Error::Capacity => -1,
        Error::UnknownMemory => -2,
        Error::UnknownAction => -3,
        Error::Busy => -4,
        Error::Range => -5,
        Error::Exhausted => -6,
        Error::Incomplete => -7,
        Error::Effect(_) => -8,
    }
}
fn read_code(error: crate::read::Error) -> i32 {
    match error {
        crate::read::Error::Lease(e) => code(e),
        crate::read::Error::Busy => -4,
        crate::read::Error::Range => -5,
        crate::read::Error::Capacity => -1,
        crate::read::Error::Execution(_) => -11,
        _ => -10,
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Ordinary,
    Read,
    #[cfg(feature = "capture-v1")]
    CaptureSelection,
    PathFinish {
        execution: u64,
        action: Token,
    },
    #[cfg(not(feature = "capture-v1"))]
    SendFinish {
        execution: u64,
        sequence: u32,
        action: Token,
    },
    #[cfg(feature = "queued-worker-probe")]
    CaptureFinish {
        execution: u64,
        call: descriptor::capture::CallId,
    },
    #[cfg(feature = "queued-worker-probe")]
    ReceiveFinish(u64),
}
fn with_state(allow_view: bool, f: impl FnOnce(&mut State) -> Result<u64, i32>) -> i32 {
    with_state_access(
        if allow_view {
            Access::Read
        } else {
            Access::Ordinary
        },
        f,
    )
}
fn with_state_access(access: Access, f: impl FnOnce(&mut State) -> Result<u64, i32>) -> i32 {
    STATE.with(|cell| {
        let mut outer = cell.borrow_mut();
        let Some(s) = outer.as_mut() else {
            return -9;
        };
        s.result = 0;
        s.length = 0;
        s.auxiliary = 0;
        s.endpoint = 0;
        s.state = 0;
        #[cfg(feature = "capture-v1")]
        if !s.capture_selected && access != Access::CaptureSelection {
            return -12;
        }
        #[cfg(feature = "queued-worker-probe")]
        if s.capture_receiver.blocks(access) {
            return -4;
        }
        #[cfg(feature = "queued-worker-probe")]
        if s.capture_write.as_ref().is_some_and(|pending| pending.blocks(access)) {
            return -4;
        }
        // Canonical source views exclude every old Read exception too. Only
        // one exact owner/sequence/action may submit evidence. Another valid
        // Unknown owner's late completion is not permission to allocate here.
        #[cfg(not(feature = "capture-v1"))]
        let mut send_views = s
            .executions
            .iter()
            .enumerate()
            .filter_map(|(i, slot)| match slot {
                Slot::Live(slot) => slot
                    .continuation
                    .as_ref()
                    .and_then(|c| c.sendfile_view())
                    .map(|(sequence, action)| (i as u64 + 1, sequence, action)),
                _ => None,
            });
        #[cfg(not(feature = "capture-v1"))]
        if let Some((execution, sequence, action)) = send_views.next() {
            if send_views.next().is_some()
                || access
                    != (Access::SendFinish {
                        execution,
                        sequence,
                        action,
                    })
            {
                return -4;
            }
        }
        // A path input view excludes even the old read-view exceptions. Only
        // its exact owner/action finish can end it; another late finish cannot
        // allocate while this owner's physical view is still exposed.
        let path_view = s
            .executions
            .iter()
            .enumerate()
            .find_map(|(i, slot)| match slot {
                Slot::Live(slot) => slot
                    .continuation
                    .as_ref()
                    .and_then(|c| c.path_view())
                    .map(|action| (i as u64 + 1, action)),
                _ => None,
            });
        if path_view
            .is_some_and(|(execution, action)| access != (Access::PathFinish { execution, action }))
        {
            return -4;
        }
        if access != Access::Read && s.sealed.as_ref().is_some_and(|r| r.reads.viewing()) {
            return -4;
        }
        match f(s) {
            Ok(v) => {
                s.result = v;
                0
            }
            Err(e) => e,
        }
    })
}
fn with(f: impl FnOnce(&mut Domain) -> Result<u64, Error>) -> i32 {
    with_state(false, |s| f(&mut s.domain).map_err(code))
}
fn token(sequence: u64) -> Token {
    Token::from_parts(DOMAIN, sequence)
}
fn generic(sequence: u64, f: impl FnOnce(&mut Domain, Token) -> Result<u64, Error>) -> i32 {
    with_state(false, |s| {
        let t = token(sequence);
        #[cfg(feature = "queued-worker-probe")]
        if s.capture_write.as_ref().is_some_and(|pending| pending.owns(t)) {
            return Err(-4);
        }
        if s.sealed.as_ref().is_some_and(|r| r.reads.owns(t))
            || s.executions.iter().any(|e| e.owns(t))
        {
            return Err(-4);
        }
        f(&mut s.domain, t).map_err(code)
    })
}
fn completion(n: u32) -> Result<Completion, i32> {
    match n {
        0 => Ok(Completion::Stopped),
        1 => Ok(Completion::Unknown),
        _ => Err(-5),
    }
}
fn inode(n: u64) -> Inode {
    Inode::from_parts(TREE, n)
}
#[no_mangle]
pub extern "C" fn linux_abi_version() -> u32 {
    7
}
/// A conspicuous synthetic artifact marker, never a production capability.
#[cfg(feature = "sendfile-probe")]
#[no_mangle]
pub extern "C" fn linux_sendfile_probe() -> u32 {
    1
}
#[cfg(feature = "queued-output-probe")]
fn queue_probe_error(error: descriptor::QueueProbeError) -> i32 {
    match error {
        descriptor::QueueProbeError::Capacity => -1,
        descriptor::QueueProbeError::Range => -5,
        descriptor::QueueProbeError::Owner => -10,
        descriptor::QueueProbeError::Busy => -4,
    }
}
/// Diagnostic-only admission under the synthetic artifact sentinel. The normal
/// host refuses this entire feature artifact before instantiation.
#[cfg(feature = "queued-output-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_output_probe_init() -> i32 {
    init_probe(true)
}
/// The rejected joined fixture admits only one queue and receiver. This does
/// not grant guest startup, a host-owned result, or a stopped file effect.
#[cfg(feature = "queued-worker-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_init_joined() -> i32 {
    init_probe(false)
}
#[cfg(feature = "queued-output-probe")]
fn init_probe(separate: bool) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        if r.queue_probe.is_some() {
            return Err(-4);
        }
        r.queue_probe =
            Some(descriptor::QueueProbe::new(&mut r.files, separate).map_err(queue_probe_error)?);
        Ok(0)
    })
}
/// Synthetic publisher on one real live execution's resident table. This is
/// not a selected syscall, lazy continuation, Worker producer or host write.
#[cfg(feature = "queued-output-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_output_probe_publish(
    id: u64,
    invocation: u64,
    fd: u32,
    lane: u32,
    count: u32,
) -> i32 {
    with_state(false, |s| {
        let index = execution_index(s, id)?;
        let slot = s.executions[index].live_mut()?;
        if !matches!(slot.resources, Resources::Normal { .. }) {
            return Err(-11);
        }
        let table = slot.resources.table()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let queue = r.queue_probe.as_mut().ok_or(-9)?;
        let invocation = slot.execution.invocation(invocation).map_err(|_| -11)?;
        slot.execution.hold_call(invocation).map_err(|_| -11)?;
        let publication = queue.publish(&mut r.files, table, fd, lane as usize, count as usize);
        slot.execution
            .finish_call(invocation)
            .expect("diagnostic synchronous call owner");
        publication.map(|n| n as u64).map_err(queue_probe_error)
    })
}
/// Scalar inspection only: no pointer, stopped access claim, or delivery.
#[cfg(feature = "queued-output-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_output_probe_peek(lane: u32, index: u32) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        let (length, byte) = r
            .queue_probe
            .as_mut()
            .ok_or(-9)?
            .peek(&mut r.files, lane as usize, index as usize)
            .map_err(queue_probe_error)?;
        s.length = length as u64;
        Ok(u64::from(byte))
    })
}
#[cfg(feature = "queued-output-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_output_probe_discard(lane: u32) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.queue_probe
            .as_mut()
            .ok_or(-9)?
            .discard(&mut r.files, lane as usize)
            .map(u64::from)
            .map_err(queue_probe_error)
    })
}
#[no_mangle]
pub extern "C" fn linux_init(memories: u32, actions: u32) -> i32 {
    STATE.with(|cell| {
        let mut outer = cell.borrow_mut();
        if let Some(s) = outer.as_mut() {
            s.result = 0;
            s.length = 0;
            s.auxiliary = 0;
            s.endpoint = 0;
            s.state = 0;
            return -9;
        }
        let domain = match Domain::new(DOMAIN, memories as usize, actions as usize) {
            Ok(d) => d,
            Err(e) => return code(e),
        };
        *outer = Some(State {
            startup_input: Vec::new(),
            root_input: Vec::new(),
            root_catalog: None,
            artifact_info: [0; 160],
            stack: None,
            domain,
            executions: Vec::new(),
            execution_limit: memories as usize,
            result: 0,
            length: 0,
            auxiliary: 0,
            endpoint: 0,
            state: 0,
            builder: None,
            sealed: None,
            #[cfg(feature = "capture-v1")]
            capture_selected: false,
            #[cfg(feature = "queued-worker-probe")]
            capture_write: None,
            #[cfg(feature = "queued-worker-probe")]
            capture_receiver: capture_receiver::Receiver::default(),
        });
        0
    })
}
#[no_mangle]
pub extern "C" fn linux_result() -> u64 {
    STATE.with(|s| s.borrow().as_ref().map_or(0, |s| s.result))
}
#[no_mangle]
pub extern "C" fn linux_result_length() -> u64 {
    STATE.with(|s| s.borrow().as_ref().map_or(0, |s| s.length))
}
#[no_mangle]
pub extern "C" fn linux_result_state() -> u32 {
    STATE.with(|s| s.borrow().as_ref().map_or(0, |s| s.state))
}
#[no_mangle]
pub extern "C" fn linux_bind(extent: u64) -> i32 {
    with(|d| {
        if extent > WASM32_BYTES {
            Err(Error::Range)
        } else {
            d.bind(extent)
        }
    })
}
#[no_mangle]
pub extern "C" fn linux_binding_room() -> i32 {
    with(|d| d.binding_room().map(|_| 0))
}
#[no_mangle]
pub extern "C" fn linux_span(binding: u64, offset: u64, length: u64) -> i32 {
    with_state(false, |s| {
        if s.executions.iter().any(|e| e.normal_binding(binding)) {
            return Err(-4);
        }
        s.domain
            .span(binding, offset, length)
            .map(|t| t.sequence())
            .map_err(code)
    })
}
#[no_mangle]
pub extern "C" fn linux_change(binding: u64, extent: u64) -> i32 {
    with_state(false, |s| {
        // An execution owns its image incarnation. Generic physical growth must
        // not silently leave that owner pointing at a retired binding.
        if s.executions.iter().any(|e| e.binding() == Some(binding)) {
            return Err(-4);
        }
        s.domain
            .change(binding, extent)
            .map(|t| t.sequence())
            .map_err(code)
    })
}
#[no_mangle]
pub extern "C" fn linux_start(sequence: u64) -> i32 {
    generic(sequence, |d, t| d.start(t).map(|_| 0))
}
#[no_mangle]
pub extern "C" fn linux_cancel(sequence: u64) -> i32 {
    generic(sequence, |d, t| d.cancel(t).map(|_| 0))
}
#[no_mangle]
pub extern "C" fn linux_receipt(sequence: u64, confirmed: u64, done: u32) -> i32 {
    generic(sequence, |d, t| {
        let done = match done {
            0 => Completion::Stopped,
            1 => Completion::Unknown,
            _ => return Err(Error::Range),
        };
        d.receipt(t, confirmed, done).map(|_| 0)
    })
}
#[no_mangle]
pub extern "C" fn linux_retire(sequence: u64) -> i32 {
    generic(sequence, |d, t| d.retire(t).map(|id| id.unwrap_or(0)))
}
#[no_mangle]
pub extern "C" fn linux_files_prepare(
    inodes: u32,
    entries: u32,
    file_bytes: u32,
    tables: u32,
    descriptions: u32,
    slots: u32,
    reads: u32,
) -> i32 {
    with_state(false, |s| {
        if s.builder.is_some() || s.sealed.is_some() {
            return Err(-9);
        }
        let tree = Tree::new(
            TREE,
            inodes as usize,
            entries as usize,
            file_bytes as usize,
            crate::inode::Creation {
                mode: 0o755,
                uid: 0,
                gid: 0,
            },
        )
        .map_err(|_| -10)?;
        let capacity = ReadCapacity::new(reads as usize).map_err(read_code)?;
        s.builder = Some(Builder {
            tree: Some(tree),
            sealing: None,
            limits: descriptor::Limits {
                contexts: 0,
                tables: tables as usize,
                descriptions: descriptions as usize,
                slots: slots as usize,
            },
            capacity: Some(capacity),
            file_limit: file_bytes as usize,
            profile: None,
            root_view: None,
            name: Vec::new(),
            input: Vec::new(),
        });
        Ok(1)
    })
}
fn buffer(name: bool, len: u32) -> i32 {
    with_state(false, |s| {
        let b = s.builder.as_mut().ok_or(-9)?;
        if b.tree.is_none() {
            return Err(-9);
        }
        let n = len as usize;
        if n > if name { 255 } else { b.file_limit } {
            return Err(-5);
        }
        let bytes = if name { &mut b.name } else { &mut b.input };
        let mut next = Vec::new();
        next.try_reserve_exact(n).map_err(|_| -1)?;
        next.resize(n, 0);
        *bytes = next;
        Ok(if n == 0 { 0 } else { bytes.as_mut_ptr() as u64 })
    })
}
#[no_mangle]
pub extern "C" fn linux_name(length: u32) -> i32 {
    buffer(true, length)
}
#[no_mangle]
pub extern "C" fn linux_input(length: u32) -> i32 {
    buffer(false, length)
}
#[no_mangle]
pub extern "C" fn linux_tree_directory(parent: u64, mode: u32) -> i32 {
    with_state(false, |s| {
        let b = s.builder.as_mut().ok_or(-9)?;
        b.tree
            .as_mut()
            .ok_or(-9)?
            .directory(
                inode(parent),
                &b.name,
                crate::inode::Creation {
                    mode: mode,
                    uid: 0,
                    gid: 0,
                },
            )
            .map(|n| n.number())
            .map_err(|_| -10)
    })
}
/// Builder-only symbolic link. Name and target are validated and copied by Tree
/// before namespace publication; a failed call leaves input and tree unchanged.
#[no_mangle]
pub extern "C" fn linux_tree_symlink(parent: u64) -> i32 {
    with_state(false, |s| {
        let b = s.builder.as_mut().ok_or(-9)?;
        b.tree
            .as_mut()
            .ok_or(-9)?
            .symlink(
                inode(parent),
                &b.name,
                &b.input,
                crate::inode::Creation {
                    mode: 0o777,
                    uid: 0,
                    gid: 0,
                },
            )
            .map(|n| n.number())
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_tree_file(parent: u64, mode: u32) -> i32 {
    with_state(false, |s| {
        let b = s.builder.as_mut().ok_or(-9)?;
        b.tree
            .as_mut()
            .ok_or(-9)?
            .file_take(
                inode(parent),
                &b.name,
                crate::inode::Creation {
                    mode: mode,
                    uid: 0,
                    gid: 0,
                },
                &mut b.input,
            )
            .map(|n| n.number())
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_files_seal(fd_limit: u32) -> i32 {
    with_state(false, |s| {
        if s.sealed.is_some() {
            return Err(-9);
        }
        let b = s.builder.as_mut().ok_or(-9)?;
        if let Some(tree) = b.tree.take() {
            b.sealing = Some(Files::new(FILES, tree, b.limits));
        }
        if let Some(profile) = &b.profile {
            if b.root_view.is_none() {
                b.root_view = Some(
                    b.sealing
                        .as_mut()
                        .ok_or(-9)?
                        .bootstrap_mount(
                            inode(1),
                            mount::Limits {
                                views: profile.views,
                                holds: profile.holds,
                            },
                            profile.policy,
                        )
                        .map_err(|_| -10)?,
                );
            }
        }
        let root = match &b.root_view {
            Some(view) => Some(
                b.sealing
                    .as_ref()
                    .ok_or(-9)?
                    .view_root(view)
                    .map_err(|_| -10)?,
            ),
            None => None,
        };
        let table = if b.profile.is_none() {
            Some(
                b.sealing
                    .as_mut()
                    .ok_or(-9)?
                    .table(fd_limit)
                    .map_err(|_| -10)?,
            )
        } else {
            None
        };
        // Capacity was acquired in prepare, before ownership moved into Files.
        let files = b.sealing.take().unwrap();
        let capacity = b.capacity.take().unwrap();
        let reads = Reads::new(&files, capacity);
        s.sealed = Some(Sealed {
            files,
            #[cfg(feature = "queued-output-probe")]
            queue_probe: None,
            table,
            root,
            root_view: b.root_view.take(),
            fd_limit,
            reads,
            input: Vec::new(),
            file_limit: b.file_limit,
        });
        s.builder = None;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_open(node: u64) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.files
            .open(r.table.as_ref().ok_or(-11)?, inode(node), false)
            .map(|fd| fd as u64)
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_dup(fd: u32) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.files
            .dup(r.table.as_ref().ok_or(-11)?, fd, 0, false)
            .map(|fd| fd as u64)
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_close(fd: u32) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.files
            .close(r.table.as_ref().ok_or(-11)?, fd)
            .map(|_| 0)
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_offset(fd: u32) -> i32 {
    with_state(true, |s| {
        let r = s.sealed.as_ref().ok_or(-9)?;
        r.files
            .offset(r.table.as_ref().ok_or(-11)?, fd)
            .map(|v| v.0)
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_seek(fd: u32, offset: u64) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.files
            .set_offset(r.table.as_ref().ok_or(-11)?, fd, offset)
            .map(|_| 0)
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_begin(fd: u32, binding: u64, at: u64, requested: u64) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.reads
            .begin(
                &mut r.files,
                r.table.as_ref().ok_or(-11)?,
                &mut s.domain,
                fd,
                binding,
                at,
                requested,
            )
            .map_err(read_code)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_start(id: u64) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        let (ptr, len) = r
            .reads
            .start(&mut r.files, &mut s.domain, id)
            .map_err(read_code)?;
        s.length = len;
        Ok(ptr as u64)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_receipt(id: u64, confirmed: u64, done: u32) -> i32 {
    with_state(true, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.reads
            .receipt(
                &mut r.files,
                &mut s.domain,
                id,
                confirmed,
                completion(done)?,
            )
            .map(|_| 0)
            .map_err(read_code)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_cancel(id: u64) -> i32 {
    with_state(true, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.reads
            .cancel(&mut r.files, &mut s.domain, id)
            .map(|_| 0)
            .map_err(read_code)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_query(id: u64) -> i32 {
    with_state(true, |s| {
        let (confirmed, len, state) = s
            .sealed
            .as_ref()
            .ok_or(-9)?
            .reads
            .query(id)
            .map_err(read_code)?;
        s.length = len;
        s.state = state;
        Ok(confirmed)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_retire(id: u64) -> i32 {
    with_state(false, |s| {
        if s.executions.iter().any(|e| {
            e.live()
                .is_ok_and(|v| v.continuation.as_ref().is_some_and(|c| c.owns_read(id)))
        }) {
            return Err(-4);
        }
        s.sealed
            .as_mut()
            .ok_or(-9)?
            .reads
            .retire(id)
            .map(|_| 0)
            .map_err(read_code)
    })
}

// Private execution admission. IDs index a bounded, append-only owner table;
// neither identity nor image/run state is reconstructed by the host.
fn execution_index(s: &State, id: u64) -> Result<usize, i32> {
    let n = usize::try_from(id.checked_sub(1).ok_or(-11)?).map_err(|_| -11)?;
    if n < s.executions.len() && !matches!(s.executions[n].live()?.resources, Resources::Retired) {
        Ok(n)
    } else {
        Err(-11)
    }
}
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_execution_create(binding: u64) -> i32 {
    with_state(false, |s| {
        if s.builder.as_ref().is_some_and(|b| b.profile.is_some())
            || s.sealed.as_ref().is_some_and(|r| r.root.is_some())
        {
            return Err(-11);
        }
        s.domain.range(binding, 0, 0).map_err(code)?;
        if s.executions.iter().any(|e| e.binding() == Some(binding)) {
            return Err(-4);
        }
        if s.executions.len() == s.execution_limit {
            return Err(-1);
        }
        s.executions.try_reserve(1).map_err(|_| -1)?;
        let id = s.executions.len() as u64 + 1;
        let resources = match &mut s.sealed {
            Some(r) => Resources::Diagnostic(
                r.files
                    .share(r.table.as_ref().ok_or(-11)?)
                    .map_err(|_| -10)?,
            ),
            None => Resources::MemoryOnly,
        };
        s.executions.push(Slot::Live(ExecutionSlot {
            normal: false,
            resources,
            execution: Execution::new(id, binding),
            continuation: None,
        }));
        Ok(id)
    })
}
#[no_mangle]
pub extern "C" fn linux_image_begin(id: u64, extent: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        if matches!(s.executions[i].live()?.resources, Resources::Normal { .. }) {
            return Err(-11);
        }
        s.executions[i]
            .live_mut()?
            .execution
            .image_begin(&mut s.domain, extent)
            .map_err(|_| -11)?;
        if s.stack.as_ref().is_some_and(|stack| stack.owner == id) {
            s.stack = None;
        }
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_image_finish(id: u64, outcome: u32) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        if matches!(s.executions[i].live()?.resources, Resources::Normal { .. }) {
            return Err(-11);
        }
        let outcome = match outcome {
            0 => ImageResult::Installed,
            1 => ImageResult::Untouched,
            2 => ImageResult::PoisonedStopped,
            3 => ImageResult::Unknown,
            _ => return Err(-5),
        };
        s.executions[i]
            .live_mut()?
            .execution
            .image_finish(&mut s.domain, outcome)
            .map_err(|_| -11)?;
        if s.stack.as_ref().is_some_and(|stack| stack.owner == id) {
            s.stack = None;
        }
        Ok(s.executions[i].live_mut()?.execution.binding())
    })
}
#[no_mangle]
pub extern "C" fn linux_tree_lazy(parent: u64, mode: u32, source: u32, size: u32) -> i32 {
    with_state(false, |s| {
        let b = s.builder.as_mut().ok_or(-9)?;
        b.tree
            .as_mut()
            .ok_or(-9)?
            .lazy_file(
                inode(parent),
                &b.name,
                crate::inode::Creation {
                    mode: mode,
                    uid: 0,
                    gid: 0,
                },
                source,
                size as usize,
            )
            .map(|n| n.number())
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_managed_read_begin(
    execution: u64,
    fd: u32,
    at: u64,
    requested: u64,
) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, execution)?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.reads
            .begin_managed(
                &mut r.files,
                s.executions[i].live()?.resources.table()?,
                &mut s.domain,
                &s.executions[i].live()?.execution,
                fd,
                at,
                requested,
            )
            .map_err(read_code)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_load_start(execution: u64, id: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, execution)?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let (source, attempt) = r
            .reads
            .load_start(&mut r.files, &s.executions[i].live()?.execution, id)
            .map_err(read_code)?;
        s.length = attempt as u64;
        Ok(source as u64)
    })
}
#[no_mangle]
pub extern "C" fn linux_load_input(length: u32) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        let n = length as usize;
        if n > r.file_limit {
            return Err(-5);
        }
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(n).map_err(|_| -1)?;
        bytes.resize(n, 0);
        r.input = bytes;
        Ok(if n == 0 {
            0
        } else {
            r.input.as_mut_ptr() as u64
        })
    })
}
fn finish_source(
    s: &mut State,
    execution: u64,
    id: u64,
    attempt: u32,
    success: u32,
    syscall: bool,
) -> Result<u64, i32> {
    if success > 1 {
        return Err(-5);
    }
    let i = execution_index(s, execution)?;
    let slot = s.executions[i].live_mut()?;
    if syscall && !slot.continuation.as_ref().is_some_and(|c| c.owns_read(id)) {
        return Err(-12);
    }
    let r = s.sealed.as_mut().ok_or(-9)?;
    r.reads
        .load_finish(
            &mut r.files,
            &mut s.domain,
            &slot.execution,
            id,
            attempt,
            success == 1,
            &mut r.input,
        )
        .map_err(read_code)?;
    // This callback has stopped and its matching failure was accepted above.
    // Do not infer source failure from unrelated Failed/identity/copy states.
    if syscall && success == 0 {
        slot.continuation
            .as_mut()
            .ok_or(-11)?
            .source_failed(&slot.execution, id)
            .map_err(|_| -12)?;
    }
    Ok(0)
}
#[no_mangle]
pub extern "C" fn linux_read_load_finish(
    execution: u64,
    id: u64,
    attempt: u32,
    success: u32,
) -> i32 {
    with_state(false, |s| {
        finish_source(s, execution, id, attempt, success, false)
    })
}
#[no_mangle]
pub extern "C" fn linux_syscall_load_finish(
    execution: u64,
    id: u64,
    attempt: u32,
    success: u32,
) -> i32 {
    with_state(false, |s| {
        finish_source(s, execution, id, attempt, success, true)
    })
}
#[no_mangle]
pub extern "C" fn linux_managed_read_start(execution: u64, id: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, execution)?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let (pointer, length) = r
            .reads
            .start_managed(
                &mut r.files,
                &mut s.domain,
                &s.executions[i].live()?.execution,
                id,
            )
            .map_err(read_code)?;
        s.length = length;
        Ok(pointer as u64)
    })
}

#[no_mangle]
pub extern "C" fn linux_result_auxiliary() -> u64 {
    STATE.with(|cell| cell.borrow().as_ref().map_or(0, |s| s.auxiliary))
}
#[no_mangle]
pub extern "C" fn linux_result_endpoint() -> u64 {
    STATE.with(|cell| cell.borrow().as_ref().map_or(0, |s| s.endpoint))
}
fn step(s: &mut State, command: Step) -> u64 {
    match command {
        Step::Return(value) => {
            s.state = 0;
            value as u64
        }
        Step::Read { id, target } => {
            s.state = 1;
            s.auxiliary = target;
            id
        }
        Step::Stream {
            action,
            endpoint,
            target,
            length,
            write,
        } => {
            s.state = 7 | (u32::from(write) << 8);
            s.endpoint = endpoint;
            s.auxiliary = target;
            s.length = length;
            action.sequence()
        }
        Step::SetFs {
            action,
            sequence,
            base,
        } => {
            s.state = 9;
            s.auxiliary = base;
            s.length = u64::from(sequence);
            action.sequence()
        }
        #[cfg(not(feature = "capture-v1"))]
        Step::SendfileCapability {
            action,
            sequence,
            endpoint,
        } => {
            s.state = 10;
            s.auxiliary = u64::from(sequence);
            s.endpoint = endpoint;
            action.sequence()
        }
        #[cfg(not(feature = "capture-v1"))]
        Step::SendfileLoad { action, sequence } => {
            s.state = 11;
            s.auxiliary = u64::from(sequence);
            action.sequence()
        }
        #[cfg(not(feature = "capture-v1"))]
        Step::SendfileOffer {
            action,
            sequence,
            endpoint,
            length,
        } => {
            s.state = 12;
            s.auxiliary = u64::from(sequence);
            s.endpoint = endpoint;
            s.length = length;
            action.sequence()
        }
        #[cfg(any(test, feature = "queued-worker-probe", feature = "capture-v1"))]
        Step::CaptureWrite { call, at, length } => {
            s.state = 13;
            s.auxiliary = at;
            s.length = length;
            call.action.sequence()
        }
        Step::Path {
            action,
            target,
            length,
        } => {
            s.state = 8;
            s.auxiliary = target;
            s.length = length;
            action.sequence()
        }
        Step::Exit => {
            s.state = 2;
            0
        }
        Step::Unsupported(number) => {
            s.state = 3;
            number
        }
        Step::Waiting => {
            s.state = 4;
            0
        }
        Step::Resume(resume) => {
            s.state = 5;
            s.length = resume.next;
            s.auxiliary = resume.rcx;
            resume.rax as u64
        }
    }
}
#[no_mangle]
pub extern "C" fn linux_run_start(id: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        if slot.continuation.is_none()
            && matches!(
                slot.resources,
                Resources::Diagnostic(_) | Resources::Normal { .. }
            )
        {
            slot.continuation = Some(Continuation::new(&slot.execution).map_err(|_| -11)?);
        }
        slot.execution
            .start(&mut s.domain)
            .map(|v| v.number())
            .map_err(|_| -11)
    })
}
#[no_mangle]
pub extern "C" fn linux_run_receipt(id: u64, invocation: u64, outcome: u32, next: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let e = &mut s.executions[i].live_mut()?.execution;
        let invocation = e.invocation(invocation).map_err(|_| -11)?;
        let unwind = match outcome {
            0 => Unwind::Yield(next),
            1 => Unwind::Exit,
            2 => Unwind::Fault,
            3 => Unwind::Unknown,
            _ => return Err(-5),
        };
        e.receipt(&mut s.domain, invocation, unwind)
            .map_err(|_| -11)?;
        Ok(e.status().unwrap_or(0) as u64)
    })
}
#[no_mangle]
pub extern "C" fn linux_syscall(
    id: u64,
    invocation: u64,
    nr: u64,
    a: u64,
    b: u64,
    c: u64,
    d: u64,
    e: u64,
    f: u64,
    next: u64,
) -> i32 {
    with_state(false, |s| {
        syscall_enter(s, id, invocation, None, nr, a, b, c, d, e, f, next)
    })
}
/// Actual Worker entrance: sequence is captured before syscall admission, not
/// first adopted at a physical subround. Unsequenced diagnostics cannot set FS.
#[no_mangle]
pub extern "C" fn linux_syscall_sequenced(
    id: u64,
    invocation: u64,
    sequence: u32,
    nr: u64,
    a: u64,
    b: u64,
    c: u64,
    d: u64,
    e: u64,
    f: u64,
    next: u64,
) -> i32 {
    with_state(false, |s| {
        syscall_enter(
            s,
            id,
            invocation,
            Some(sequence),
            nr,
            a,
            b,
            c,
            d,
            e,
            f,
            next,
        )
    })
}
fn syscall_enter(
    s: &mut State,
    id: u64,
    invocation: u64,
    sequence: Option<u32>,
    nr: u64,
    a: u64,
    b: u64,
    c: u64,
    d: u64,
    e: u64,
    f: u64,
    next: u64,
) -> Result<u64, i32> {
    let i = execution_index(s, id)?;
    let slot = s.executions[i].live_mut()?;
    let invocation = slot.execution.invocation(invocation).map_err(|_| -11)?;
    let r = s.sealed.as_mut().ok_or(-9)?;
    let namespace = match &slot.resources {
        Resources::Normal {
            fs: Some(fs),
            decision,
            ..
        } => Some((fs, &decision.credentials)),
        _ => None,
    };
    let continuation = slot.continuation.as_mut().ok_or(-11)?;
    let args = [a, b, c, d, e, f];
    let command = if let Some(sequence) = sequence {
        continuation.enter_sequenced(
            &mut r.files,
            slot.resources.table()?,
            namespace,
            &mut r.reads,
            &mut s.domain,
            &mut slot.execution,
            invocation,
            sequence,
            nr,
            args,
            next,
        )
    } else {
        continuation.enter_with_namespace(
            &mut r.files,
            slot.resources.table()?,
            namespace,
            &mut r.reads,
            &mut s.domain,
            &mut slot.execution,
            invocation,
            nr,
            args,
            next,
        )
    }
    .map_err(|_| -12)?;
    Ok(step(s, command))
}
/// Read-only task metadata observer, not a guest pointer/host TID capability.
/// The record must remain exact through unwind/lost replies until retirement.
#[no_mangle]
pub extern "C" fn linux_task_registration(id: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let registration = slot
            .continuation
            .as_ref()
            .ok_or(-11)?
            .task_registration(&slot.execution)
            .map_err(|_| -12)?;
        s.length = u64::from(registration.tid);
        Ok(registration.clear_child_tid)
    })
}
#[no_mangle]
pub extern "C" fn linux_register_start(id: u64, sequence: u32, action: u64, base: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        slot.continuation
            .as_mut()
            .ok_or(-11)?
            .register_start(
                &mut s.domain,
                &slot.execution,
                sequence,
                token(action),
                base,
            )
            .map_err(|_| -12)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_register_receipt(
    id: u64,
    sequence: u32,
    action: u64,
    base: u64,
    outcome: u32,
) -> i32 {
    with_state(false, |s| {
        let outcome = match outcome {
            0 => RegisterOutcome::AppliedStopped,
            1 => RegisterOutcome::NotAppliedStopped,
            2 => RegisterOutcome::Unknown,
            _ => return Err(-5),
        };
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let command = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .register_receipt(
                &mut s.domain,
                &mut slot.execution,
                sequence,
                token(action),
                base,
                outcome,
            )
            .map_err(|_| -12)?;
        Ok(step(s, command))
    })
}

/// Read-only capability subround; no source view or output permission. The
/// continuation stores the non-Copy request before its metadata crosses ABI.
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_sendfile_cap_start(id: u64, sequence: u32, action: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let endpoint = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .sendfile_cap_start(
                &mut r.files,
                &mut s.domain,
                &mut slot.execution,
                sequence,
                token(action),
            )
            .map_err(|_| -12)?;
        s.auxiliary = u64::from(sequence);
        s.endpoint = endpoint;
        Ok(action)
    })
}
/// Production can only reject until a reviewed physical construction exists.
/// Code1 is synthetic evidence in the segregated probe artifact ONLY. Shape-
/// complete raw exports are not a security boundary against a lying embedder.
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_sendfile_cap_finish(
    id: u64,
    sequence: u32,
    action: u64,
    endpoint: u64,
    proof: u32,
) -> i32 {
    with_state(false, |s| {
        if proof > 1 {
            return Err(-5);
        }
        #[cfg(not(feature = "sendfile-probe"))]
        if proof != 0 {
            return Err(-5);
        }
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let call = slot.continuation.as_mut().ok_or(-11)?;
        let command = if proof == 0 {
            call.sendfile_cap_finish_rejected(
                &mut r.files,
                &mut s.domain,
                &mut slot.execution,
                sequence,
                token(action),
                endpoint,
            )
        } else {
            #[cfg(feature = "sendfile-probe")]
            {
                call.sendfile_cap_finish_synthetic(
                    &mut r.files,
                    &mut s.domain,
                    &mut slot.execution,
                    sequence,
                    token(action),
                    endpoint,
                )
            }
            #[cfg(not(feature = "sendfile-probe"))]
            {
                return Err(-5);
            }
        }
        .map_err(|_| -12)?;
        Ok(step(s, command))
    })
}
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_sendfile_load_start(id: u64, sequence: u32, action: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let load = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .sendfile_load_start(
                &mut r.files,
                &mut s.domain,
                &mut slot.execution,
                sequence,
                token(action),
            )
            .map_err(|_| -12)?;
        s.length = u64::from(load.attempt);
        s.auxiliary = u64::from(sequence);
        Ok(u64::from(load.source))
    })
}
/// The global source staging turn is synchronous through this exact finish.
/// Source and attempt are both checked before input adoption; failed/cancelled
/// delivery is not a capability or output receipt.
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_sendfile_load_finish(
    id: u64,
    sequence: u32,
    action: u64,
    source: u32,
    attempt: u32,
    success: u32,
) -> i32 {
    with_state(false, |s| {
        if success > 1 {
            return Err(-5);
        }
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let command = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .sendfile_load_finish(
                &mut r.files,
                &mut s.domain,
                &mut slot.execution,
                sequence,
                token(action),
                descriptor::LoadRequest { source, attempt },
                success == 1,
                &mut r.input,
            )
            .map_err(|_| -12)?;
        Ok(step(s, command))
    })
}
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_sendfile_start(id: u64, sequence: u32, action: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let call = slot.continuation.as_mut().ok_or(-11)?;
        // All fallible metadata preflight precedes the live view interval.
        let endpoint = call
            .sendfile_query(&slot.execution)
            .map_err(|_| -12)?
            .ok_or(-12)?
            .endpoint;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let (pointer, length) = call
            .sendfile_start(
                &mut r.files,
                &mut s.domain,
                &mut slot.execution,
                sequence,
                token(action),
            )
            .map_err(|_| -12)?;
        s.length = length;
        s.auxiliary = u64::from(sequence);
        s.endpoint = endpoint;
        Ok(pointer as u64)
    })
}
/// Ended access is separate from prefix certainty. Every shape check and the
/// exact owner/action guard precedes any Domain, cursor or view transition.
/// Known zero errors settle ownership but never become guest errno here.
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_sendfile_receipt(
    id: u64,
    sequence: u32,
    action: u64,
    confirmed: u64,
    outcome: u32,
    ended: u32,
) -> i32 {
    with_state_access(
        Access::SendFinish {
            execution: id,
            sequence,
            action: token(action),
        },
        |s| {
            let access = match ended {
                0 => crate::sendfile::AccessEvidence::NotEnded,
                1 => crate::sendfile::AccessEvidence::Ended,
                _ => return Err(-5),
            };
            let outcome = match outcome {
                0 => crate::sendfile::Outcome::Transferred,
                1 => crate::sendfile::Outcome::Again,
                2 => crate::sendfile::Outcome::Interrupted,
                3 => crate::sendfile::Outcome::BadFd,
                4 => crate::sendfile::Outcome::BrokenPipe,
                5 => crate::sendfile::Outcome::Io,
                6 => crate::sendfile::Outcome::Unknown,
                7 => crate::sendfile::Outcome::PreparationFailed,
                _ => return Err(-5),
            };
            let i = execution_index(s, id)?;
            let slot = s.executions[i].live_mut()?;
            let r = s.sealed.as_mut().ok_or(-9)?;
            let command = slot
                .continuation
                .as_mut()
                .ok_or(-11)?
                .sendfile_receipt(
                    &mut r.files,
                    &mut s.domain,
                    &mut slot.execution,
                    sequence,
                    token(action),
                    confirmed,
                    outcome,
                    access,
                )
                .map_err(|_| -12)?;
            Ok(step(s, command))
        },
    )
}
/// Synthetic independent lexical-end certificate, absent from normal builds.
#[cfg(all(feature = "sendfile-probe", not(feature = "capture-v1")))]
#[no_mangle]
pub extern "C" fn linux_sendfile_probe_access_ended(id: u64, sequence: u32, action: u64) -> i32 {
    with_state_access(
        Access::SendFinish {
            execution: id,
            sequence,
            action: token(action),
        },
        |s| {
            let i = execution_index(s, id)?;
            let slot = s.executions[i].live_mut()?;
            let r = s.sealed.as_ref().ok_or(-9)?;
            slot.continuation
                .as_mut()
                .ok_or(-11)?
                .sendfile_access_ended_synthetic(
                    &r.files,
                    &s.domain,
                    &slot.execution,
                    sequence,
                    token(action),
                )
                .map_err(|_| -12)?;
            Ok(0)
        },
    )
}
/// Closing cleanup needs no action token that may already have retired. It
/// never restarts an offer or recommits a source prefix.
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_sendfile_cleanup(id: u64, sequence: u32) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let command = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .sendfile_cleanup_retry(&mut r.files, &mut s.domain, &mut slot.execution, sequence)
            .map_err(|_| -12)?;
        Ok(step(s, command))
    })
}
/// Private metadata only; cannot bypass a canonical/path/read view. No pending
/// owner is state0xffff; otherwise state is phase | closed<<8 | finished<<9.
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_sendfile_query(id: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live()?;
        let query = slot
            .continuation
            .as_ref()
            .ok_or(-11)?
            .sendfile_query(&slot.execution)
            .map_err(|_| -12)?;
        let Some(q) = query else {
            s.state = 0xffff;
            return Ok(0);
        };
        use crate::sendfile::Phase;
        s.state = match q.phase {
            Phase::Idle => 0,
            Phase::CapReady => 1,
            Phase::CapChecking => 2,
            Phase::LoadingReady => 3,
            Phase::Loading => 4,
            Phase::OfferReady => 5,
            Phase::Started => 6,
            Phase::Unknown => 7,
            Phase::Closing => 8,
            Phase::Terminal => 9,
        } | (u32::from(q.closed) << 8)
            | (u32::from(q.finished) << 9);
        s.length = q.offered;
        s.auxiliary = u64::from(q.sequence);
        s.endpoint = q.endpoint;
        Ok(q.confirmed)
    })
}

/// One-shot bounded pathname capture. The private host may only use captured
/// synchronous view/copy intrinsics until its exact matching finish call.
#[no_mangle]
pub extern "C" fn linux_syscall_path_start(id: u64, action: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let input = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .path_start(&mut s.domain, &slot.execution, token(action))
            .map_err(|_| -12)?;
        s.length = input.len() as u64;
        Ok(input.as_mut_ptr() as u64)
    })
}
/// Every receipt certifies the short core input view has ended. Outcome0 is
/// captured+stopped,1 failed+stopped,2 unknown guest-span/content completion.
/// Unknown retains all operation owners and never grants another capture start.
#[no_mangle]
pub extern "C" fn linux_syscall_path_finish(
    id: u64,
    action: u64,
    actual: u64,
    outcome: u32,
) -> i32 {
    with_state_access(
        Access::PathFinish {
            execution: id,
            action: token(action),
        },
        |s| {
            let outcome = match outcome {
                0 => PathOutcome::Captured,
                1 => PathOutcome::Failed,
                2 => PathOutcome::Unknown,
                _ => return Err(-5),
            };
            let i = execution_index(s, id)?;
            let slot = s.executions[i].live_mut()?;
            let r = s.sealed.as_mut().ok_or(-9)?;
            let command = slot
                .continuation
                .as_mut()
                .ok_or(-11)?
                .path_finish(
                    &mut r.files,
                    slot.resources.table()?,
                    &mut s.domain,
                    &mut slot.execution,
                    token(action),
                    actual,
                    outcome,
                )
                .map_err(|_| -12)?;
            Ok(step(s, command))
        },
    )
}
/// One physical host operation, never a Linux FD/errno decision in the host.
#[no_mangle]
pub extern "C" fn linux_stream_start(id: u64, action: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let r = s.sealed.as_ref().ok_or(-9)?;
        slot.continuation
            .as_mut()
            .ok_or(-11)?
            .stream_start(&r.files, &mut s.domain, &slot.execution, token(action))
            .map_err(|_| -12)?;
        Ok(0)
    })
}
/// 0 transferred, 1 again, 2 interrupted, 3 bad host fd, 4 broken pipe,
/// 5 known no-effect I/O failure, 6 unknown. Unknown never authorizes retry.
#[no_mangle]
pub extern "C" fn linux_stream_receipt(id: u64, action: u64, count: u64, outcome: u32) -> i32 {
    with_state(false, |s| {
        let outcome = match outcome {
            0 => PhysicalResult::Transferred,
            1 => PhysicalResult::Again,
            2 => PhysicalResult::Interrupted,
            3 => PhysicalResult::BadFd,
            4 => PhysicalResult::BrokenPipe,
            5 => PhysicalResult::Io,
            6 => PhysicalResult::Unknown,
            _ => return Err(-5),
        };
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let command = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .stream_receipt(
                &mut r.files,
                &mut s.domain,
                &mut slot.execution,
                token(action),
                count,
                outcome,
            )
            .map_err(|_| -12)?;
        Ok(step(s, command))
    })
}
#[no_mangle]
pub extern "C" fn linux_syscall_complete(id: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let command = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .complete(&mut r.reads, &mut slot.execution)
            .map_err(|_| -12)?;
        Ok(step(s, command))
    })
}
#[no_mangle]
pub extern "C" fn linux_syscall_resumed(id: u64, stopped: u32, success: u32) -> i32 {
    with_state(false, |s| {
        if success > 1 {
            return Err(-5);
        }
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        slot.continuation
            .as_mut()
            .ok_or(-11)?
            .resumed(&mut slot.execution, completion(stopped)?, success == 1)
            .map_err(|_| -12)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_syscall_abandon(id: u64) -> i32 {
    with_state(false, |s| {
        #[cfg(feature = "queued-worker-probe")]
        if !capture_worker::abandon(s, id)? {
            return Ok(0);
        }
        let i = execution_index(s, id)?;
        let slot = s.executions[i].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        slot.continuation
            .as_mut()
            .ok_or(-11)?
            .abandon(
                &mut r.files,
                &mut r.reads,
                &mut s.domain,
                &mut slot.execution,
            )
            .map(u64::from)
            .map_err(|_| -12)
    })
}

/// One bounded initialization wire. The private host must perform only short
/// intrinsic copy between pointer publication and the next ABI operation.
#[no_mangle]
pub extern "C" fn linux_stack_input(id: u64, length: u32) -> i32 {
    with_state(false, |s| {
        if length as usize > crate::stack::MAX_WIRE_BYTES {
            return Err(-5);
        }
        let i = execution_index(s, id)?;
        if matches!(s.executions[i].live()?.resources, Resources::Normal { .. }) {
            return Err(-11);
        }
        let (generation, _) = s.executions[i]
            .live_mut()?
            .execution
            .initialization()
            .ok_or(-11)?;
        let owner = id;
        if s.stack.as_ref().is_some_and(|stack| stack.owner != id) {
            return Err(-4);
        }
        let mut input = Vec::new();
        input.try_reserve_exact(length as usize).map_err(|_| -1)?;
        input.resize(length as usize, 0);
        s.stack = Some(StackTransport {
            owner,
            generation,
            input,
            output: None,
        });
        Ok(s.stack.as_mut().unwrap().input.as_mut_ptr() as usize as u64)
    })
}
#[no_mangle]
pub extern "C" fn linux_stack_build(id: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        if matches!(s.executions[i].live()?.resources, Resources::Normal { .. }) {
            return Err(-11);
        }
        let (generation, extent) = s.executions[i]
            .live_mut()?
            .execution
            .initialization()
            .ok_or(-11)?;
        let transport = s.stack.as_mut().ok_or(-9)?;
        if transport.owner != id || transport.generation != generation {
            return Err(-11);
        }
        if transport.output.is_some() {
            return Err(-4);
        }
        let stack = crate::stack::build_wire(&transport.input, extent).map_err(|e| match e {
            crate::stack::Error::Capacity => -1,
            _ => -5,
        })?;
        transport.input = Vec::new();
        transport.output = Some(stack);
        let output = transport.output.as_ref().unwrap();
        s.length = output.bytes.len() as u64;
        s.auxiliary = output.pointer;
        Ok(output.bytes.as_ptr() as usize as u64)
    })
}
#[no_mangle]
pub extern "C" fn linux_stack_clear() -> i32 {
    with_state(false, |s| {
        s.stack = None;
        Ok(0)
    })
}

/// Retires only the execution's resource holder, not the shared Files or physical
/// memory. Host evidence, outstanding source/copy work and observations differ.
#[no_mangle]
pub extern "C" fn linux_execution_retire(id: u64) -> i32 {
    with_state(true, |s| {
        let i = usize::try_from(id.checked_sub(1).ok_or(-11)?).map_err(|_| -11)?;
        let slot = s.executions.get_mut(i).ok_or(-11)?.live_mut()?;
        if matches!(slot.resources, Resources::Retired) {
            return Ok(1);
        }
        if s.sealed.as_ref().is_some_and(|r| r.reads.viewing()) || !slot.execution.stopped() {
            return Ok(0);
        }
        #[cfg(feature = "queued-worker-probe")]
        let slot = {
            if !capture_worker::abandon(s, id)? {
                return Ok(0);
            }
            s.executions[i].live_mut()?
        };
        if let Some(call) = &mut slot.continuation {
            let r = s.sealed.as_mut().ok_or(-9)?;
            if !call
                .abandon(
                    &mut r.files,
                    &mut r.reads,
                    &mut s.domain,
                    &mut slot.execution,
                )
                .map_err(|_| -12)?
            {
                return Ok(0);
            }
        }
        if !slot.execution.retireable()
            || {
                #[cfg(not(feature = "capture-v1"))]
                {
                    slot.continuation.as_ref().is_some_and(|c|
                        c.sendfile_pending() || c.sendfile_references(&slot.execution))
                }
                #[cfg(feature = "capture-v1")]
                { false }
            }
            || s.sealed
                .as_ref()
                .is_some_and(|r| r.reads.references(&slot.execution))
        {
            return Ok(0);
        }
        if let Resources::Normal {
            table,
            fs,
            executable,
            ..
        } = &mut slot.resources
        {
            let r = s.sealed.as_mut().ok_or(-9)?;
            if let Some(v) = table.take() {
                if let Err((_, v)) = r.files.let_go(v) {
                    *table = Some(v);
                    return Err(-10);
                }
            }
            if let Some(v) = fs.take() {
                if let Err((_, v)) = r.files.release_fs(v) {
                    *fs = Some(v);
                    return Err(-10);
                }
            }
            if let Some(v) = executable.take() {
                if let Err((_, v)) = r.files.release_executable(v) {
                    *executable = Some(v);
                    return Err(-10);
                }
            }
        }
        // No callback or fallible operation between holder extraction and release.
        let resources = std::mem::replace(&mut slot.resources, Resources::Retired);
        if let Resources::Diagnostic(table) = resources {
            let Some(r) = &mut s.sealed else {
                slot.resources = Resources::Diagnostic(table);
                return Err(-9);
            };
            if let Err((_, table)) = r.files.let_go(table) {
                slot.resources = Resources::Diagnostic(table);
                return Err(-10);
            }
        }
        slot.continuation = None;
        Ok(1)
    })
}

/// Actual host exit before its first invocation, never a timeout or stop request.
#[no_mangle]
pub extern "C" fn linux_execution_unstarted_stopped(id: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        s.executions[i]
            .live_mut()?
            .execution
            .unstarted_stopped()
            .map_err(|_| -11)?;
        Ok(0)
    })
}

/// Explicit prepared-root profile. No diagnostic table is created at seal.
#[no_mangle]
pub extern "C" fn linux_prepared_files(
    inodes: u32,
    entries: u32,
    file_bytes: u32,
    tables: u32,
    descriptions: u32,
    slots: u32,
    reads: u32,
    contexts: u32,
    views: u32,
    holds: u32,
    policy: u32,
) -> i32 {
    with_state(false, |s| {
        if s.builder.is_some() || s.sealed.is_some() || !s.executions.is_empty() {
            return Err(-9);
        }
        if policy & !7 != 0 || contexts == 0 || views == 0 || holds == 0 {
            return Err(-5);
        }
        let tree = Tree::new(
            TREE,
            inodes as usize,
            entries as usize,
            file_bytes as usize,
            crate::inode::Creation {
                mode: 0o755,
                uid: 0,
                gid: 0,
            },
        )
        .map_err(|_| -10)?;
        let capacity = ReadCapacity::new(reads as usize).map_err(read_code)?;
        s.builder = Some(Builder {
            tree: Some(tree),
            sealing: None,
            limits: descriptor::Limits {
                contexts: contexts as usize,
                tables: tables as usize,
                descriptions: descriptions as usize,
                slots: slots as usize,
            },
            capacity: Some(capacity),
            file_limit: file_bytes as usize,
            profile: Some(Profile {
                views: views as usize,
                holds: holds as usize,
                policy: mount::ViewPolicy {
                    no_exec: policy & 1 != 0,
                    no_suid: policy & 2 != 0,
                    no_symfollow: policy & 4 != 0,
                },
            }),
            root_view: None,
            name: Vec::new(),
            input: Vec::new(),
        });
        Ok(1)
    })
}
const ROOT_WIRE_MAX: usize = 16 * 1024 * 1024;
#[no_mangle]
pub extern "C" fn linux_root_input(length: u32) -> i32 {
    with_state(false, |s| {
        if s.builder.is_some() || s.sealed.is_some() || !s.executions.is_empty() {
            return Err(-9);
        }
        if length as usize > ROOT_WIRE_MAX {
            return Err(-5);
        }
        let mut input = Vec::new();
        input.try_reserve_exact(length as usize).map_err(|_| -1)?;
        input.resize(length as usize, 0);
        s.root_input = input;
        Ok(if length == 0 {
            0
        } else {
            s.root_input.as_mut_ptr() as u64
        })
    })
}
/// Build and seal locally, then publish once. No component-builder alias or
/// partial namespace is exposed, and no source callback/image can run here.
#[no_mangle]
pub extern "C" fn linux_prepared_root(
    inodes: u32,
    entries: u32,
    file_bytes: u32,
    tables: u32,
    descriptions: u32,
    slots: u32,
    reads: u32,
    contexts: u32,
    views: u32,
    holds: u32,
    policy: u32,
    fd_limit: u32,
) -> i32 {
    with_state(false, |s| {
        // Every attempted seal consumes its private staging, including failure.
        let input = std::mem::take(&mut s.root_input);
        if s.builder.is_some() || s.sealed.is_some() || !s.executions.is_empty() {
            return Err(-9);
        }
        if policy & !7 != 0 || contexts == 0 || views == 0 || holds == 0 {
            return Err(-5);
        }
        let capacity = ReadCapacity::new(reads as usize).map_err(read_code)?;
        let image = RootImage::build(
            TREE,
            &input,
            RootLimits {
                inodes: inodes as usize,
                entries: entries as usize,
                file_bytes: file_bytes as usize,
            },
        )
        .map_err(|_| -10)?;
        let (tree, catalog) = image.into_parts();
        let mut files = Files::new(
            FILES,
            tree,
            descriptor::Limits {
                contexts: contexts as usize,
                tables: tables as usize,
                descriptions: descriptions as usize,
                slots: slots as usize,
            },
        );
        let view = files
            .bootstrap_mount(
                inode(1),
                mount::Limits {
                    views: views as usize,
                    holds: holds as usize,
                },
                mount::ViewPolicy {
                    no_exec: policy & 1 != 0,
                    no_suid: policy & 2 != 0,
                    no_symfollow: policy & 4 != 0,
                },
            )
            .map_err(|_| -10)?;
        let root = files.view_root(&view).map_err(|_| -10)?;
        let reads = Reads::new(&files, capacity);
        s.sealed = Some(Sealed {
            files,
            #[cfg(feature = "queued-output-probe")]
            queue_probe: None,
            table: None,
            root: Some(root),
            root_view: Some(view),
            fd_limit,
            reads,
            input: Vec::new(),
            file_limit: file_bytes as usize,
        });
        s.root_catalog = Some(catalog);
        Ok(0)
    })
}
/// Immutable transport locator, not guest path/FD selection or a read attempt.
#[no_mangle]
pub extern "C" fn linux_root_source(source: u32) -> i32 {
    with_state(false, |s| {
        let source = s
            .root_catalog
            .as_ref()
            .ok_or(-9)?
            .source(source)
            .ok_or(-10)?;
        s.length = source.size;
        s.auxiliary = source.at;
        s.endpoint = source.stored;
        s.state = u32::from(source.raw);
        Ok(source.pack as u64)
    })
}
/// Fixed metadata snapshot. Host copies synchronously before any export/await.
#[no_mangle]
pub extern "C" fn linux_root_artifact(artifact: u32) -> i32 {
    with_state(false, |s| {
        let catalog = s.root_catalog.as_ref().ok_or(-9)?;
        let artifact = catalog.artifact(artifact).ok_or(-10)?;
        let source = catalog.source(artifact.source).ok_or(-10)?;
        let out = &mut s.artifact_info;
        out[..32].copy_from_slice(catalog.generation());
        out[32..64].copy_from_slice(&artifact.source_digest);
        out[64..96].copy_from_slice(&artifact.artifact_digest);
        out[96..128].copy_from_slice(&artifact.translator_digest);
        out[128..132].copy_from_slice(&artifact.source.to_le_bytes());
        out[132..136].copy_from_slice(&u32::from(artifact.shared).to_le_bytes());
        out[136..144].copy_from_slice(&source.size.to_le_bytes());
        out[144..152].copy_from_slice(&artifact.inode.number().to_le_bytes());
        out[152..].fill(0);
        s.length = out.len() as u64;
        Ok(out.as_ptr() as u64)
    })
}
const STARTUP_WIRE_MAX: usize = 2 * 1024 * 1024;
fn startup_limits() -> crate::stack::Limits {
    crate::stack::Limits {
        max_string_bytes: 128 * 1024,
        max_input_bytes: STARTUP_WIRE_MAX as u64,
        max_pointers: 65536,
    }
}
fn startup_word(bytes: &[u8], at: &mut usize) -> Result<u64, i32> {
    let end = at.checked_add(8).ok_or(-5)?;
    let b = bytes.get(*at..end).ok_or(-5)?;
    *at = end;
    Ok(u64::from_le_bytes(b.try_into().unwrap()))
}
fn startup_string<'a>(bytes: &'a [u8], at: &mut usize, n: u64) -> Result<&'a [u8], i32> {
    let n = usize::try_from(n).map_err(|_| -5)?;
    if n >= 128 * 1024 {
        return Err(-5);
    }
    let end = at.checked_add(n).ok_or(-5)?;
    let b = bytes.get(*at..end).ok_or(-5)?;
    if b.contains(&0) {
        return Err(-5);
    }
    *at = end;
    Ok(b)
}
fn slot_index(s: &State, id: u64) -> Result<usize, i32> {
    let i = usize::try_from(id.checked_sub(1).ok_or(-11)?).map_err(|_| -11)?;
    if i < s.executions.len() {
        Ok(i)
    } else {
        Err(-11)
    }
}
#[no_mangle]
pub extern "C" fn linux_startup_input(length: u32) -> i32 {
    with_state(false, |s| {
        if length as usize > STARTUP_WIRE_MAX {
            return Err(-5);
        }
        let mut b = Vec::new();
        b.try_reserve_exact(length as usize).map_err(|_| -1)?;
        b.resize(length as usize, 0);
        s.startup_input = b;
        Ok(if length == 0 {
            0
        } else {
            s.startup_input.as_mut_ptr() as u64
        })
    })
}
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_startup_begin() -> i32 {
    startup_begin(StartupTable::Empty)
}
#[cfg(not(feature = "capture-v1"))]
#[no_mangle]
pub extern "C" fn linux_startup_begin_stdio() -> i32 {
    startup_begin(StartupTable::Physical)
}
/// Actual captured OFD installation only in the already rejected test artifact.
/// This does not select a Worker, guest output, or a host receiver.
#[cfg(all(feature = "queued-output-probe", not(feature = "capture-v1")))]
#[no_mangle]
pub extern "C" fn linux_queued_output_probe_startup() -> i32 {
    startup_begin(StartupTable::CaptureProbe {
        shared_output: false,
    })
}
/// Deliberate stdout/stderr alias for the stronger, still rejected fixture.
/// The actual captured profile does not expose this diagnostic entry.
#[cfg(all(feature = "queued-worker-probe", not(feature = "capture-v1")))]
#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_startup_shared() -> i32 {
    startup_begin(StartupTable::CaptureProbe {
        shared_output: true,
    })
}
#[cfg(not(feature = "capture-v1"))]
#[derive(Clone, Copy)]
enum StartupTable {
    Empty,
    Physical,
    #[cfg(feature = "queued-output-probe")]
    CaptureProbe {
        shared_output: bool,
    },
}
#[cfg(not(feature = "capture-v1"))]
fn startup_begin(table: StartupTable) -> i32 {
    with_state(false, |s| {
        let wire = &s.startup_input;
        let mut at = 0;
        let version = startup_word(wire, &mut at)?;
        if version != 1 && version != 2 {
            return Err(-5);
        }
        let argc = usize::try_from(startup_word(wire, &mut at)?).map_err(|_| -5)?;
        let envc = usize::try_from(startup_word(wire, &mut at)?).map_err(|_| -5)?;
        let pathlen = startup_word(wire, &mut at)?;
        let count = argc.checked_add(envc).filter(|n| *n <= 65536).ok_or(-5)?;
        let random: [u8; 16] = wire.get(at..at + 16).ok_or(-5)?.try_into().unwrap();
        at += 16;
        let cwd = if version == 2 {
            let length = startup_word(wire, &mut at)?;
            if length == 0 || length > 4095 {
                return Err(-5);
            }
            startup_string(wire, &mut at, length)?
        } else {
            b"/".as_slice()
        };
        let path = startup_string(wire, &mut at, pathlen)?;
        let mut strings = Vec::new();
        strings.try_reserve_exact(count).map_err(|_| -1)?;
        for _ in 0..count {
            let n = startup_word(wire, &mut at)?;
            strings.push(startup_string(wire, &mut at, n)?);
        }
        if at != wire.len() {
            return Err(-5);
        }
        crate::stack::validate_arguments(
            path,
            &strings[..argc],
            &strings[argc..],
            startup_limits(),
        )
        .map_err(|_| -5)?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let root = r.root.as_ref().ok_or(-11)?;
        #[cfg(feature = "queued-output-probe")]
        if let StartupTable::CaptureProbe { shared_output } = table {
            r.queue_probe
                .as_ref()
                .ok_or(-9)?
                .check_stdio(shared_output)
                .map_err(queue_probe_error)?;
        }
        if s.executions.len() >= s.execution_limit {
            return Err(-1);
        }
        s.executions.try_reserve(1).map_err(|_| -1)?;
        let id = s.executions.len() as u64 + 1;
        s.executions.push(Slot::Preparing(Preparing {
            startup: None,
            program: None,
            failed_image: None,
            fs: None,
            table: None,
            random,
        }));
        s.result = id; // Failure after admission leaves an addressable cleanup owner.
        let p = s.executions.last_mut().unwrap().preparing_mut()?;
        p.fs = Some(r.files.create_fs(root, root, 0o022).map_err(|_| -10)?);
        r.files
            .select_cwd(p.fs.as_ref().unwrap(), &Credentials::initial_root(), cwd)
            .map_err(|_| -10)?;
        p.table = Some(match table {
            StartupTable::Empty => r.files.table(r.fd_limit).map_err(|_| -10)?,
            StartupTable::Physical => r.files.stdio([1, 2, 3], r.fd_limit).map_err(|_| -10)?,
            #[cfg(feature = "queued-output-probe")]
            StartupTable::CaptureProbe { shared_output } => r
                .queue_probe
                .as_ref()
                .expect("validated capture probe")
                .stdio(&mut r.files, r.fd_limit, shared_output)
                .map_err(queue_probe_error)?,
        });
        p.program = Some(
            r.files
                .prepare_program(p.fs.as_ref().unwrap(), &Credentials::initial_root(), path)
                .map_err(|_| -10)?,
        );
        match Startup::new(
            id,
            &r.files,
            p.program.take().unwrap(),
            &strings[..argc],
            &strings[argc..],
            startup_limits(),
        ) {
            Ok(v) => p.startup = Some(v),
            Err((_, v)) => {
                p.program = Some(v);
                return Err(-10);
            }
        }
        s.startup_input = Vec::new();
        Ok(id)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_check(id: u64) -> i32 {
    with_state(false, |s| {
        let i = slot_index(s, id)?;
        let p = s.executions[i].preparing_mut()?;
        if !p.startup.as_ref().is_some_and(|v| v.continuable()) {
            return Err(-11);
        }
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_artifact_start(id: u64) -> i32 {
    with_state(false, |s| {
        let i = slot_index(s, id)?;
        let startup = s.executions[i]
            .preparing_mut()?
            .startup
            .as_mut()
            .ok_or(-11)?;
        let files = &mut s.sealed.as_mut().ok_or(-9)?.files;
        let identity = startup.selected_identity(files).map_err(|_| -10)?;
        let catalog = s.root_catalog.as_ref().ok_or(-9)?;
        let (artifact, record) = catalog.artifact_for(identity.inode).ok_or(-11)?;
        let source = catalog.source(record.source).ok_or(-10)?;
        if record.source != identity.source || source.size != identity.size as u64 || !record.shared
        {
            return Err(-10);
        }
        startup
            .artifact_start(files, artifact, identity)
            .map_err(|_| -10)?;
        Ok(artifact as u64)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_artifact_finish(
    id: u64,
    artifact: u32,
    success: u32,
    entry: u64,
    phdr: u64,
    phent: u64,
    phnum: u64,
    extent: u64,
) -> i32 {
    with_state(false, |s| {
        if success > 1 {
            return Err(-5);
        }
        let i = slot_index(s, id)?;
        let startup = s.executions[i]
            .preparing_mut()?
            .startup
            .as_mut()
            .ok_or(-11)?;
        let files = &mut s.sealed.as_mut().ok_or(-9)?.files;
        startup
            .artifact_finish(
                files,
                id,
                artifact,
                if success == 1 {
                    Some(Facts {
                        entry,
                        phdr,
                        phent,
                        phnum,
                        extent,
                    })
                } else {
                    None
                },
            )
            .map_err(|_| -10)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_source_start(id: u64) -> i32 {
    with_state(false, |s| {
        let i = slot_index(s, id)?;
        let p = s.executions[i].preparing_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        match p
            .startup
            .as_mut()
            .ok_or(-11)?
            .source_start(&mut r.files)
            .map_err(|_| -10)?
        {
            Some(v) => {
                s.auxiliary = v.attempt as u64;
                Ok(v.source as u64)
            }
            None => Ok(0),
        }
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_source_finish(id: u64, attempt: u32, success: u32) -> i32 {
    with_state(false, |s| {
        if success > 1 {
            return Err(-5);
        }
        let i = slot_index(s, id)?;
        let p = s.executions[i].preparing_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        p.startup
            .as_mut()
            .ok_or(-11)?
            .source_finish(&mut r.files, id, attempt, success == 1, &mut r.input)
            .map_err(|_| -10)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_bytes(id: u64) -> i32 {
    with_state(false, |s| {
        let i = slot_index(s, id)?;
        let p = s.executions[i].preparing_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let bytes = p
            .startup
            .as_mut()
            .ok_or(-11)?
            .translation_start(&mut r.files)
            .map_err(|_| -10)?;
        s.length = bytes.len() as u64;
        Ok(bytes.as_ptr() as u64)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_translation_finish(
    id: u64,
    success: u32,
    entry: u64,
    phdr: u64,
    phent: u64,
    phnum: u64,
    extent: u64,
) -> i32 {
    with_state(false, |s| {
        if success > 1 {
            return Err(-5);
        }
        let i = slot_index(s, id)?;
        s.executions[i]
            .preparing_mut()?
            .startup
            .as_mut()
            .ok_or(-11)?
            .translation_finish(
                id,
                if success == 1 {
                    Some(Facts {
                        entry,
                        phdr,
                        phent,
                        phnum,
                        extent,
                    })
                } else {
                    None
                },
            )
            .map_err(|_| -10)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_image_begin(id: u64, binding: u64, low: u64, top: u64) -> i32 {
    with_state(false, |s| {
        let i = slot_index(s, id)?;
        if s.executions.iter().any(|v| v.binding() == Some(binding)) {
            return Err(-4);
        }
        let p = s.executions[i].preparing_mut()?;
        p.startup
            .as_mut()
            .ok_or(-11)?
            .image_begin(&mut s.domain, binding, low, top, &p.random)
            .map_err(|_| -11)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_stack(id: u64) -> i32 {
    with_state(false, |s| {
        let i = slot_index(s, id)?;
        let p = s.executions[i].preparing_mut()?;
        let stack = p.startup.as_ref().ok_or(-11)?.stack().map_err(|_| -11)?;
        s.length = stack.bytes.len() as u64;
        s.auxiliary = stack.pointer;
        Ok(stack.bytes.as_ptr() as u64)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_image_finish(id: u64, outcome: u32) -> i32 {
    with_state(false, |s| {
        let i = slot_index(s, id)?;
        let p = s.executions[i].preparing_mut()?;
        let outcome = match outcome {
            0 => ImageResult::Installed,
            1 => ImageResult::Untouched,
            2 => ImageResult::PoisonedStopped,
            3 => ImageResult::Unknown,
            _ => return Err(-5),
        };
        let startup = p.startup.as_mut().ok_or(-11)?;
        startup
            .image_finish(&mut s.domain, outcome)
            .map_err(|_| -11)?;
        let binding = startup.binding().ok_or(-11)?;
        if let Some(live) = startup.take_live() {
            let resources = Resources::Normal {
                table: p.table.take(),
                fs: p.fs.take(),
                executable: Some(live.executable),
                decision: live.decision,
                facts: live.facts,
            };
            s.executions[i] = Slot::Live(ExecutionSlot {
                normal: true,
                resources,
                execution: live.execution,
                continuation: None,
            });
        }
        Ok(binding)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_failed_image(id: u64) -> i32 {
    with_state(false, |s| {
        let i = slot_index(s, id)?;
        let p = s.executions[i].preparing_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        if p.failed_image.is_none() {
            p.failed_image = p
                .startup
                .as_mut()
                .ok_or(-11)?
                .take_failed_image(&mut r.files)
                .map_err(|_| -10)?;
        }
        Ok(p.failed_image.as_ref().ok_or(-11)?.binding())
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_cancel(id: u64) -> i32 {
    with_state(false, |s| {
        let i = slot_index(s, id)?;
        if matches!(s.executions[i], Slot::Retired(_)) {
            return Ok(1);
        }
        let p = s.executions[i].preparing_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        if let Some(v) = p.startup.as_mut() {
            if !v.cancel(&mut r.files).map_err(|_| -10)? {
                return Ok(0);
            }
        }
        if let Some(v) = p.program.take() {
            if let Err((_, v)) = r.files.release_program(v) {
                p.program = Some(v);
                return Err(-10);
            }
        }
        if let Some(v) = p.table.take() {
            if let Err((_, v)) = r.files.let_go(v) {
                p.table = Some(v);
                return Err(-10);
            }
        }
        if let Some(v) = p.fs.take() {
            if let Err((_, v)) = r.files.release_fs(v) {
                p.fs = Some(v);
                return Err(-10);
            }
        }
        // Retain failed physical binding identity, not a physical reclamation claim.
        let evidence = p.failed_image.take();
        s.executions[i] = Slot::Retired(evidence);
        Ok(1)
    })
}
#[no_mangle]
pub extern "C" fn linux_startup_entry(id: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        match &s.executions[i].live()?.resources {
            Resources::Normal { facts, .. } => Ok(facts.entry),
            _ => Err(-11),
        }
    })
}
