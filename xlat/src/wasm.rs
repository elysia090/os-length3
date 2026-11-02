//! The translator as a wasm module, so a browser can translate the
//! programs it runs. The host copies an ELF into memory from
//! `xlat_alloc`, calls `xlat_translate`, then reads the module (or the
//! error text) from `xlat_output_ptr`/`xlat_output_len`. Code a program
//! reaches later comes from `xlat_open` once, then `xlat_translate_more`,
//! until `xlat_close`. The ELF given to either is the translator's from
//! then on (it is parsed where it lies, not copied): the host does not free
//! it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;

/// The translator's allocator: the system's, with its memory grown by a quarter again at a time rather than by as
/// little as each allocation needs. An engine may collect its whole heap as a wasm memory grows; a big program's
/// translation grew it hundreds of times (a compiler's, 516 collections), and in a kernel's heap those took longer
/// than the translation's own work. (By a half: 8 for its 12, with two fifths more held; by an eighth: 16, for a
/// twentieth less.)
struct Roomy;

#[global_allocator]
static ALLOCATOR: Roomy = Roomy;

/// The memory's size now, in 64 KiB pages.
fn pages() -> usize {
    core::arch::wasm32::memory_size::<0>()
}

/// Once the memory has grown past `before` pages: room for a quarter as much again, made now and given back (the
/// allocator keeps what is freed at its top, and hands it out without growing the memory).
fn room(before: usize) {
    if let Ok(layout) = Layout::from_size_align(before * 65536 / 4, 16) {
        // SAFETY: the layout's size is not zero (a memory that grew held pages), and what is allocated is freed at once.
        unsafe {
            let p = System.alloc(layout);
            if !p.is_null() { System.dealloc(p, layout); }
        }
    }
}

