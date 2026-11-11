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

pub mod elf;
pub mod x86;
pub mod scan;
mod scan_table;
pub mod program;
pub mod layout;
pub mod find;
pub mod facts;
pub mod abi;
pub mod wasm;
pub mod frame;
pub mod sync;
pub mod operand;
pub mod flags;
pub mod integer;
pub mod sse;
pub mod fpu;
pub mod lower;
pub mod image;
pub mod x87;
#[cfg(target_arch = "wasm32")]
pub mod web;
