//! sods: a static x86-64 Linux program made a WebAssembly module. One direction, each file one thing:
//!
//! - `elf`: the program at rest.
//! - `x86`: an instruction as sods reads it; `scan`: what a walk needs of one, from its bytes (`scan_table`: its
//!   tables, made ahead).
//! - `program`: what is found of a program; `find`: finding it; `layout`: the order its blocks are lowered in.
//! - `facts`: what the whole program decides before any function is made.
//! - `abi`: what translated code and what runs it agree on; `wasm`: WebAssembly as bytes.
//! - `frame`: a function as it is made; `sync`: which registers it moves to their globals, and where.
//! - `operand`, `flags`, `integer`, `sse`, `fpu`: what each instruction means, written on the frame.
//! - `lower`: a function's control flow; `image`: the module around the code.
//! - `x87`: the coprocessor that runs beside the program; `web`: sods itself as a module in a browser.

#[cfg(feature = "translator")]
pub mod elf;
#[cfg(feature = "translator")]
pub mod x86;
#[cfg(feature = "translator")]
pub mod scan;
#[cfg(feature = "translator")]
mod scan_table;
#[cfg(feature = "translator")]
pub mod program;
#[cfg(feature = "translator")]
pub mod layout;
#[cfg(feature = "translator")]
pub mod find;
#[cfg(feature = "translator")]
pub mod facts;
#[cfg(feature = "translator")]
pub mod abi;
#[cfg(feature = "translator")]
pub mod wasm;
#[cfg(feature = "translator")]
pub mod frame;
#[cfg(feature = "translator")]
pub mod sync;
#[cfg(feature = "translator")]
pub mod operand;
#[cfg(feature = "translator")]
pub mod flags;
#[cfg(feature = "translator")]
pub mod integer;
#[cfg(feature = "translator")]
pub mod sse;
#[cfg(feature = "translator")]
pub mod fpu;
#[cfg(feature = "translator")]
pub mod lower;
#[cfg(feature = "translator")]
pub mod image;
#[cfg(feature = "translator")]
pub mod x87;
#[cfg(target_arch = "wasm32")]
#[cfg(feature = "translator")]
pub mod web;

pub mod identity;
