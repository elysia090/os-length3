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
/// The extra imports of mapped fragments after their shared helpers.
pub const F_MAPPED_STRING: u32 = FIRST_GUEST;
pub const F_MAPPED_FX_STATE: u32 = F_MAPPED_STRING + 1;
pub const F_MAPPED_ADDRESS: u32 = F_MAPPED_FX_STATE + 1;
pub const MAX_MAPPED_OPERAND_BYTES: i32 = 16;
/// Low bits select page rights. A negative operand marks read-modify-write
/// so the host can classify a denied read before checking the write.
#[repr(i32)]
pub(crate) enum MappedAccess {
    Read = 3,
    Write = 2,
    Update = (-64i32) | 2,
}
pub const fn guest_function(index: u32, mapped: bool) -> u32 {
    (if mapped { F_MAPPED_ADDRESS + 1 } else { FIRST_GUEST }) + index
}

/// Globals every module of a program shares: r0..r15, fs, x0..x15, then these.
pub const G_FS: u32 = 16;
pub const fn g_xmm(n: u32) -> u32 { 17 + n }
/// CF, ZF, SF, OF, PF and AF as bits 0..5 (AF appended): what an entry that reads flags first is handed.
pub const G_FLAGS: u32 = 33;
/// Loops gone round and calls made before the thread goes back to the kernel (its time slice).
pub const G_BUDGET: u32 = 34;
/// Calls the thread is inside, in wasm frames: past DEPTH_LIMIT a call starts afresh from the kernel.
pub const G_DEPTH: u32 = 35;
pub const DEPTH_LIMIT: i32 = 400;
/// Static memory pooling uses the least rsp has been.
pub const G_LOW: u32 = 36;
/// The static thread's x87 handle. The mapped dispatcher owns its handles.
pub const G_X87: u32 = 37;
/// What is kept of rflags beyond G_FLAGS, each bit where x86 has it: DF, set and cleared as the thread runs (std,
/// cld, popfq) and read by its string instructions, whichever block, function or module they are in.
pub const G_RF: u32 = 38;
pub const RF_DF: i64 = 0x400;
pub const GLOBALS: u32 = 39;
/// The mapped CPU keeps MXCSR apart from the arithmetic flags and XMM contents.
pub const G_MXCSR: u32 = GLOBALS;
/// A mapped fragment's own table position, assigned after compilation.
pub const G_MAPPED_BASE: u32 = G_MXCSR + 1;
#[cfg(feature = "mapped-code")]
pub const MAPPED_SLOTS: usize = 65536;
pub const MXCSR_RESET: i32 = 0x1f80;
pub const FX_LOAD_MXCSR: i32 = 4;
pub const FX_SAVE_X87_ENV: i32 = 5;

/// Logical IDs of core globals, in their Wasm index order for this profile.
pub fn core_globals(mapped: bool) -> impl Iterator<Item = u32> {
    (0..GLOBALS + u32::from(mapped)).filter(move |&g| !mapped || !matches!(g, G_LOW | G_X87))
}

pub const fn global_index(g: u32, mapped: bool) -> u32 {
    if !mapped || g < G_LOW { return g; }
    assert!(g > G_X87);
    g - 2
}

/// Scalar imports are a fixed prefix of the mapped fragment's globals.
/// Vector registers can therefore be omitted without rewriting any body.
pub const MAPPED_SCALARS: [u32; 6] = [G_FLAGS, G_BUDGET, G_DEPTH, G_RF, G_MXCSR, G_MAPPED_BASE];
const MAPPED_VECTORS: u32 = G_FS + 1 + MAPPED_SCALARS.len() as u32;

pub const fn fragment_global_index(g: u32, mapped: bool) -> u32 {
    if !mapped || g <= G_FS { return g; }
    if g < G_FLAGS { return MAPPED_VECTORS + g - g_xmm(0); }
    match g {
        G_FLAGS => G_FS + 1,
        G_BUDGET => G_FS + 2,
        G_DEPTH => G_FS + 3,
        G_RF => G_FS + 4,
        G_MXCSR => G_FS + 5,
        G_MAPPED_BASE => G_FS + 6,
        _ => panic!("static-only global in a mapped fragment"),
    }
}
/// A word below where anything may be mapped: nonzero when the kernel wants the thread to look in (a signal, another
/// thread's turn), read at each loop's head.
pub const INTERRUPT: u32 = 0x100;

/// Trap codes reported to the host with the guest address.
pub const TRAP_UNMAPPED_TARGET: i32 = 1;
pub const TRAP_UNDECODED: i32 = 2;
pub const TRAP_UNSUPPORTED: i32 = 3;
/// A division the processor refuses (#DE, SIGFPE): a quotient that does not fit where it goes. (The host's wider
/// division says the same of its own: div128.)
pub const TRAP_DIVIDE: i32 = 4;
/// Not faults: the time slice is up (at a loop's head, the address named), or the calls are deep enough that the next
/// starts from the kernel. Registers and the flags the target reads are in globals.
pub const TRAP_YIELD: i32 = 5;
pub const TRAP_UNWIND: i32 = 6;
/// What the program itself traps with: ud2 (SIGILL), int3 (SIGTRAP), hlt (SIGSEGV).
pub const TRAP_UD2: i32 = 7;
pub const TRAP_INT3: i32 = 8;
pub const TRAP_HLT: i32 = 9;
