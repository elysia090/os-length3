//! cowboy: links out of a box and between boxes, decided where the box runs, so that almost all of it is done on
//! the device and what a service is left to do costs next to nothing.
//!
//! A link is a stream of bytes between two ends. A box's sockets are calls (sods answers them), so there are no
//! packets here: no TCP to run a second time, no frame to parse on the way. What is here is what decides how a link
//! is made, and it asks nothing of anyone to decide it:
//!
//!   names.rs   a name asked for (DNS) is answered here, with an address of cowboy's own, kept beside the name: a
//!              connection is then known by the name it was meant for. No resolver is asked, no packet leaves
//!   route.rs   which way a link to an address is made: to a name cowboy gave an address to, or to an address as
//!              it stands; never to the machine itself (that is the machine's own to answer)
//!   frame.rs   what goes over a relay: one line of where to, one byte back of whether it is made, then nothing but
//!              the bytes, sealed between the box and the host (TLS, SSH) and not read
//!
//! Its state is one piece of memory laid out once (names.rs: a table of slots, the names' own bytes, each name's
//! place), asked for never: nothing is allocated, on a query or on a connection. Its bounds, counted by hand and
//! held by its tests:
//!
//!   a name answered     its bytes read once (made lower case, hashed and kept in that one pass), one slot looked
//!                       at where the table is not crowded, the answer written once: the query's own bytes and
//!                       sixteen more
//!   an address named    one index: an address is its name's place
//!   a link's first line the name's bytes and its port's digits, written once
//!
//! It is Rust, built as wasm where a box runs in a page (the three calls at the foot of this file, over one piece of
//! memory the host writes a query into and reads an answer from), and as itself where it is tested.

#![cfg_attr(target_arch = "wasm32", no_std)]

pub mod frame;
pub mod names;
pub mod route;

/// The memory a host and cowboy pass bytes through: a query in, an answer out; a name out.
#[cfg(target_arch = "wasm32")]
mod door {
    use crate::{frame, names::Names, route};
    use core::cell::UnsafeCell;

    /// One instance, one thread (a page's Worker): the state and the bytes passed are its alone.
    struct Alone<T>(UnsafeCell<T>);
    // SAFETY: a wasm instance of this module is entered by one thread at a time (it has no threads of its own).
    unsafe impl<T> Sync for Alone<T> {}

    static NAMES: Alone<Names> = Alone(UnsafeCell::new(Names::new()));
    static PASSED: Alone<[u8; 2048]> = Alone(UnsafeCell::new([0; 2048]));

    /// Where the host writes what it passes in, and reads what comes out: 2,048 bytes, a query in the first half.
    #[no_mangle]
    pub extern "C" fn cowboy_passed() -> *mut u8 {
        PASSED.0.get().cast()
    }

    /// The query of `len` bytes at the start of what is passed, answered into its second half: how long the answer is
    /// (0: no answer is made, as to what is no query).
    #[no_mangle]
    pub extern "C" fn cowboy_answer(len: usize) -> usize {
        // SAFETY: one thread, and no other reference to either is alive across this call.
        let (names, passed) = unsafe { (&mut *NAMES.0.get(), &mut *PASSED.0.get()) };
        let (query, answer) = passed.split_at_mut(1024);
        names.answer(&query[..len.min(1024)], answer)
    }

    /// The first line of a link to `address` (as a number, its first byte highest) at `port`, written at the start
    /// of what is passed: how long it is (0: there is no way there).
    #[no_mangle]
    pub extern "C" fn cowboy_line(address: u32, port: u32) -> usize {
        // SAFETY: as above.
        let (names, passed) = unsafe { (&*NAMES.0.get(), &mut *PASSED.0.get()) };
        match route::to(names, address.to_be_bytes()) {
            Some(way) => frame::line(&way, port as u16, &mut passed[..]),
            None => 0,
        }
    }

    #[panic_handler]
    fn gone(_: &core::panic::PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }
}
