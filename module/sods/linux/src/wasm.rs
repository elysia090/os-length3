//! Private wasm32 ABI, one managed domain per instance. No guest syscall entry.
//! Prepared resident Tree is sealed once into Files; no source mutation afterward.
//! The host reads result fields before making a fresh core view. Between read_start
//! and read_receipt it performs only intrinsic synchronous copy, no callback/await.
use crate::descriptor::{self, Files};
use crate::effect::{Completion, Token};
use crate::inode::{Inode, Tree};
use crate::lease::{Domain, Error};
use crate::read::{ReadCapacity, Reads};
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
struct State {
    domain: Domain,
    result: u64,
    length: u64,
    state: u32,
    builder: Option<Builder>,
    reads: Option<Reads>,
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
        s.state = 0;
        if !allow_view && s.reads.as_ref().is_some_and(Reads::viewing) {
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
        if s.reads.as_ref().is_some_and(|r| r.owns(t)) {
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
            s.state = 0;
            return -9;
        }
        let domain = match Domain::new(DOMAIN, memories as usize, actions as usize) {
            Ok(d) => d,
            Err(e) => return code(e),
        };
        *outer = Some(State {
            domain,
            result: 0,
            length: 0,
            state: 0,
            builder: None,
            reads: None,
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
    with(|d| d.change(binding, extent).map(|t| t.sequence()))
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
        if s.builder.is_some() || s.reads.is_some() {
            return Err(-9);
        }
        let tree = Tree::new(TREE, inodes as usize, entries as usize, file_bytes as usize)
            .map_err(|_| -10)?;
        let capacity = ReadCapacity::new(reads as usize).map_err(read_code)?;
        s.builder = Some(Builder {
            tree: Some(tree),
            sealing: None,
            limits: descriptor::Limits {
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
        if s.reads.is_some() {
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
        s.reads = Some(Reads::new(files, table, capacity));
        s.builder = None;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn linux_open(node: u64) -> i32 {
    with_state(false, |s| {
        let r = s.reads.as_mut().ok_or(-9)?;
        r.files
            .open(&r.table, inode(node), false)
            .map(|fd| fd as u64)
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_dup(fd: u32) -> i32 {
    with_state(false, |s| {
        let r = s.reads.as_mut().ok_or(-9)?;
        r.files
            .dup(&r.table, fd, 0, false)
            .map(|fd| fd as u64)
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_close(fd: u32) -> i32 {
    with_state(false, |s| {
        let r = s.reads.as_mut().ok_or(-9)?;
        r.files.close(&r.table, fd).map(|_| 0).map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_offset(fd: u32) -> i32 {
    with_state(true, |s| {
        let r = s.reads.as_ref().ok_or(-9)?;
        r.files.offset(&r.table, fd).map(|v| v.0).map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_seek(fd: u32, offset: u64) -> i32 {
    with_state(false, |s| {
        let r = s.reads.as_mut().ok_or(-9)?;
        r.files
            .set_offset(&r.table, fd, offset)
            .map(|_| 0)
            .map_err(|_| -10)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_begin(fd: u32, binding: u64, at: u64, requested: u64) -> i32 {
    with_state(false, |s| {
        s.reads
            .as_mut()
            .ok_or(-9)?
            .begin(&mut s.domain, fd, binding, at, requested)
            .map_err(read_code)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_start(id: u64) -> i32 {
    with_state(false, |s| {
        let (ptr, len) = s
            .reads
            .as_mut()
            .ok_or(-9)?
            .start(&mut s.domain, id)
            .map_err(read_code)?;
        s.length = len;
        Ok(ptr as u64)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_receipt(id: u64, confirmed: u64, done: u32) -> i32 {
    with_state(true, |s| {
        s.reads
            .as_mut()
            .ok_or(-9)?
            .receipt(&mut s.domain, id, confirmed, completion(done)?)
            .map(|_| 0)
            .map_err(read_code)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_cancel(id: u64) -> i32 {
    with_state(true, |s| {
        s.reads
            .as_mut()
            .ok_or(-9)?
            .cancel(&mut s.domain, id)
            .map(|_| 0)
            .map_err(read_code)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_query(id: u64) -> i32 {
    with_state(true, |s| {
        let (confirmed, len, state) = s.reads.as_ref().ok_or(-9)?.query(id).map_err(read_code)?;
        s.length = len;
        s.state = state;
        Ok(confirmed)
    })
}
#[no_mangle]
pub extern "C" fn linux_read_retire(id: u64) -> i32 {
    with_state(false, |s| {
        s.reads
            .as_mut()
            .ok_or(-9)?
            .retire(id)
            .map(|_| 0)
            .map_err(read_code)
    })
}
