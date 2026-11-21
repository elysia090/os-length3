//! What the whole program decides before any function is made: the flags each entry reads (a fixed point over flat
//! arrays, a function solved again only when an entry it goes to grew), and what each function may do to the
//! registers as a call sees it.

use crate::elf::Elf;
use crate::layout::has_loop;
use crate::program::*;
use crate::x86::*;
use std::collections::VecDeque;

/// Flag liveness over the whole program in flat arrays, every function's blocks in turn (function f's from
/// `first[f]`): the flags each block reads before writing and writes, where it goes (a block of its own function, an
/// entry of another's, or other code, handed every flag), and the flags live into it. A compare can end one function
/// and the jump that reads it begin another (the post-link compiler merges equal tails): such an entry is handed what
/// it reads, in G_FLAGS. Each entry starts reading nothing and grows to what its code reads (the least fixed point),
/// a function solved again only when an entry it goes to grew.
pub struct Liveness {
    entries: Vec<u64>,
    /// What each entry reads first, each function's blocks' first, uses, defs, successors and fixed outs.
    reads: Vec<u8>,
    first: Vec<u32>,
    used: Vec<u8>,
    defined: Vec<u8>,
    to: Vec<[u32; 2]>,
    fixed: Vec<u8>,
    /// The entry a block is (or NONE), the flags live into it, and what each function's entries read.
    entry: Vec<u32>,
    live: Vec<u8>,
    pub(crate) cases: Vec<u8>,
}

const NONE: u32 = u32::MAX;
const ENTRY: u32 = 1 << 31;
/// A block ending in an indirect jump keeps what its function's entries read (it may land on any).
const INDIRECT: u8 = 0x80;

