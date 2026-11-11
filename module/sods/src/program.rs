//! A program as it is found: its functions, their blocks in the order they are lowered and their successors, and the
//! entries execution may arrive at from outside a function's own control flow. A block keeps 48 bytes of what its
//! instructions say, not the instructions (40 bytes each): they are decoded again where they are lowered.

use crate::elf::Elf;
use crate::x86::{kind, Code, Instruction, SYSCALL, TRAPS};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Exit {
    /// Falls into the block at this address.
    Fall(u64),
    Jump(u64),
    /// A direct jump that leaves the function: a tail call.
    TailJump(u64),
    Branch { taken: u64, fall: u64 },
    IndirectJump,
    Call { target: u64, ret: u64 },
    IndirectCall { ret: u64 },
    Return,
    /// Undecodable or deliberately trapping code (ud2, hlt, int3).
    Trap,
}

/// A block: where it is, what the analyses need of its instructions, and how it ends. Its instructions are not kept
/// (40 bytes each): they are decoded again where they are lowered, from the program's own bytes.
#[derive(Clone, Debug)]
pub struct Block {
    pub start: u64,
    /// Its bytes (every instruction's, the terminator's too) and how many instructions they are.
    pub len: u32,
    pub count: u32,
    /// The flags (as ALL_FLAGS) it reads before it writes them, and those it writes.
    pub reads: u8,
    pub writes: u8,
    /// Its last instruction's length.
    pub last: u8,
    /// Its last instruction is a system call (a process stops and goes on there, and a fork child starts after it).
    pub resumes: bool,
    /// One of its instructions goes out to the kernel (a system call, an int).
    pub traps: bool,
    pub exit: Exit,
}

impl Block {
    /// Where it ends: the address after its last instruction.
    pub fn end(&self) -> u64 { self.start + self.len as u64 }
    pub fn last_ip(&self) -> u64 { self.end() - self.last as u64 }
    /// Its instructions, decoded again from `elf` into `into`.
    pub fn decode(&self, elf: &Elf, into: &mut Vec<Instruction>) {
        Code::new(elf, self.start).decode(elf, self.start, self.count, into);
    }
    pub fn instructions(&self, elf: &Elf) -> Vec<Instruction> {
        let mut out = Vec::with_capacity(self.count as usize);
        self.decode(elf, &mut out);
        out
    }
    /// The block of `code` (at `start`, each instruction after the one before), ending as `exit` says.
    pub fn of(start: u64, code: &[Instruction], exit: Exit) -> Block {
        let (mut reads, mut writes, mut traps, mut len) = (0, 0, false, 0);
        for i in code {
            let k = kind(i);
            reads |= k.reads & !writes;
            writes |= k.writes;
            traps |= k.bits & TRAPS != 0;
            len += i.len() as u32;
        }
        let last = code.last().expect("a block holds an instruction");
        Block { start, len, count: code.len() as u32, reads, writes, last: last.len() as u8, resumes: kind(last).bits & SYSCALL != 0, traps, exit }
    }
}

#[derive(Clone, Debug)]
pub struct Function {
    pub start: u64,
    pub name: String,
    /// In the order they are lowered (`lay_out`): index 0 is the function's entry.
    pub blocks: Vec<Block>,
    /// Each block's successors within (as goes_to has them), by index; NO where none or not this function's.
    pub succ: Vec<[u32; 2]>,
    /// Its blocks' indices, by their addresses.
    pub(crate) by_address: Vec<u32>,
}

impl Function {
    pub fn block_index(&self, address: u64) -> Option<usize> {
        self.by_address.binary_search_by_key(&address, |&k| self.blocks[k as usize].start).ok().map(|i| self.by_address[i] as usize)
    }
    /// The first and last of its blocks' addresses.
    pub fn span(&self) -> Option<(u64, u64)> {
        let at = |k: &u32| self.blocks[*k as usize].start;
        Some((at(self.by_address.first()?), at(self.by_address.last()?)))
    }
}

#[derive(Debug)]
pub struct Program {
    pub entry: u64,
    pub functions: Vec<Function>,
    /// Code addresses execution may arrive at from outside a function's own direct control flow: entries, call
    /// continuations, loop heads, system calls and stored pointers.
    pub entries: Entries,
}

/// Each entry's address and the function and block it is, sorted by address: one each, the first marked where a
/// place was marked more than once.
#[derive(Debug, Default)]
pub struct Entries(Vec<(u64, (u32, u32))>, Buckets);

