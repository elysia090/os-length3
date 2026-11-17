//! Private wasm32 ABI, one managed domain per instance. The read/exit syscall
//! entry is a limited fixed-memory diagnostic, not the full Linux runtime.
//! Prepared resident Tree is sealed once into Files; no source mutation afterward.
//! The host reads result fields before making a fresh core view. Between read_start
//! and read_receipt it performs only intrinsic synchronous copy, no callback/await.
use crate::descriptor::{self, Files, Table};
use crate::effect::{Completion, Token};
use crate::execution::{Execution, ImageResult, Unwind};
use crate::inode::{Inode, Tree};
use crate::lease::{Domain, Error};
use crate::read::{ReadCapacity, Reads};
use crate::syscall::{Continuation, Step};
use std::cell::RefCell;
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
    name: Vec<u8>,
    input: Vec<u8>,
}
struct Sealed {
    files: Files,
    table: Table,
    reads: Reads,
    input: Vec<u8>,
    file_limit: usize,
}
struct ExecutionSlot {
    execution: Execution,
    continuation: Option<Continuation>,
}
struct State {
    domain: Domain,
    executions: Vec<ExecutionSlot>,
    execution_limit: usize,
    result: u64,
    length: u64,
    auxiliary: u64,
    state: u32,
    builder: Option<Builder>,
    sealed: Option<Sealed>,
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
fn with_state(allow_view: bool, f: impl FnOnce(&mut State) -> Result<u64, i32>) -> i32 {
    STATE.with(|cell| {
        let mut outer = cell.borrow_mut();
        let Some(s) = outer.as_mut() else {
            return -9;
        };
        s.result = 0;
        s.length = 0;
        s.auxiliary = 0;
        s.state = 0;
        if !allow_view && s.sealed.as_ref().is_some_and(|r| r.reads.viewing()) {
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
        if s.sealed.as_ref().is_some_and(|r| r.reads.owns(t))
            || s.executions.iter().any(|e| e.execution.owns(t))
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
    2
}
#[no_mangle]
pub extern "C" fn linux_init(memories: u32, actions: u32) -> i32 {
    STATE.with(|cell| {
        let mut outer = cell.borrow_mut();
        if let Some(s) = outer.as_mut() {
            s.result = 0;
            s.length = 0;
            s.auxiliary = 0;
            s.state = 0;
            return -9;
        }
        let domain = match Domain::new(DOMAIN, memories as usize, actions as usize) {
            Ok(d) => d,
            Err(e) => return code(e),
        };
        *outer = Some(State {
            domain,
            executions: Vec::new(),
            execution_limit: memories as usize,
            result: 0,
            length: 0,
            auxiliary: 0,
            state: 0,
            builder: None,
            sealed: None,
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
    with(|d| d.span(binding, offset, length).map(|t| t.sequence()))
}
#[no_mangle]
pub extern "C" fn linux_change(binding: u64, extent: u64) -> i32 {
    with_state(false, |s| {
        // An execution owns its image incarnation. Generic physical growth must
        // not silently leave that owner pointing at a retired binding.
        if s.executions
            .iter()
            .any(|e| e.execution.binding() == binding)
        {
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
        let tree = Tree::new(TREE, inodes as usize, entries as usize, file_bytes as usize)
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
            .directory(inode(parent), &b.name, mode)
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
            .file_take(inode(parent), &b.name, mode, &mut b.input)
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
        let table = b
            .sealing
            .as_mut()
            .ok_or(-9)?
            .table(fd_limit)
            .map_err(|_| -10)?;
        // Capacity was acquired in prepare, before ownership moved into Files.
        let files = b.sealing.take().unwrap();
        let capacity = b.capacity.take().unwrap();
        let reads = Reads::new(&files, capacity);
        s.sealed = Some(Sealed {
            files,
            table,
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
            .open(&r.table, inode(node), false)
            .map(|fd| fd as u64)
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_dup(fd: u32) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.files
            .dup(&r.table, fd, 0, false)
            .map(|fd| fd as u64)
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_close(fd: u32) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.files.close(&r.table, fd).map(|_| 0).map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_offset(fd: u32) -> i32 {
    with_state(true, |s| {
        let r = s.sealed.as_ref().ok_or(-9)?;
        r.files.offset(&r.table, fd).map(|v| v.0).map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_seek(fd: u32, offset: u64) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.files
            .set_offset(&r.table, fd, offset)
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
                &r.table,
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
        if s.executions
            .iter()
            .any(|e| e.continuation.as_ref().is_some_and(|c| c.owns_read(id)))
        {
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
    if n < s.executions.len() {
        Ok(n)
    } else {
        Err(-11)
    }
}
#[no_mangle]
pub extern "C" fn linux_execution_create(binding: u64) -> i32 {
    with_state(false, |s| {
        s.domain.range(binding, 0, 0).map_err(code)?;
        if s.executions
            .iter()
            .any(|e| e.execution.binding() == binding)
        {
            return Err(-4);
        }
        if s.executions.len() == s.execution_limit {
            return Err(-1);
        }
        s.executions.try_reserve(1).map_err(|_| -1)?;
        let id = s.executions.len() as u64 + 1;
        s.executions.push(ExecutionSlot {
            execution: Execution::new(id, binding),
            continuation: None,
        });
        Ok(id)
    })
}
#[no_mangle]
pub extern "C" fn linux_image_begin(id: u64, extent: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        s.executions[i]
            .execution
            .image_begin(&mut s.domain, extent)
            .map_err(|_| -11)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_image_finish(id: u64, outcome: u32) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let outcome = match outcome {
            0 => ImageResult::Installed,
            1 => ImageResult::Untouched,
            2 => ImageResult::PoisonedStopped,
            3 => ImageResult::Unknown,
            _ => return Err(-5),
        };
        s.executions[i]
            .execution
            .image_finish(&mut s.domain, outcome)
            .map_err(|_| -11)?;
        Ok(s.executions[i].execution.binding())
    })
}
#[no_mangle]
pub extern "C" fn linux_tree_lazy(parent: u64, mode: u32, source: u32, size: u32) -> i32 {
    with_state(false, |s| {
        let b = s.builder.as_mut().ok_or(-9)?;
        b.tree
            .as_mut()
            .ok_or(-9)?
            .lazy_file(inode(parent), &b.name, mode, source, size as usize)
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
                &r.table,
                &mut s.domain,
                &s.executions[i].execution,
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
            .load_start(&mut r.files, &s.executions[i].execution, id)
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
    let slot = &mut s.executions[i];
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
            .start_managed(&mut r.files, &mut s.domain, &s.executions[i].execution, id)
            .map_err(read_code)?;
        s.length = length;
        Ok(pointer as u64)
    })
}

#[no_mangle]
pub extern "C" fn linux_result_auxiliary() -> u64 {
    STATE.with(|cell| cell.borrow().as_ref().map_or(0, |s| s.auxiliary))
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
        let slot = &mut s.executions[i];
        if slot.continuation.is_none() {
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
        let e = &mut s.executions[i].execution;
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
        let i = execution_index(s, id)?;
        let slot = &mut s.executions[i];
        let invocation = slot.execution.invocation(invocation).map_err(|_| -11)?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let command = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .enter(
                &mut r.files,
                &r.table,
                &mut r.reads,
                &mut s.domain,
                &mut slot.execution,
                invocation,
                nr,
                [a, b, c, d, e, f],
                next,
            )
            .map_err(|_| -12)?;
        Ok(step(s, command))
    })
}
#[no_mangle]
pub extern "C" fn linux_syscall_complete(id: u64) -> i32 {
    with_state(false, |s| {
        let i = execution_index(s, id)?;
        let slot = &mut s.executions[i];
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
        let slot = &mut s.executions[i];
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
        let i = execution_index(s, id)?;
        let slot = &mut s.executions[i];
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