impl Liveness {
    pub fn new(program: &Program) -> Liveness { Self::for_lowering(program, &[]) }
    pub(crate) fn for_lowering(program: &Program, summaries: &[Summary]) -> Liveness {
        let entries: Vec<u64> = program.entries.keys().copied().collect();
        let blocks: usize = program.functions.iter().map(|f| f.blocks.len()).sum();
        let mut l = Liveness {
            reads: vec![0; entries.len()], first: Vec::with_capacity(program.functions.len() + 1), used: Vec::with_capacity(blocks),
            defined: Vec::with_capacity(blocks), to: Vec::with_capacity(blocks), fixed: Vec::with_capacity(blocks),
            entry: vec![NONE; blocks], live: vec![0; blocks], cases: vec![0; program.functions.len()], entries,
        };
        for (index, f) in program.functions.iter().enumerate() {
            let preserves = summaries.get(index).is_some_and(Summary::preserves_flags);
            l.first.push(l.used.len() as u32);
            for (b, at) in f.blocks.iter().zip(&f.succ) {
                let (mut to, mut fixed) = ([NONE; 2], if b.exit == Exit::IndirectJump { INDIRECT } else { 0 });
                let mut add = |a: u64, k: u32| {
                    let t = if k != NO { k } else {
                        match program.entries.index(a) { Some(e) => e as u32 | ENTRY, None => { fixed |= ALL_FLAGS as u8; return; } }
                    };
                    to[(to[0] != NONE) as usize] = t;
                };
                match b.exit {
                    Exit::Fall(a) | Exit::Jump(a) => add(a, at[0]),
                    Exit::TailJump(a) => add(a, NO),
                    Exit::Branch { taken, fall } => { add(taken, at[0]); add(fall, at[1]); }
                    // A separately translated caller can observe every arithmetic flag after a return.
                    // Keep the same contract at calls: the callee may read incoming flags, preserve
                    // some, and replace others. Register summaries do not describe those effects.
                    Exit::Call { .. } | Exit::IndirectCall { .. } | Exit::Return | Exit::IndirectJump => {
                        // A proven flag-transparent quiet function leaves the input global
                        // state untouched, including at a nonlocal return. All other callers
                        // retain every flag: a changed return address can observe them too.
                        if !preserves { fixed |= ALL_FLAGS as u8; }
                    }
                    _ => {}
                }
                l.used.push(b.reads);
                l.defined.push(b.writes);
                l.to.push(to);
                l.fixed.push(fixed);
            }
        }
        l.first.push(l.used.len() as u32);
        for (e, &(f, b)) in program.entries.values().enumerate() { l.entry[(l.first[f as usize] + b) as usize] = e as u32; }
        // The functions that go to each entry (packed), and each function once at first.
        let mut count = vec![0u32; l.entries.len() + 1];
        l.each_going(|e, _| count[e + 1] += 1);
        for e in 0..l.entries.len() { count[e + 1] += count[e]; }
        let mut by = vec![0u32; count[l.entries.len()] as usize];
        let mut at = count.clone();
        l.each_going(|e, f| { by[at[e] as usize] = f; at[e] += 1; });
        let mut queued = vec![true; program.functions.len()];
        let mut work: VecDeque<u32> = (0..program.functions.len() as u32).collect();
        while let Some(f) = work.pop_front() {
            queued[f as usize] = false;
            l.solve(f as usize);
            for g in l.first[f as usize] as usize..l.first[f as usize + 1] as usize {
                let e = l.entry[g];
                if e == NONE || l.reads[e as usize] == l.live[g] { continue; }
                l.reads[e as usize] = l.live[g];
                for &d in &by[count[e as usize] as usize..count[e as usize + 1] as usize] {
                    if !queued[d as usize] { queued[d as usize] = true; work.push_back(d); }
                }
            }
        }
        l
    }
    fn each_going(&self, mut on: impl FnMut(usize, u32)) {
        for f in 0..self.cases.len() {
            for t in self.to[self.first[f] as usize..self.first[f + 1] as usize].iter().flatten() {
                if *t != NONE && t & ENTRY != 0 { on((t & !ENTRY) as usize, f as u32); }
            }
        }
    }
    /// The flags live into each block of function `f`, from nothing, as its entries now read.
    fn solve(&mut self, f: usize) {
        let (lo, hi) = (self.first[f] as usize, self.first[f + 1] as usize);
        self.live[lo..hi].fill(0);
        let mut cases = 0;
        loop {
            let mut changed = false;
            for g in (lo..hi).rev() {
                let (held, ext) = self.out(lo, g, cases);
                let new = self.used[g] | ((held | ext) & !self.defined[g]);
                if new != self.live[g] {
                    self.live[g] = new;
                    if self.entry[g] != NONE { cases |= new; }
                    changed = true;
                }
            }
            if !changed { break; }
        }
        self.cases[f] = cases;
    }
    /// The flags live out of block `g` (its function's from `lo`): into its own function's blocks, and handed out.
    fn out(&self, lo: usize, g: usize, cases: u8) -> (u8, u8) {
        let mut held = if self.fixed[g] & INDIRECT != 0 { cases } else { 0 };
        let mut ext = self.fixed[g] & !INDIRECT;
        for &t in &self.to[g] {
            if t == NONE { continue; }
            if t & ENTRY != 0 { ext |= self.reads[(t & !ENTRY) as usize]; } else { held |= self.live[lo + t as usize]; }
        }
        (held, ext)
    }
    pub(crate) fn live_out(&self, f: u32, k: usize) -> (u32, u32) {
        let lo = self.first[f as usize] as usize;
        let (held, ext) = self.out(lo, lo + k, self.cases[f as usize]);
        (held as u32, ext as u32)
    }
    /// The flags code going to `address`, outside its function, hands over: what that entry reads, or all.
    pub fn handed(&self, address: u64) -> u32 { self.handed_at(self.entries.binary_search(&address).ok()) }
    /// As `handed`, for the entry found already (Entries::index).
    pub fn handed_at(&self, entry: Option<usize>) -> u32 { entry.map_or(ALL_FLAGS, |e| self.reads[e] as u32) }
    pub(crate) fn is_entry(&self, f: u32, k: usize) -> bool { self.entry[self.first[f as usize] as usize + k] != NONE }
}

/// What a function may do to the registers as a call sees it: bit n for r_n, 16 + n for xmm_n (as Fx::used). A call
/// moves registers through their globals; knowing what the callee may read and write, a caller stores only those and
/// takes back only what it may write, the rest staying in its locals across the call. That holds only while nothing
/// between the call and its return looks at the globals as a whole (the kernel, at a system call, a time slice's end,
/// code not translated yet, a trap): a callee that may go out to it (`exits`) is called as any call is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Summary { pub reads: u32, pub writes: u32, pub exits: bool, pub flags: u32 }
impl Summary {
    /// A closed, nonrecursive call tree neither observes nor modifies arithmetic
    /// flags. Read-only users are excluded: they still require incoming flags.
    /// For exits=true the usage mask can be incomplete and proves nothing.
    pub fn preserves_flags(&self) -> bool { !self.exits && self.flags == 0 }
}

