//! Private wasm32 host-admission ABI. One domain per instance; never reinitialize.
//! No guest pointers, guest imports, allocation callbacks or Linux syscalls yet.
//! Output identities use u64 (JS BigInt), not lossy number casts. The synchronous
//! caller must read linux_result before another call. Failed calls clear it.
use crate::effect::{Completion, Token};
use crate::lease::{Domain, Error};
use std::cell::RefCell;

struct State {
    domain: Domain,
    result: u64,
}
thread_local! { static STATE: RefCell<Option<State>> = const { RefCell::new(None) }; }
const DOMAIN: u64 = 1;
const WASM32_BYTES: u64 = 1u64 << 32;
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
fn with(f: impl FnOnce(&mut Domain) -> Result<u64, Error>) -> i32 {
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        let Some(state) = state.as_mut() else {
            return -9;
        };
        state.result = 0;
        match f(&mut state.domain) {
            Ok(value) => {
                state.result = value;
                0
            }
            Err(error) => code(error),
        }
    })
}
fn token(sequence: u64) -> Token {
    Token::from_parts(DOMAIN, sequence)
}
#[no_mangle]
pub extern "C" fn linux_abi_version() -> u32 {
    1
}
#[no_mangle]
pub extern "C" fn linux_init(memories: u32, actions: u32) -> i32 {
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        if let Some(state) = state.as_mut() {
            state.result = 0;
            return -9;
        }
        let domain = match Domain::new(DOMAIN, memories as usize, actions as usize) {
            Ok(domain) => domain,
            Err(error) => return code(error),
        };
        *state = Some(State { domain, result: 0 });
        0
    })
}
#[no_mangle]
pub extern "C" fn linux_result() -> u64 {
    STATE.with(|cell| cell.borrow().as_ref().map_or(0, |state| state.result))
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
pub extern "C" fn linux_span(binding: u64, offset: u64, length: u64) -> i32 {
    with(|d| d.span(binding, offset, length).map(|t| t.sequence()))
}
#[no_mangle]
pub extern "C" fn linux_change(binding: u64, extent: u64) -> i32 {
    with(|d| {
        if extent > WASM32_BYTES {
            Err(Error::Range)
        } else {
            d.change(binding, extent).map(|t| t.sequence())
        }
    })
}
#[no_mangle]
pub extern "C" fn linux_start(sequence: u64) -> i32 {
    with(|d| d.start(token(sequence)).map(|_| 0))
}
#[no_mangle]
pub extern "C" fn linux_cancel(sequence: u64) -> i32 {
    with(|d| d.cancel(token(sequence)).map(|_| 0))
}
#[no_mangle]
pub extern "C" fn linux_receipt(sequence: u64, confirmed: u64, completion: u32) -> i32 {
    with(|d| {
        let completion = match completion {
            0 => Completion::Stopped,
            1 => Completion::Unknown,
            _ => return Err(Error::Range),
        };
        d.receipt(token(sequence), confirmed, completion).map(|_| 0)
    })
}
#[no_mangle]
pub extern "C" fn linux_retire(sequence: u64) -> i32 {
    with(|d| {
        d.retire(token(sequence))
            .map(|binding| binding.unwrap_or(0))
    })
}

#[no_mangle]
pub extern "C" fn linux_binding_room() -> i32 {
    with(|d| d.binding_room().map(|_| 0))
}
