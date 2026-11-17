//! No host imports or callbacks. Read scratch is leased until matching finish;
//! pointer/length queries do not end it. Input scratch is transient until the
//! next mutation. Raw memory exports are not a safe public embedding API.
use crate::files::{Error, Files};
use crate::pending_read::{CopyResult, Reads};
use std::cell::RefCell;
struct State {
    files: Files,
    scratch: Vec<u8>,
    limit: usize,
    input: bool,
    reads: Reads,
}
thread_local! { static STATE: RefCell<Option<State>> = const { RefCell::new(None) }; }
fn error(e: Error) -> i32 {
    match e {
        Error::BadHandle => -1,
        Error::TooLarge => -2,
        Error::NoMemory => -3,
        Error::Exhausted => -4,
        Error::Busy => -6,
        Error::BadCompletion => -7,
        Error::LoadConflict => -8,
    }
}
fn with(f: impl FnOnce(&mut State) -> Result<i32, Error>) -> i32 {
    STATE.with(|s| match s.borrow_mut().as_mut() {
        Some(s) => f(s).unwrap_or_else(error),
        None => -5,
    })
}
fn idle(f: impl FnOnce(&mut State) -> Result<i32, Error>) -> i32 {
    with(|s| {
        s.reads.idle()?;
        f(s)
    })
}
#[no_mangle]
pub extern "C" fn files_abi_version() -> u32 {
    4
}
#[no_mangle]
pub extern "C" fn files_init(limit: u32) -> i32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if s.is_some() || limit > i32::MAX as u32 {
            return -5;
        }
        *s = Some(State {
            files: Files::new(limit as usize),
            scratch: Vec::new(),
            limit: limit as usize,
            input: false,
            reads: Reads::default(),
        });
        0
    })
}
#[no_mangle]
pub extern "C" fn files_input(length: u32) -> i32 {
    idle(|s| {
        s.input = false;
        let n = length as usize;
        if n > s.limit {
            return Err(Error::TooLarge);
        }
        if n > s.scratch.len() {
            s.scratch
                .try_reserve_exact(n - s.scratch.len())
                .map_err(|_| Error::NoMemory)?;
        }
        s.scratch.resize(n, 0);
        s.input = true;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn files_ptr() -> u32 {
    STATE.with(|s| s.borrow().as_ref().map_or(0, |s| s.scratch.as_ptr() as u32))
}
#[no_mangle]
pub extern "C" fn files_len() -> u32 {
    STATE.with(|s| s.borrow().as_ref().map_or(0, |s| s.scratch.len() as u32))
}
#[no_mangle]
pub extern "C" fn files_create() -> i32 {
    idle(|s| {
        if !s.input {
            return Err(Error::BadHandle);
        }
        s.input = false;
        s.files.create(&s.scratch).map(|id| id as i32)
    })
}
#[no_mangle]
pub extern "C" fn files_write(id: u32, at: u32) -> i32 {
    idle(|s| {
        if !s.input {
            return Err(Error::BadHandle);
        }
        s.input = false;
        s.files.write(id, at as usize, &s.scratch)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn files_read_begin(id: u32, at: u32, length: u32) -> i32 {
    idle(|s| {
        s.input = false;
        s.reads.can_begin()?;
        let data = s.files.read(id, at as usize, length as usize)?;
        if data.len() > s.scratch.len() {
            s.scratch
                .try_reserve_exact(data.len() - s.scratch.len())
                .map_err(|_| Error::NoMemory)?;
        }
        s.scratch.clear();
        s.scratch.extend_from_slice(data);
        s.reads
            .begin(id, at as usize, length as usize, data.len())
            .map(|op| op as i32)
    })
}
#[no_mangle]
pub extern "C" fn files_truncate(id: u32, length: u32) -> i32 {
    idle(|s| {
        s.input = false;
        s.files.truncate(id, length as usize)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn files_close(id: u32) -> i32 {
    idle(|s| {
        s.input = false;
        s.files.close(id)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn files_read_finish(operation: u32, outcome: u32, count: u32) -> i32 {
    with(|s| {
        let result = match (outcome, count) {
            (0, n) => CopyResult::Copied(n as usize),
            (1, 0) => CopyResult::Unknown,
            _ => return Err(Error::BadCompletion),
        };
        s.reads.finish(operation, result).map(|n| n as i32)
    })
}

#[no_mangle]
pub extern "C" fn files_create_lazy(source: u32, size: u32) -> i32 {
    idle(|s| {
        s.input = false;
        s.files
            .create_lazy(source, size as usize)
            .map(|id| id as i32)
    })
}
#[no_mangle]
pub extern "C" fn files_load_begin(id: u32) -> i32 {
    idle(|s| {
        s.input = false;
        s.files.load_begin(id).map(|op| op as i32)
    })
}
#[no_mangle]
pub extern "C" fn files_load_source(id: u32) -> i32 {
    with(|s| s.files.load_source(id).map(|source| source as i32))
}
#[no_mangle]
pub extern "C" fn files_load_finish(id: u32, operation: u32, outcome: u32) -> i32 {
    idle(|s| {
        if outcome > 1 {
            return Err(Error::BadCompletion);
        }
        let success = outcome == 0;
        if success && !s.input {
            return Err(Error::BadCompletion);
        }
        s.input = false;
        s.files.load_finish(
            id,
            operation,
            success,
            if success { &s.scratch } else { &[] },
        )?;
        if success {
            s.files.size(id).map(|n| n as i32)
        } else {
            Ok(0)
        }
    })
}

#[no_mangle]
pub extern "C" fn files_size(id: u32) -> i32 {
    with(|s| s.files.size(id).map(|n| n as i32))
}

#[no_mangle]
pub extern "C" fn files_load_check(id: u32) -> i32 {
    with(|s| {
        s.files.load_check(id)?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn files_resident(id: u32) -> i32 {
    with(|s| s.files.resident(id).map(|n| n as i32))
}
#[no_mangle]
pub extern "C" fn files_release(id: u32) -> i32 {
    idle(|s| {
        s.input = false;
        s.files.release(id).map(|n| n as i32)
    })
}
#[no_mangle]
pub extern "C" fn files_own(id: u32) -> i32 {
    idle(|s| {
        s.input = false;
        s.files.own(id)?;
        Ok(0)
    })
}