// SAFETY: each call is the system allocator's own, with the same arguments.
unsafe impl GlobalAlloc for Roomy {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let before = pages();
        let p = System.alloc(layout);
        if pages() != before { room(before); }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let before = pages();
        let p = System.alloc_zeroed(layout);
        if pages() != before { room(before); }
        p
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let before = pages();
        let p = System.realloc(ptr, layout, size);
        if pages() != before { room(before); }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

thread_local! {
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// The ELFs xlat_translate_more reads, by handle (xlat_open), each with
    /// the function starts translated so far; the oldest go first.
    static OPEN: RefCell<Vec<(u32, crate::elf::Elf, BTreeSet<u64>)>> = const { RefCell::new(Vec::new()) };
    static NEXT: Cell<u32> = const { Cell::new(1) };
    /// How many instructions one module of code reached later may hold, past its seeds' own (xlat_budget).
    static BUDGET: Cell<usize> = const { Cell::new(crate::discover::BUDGET) };
}

/// u64s as little-endian bytes from xlat_alloc, which promises no alignment.
unsafe fn words(p: *const u8, n: usize) -> Vec<u64> {
    std::slice::from_raw_parts(p, n * 8).chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect()
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

/// Translate the ELF at `ptr` (taken: the host does not free it). Returns
/// 0 with the wasm module as output, or 1 with an error message as output.
///
/// # Safety
/// `ptr` and `len` must come from one `xlat_alloc` call, all written.
#[no_mangle]
pub unsafe extern "C" fn xlat_translate(ptr: *mut u8, len: usize) -> i32 {
    let (status, out) = match crate::elf::Elf::parse_owned(Vec::from_raw_parts(ptr, len, len)) {
        Ok(elf) => {
            let program = crate::discover::discover(&elf);
            (0, crate::lower::translate(&elf, &program, crate::lower::Options::default()).wasm)
        }
        Err(e) => (1, e.to_string().into_bytes()),
    };
    OUTPUT.with(|o| *o.borrow_mut() = out);
    status
}

/// As `xlat_translate`, all of the program (discover::discover_whole), as the hot programs are translated in the
/// release: what a page translates ahead of a program's first run (runtime/ahead.mjs), so the run reaches nothing later.
///
/// # Safety
/// As `xlat_translate`.
#[no_mangle]
pub unsafe extern "C" fn xlat_translate_whole(ptr: *mut u8, len: usize) -> i32 {
    let (status, out) = match crate::elf::Elf::parse_owned(Vec::from_raw_parts(ptr, len, len)) {
        Ok(elf) => {
            let program = crate::discover::discover_whole(&elf);
            (0, crate::lower::translate(&elf, &program, crate::lower::Options::default()).wasm)
        }
        Err(e) => (1, e.to_string().into_bytes()),
    };
    OUTPUT.with(|o| *o.borrow_mut() = out);
    status
}

/// As `xlat_translate`, and from the function starts at `seeds` (`n_seeds` u64s, left to the host) too: a program
/// with its code reached later, in one module (discover::discover_seeded).
///
/// # Safety
/// As `xlat_translate`, and `seeds` must point to `n_seeds` u64s.
#[no_mangle]
pub unsafe extern "C" fn xlat_translate_seeded(ptr: *mut u8, len: usize, seeds: *const u8, n_seeds: usize) -> i32 {
    let seeds = words(seeds, n_seeds);
    let (status, out) = match crate::elf::Elf::parse_owned(Vec::from_raw_parts(ptr, len, len)) {
        Ok(elf) => {
            let program = crate::discover::discover_seeded(&elf, &seeds);
            (0, crate::lower::translate(&elf, &program, crate::lower::Options::default()).wasm)
        }
        Err(e) => (1, e.to_string().into_bytes()),
    };
    OUTPUT.with(|o| *o.borrow_mut() = out);
    status
}

/// Keep the ELF at `ptr` for `xlat_translate_more`, with the function
/// starts already translated (`known`, u64s): a program reaches its code a
/// function at a time, and each time the same file is read, so it is parsed
/// once, and what each module adds is remembered here. Returns its handle,
/// or 0 with an error as output. A few stay open (a compiler's driver, cc1
/// and the assembler take turns); opening more lets the oldest go.
///
/// # Safety
/// `ptr` and `len` must come from one `xlat_alloc` call, all written (it is
/// taken), and `known` must point to `n_known` u64s.
#[no_mangle]
pub unsafe extern "C" fn xlat_open(ptr: *mut u8, len: usize, known: *const u8, n_known: usize) -> u32 {
    const KEPT: usize = 6;
    match crate::elf::Elf::parse_owned(Vec::from_raw_parts(ptr, len, len)) {
        Ok(elf) => {
            let handle = NEXT.with(|n| { let h = n.get(); n.set(h + 1); h });
            let known = words(known, n_known).into_iter().collect();
            OPEN.with(|o| {
                let mut o = o.borrow_mut();
                if o.len() >= KEPT { o.remove(0); }
                o.push((handle, elf, known));
            });
            handle
        }
        Err(e) => { OUTPUT.with(|o| *o.borrow_mut() = e.to_string().into_bytes()); 0 }
    }
}

/// Code reached later in the ELF opened as `handle`: the functions reached
/// from the `seeds` (u64s) past those translated already, as a module
/// filling table slots from `base`. Returns 0 with the module as output, or
/// 1 with an error message.
///
/// # Safety
/// `seeds` must point to `n_seeds` u64s.
#[no_mangle]
pub unsafe extern "C" fn xlat_translate_more(handle: u32, seeds: *const u8, n_seeds: usize, base: u32) -> i32 {
    let seeds = words(seeds, n_seeds);
    let (status, out) = OPEN.with(|o| match o.borrow_mut().iter_mut().find(|(h, _, _)| *h == handle) {
        Some((_, elf, known)) => {
            let program = crate::discover::discover_within(elf, &seeds, known, BUDGET.with(|b| b.get()));
            known.extend(program.functions.iter().map(|f| f.start));
            (0, crate::lower::translate_more(&program, base, crate::lower::Options::default()).wasm)
        }
        None => (1, b"that ELF is not open".to_vec()),
    });
    OUTPUT.with(|o| *o.borrow_mut() = out);
    status
}

/// Decode the zstd frames at `ptr` (left to the host to free), `size`
/// bytes once decoded: a root file from a pack, which a system call needs at
/// once and the host's own decoders give only later. Returns 0 with the
/// bytes as output, or 1 with an error message.
///
/// # Safety
/// `ptr` must point to `len` initialized bytes.
#[no_mangle]
pub unsafe extern "C" fn xlat_unzstd(ptr: *const u8, len: usize, size: usize) -> i32 {
    use std::io::Read;
    let mut src = std::slice::from_raw_parts(ptr, len);
    let mut out = Vec::with_capacity(size);
    let done = ruzstd::decoding::StreamingDecoder::new(&mut src).map_err(|e| e.to_string())
        .and_then(|mut d| d.read_to_end(&mut out).map_err(|e| e.to_string()));
    let (status, out) = match done {
        Ok(_) if out.len() == size => (0, out),
        Ok(_) => (1, format!("decoded {} bytes, not {size}", out.len()).into_bytes()),
        Err(e) => (1, e.into_bytes()),
    };
    OUTPUT.with(|o| *o.borrow_mut() = out);
    status
}

/// The SHA-256 of the bytes at `ptr` (left to the host to free): a root
/// file as its pack stores it, checked against the pack's table
/// (runtime/table.mjs) before it is decoded, where the host's own digests
/// come only later. Returns 0 with the 32 bytes of the digest as output.
///
/// # Safety
/// `ptr` must point to `len` initialized bytes.
#[no_mangle]
pub unsafe extern "C" fn xlat_sha256(ptr: *const u8, len: usize) -> i32 {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(std::slice::from_raw_parts(ptr, len));
    OUTPUT.with(|o| *o.borrow_mut() = digest.to_vec());
    0
}

/// Set how much code reached later one module may hold (discover_within;
/// 0: all it reaches); for measuring against discover::BUDGET.
#[no_mangle]
pub extern "C" fn xlat_budget(instructions: u32) {
    BUDGET.with(|b| b.set(if instructions == 0 { usize::MAX } else { instructions as usize }));
}

/// Let go of the ELF opened as `handle`, and of what was remembered with it.
#[no_mangle]
pub extern "C" fn xlat_close(handle: u32) {
    OPEN.with(|o| o.borrow_mut().retain(|(h, _, _)| *h != handle));
}

#[no_mangle]
pub extern "C" fn xlat_output_ptr() -> *const u8 {
    OUTPUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn xlat_output_len() -> usize {
    OUTPUT.with(|o| o.borrow().len())
}