/// Where in a sorted list of addresses each stretch of 2^shift bytes from `base` begins: a look-up is a load and a
/// search of the few addresses in one stretch, not of all of them.
#[derive(Debug, Default)]
pub(crate) struct Buckets { base: u64, shift: u32, at: Vec<u32> }

impl Buckets {
    /// Over `sorted` (ascending), about as many stretches as addresses.
    pub(crate) fn of(sorted: impl ExactSizeIterator<Item = u64> + Clone) -> Buckets {
        let (n, mut all) = (sorted.len(), sorted.clone());
        let (Some(base), Some(last)) = (all.next(), sorted.clone().last()) else { return Buckets::default() };
        let shift = ((last - base) / n as u64).max(1).ilog2();
        let count = ((last - base) >> shift) as usize + 1;
        let mut at = vec![0u32; count + 1];
        for a in sorted { at[((a - base) >> shift) as usize + 1] += 1; }
        for k in 0..count { at[k + 1] += at[k]; }
        Buckets { base, shift, at }
    }
    /// The range of the list where `address` would be.
    #[inline]
    pub(crate) fn range(&self, address: u64) -> std::ops::Range<usize> {
        // (In 64 bits throughout: an address before `base` wraps to far past the last stretch, and a 32-bit usize
        // would cut it to a stretch it is not in.)
        let b = address.wrapping_sub(self.base) >> self.shift;
        if b >= self.at.len().saturating_sub(1) as u64 { return 0..0; }
        let b = b as usize;
        self.at[b] as usize..self.at[b + 1] as usize
    }
}

impl Entries {
    pub(crate) fn of(mut marks: Vec<(u64, (u32, u32))>) -> Entries {
        // The first marked of an address is the one of the lowest function (a function marks an address one way).
        marks.sort_unstable_by_key(|&(a, (f, _))| (a as u128) << 32 | f as u128);
        marks.dedup_by_key(|&mut (a, _)| a);
        marks.shrink_to_fit();
        let buckets = Buckets::of(marks.iter().map(|&(a, _)| a));
        Entries(marks, buckets)
    }
    pub fn get(&self, address: &u64) -> Option<&(u32, u32)> { self.index(*address).map(|k| &self.0[k].1) }
    /// Where `address` is among the entries (as Liveness numbers them), found once for all that is asked of it.
    pub fn index(&self, address: u64) -> Option<usize> {
        let r = self.1.range(address);
        self.0[r.clone()].binary_search_by_key(&address, |&(a, _)| a).ok().map(|k| r.start + k)
    }
    pub fn at(&self, k: usize) -> (u32, u32) { self.0[k].1 }
    pub fn contains_key(&self, address: &u64) -> bool { self.get(address).is_some() }
    pub fn len(&self) -> usize { self.0.len() }
    pub fn is_empty(&self) -> bool { self.0.is_empty() }
    pub fn keys(&self) -> impl Iterator<Item = &u64> + '_ { self.0.iter().map(|(a, _)| a) }
    pub fn values(&self) -> impl Iterator<Item = &(u32, u32)> + '_ { self.0.iter().map(|(_, v)| v) }
    pub fn iter(&self) -> impl Iterator<Item = (&u64, &(u32, u32))> + '_ { self.0.iter().map(|(a, v)| (a, v)) }
}

impl<'a> IntoIterator for &'a Entries {
    type Item = (&'a u64, &'a (u32, u32));
    type IntoIter = std::iter::Map<std::slice::Iter<'a, (u64, (u32, u32))>, fn(&'a (u64, (u32, u32))) -> (&'a u64, &'a (u32, u32))>;
    fn into_iter(self) -> Self::IntoIter { self.0.iter().map(|(a, v)| (a, v)) }
}

/// Where a block may go on to within its function: where it falls or jumps, both sides of a branch, where a call
/// comes back to.
pub fn goes_to(b: &Block) -> [Option<u64>; 2] {
    match b.exit {
        Exit::Fall(a) | Exit::Jump(a) | Exit::Call { ret: a, .. } | Exit::IndirectCall { ret: a } => [Some(a), None],
        Exit::Branch { taken, fall } => [Some(taken), Some(fall)],
        _ => [None, None],
    }
}

/// No block (in a block's successors, by index within its function).
pub const NO: u32 = u32::MAX;
