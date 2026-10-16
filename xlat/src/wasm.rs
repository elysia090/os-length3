//! The translator as a wasm module, so a browser can translate the
//! programs it runs. The host copies an ELF into memory from
//! `xlat_alloc`, calls `xlat_translate`, then reads the module (or the
//! error text) from `xlat_output_ptr`/`xlat_output_len`.

use std::cell::RefCell;

thread_local! {
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn xlat_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must come from one `xlat_alloc` call.
#[no_mangle]
pub unsafe extern "C" fn xlat_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Translate the ELF at `ptr`. Returns 0 with the wasm module as output,
/// or 1 with an error message as output.
///
/// # Safety
/// `ptr` must point to `len` initialized bytes.
#[no_mangle]
pub unsafe extern "C" fn xlat_translate(ptr: *const u8, len: usize) -> i32 {
    let bytes = std::slice::from_raw_parts(ptr, len);
    let (status, out) = match crate::elf::Elf::parse(bytes) {
        Ok(elf) => {
            let program = crate::discover::discover(&elf);
            (0, crate::lower::translate(&elf, &program, crate::lower::Options::default()).wasm)
        }
        Err(e) => (1, e.to_string().into_bytes()),
    };
    OUTPUT.with(|o| *o.borrow_mut() = out);
    status
}

#[no_mangle]
pub extern "C" fn xlat_output_ptr() -> *const u8 {
    OUTPUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn xlat_output_len() -> usize {
    OUTPUT.with(|o| o.borrow().len())
}
