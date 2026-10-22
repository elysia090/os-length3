//! The core as a browser runs it (built for wasm32-wasip1; src/core.worker.ts runs it over its own files).
//! A page asks it what the app asks through Tauri: `{"name", "args"}` in, `{"ok"}` or `{"error"}` out
//! (core/src/api.rs answer), as JSON in this module's memory.
//!
//! The host gives a buffer with `l3_alloc`, writes the question into it and calls `l3_call`, which takes
//! the buffer back and returns where the answer is (its address high, its length low); the host reads it
//! and gives it back with `l3_free`.

use std::alloc::{alloc, dealloc, Layout};

fn layout(len: usize) -> Layout {
    Layout::from_size_align(len.max(1), 1).expect("a byte buffer's layout")
}

/// A buffer of `len` bytes for the host to write a question into.
#[no_mangle]
pub extern "C" fn l3_alloc(len: usize) -> *mut u8 {
    // SAFETY: a layout of at least one byte.
    unsafe { alloc(layout(len)) }
}

/// Give back a buffer this module handed out (`l3_alloc`'s, or an answer's).
///
/// # Safety
/// `ptr` and `len` are one buffer this module handed out and the host has not given back yet.
#[no_mangle]
pub unsafe extern "C" fn l3_free(ptr: *mut u8, len: usize) {
    dealloc(ptr, layout(len));
}

/// Answer the question in `ptr..ptr+len` (taken back here); the answer is at the high half, its length the low.
///
/// # Safety
/// `ptr` and `len` are a buffer from `l3_alloc` holding the question.
#[no_mangle]
pub unsafe extern "C" fn l3_call(ptr: *mut u8, len: usize) -> u64 {
    let question = std::slice::from_raw_parts(ptr, len).to_vec();
    l3_free(ptr, len);
    let answer = match serde_json::from_slice::<serde_json::Value>(&question) {
        Ok(q) => length3_core::api::answer(q["name"].as_str().unwrap_or_default(), &q["args"]),
        Err(e) => serde_json::json!({"error": e.to_string()}),
    };
    let bytes = answer.to_string().into_bytes().into_boxed_slice();
    let n = bytes.len();
    let at = Box::into_raw(bytes) as *mut u8;
    ((at as u64) << 32) | n as u64
}
