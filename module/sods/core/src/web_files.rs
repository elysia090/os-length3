//! No host imports or callbacks. Scratch views live only until the next export.
use crate::files::{Error, Files};
use std::cell::RefCell;
struct State {
    files: Files,
    scratch: Vec<u8>,
    limit: usize,
    input: bool,
}
thread_local! { static STATE: RefCell<Option<State>> = const { RefCell::new(None) }; }
fn error(e: Error) -> i32 {
    match e {
        Error::BadHandle => -1,
        Error::TooLarge => -2,
        Error::NoMemory => -3,
        Error::Exhausted => -4,
    }
}
fn with(f: impl FnOnce(&mut State) -> Result<i32, Error>) -> i32 {
    STATE.with(|s| match s.borrow_mut().as_mut() {
        Some(s) => f(s).unwrap_or_else(error),
        None => -5,
    })
}
#[no_mangle]
pub extern "C" fn files_abi_version() -> u32 {
    1
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
        });
        0
    })
}
#[no_mangle]
pub extern "C" fn files_input(length: u32) -> i32 {
    with(|s| {
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
    with(|s| {
        if !s.input {
            return Err(Error::BadHandle);
        }
        s.input = false;
        s.files.create(&s.scratch).map(|id| id as i32)
    })
}
#[no_mangle]
pub extern "C" fn files_write(id: u32, at: u32) -> i32 {
    with(|s| {
        if !s.input {
            return Err(Error::BadHandle);
        }
        s.input = false;
        s.files.write(id, at as usize, &s.scratch)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn files_read(id: u32, at: u32, length: u32) -> i32 {
    with(|s| {
        s.input = false;
        let data = s.files.read(id, at as usize, length as usize)?;
        if data.len() > s.scratch.len() {
            s.scratch
                .try_reserve_exact(data.len() - s.scratch.len())
                .map_err(|_| Error::NoMemory)?;
        }
        s.scratch.clear();
        s.scratch.extend_from_slice(data);
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn files_truncate(id: u32, length: u32) -> i32 {
    with(|s| {
        s.input = false;
        s.files.truncate(id, length as usize)?;
        Ok(0)
    })
}
#[no_mangle]
pub extern "C" fn files_close(id: u32) -> i32 {
    with(|s| {
        s.input = false;
        s.files.close(id)?;
        Ok(0)
    })
}