/// The longest chain of calls made without counting their depth: one longer goes out, so the host's stack is never
/// more than this many frames past what DEPTH_LIMIT allows.
const QUIET_CHAIN: u32 = 16;

/// Every function's summary, in the program's order: what it itself may do, where it does not go out (decoded again
/// only there), then its callees' taken on, callees first (Kahn's order: what is never taken is on a cycle of calls).
pub fn summarize(elf: &Elf, program: &Program) -> Vec<Summary> {
    let n = program.functions.len();
    let mut starts: Vec<(u64, usize)> = program.functions.iter().enumerate().map(|(k, f)| (f.start, k)).collect();
    starts.sort_unstable();
    let (mut info, mut code) = (InstructionInfoFactory::new(), Vec::new());
    let rsp = 1 << (Register::RSP as u32 - Register::RAX as u32);
    let (mut summaries, callees): (Vec<Summary>, Vec<Vec<usize>>) = program.functions.iter().map(|f| {
        let mut s = Summary { reads: rsp, writes: rsp, exits: has_loop(f), flags: 0 };
        let mut callees = Vec::new();
        for (b, to) in f.blocks.iter().zip(&f.succ) {
            s.exits |= b.traps || match b.exit {
                // (A function's start is most often the entry of its first block; else it is searched for.)
                Exit::Call { target, .. } => match program.entries.index(target).map(|e| program.entries.at(e)) {
                    Some((g, 0)) if program.functions[g as usize].start == target => { callees.push(g as usize); false }
                    _ => match starts.binary_search_by_key(&target, |&(a, _)| a) { Ok(k) => { callees.push(starts[k].1); false } Err(_) => true },
                },
                Exit::Fall(_) | Exit::Jump(_) => to[0] == NO,
                Exit::Branch { .. } => to[0] == NO || to[1] == NO,
                Exit::TailJump(_) | Exit::IndirectJump | Exit::IndirectCall { .. } | Exit::Trap => true,
                Exit::Return => false,
            };
        }
        if s.exits { return (s, callees); }
        let mut at = Code::new(elf, f.span().map_or(f.start, |(lo, _)| lo));
        for b in &f.blocks {
            at.decode(elf, b.start, b.count, &mut code);
            for i in &code {
                let k = kind(i);
                s.flags |= (k.reads | k.writes) as u32;
                for u in info.info(i).used_registers() {
                    let Some(k) = bit(u.register()) else { continue };
                    // A write that keeps any of what was there reads it too (an 8- or 16-bit register's, an xmm's, a
                    // conditional one's).
                    let keeps = k >= 16 || u.register().size() < 4;
                    match u.access() {
                        OpAccess::Read | OpAccess::CondRead => s.reads |= 1 << k,
                        OpAccess::Write if !keeps => s.writes |= 1 << k,
                        OpAccess::Write | OpAccess::CondWrite | OpAccess::ReadWrite | OpAccess::ReadCondWrite => { s.reads |= 1 << k; s.writes |= 1 << k; }
                        _ => {}
                    }
                }
            }
        }
        (s, callees)
    }).unzip();
    let mut waiting: Vec<usize> = callees.iter().map(|c| c.len()).collect();
    let mut callers: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (k, c) in callees.iter().enumerate() { for &g in c { callers[g].push(k); } }
    let mut ready: Vec<usize> = (0..n).filter(|&k| waiting[k] == 0).collect();
    let (mut taken, mut height) = (vec![false; n], vec![0u32; n]);
    while let Some(k) = ready.pop() {
        taken[k] = true;
        for &g in &callees[k] {
            let c = summaries[g];
            let s = &mut summaries[k];
            s.flags |= c.flags;
            (s.reads, s.writes, s.exits) = (s.reads | c.reads, s.writes | c.writes, s.exits | c.exits);
            height[k] = height[k].max(height[g] + 1);
        }
        if height[k] > QUIET_CHAIN { summaries[k].exits = true; }
        for &c in &callers[k] { waiting[c] -= 1; if waiting[c] == 0 { ready.push(c); } }
    }
    for k in 0..n { if !taken[k] { summaries[k].exits = true; } }
    summaries
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Functions of one block each (x86 bytes at an address, ending as given), in a program of one executable
    /// segment that holds them all.
    fn program(functions: &[(u64, &[u8], Exit)]) -> (Elf, Program) {
        let base = 0x1000;
        let end = functions.iter().map(|&(a, c, _)| a + c.len() as u64).max().unwrap();
        let mut bytes = vec![0; (end - base) as usize];
        for &(a, c, _) in functions { bytes[(a - base) as usize..][..c.len()].copy_from_slice(c); }
        let made = functions.iter().map(|(start, code, exit)| {
            let code = decode_all(code, *start);
            Function::new(*start, format!("f_{start:x}"), vec![Block::of(*start, &code, exit.clone())])
        }).collect::<Vec<_>>();
        (Elf::of_code(base, bytes), Program { entry: made[0].start, functions: made, entries: Default::default() })
    }
    const RAX: u32 = 1 << 0;
    const RSP: u32 = 1 << 4;
    const RDI: u32 = 1 << 7;
    const XMM0: u32 = 1 << 16;

    #[test]
    fn quiet_flag_preservation_excludes_observation_modification_and_unknown_calls() {
        for (bytes, mask) in [
            (&[0x9c, 0x58, 0xc3][..], ALL_FLAGS), // pushfq; pop rax; ret
            (&[0x74, 0x00, 0xc3][..], RflagsBits::ZF), // jz; ret (read-only)
            (&[0x48, 0x83, 0xc0, 0x01, 0xc3][..], ALL_FLAGS), // add rax,1; ret
        ] {
            let (elf, p) = program(&[(0x1000,bytes,Exit::Return)]);
            let s = summarize(&elf,&p)[0];
            assert!(!s.exits);
            assert_eq!(s.flags,mask);
            assert!(!s.preserves_flags());
            let (elf,p) = program(&[
                (0x2000,&[0xe8,0xfb,0xef,0xff,0xff],Exit::Call{target:0x1000,ret:0x2005}),
                (0x1000,bytes,Exit::Return),
            ]);
            let summaries=summarize(&elf,&p);
            assert_eq!(summaries[0].flags,mask);
            assert!(!summaries[0].preserves_flags());
        }
        let (elf,p)=program(&[
            (0x3000,&[0xe8,0xfb,0xef,0xff,0xff],Exit::Call{target:0x2000,ret:0x3005}),
            (0x2000,&[0xe8,0xfb,0xef,0xff,0xff],Exit::Call{target:0x1000,ret:0x2005}),
            (0x1000,&[0x48,0x8d,0x44,0x7f,0x01,0xc3],Exit::Return),
        ]);
        assert!(summarize(&elf,&p).iter().all(Summary::preserves_flags));
        for target in [0x1000,0x9000] {
            let (elf,p)=program(&[(0x1000,&[0xe8,0xfb,0xff,0xff,0xff],Exit::Call{target,ret:0x1005})]);
            assert!(!summarize(&elf,&p)[0].preserves_flags());
        }
    }

    /// Several blocks per function, every block also an externally known entry.
    /// Entry-specific demand must not be confused with the union loaded by its prologue.
    fn marked_program(functions: &[&[(u64, &[u8], Exit)]]) -> (Elf, Program) {
        let base = functions.iter().flat_map(|f| f.iter()).map(|b| b.0).min().unwrap();
        let end = functions.iter().flat_map(|f| f.iter()).map(|b| b.0 + b.1.len() as u64).max().unwrap();
        let mut bytes = vec![0; (end - base) as usize];
        let made = functions.iter().map(|blocks| {
            let blocks: Vec<Block> = blocks.iter().map(|(start, code, exit)| {
                bytes[(*start - base) as usize..][..code.len()].copy_from_slice(code);
                Block::of(*start, &decode_all(code, *start), exit.clone())
            }).collect();
            Function::new(blocks[0].start, String::new(), blocks)
        }).collect::<Vec<_>>();
        let entries = Entries::of(made.iter().enumerate().flat_map(|(f, function)| {
            function.blocks.iter().enumerate().map(move |(b, block)| (block.start, (f as u32, b as u32)))
        }).collect());
        (Elf::of_code(base, bytes), Program { entry: made[0].start, functions: made, entries })
    }

    #[test]
    fn quiet_call_input_is_its_entry_demand_not_its_prologue_union() {
        let blocks = [
            (0x1000, &[0x48, 0x83, 0xf8, 0x01][..], Exit::Fall(0x1004)), // cmp rax,1
            (0x1004, &[0x9c, 0x5b, 0xc3][..], Exit::Return), // address-taken: pushfq; pop rbx; ret
        ];
        let (elf, p) = marked_program(&[&blocks]);
        let summaries = summarize(&elf, &p);
        assert!(!summaries[0].exits);
        assert!(!summaries[0].preserves_flags());
        let live = Liveness::for_lowering(&p, &summaries);
        assert_eq!(live.handed(0x1000), 0);
        assert_eq!(live.handed(0x1004), ALL_FLAGS);
        assert_eq!(live.cases[0] as u32, ALL_FLAGS);
        assert_eq!(live.handed(0x9000), ALL_FLAGS, "unknown entries stay conservative");
    }

    #[test]
    fn quiet_partial_and_counted_producers_keep_their_incoming_bits() {
        for (code, expected) in [
            (&[0x48, 0xff, 0xc0, 0xc3][..], RflagsBits::CF), // inc rax; ret
            (&[0x48, 0xd3, 0xe0, 0xc3][..], ALL_FLAGS), // shl rax,cl; ret (CL may be zero)
            (&[0x9c, 0x5b, 0xc3][..], ALL_FLAGS), // read-only: pushfq; pop rbx; ret
        ] {
            let blocks = [(0x1000, code, Exit::Return)];
            let (elf, p) = marked_program(&[&blocks]);
            let summaries = summarize(&elf, &p);
            assert!(!summaries[0].exits);
            assert!(!summaries[0].preserves_flags());
            assert_eq!(Liveness::for_lowering(&p, &summaries).handed(0x1000), expected);
        }
    }

    #[test]
    fn a_quiet_call_before_a_later_producer_retains_nonlocal_input() {
        // The inner pure function may rewrite its return address and bypass CMP.
        // A Call must demand ALL even when its ordinary continuation kills them.
        let outer = [
            (0x1000, &[0xe8, 0xfb, 0x0f, 0x00, 0x00][..], Exit::Call { target: 0x2000, ret: 0x1005 }),
            (0x1005, &[0x48, 0x83, 0xf8, 0x01, 0xc3][..], Exit::Return),
        ];
        let inner = [(0x2000, &[0xc3][..], Exit::Return)];
        let (elf, p) = marked_program(&[&outer, &inner]);
        let summaries = summarize(&elf, &p);
        assert!(!summaries[0].exits);
        assert!(!summaries[0].preserves_flags());
        assert!(summaries[1].preserves_flags());
        let live = Liveness::for_lowering(&p, &summaries);
        assert_eq!(live.handed(0x1005), 0);
        assert_eq!(live.handed(0x1000), ALL_FLAGS);
    }

    #[test]
    fn a_leaf_reads_and_writes_what_its_instructions_do() {
        // lea rax, [rdi + rdi*2 + 1]; ret
        let (elf, p) = program(&[(0x1000, &[0x48, 0x8d, 0x44, 0x7f, 0x01, 0xc3], Exit::Return)]);
        let s = summarize(&elf, &p)[0];
        assert_eq!(s, Summary { reads: RDI | RSP, writes: RAX | RSP, exits: false, flags: 0 });
    }

    #[test]
    fn a_caller_takes_on_its_callees_and_recursion_goes_out() {
        // 0x2000: call 0x1000 (then ret); 0x1000: lea rax, [rdi + rdi*2 + 1]; ret
        let (elf, p) = program(&[
            (0x2000, &[0xe8, 0xfb, 0xef, 0xff, 0xff], Exit::Call { target: 0x1000, ret: 0x2005 }),
            (0x1000, &[0x48, 0x8d, 0x44, 0x7f, 0x01, 0xc3], Exit::Return),
        ]);
        let s = summarize(&elf, &p);
        assert_eq!(s[0], Summary { reads: RDI | RSP, writes: RAX | RSP, exits: false, flags: 0 });
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
