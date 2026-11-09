//! What each function may do to the registers, found from its instructions before any function is lowered, so a
//! call to one that never goes out to the kernel moves only the registers it may touch (lower.rs Exit::Call).
//!
//! A call moves registers through their globals: the caller stores what it holds that is newer than its global
//! (a save), the callee takes in what it reads and stores what it wrote, and the caller takes back what it reads
//! after. Not knowing the callee, the caller stores everything newer and takes back everything it reads next: around
//! a leaf such as `lea rax, [rdi + rdi*2 + 1]; ret` that was six stores and six loads for its two reads and two
//! writes. Knowing the callee, a caller stores only what the callee may read or write (a register it writes on one
//! path only must hold the caller's value on the others) and takes back only what it may write; the rest stays in
//! the caller's locals across the call.
//!
//! That holds only while nothing between the call and its return looks at the globals as a whole: the kernel at a
//! system call, at a time slice's end, at code not translated yet, at a trap a handler may take. A callee that may
//! go out to the kernel (`exits`) is called as before. Faults are not among those: a fault ends the process
//! (process.ts fault), with whatever was in the locals lost as it is now within any one function.

use crate::discover::{Exit, Function, Program};
use crate::elf::Elf;
use iced_x86::{Instruction, InstructionInfoFactory, OpAccess, Register};

/// A function's registers as a call to it sees them: bit n for r_n, 16 + n for xmm_n (as lower.rs Fx::used).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Summary {
    /// What it, or anything it calls, may read (where it does not go out).
    pub reads: u32,
    /// What it, or anything it calls, may write (where it does not go out).
    pub writes: u32,
    /// It may go out to the kernel before it returns (a loop's time slice, a system call, a trap, code it reaches
    /// only through a pointer or not translated with it, recursion, a callee that may): called as any call is.
    pub exits: bool,
}

/// The longest chain of calls made without counting their depth (calls to functions that never go out): one
/// longer counts as calls that may go out do, so the host's stack is never more than this many frames past what
/// DEPTH_LIMIT allows (lower.rs).
const QUIET_CHAIN: u32 = 16;

/// The bit of a register a summary keeps, if any. (A vector register by its own number: iced's full register of an
/// xmm register is its zmm one.)
fn bit(r: Register) -> Option<u32> {
    let n = r as u32;
    for first in [Register::XMM0, Register::YMM0, Register::ZMM0] {
        let first = first as u32;
        if (first..first + 16).contains(&n) { return Some(16 + n - first); }
    }
    let full = r.full_register() as u32;
    (Register::RAX as u32..=Register::R15 as u32).contains(&full).then(|| full - Register::RAX as u32)
}

/// What `f` itself reads and writes, whether it may go out on its own, and the functions it calls directly. What it
/// reads and writes is found only where it does not go out: a call to one that may is made as any call is, reading
/// neither, and so is a call to anything that calls it.
fn own(elf: &Elf, f: &Function, starts: &[(u64, usize)], (info, code): (&mut InstructionInfoFactory, &mut Vec<Instruction>)) -> (Summary, Vec<usize>) {
    // rsp: every call pushes and every return pops.
    let rsp = 1 << (Register::RSP as u32 - Register::RAX as u32);
    let mut s = Summary { reads: rsp, writes: rsp, exits: crate::lower::has_loop(f) };
    let mut callees = Vec::new();
    for b in &f.blocks {
        if b.traps { s.exits = true; }
        let within = |a: u64| f.block_index(a).is_some();
        match b.exit {
            Exit::Call { target, .. } => match starts.binary_search_by_key(&target, |&(a, _)| a) { Ok(k) => callees.push(starts[k].1), Err(_) => s.exits = true },
            Exit::Fall(a) | Exit::Jump(a) => if !within(a) { s.exits = true },
            Exit::Branch { taken, fall } => if !within(taken) || !within(fall) { s.exits = true },
            Exit::TailJump(_) | Exit::IndirectJump | Exit::IndirectCall { .. } | Exit::Trap => s.exits = true,
            Exit::Return => {}
        }
    }
    if s.exits { return (s, callees); }
    for b in &f.blocks {
        b.decode(elf, code);
        for i in code.iter() {
            for u in info.info(i).used_registers() {
                let Some(b) = bit(u.register()) else { continue };
                // A write that keeps any of what was there reads it too: an 8- or 16-bit register's (merged into
                // the rest), an xmm register's (a scalar or a lane written, the others kept), a conditional one's.
                let keeps = b >= 16 || u.register().size() < 4;
                match u.access() {
                    OpAccess::Read | OpAccess::CondRead => s.reads |= 1 << b,
                    OpAccess::Write if !keeps => s.writes |= 1 << b,
                    OpAccess::Write | OpAccess::CondWrite | OpAccess::ReadWrite | OpAccess::ReadCondWrite => { s.reads |= 1 << b; s.writes |= 1 << b; }
                    _ => {}
                }
            }
        }
    }
    (s, callees)
}

