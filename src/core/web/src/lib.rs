//! The core as a browser runs it (built for wasm32-wasip1; app/core/worker.ts runs it over its own files).
//! A page asks it what the app asks through Tauri: `{"name", "args"}` in, `{"ok"}` or `{"error"}` out
//! (core/src/api.rs answer), as JSON in this module's memory.
//!
//! The host gives a buffer with `l3_alloc`, writes the question into it and calls `l3_call`, which takes
//! the buffer back and returns where the answer is (its address high, its length low); the host reads it
//! and gives it back with `l3_free`. Its one import of its own beside WASI is the page's way of sending a request
//! (`length3.http`, mod page), handed to the core as each call starts (device/net.rs `through_page`).

use std::alloc::{dealloc, Layout};

fn layout(len: usize) -> Layout {
    Layout::from_size_align(len.max(1), 1).expect("a byte buffer's layout")
}

/// A buffer of `len` bytes for the host to write a question into: at least one byte, so it is a real allocation of
/// the layout `l3_free` gives back, never a dangling pointer of an empty one.
#[no_mangle]
pub extern "C" fn l3_alloc(len: usize) -> *mut u8 {
    Box::leak(vec![0u8; len.max(1)].into_boxed_slice()).as_mut_ptr()
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
    #[cfg(target_os = "wasi")]
    length3_core::device::net::through_page(page::send);
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

/// The module's one import of its own beside WASI (app/core/abi.ts `length3.http`): the page sends a request for the
/// core (core/src/device/net.rs), synchronously, and keeps the answer's body until it is copied in.
#[cfg(target_os = "wasi")]
mod page {
    #[link(wasm_import_module = "length3")]
    extern "C" {
        /// Send a request (`head`: JSON {method, url, headers, timeout}); the answer's status (0: not reached) and
        /// its body's length are written back, the body (or why it was not reached) kept as the handle returned.
        fn http(head: *const u8, head_len: usize, body: *const u8, body_len: usize, status: *mut u32, len: *mut u32) -> u32;
        /// Copy the body kept as `handle` (its length as said) and let it go.
        fn http_body(handle: u32, out: *mut u8);
    }

    /// `head` and `body` sent: the status (0: not reached) and the body, whole.
    pub fn send(head: &str, body: &[u8]) -> (u32, Vec<u8>) {
        let (mut status, mut len) = (0u32, 0u32);
        // SAFETY: the pointers are to this function's own buffers, valid for the lengths given; the host writes only
        // `status` and `len`.
        let handle = unsafe { http(head.as_ptr(), head.len(), body.as_ptr(), body.len(), &mut status, &mut len) };
        let mut bytes = vec![0u8; len as usize];
        // SAFETY: `bytes` is exactly the `len` bytes the host said it copies.
        unsafe { http_body(handle, bytes.as_mut_ptr()) };
        (status, bytes)
    }
}
