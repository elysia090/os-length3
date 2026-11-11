//! What translated code and what runs it agree on: the functions a module imports (the host's, and in a module made
//! later the first module's own), the globals every module of a program shares, the word a thread is called in by,
//! and what a trap says. The other side of each is the kernel's that runs the code (muk's, in a browser).

/// Imported functions (the host's, then in a module made later the first module's helpers), and where the guest's
/// functions start.
pub const F_SYSCALL: u32 = 0;
pub const F_TRAP: u32 = 1;
pub const F_DIV128: u32 = 2;
pub const F_CLOCK: u32 = 3;
pub const F_FPU: u32 = 4;
pub const F_TRACE: u32 = 5;
/// The host's answer for code not translated yet: the entry (function << 32 | block), or -1.
pub const F_MISS: u32 = 6;
/// A wall or steady clock's time in ms, as the host's kernel keeps it; NaN for any other clock.
pub const F_TIME: u32 = 7;
pub const F_MULHU: u32 = 8;
pub const F_MULHS: u32 = 9;
pub const F_RESOLVE: u32 = 10;
pub const F_DISPATCH: u32 = 11;
pub const FIRST_GUEST: u32 = 13;

/// Globals every module of a program shares: r0..r15, fs, x0..x15, then these.
pub const G_FS: u32 = 16;
pub const fn g_xmm(n: u32) -> u32 { 17 + n }
/// CF, ZF, SF, OF and PF as bits 0..4: what an entry that reads flags first is handed.
pub const G_FLAGS: u32 = 33;
/// Loops gone round and calls made before the thread goes back to the kernel (its time slice).
pub const G_BUDGET: u32 = 34;
/// Calls the thread is inside, in wasm frames: past DEPTH_LIMIT a call starts afresh from the kernel.
pub const G_DEPTH: u32 = 35;
pub const DEPTH_LIMIT: i32 = 400;
/// The least rsp has been (how deep the thread's stack has gone).
pub const G_LOW: u32 = 36;
/// The thread's x87 registers: their handle in the coprocessor (x87.rs).
pub const G_X87: u32 = 37;
pub const GLOBALS: u32 = 38;
/// A word below where anything may be mapped: nonzero when the kernel wants the thread to look in (a signal, another
/// thread's turn), read at each loop's head.
pub const INTERRUPT: u32 = 0x100;

/// Trap codes reported to the host with the guest address.
pub const TRAP_UNMAPPED_TARGET: i32 = 1;
pub const TRAP_UNDECODED: i32 = 2;
pub const TRAP_UNSUPPORTED: i32 = 3;
/// Not faults: the time slice is up (at a loop's head, the address named), or the calls are deep enough that the next
/// starts from the kernel. Registers and the flags the target reads are in globals.
pub const TRAP_YIELD: i32 = 5;
pub const TRAP_UNWIND: i32 = 6;
/// What the program itself traps with: ud2 (SIGILL), int3 (SIGTRAP), hlt (SIGSEGV).
pub const TRAP_UD2: i32 = 7;
pub const TRAP_INT3: i32 = 8;
pub const TRAP_HLT: i32 = 9;