/// Every function's summary, in `program.functions`' order.
pub fn summarize(elf: &Elf, program: &Program) -> Vec<Summary> {
    let n = program.functions.len();
    // Each function's start and place, by start.
    let mut starts: Vec<(u64, usize)> = program.functions.iter().enumerate().map(|(k, f)| (f.start, k)).collect();
    starts.sort_unstable();
    let (mut info, mut code) = (InstructionInfoFactory::new(), Vec::new());
    let (mut summaries, callees): (Vec<Summary>, Vec<Vec<usize>>) = program.functions.iter().map(|f| own(elf, f, &starts, (&mut info, &mut code))).unzip();
    // Callees first (Kahn's order over the calls, so no depth of recursion is needed here): a function is taken
    // once everything it calls has been. What is never taken is on a cycle of calls (recursion), or calls into one.
    let mut waiting: Vec<usize> = callees.iter().map(|c| c.len()).collect();
    let mut callers: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (k, c) in callees.iter().enumerate() { for &g in c { callers[g].push(k); } }
    let mut ready: Vec<usize> = (0..n).filter(|&k| waiting[k] == 0).collect();
    let mut taken = vec![false; n];
    let mut height = vec![0u32; n];
    while let Some(k) = ready.pop() {
        taken[k] = true;
        for &g in &callees[k] {
            let c = summaries[g];
            let s = &mut summaries[k];
            s.reads |= c.reads;
            s.writes |= c.writes;
            s.exits |= c.exits;
            height[k] = height[k].max(height[g] + 1);
        }
        if height[k] > QUIET_CHAIN { summaries[k].exits = true; }
        for &caller in &callers[k] {
            waiting[caller] -= 1;
            if waiting[caller] == 0 { ready.push(caller); }
        }
    }
    for k in 0..n { if !taken[k] { summaries[k].exits = true; } }
    summaries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discover::{Block, Function, Program};
    use iced_x86::{Decoder, DecoderOptions, Instruction};

    /// Functions of one block each (x86 bytes at an address, ending as given), in a program of one executable
    /// segment that holds them all.
    fn program(functions: &[(u64, &[u8], Exit)]) -> (Elf, Program) {
        let base = 0x1000;
        let end = functions.iter().map(|&(a, c, _)| a + c.len() as u64).max().unwrap();
        let mut bytes = vec![0; (end - base) as usize];
        for &(a, c, _) in functions { bytes[(a - base) as usize..][..c.len()].copy_from_slice(c); }
        let made = functions.iter().map(|(start, code, exit)| {
            let mut d = Decoder::with_ip(64, code, *start, DecoderOptions::NONE);
            let code: Vec<Instruction> = std::iter::from_fn(|| d.can_decode().then(|| d.decode())).collect();
            Function::new(*start, format!("f_{start:x}"), vec![Block::of(*start, &code, exit.clone())])
        }).collect::<Vec<_>>();
        (Elf::of_code(base, bytes), Program { entry: made[0].start, functions: made, entries: Default::default() })
    }
    const RAX: u32 = 1 << 0;
    const RSP: u32 = 1 << 4;
    const RDI: u32 = 1 << 7;
    const XMM0: u32 = 1 << 16;

    #[test]
    fn a_leaf_reads_and_writes_what_its_instructions_do() {
        // lea rax, [rdi + rdi*2 + 1]; ret
        let (elf, p) = program(&[(0x1000, &[0x48, 0x8d, 0x44, 0x7f, 0x01, 0xc3], Exit::Return)]);
        let s = summarize(&elf, &p)[0];
        assert_eq!(s, Summary { reads: RDI | RSP, writes: RAX | RSP, exits: false });
    }

    #[test]
    fn a_caller_takes_on_its_callees_and_recursion_goes_out() {
        // 0x2000: call 0x1000 (then ret); 0x1000: lea rax, [rdi + rdi*2 + 1]; ret
        let (elf, p) = program(&[
            (0x2000, &[0xe8, 0xfb, 0xef, 0xff, 0xff], Exit::Call { target: 0x1000, ret: 0x2005 }),
            (0x1000, &[0x48, 0x8d, 0x44, 0x7f, 0x01, 0xc3], Exit::Return),
        ]);
        let s = summarize(&elf, &p);
        assert_eq!(s[0], Summary { reads: RDI | RSP, writes: RAX | RSP, exits: false });
        // 0x3000: call 0x3000, itself.
        let (elf, p) = program(&[(0x3000, &[0xe8, 0xfb, 0xff, 0xff, 0xff], Exit::Call { target: 0x3000, ret: 0x3005 })]);
        assert!(summarize(&elf, &p)[0].exits);
        // cvtsi2sd xmm0, rdi; ret: what it writes in xmm0 (keeping its high half) is read and written.
        let (elf, p) = program(&[(0x5000, &[0xf2, 0x48, 0x0f, 0x2a, 0xc7, 0xc3], Exit::Return)]);
        let s = summarize(&elf, &p)[0];
        assert_eq!((s.reads & XMM0, s.writes & XMM0), (XMM0, XMM0));
        // A system call goes out.
        let (elf, p) = program(&[(0x4000, &[0x0f, 0x05, 0xc3], Exit::Return)]);
        assert!(summarize(&elf, &p)[0].exits);
    }
}
