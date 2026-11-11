//! A function made a wasm function: its blocks in the order layout.rs gave them, each a label the code before it
//! breaks out to, its loops wasm loops, a dispatch loop only where it may be entered within; each block's
//! instructions decoded again and lowered on the frame (frame.rs); how it goes on, calls and comes back; and its
//! bytes written onto the module once sync.rs has said what each sync moves.
//!
//! What it costs, an x86 instruction at a time: a decode (iced's, about 120 of the host's instructions), the operators
//! it lowers to written as their bytes, a note of each register it moves, and the flags needed after it. What making a
//! function needs is kept from one function to the next, so none allocates, and nothing is made twice.

use crate::abi::*;
use crate::elf::Elf;
use crate::facts::{Liveness, Summary};
use crate::flags::Flags;
use crate::frame::*;
use crate::layout::{has_loop, loops_into, within_of, Loop};
use crate::program::*;
use crate::sync::{sync_masks, Masks};
use crate::wasm::*;
use crate::x86::*;

/// What every function's lowering reads.
#[derive(Clone, Copy)]
pub struct Lowering<'p> {
    pub elf: &'p Elf,
    pub program: &'p Program,
    pub handed: &'p Liveness,
    pub summaries: &'p [Summary],
    pub trace: bool,
}

impl Fx<'_> {
    /// Into loop `l` at its head: its label and those of the blocks directly within it. Entered past its head (only
    /// ever from the dispatch: a call's continuation, a loop within, after the thread went to the kernel there), on to
    /// that block, or the head of the loop within this one that holds it, which sends it on in turn: a local tested
    /// every round, the rest only then.
    fn enter_loop(&mut self, l: usize) {
        let Loop { head, last, .. } = self.loops[l];
        self.loop_();
        self.open(Lab::Loop(l));
        for b in (head + 1..=last).rev() { if self.within[b] == Some(l) { self.block(); self.open(Lab::Block(b)); } }
        if !(head + 1..=last).any(|b| self.entry[b]) { return; }
        self.depth = self.labels.len() as u32;
        // Each block's way: its label within this loop itself, or (WITHIN) the label of the head of the loop within
        // this one that holds it.
        const WITHIN: u32 = 1 << 31;
        let (mut route, mut table) = (std::mem::take(&mut self.tables[0]), std::mem::take(&mut self.tables[1]));
        route.clear();
        route.extend((head + 1..=last).map(|b| {
            let (mut w, mut t) = (self.within[b], b);
            while let Some(c) = w { if c == l { break; } t = self.loops[c].head; w = self.loops[c].parent; }
            let at = self.block_at[t].unwrap_or_default();
            if t == b { at } else { at | WITHIN }
        }));
        self.get(L_INTO);
        self.if_();
        self.block();
        table.clear();
        table.extend(route.iter().map(|&r| if r & WITHIN == 0 { 0 } else { self.to(r & !WITHIN) + 2 }));
        self.get(L_INTO); self.c32(head as i32 + 2); self.op(I32_SUB);
        self.br_table(&table, 1);
        self.end();
        table.clear();
        table.extend(route.iter().map(|&r| if r & WITHIN == 0 { self.to(r) + 1 } else { 0 }));
        self.get(L_INTO); self.c32(0); self.set(L_INTO);
        self.c32(head as i32 + 2); self.op(I32_SUB);
        self.br_table(&table, 0);
        self.end();
        self.tables = [route, table];
    }

    /// On at `address`: falling through to the next block, out to a block after this one, round a loop it is in,
    /// round the dispatch loop, or out of the function.
    fn goto(&mut self, (address, target): (u64, u32), next: Option<u64>) {
        if Some(address) == next { self.note(Ev::Edge); return; }
        match (target != NO).then_some(target as usize) {
            Some(b) => {
                if b <= self.at { self.time_slice(address); }
                self.note(Ev::Edge);
                let label = if b > self.at { self.block_at[b] } else { self.heads[b].and_then(|l| self.loop_at[l]) };
                match label {
                    Some(at) => self.br(self.to(at)),
                    None => { debug_assert!(self.dispatch, "a lean function went round the dispatch"); self.c32(b as i32); self.set(L_BLK); self.br(self.depth); }
                }
            }
            None => {
                // Out to an address before this block's (another run of the same function) may go round a loop.
                if address <= self.function.blocks[self.at].start { self.time_slice(address); }
                self.tail(address)
            }
        }
    }

    /// Nonzero when the thread's budget is spent (one less now).
    fn spent(&mut self) {
        if self.budget { self.get(L_BUDGET); self.c32(1); self.op(I32_SUB); self.tee(L_BUDGET); self.op(I32_EQZ); }
        else { self.gget(G_BUDGET); self.c32(1); self.op(I32_SUB); self.gset(G_BUDGET); self.gget(G_BUDGET); self.op(I32_EQZ); }
    }

    /// At a loop's head: its turn is up when its budget is spent, or when it is asked to look in (a signal, taken at a
    /// loop as a CPU takes an interrupt, so `while (!got) pause();` takes it at the call).
    fn time_slice(&mut self, address: u64) {
        self.spent();
        self.c32(0); self.mem(I32_LOAD, 2, INTERRUPT as u64);
        self.op(I32_OR);
        self.if_();
        self.depth += 1;
        self.save();
        self.save_flags(self.handed.handed_at(self.program.entries.index(address)));
        self.c64(address as i64); self.c32(TRAP_YIELD); self.call(F_TRAP); self.op(UNREACHABLE);
        self.depth -= 1;
        self.end();
    }

    /// Before a call: past DEPTH_LIMIT frames, or when the budget is spent, made from the kernel instead (to the
    /// target `target` pushes); else one frame more.
    fn enter_call(&mut self, flags: u32, target: impl FnOnce(&mut Self)) {
        self.note_low();
        self.gget(G_DEPTH); self.c32(DEPTH_LIMIT); self.op(I32_GE_U);
        self.spent();
        self.op(I32_OR);
        self.if_();
        self.depth += 1;
        self.save_flags(flags);
        target(self);
        self.c32(TRAP_UNWIND); self.c32(TRAP_YIELD);
        self.gget(G_DEPTH); self.c32(DEPTH_LIMIT); self.op(I32_GE_U);
        self.op(SELECT);
        self.call(F_TRAP); self.op(UNREACHABLE);
        self.depth -= 1;
        self.end();
        self.gget(G_DEPTH); self.c32(1); self.op(I32_ADD); self.gset(G_DEPTH);
    }
    fn leave_call(&mut self) { self.gget(G_DEPTH); self.c32(1); self.op(I32_SUB); self.gset(G_DEPTH); }

    /// To code outside this function without growing the stack.
    fn tail(&mut self, address: u64) {
        self.save();
        let e = self.program.entries.index(address);
        self.save_flags(self.handed.handed_at(e));
        match e.map(|e| self.program.entries.at(e)) {
            Some((f, b)) => { self.c32(b as i32); self.return_call(FIRST_GUEST + f); }
            None => { self.c64(address as i64); self.return_call(F_DISPATCH); }
        }
    }

    /// After a call: on at its return address (taking back `writes`, or all of them, from the globals), or, handed
    /// another (a longjmp out of the callee, in l_t(0)), to the function's resume (after what this frame holds is
    /// saved, where a quiet call left it in the locals).
    fn after_call(&mut self, ret: (u64, u32), next: Option<u64>, writes: Option<u32>) {
        self.get(l_t(0)); self.c64(ret.0 as i64); self.op(I64_NE);
        self.if_();
        if writes.is_some() { self.save(); }
        self.br(self.depth + 1 + self.dispatch as u32);
        self.end();
        self.sync_in(false, writes.unwrap_or(ALL));
        self.set_flags(Flags::Held);
        self.goto(ret, next);
    }
}

/// The function `target` (entry `e`) starts and its summary, when it is one of this program's that never goes out.
fn quiet(program: &Program, summaries: &[Summary], target: u64, e: Option<usize>) -> Option<(u32, Summary)> {
    let (f, b) = program.entries.at(e?);
    let s = *summaries.get(f as usize)?;
    (b == 0 && program.functions[f as usize].start == target && !s.exits).then_some((f, s))
}

/// What making a function needs, kept from one function to the next (cleared, not freed), so none allocates.
#[derive(Default)]
pub struct Frame {
    f: Vec<u8>,
    ev: Vec<Ev>,
    ev_at: Vec<usize>,
    syncs: Vec<(usize, bool, u32)>,
    kinds: Vec<u8>,
    entry: Vec<bool>,
    loops: Vec<Loop>,
    within: Vec<Option<usize>>,
    heads: Vec<Option<usize>>,
    labels: Vec<Lab>,
    block_at: Vec<Option<u32>>,
    loop_at: Vec<Option<u32>>,
    code: Vec<Instruction>,
    needed: Vec<u32>,
    /// clean_loops' and sync_masks' own.
    marks: (Vec<usize>, Vec<usize>),
    cold: Vec<bool>,
    entered: Vec<bool>,
    masks: Masks,
    /// Two lists of labels: a function's dispatch and each loop's are made in them.
    tables: [Vec<u32>; 2],
}

/// Entries the dispatch starts at only to go on after the thread went to the kernel there, or a longjmp: a call's
/// continuation, a loop's head, a system call's or the instruction after it. A loop entered past its head at one is
/// still a wasm loop (enter_loop routes it); one entered at others (a switch's cases, another run's code) is not.
fn cold_entries(function: &Function, succ: &[[u32; 2]], cold: &mut Vec<bool>) {
    cold.clear();
    cold.resize(function.blocks.len(), false);
    for (k, b) in function.blocks.iter().enumerate() {
        // (A call's return is its first successor.)
        if matches!(b.exit, Exit::Call { .. } | Exit::IndirectCall { .. }) && succ[k][0] != NO { cold[succ[k][0] as usize] = true; }
        for &t in &succ[k] { if t != NO && t as usize <= k { cold[t as usize] = true; } }
        if b.resumes {
            if let Some(t) = function.block_index(b.end()) { cold[t] = true; }
            if b.count == 1 { cold[k] = true; }
        }
    }
}

/// Of the function's loops (into `s.loops`, with `s.within` and `s.heads`), those made wasm loops: the ones no jump
/// from outside enters past their head and no entry but a cold one lies in past their head, each within the nearest
/// such. Returns whether the function needs no dispatch loop beyond its entry: no jump back but a kept loop's round.
fn clean_loops(function: &Function, s: &mut Frame) -> bool {
    let n = function.blocks.len();
    loops_into(&function.succ, &mut s.loops, (&mut s.marks.0, &mut s.marks.1));
    cold_entries(function, &function.succ, &mut s.cold);
    loop {
        s.heads.clear();
        s.heads.resize(n, None);
        for (l, lp) in s.loops.iter().enumerate() { s.heads[lp.head] = Some(l); }
        s.entered.clear();
        s.entered.resize(s.loops.len(), false);
        let (loops, entered, heads) = (&s.loops, &mut s.entered, &s.heads);
        let mut rounds_only = true;
        let mut mark = |t: usize, from: Option<usize>| for (l, lp) in loops.iter().enumerate() {
            if t > lp.head && t <= lp.last && from.is_none_or(|k| k < lp.head || k > lp.last) { entered[l] = true; }
        };
        for (k, to) in function.succ.iter().enumerate() {
            if !s.cold[k] && s.entry[k] { mark(k, None); }
            for t in to.iter().filter(|&&t| t != NO).map(|&t| t as usize) {
                if t > k { mark(t, Some(k)); continue; }
                if !heads[t].is_some_and(|l| (loops[l].head..=loops[l].last).contains(&k)) { mark(t, None); rounds_only = false; }
            }
        }
        if !s.entered.contains(&true) {
            within_of(&s.loops, n, &mut s.within);
            return rounds_only;
        }
        // The loops kept, in place (a loop's parent comes before it), each within the nearest kept one: their parents
        // as they were read from `was`, the slots before a loop being written over as it is reached.
        let (now, was) = (&mut s.marks.0, &mut s.marks.1);
        now.clear();
        now.resize(s.loops.len(), usize::MAX);
        was.clear();
        was.extend(s.loops.iter().map(|lp| lp.parent.unwrap_or(usize::MAX)));
        let mut kept = 0;
        for l in 0..s.loops.len() {
            if s.entered[l] { continue; }
            let mut p = was[l];
            while p != usize::MAX && s.entered[p] { p = was[p]; }
            now[l] = kept;
            s.loops[kept] = Loop { parent: (p != usize::MAX).then(|| now[p]), ..s.loops[l] };
            kept += 1;
        }
        s.loops.truncate(kept);
    }
}

/// Function `index` (numbered in the table from `base`) made, its body with its size before it, onto `out`. Lean
/// when it may be (entered only at its start, with no indirect jump and no jump back but a loop's round: no dispatch
/// loop, no br_table, and with no call no resume either); V8's first tier checks the stack at each loop's head and
/// zeroes the locals of a function with more than a few.
pub fn lower_function(cx: &Lowering, index: u32, base: u32, report: &mut Report, frame: &mut Frame, out: &mut Vec<u8>) {
    let Lowering { elf, program, handed, summaries, trace } = *cx;
    let function = &program.functions[index as usize];
    let n = function.blocks.len();
    // Whether each block is an entry, found once here.
    frame.entry.clear();
    frame.entry.extend((0..n).map(|k| handed.is_entry(index, k)));
    let rounds_only = clean_loops(function, frame);
    let entered_within = function.blocks.iter().any(|b| b.exit == Exit::IndirectJump) || frame.entry.iter().skip(1).any(|&e| e);
    let lean = !entered_within && rounds_only;
    let cases = handed.cases[index as usize] as u32;
    let mut s = std::mem::take(frame);
    s.loop_at.clear();
    s.loop_at.resize(s.loops.len(), None);
    s.block_at.clear();
    s.block_at.resize(n, None);
    s.ev_at.clear();
    s.ev_at.push(0);
    s.f.clear(); s.ev.clear(); s.syncs.clear(); s.kinds.clear(); s.labels.clear();
    let mut fx = Fx {
        f: s.f, syncs: s.syncs, used: 0, ev: s.ev, ev_at: s.ev_at, run: [0; 3], nest: 0, depth: 0,
        slots: [0; LOCALS], kinds: s.kinds, flags: Flags::Held, fr_pending: false, fused: None, rsp_up: false, backward: false,
        entry: s.entry, dispatch: !lean, program, function, report, handed, at: 0, budget: has_loop(function), summaries, succ: &function.succ,
        loop_at: s.loop_at, loops: s.loops, within: s.within, heads: s.heads, labels: s.labels, block_at: s.block_at, tables: s.tables,
    };
    let (mut code, mut needed) = (s.code, s.needed);
    // The stack pointer it began with, only where it is read: past a call (the resume) or an indirect jump.
    let calls = function.blocks.iter().any(|b| matches!(b.exit, Exit::Call { .. } | Exit::IndirectCall { .. }));
    if calls || function.blocks.iter().any(|b| b.exit == Exit::IndirectJump) {
        fx.gget(RSP); fx.c64(-1); fx.get(L_ENTRY); fx.op(I32_EQZ); fx.op(SELECT); fx.set(L_SP0);
    }
    // Entered at L_ENTRY: from outside, or again from the resume below, as from outside.
    let resume = !lean || calls;
    if resume { fx.loop_(); }
    if !lean { fx.get(L_ENTRY); fx.set(L_BLK); }
    fx.load();
    fx.load_flags(cases);
    if resume { fx.block(); }
    if !lean { fx.loop_(); }
    // A label for each block within no loop past its head, the last block's outermost: each ends where its code starts.
    for b in (0..n).rev() { if fx.within[b].is_none() { fx.block(); fx.open(Lab::Block(b)); } }
    fx.depth = fx.labels.len() as u32;
    if !lean {
        // Each entry to its label; one within a loop past its head to the head of the outermost loop it lies within,
        // with L_INTO saying where to go on. Block 0 (a call's way in) first: a br_table of n is log n compares.
        let outermost = |fx: &Fx, b: usize| {
            let (mut l, mut t) = (fx.within[b], b);
            while let Some(w) = l { t = fx.loops[w].head; l = fx.loops[w].parent; }
            fx.to(fx.block_at[t].unwrap_or_default())
        };
        let (mut heads, mut targets) = (std::mem::take(&mut fx.tables[0]), std::mem::take(&mut fx.tables[1]));
        heads.clear();
        heads.extend((0..n).map(|b| outermost(&fx, b)));
        if (0..n).any(|b| fx.entry[b] && fx.within[b].is_some()) {
            fx.block();
            targets.clear();
            targets.extend((0..n).map(|b| if fx.within[b].is_some() { 0 } else { heads[b] + 1 }));
            fx.get(L_BLK); fx.op(I32_EQZ); fx.br_if(targets[0]);
            fx.get(L_BLK);
            fx.br_table(&targets, 0);
            fx.end();
            fx.get(L_BLK); fx.c32(1); fx.op(I32_ADD); fx.set(L_INTO);
            fx.get(L_BLK);
            fx.br_table(&heads, 0);
        } else {
            fx.get(L_BLK); fx.op(I32_EQZ); fx.br_if(heads[0]);
            fx.get(L_BLK);
            fx.br_table(&heads, 0);
        }
        fx.tables = [heads, targets];
    }
    let mut decoder = Code::new(elf, function.span().map_or(function.start, |(lo, _)| lo));
    for (k, block) in function.blocks.iter().enumerate() {
        decoder.decode(elf, block.start, block.count, &mut code);
        // Block k's label closed so its code starts here; a loop it heads is gone round from here.
        fx.end();
        fx.close(Lab::Block(k));
        if let Some(l) = fx.heads[k] { fx.enter_loop(l); }
        fx.end_run();
        fx.ev_at.push(fx.ev.len());
        fx.nest = 0;
        fx.depth = fx.labels.len() as u32;
        fx.set_flags(Flags::Held);
        fx.backward = false;
        fx.at = k;
        fx.report.blocks += 1;
        if trace { fx.c64(block.start as i64); fx.call(F_TRACE); }
        let next = function.blocks.get(k + 1).map(|b| b.start);
        let (held, ext) = handed.live_out(index, k);
        // The flags needed after each instruction, from the end back.
        needed.clear();
        needed.resize(code.len(), 0);
        let mut live = held | ext;
        for (j, i) in code.iter().enumerate().rev() { needed[j] = live; let k = kind(i); live = (live & !k.writes as u32) | k.reads as u32; }
        let last = code.len() - 1;
        for (j, i) in code.iter().enumerate() {
            fx.report.instructions += 1;
            if j == last && !runs_on(i) { break; }
            // A compare whose flags only the branch that ends the block reads is that branch's condition.
            if j + 1 == last && held | ext == 0 && matches!(block.exit, Exit::Branch { .. }) && Fx::fusable(i, code[last].condition_code()) {
                fx.fused = Some(*i);
                continue;
            }
            fx.instruction(i, needed[j] != 0);
        }
        let term = code[last];
        let to = fx.succ[k];
        if held != 0 && !matches!(block.exit, Exit::Branch { .. }) { fx.hold_flags(); }
        match block.exit {
            Exit::Fall(a) | Exit::Jump(a) => fx.goto((a, to[0]), next),
            Exit::TailJump(a) => fx.tail(a),
            Exit::Branch { taken, fall } => {
                fx.condition(term.condition_code());
                if held != 0 { fx.set(l_u(1)); fx.hold_flags(); fx.get(l_u(1)); }
                // A side going forward to a label open here is a br_if to it; where the taken side is the next block,
                // the condition turned round goes to the other.
                let (taken, fall) = ((taken, to[0]), (fall, to[1]));
                if let Some(d) = fx.forward(taken.1) {
                    fx.note(Ev::Edge);
                    fx.br_if(d);
                    fx.goto(fall, next);
                } else if let Some(d) = fx.forward(fall.1).filter(|_| Some(taken.0) == next) {
                    fx.op(I32_EQZ);
                    fx.note(Ev::Edge);
                    fx.br_if(d);
                    fx.goto(taken, next);
                } else {
                    fx.if_();
                    fx.depth += 1;
                    fx.goto(taken, None);
                    fx.depth -= 1;
                    fx.end();
                    fx.goto(fall, next);
                }
            }
            Exit::IndirectJump => {
                fx.read(&term, 0, 8);
                fx.set(l_t(0));
                fx.get(l_t(0)); fx.call(F_RESOLVE); fx.set(l_t(1));
                // This function's own (by the table's numbering, which a module made later starts at its base).
                fx.get(l_t(1)); fx.c64(32); fx.op(I64_SHR_U); fx.c64((base + index) as i64); fx.op(I64_EQ);
                fx.note(Ev::Edge);
                fx.if_();
                fx.get(l_t(1)); fx.op(I32_WRAP_I64); fx.set(L_BLK);
                fx.br(fx.depth + 1);
                fx.end();
                fx.save();
                // Elsewhere, it is handed what this function's own cases read: up to the frames further out when rsp
                // is above where this one began (a longjmp), else to the dispatcher.
                fx.save_flags(cases);
                fx.get(l_reg(RSP)); fx.get(L_SP0); fx.op(I64_GT_U);
                fx.if_();
                fx.get(l_t(0)); fx.op(RETURN);
                fx.end();
                fx.get(l_t(0)); fx.return_call(F_DISPATCH);
            }
            Exit::Call { target, ret } => {
                fx.push_with(|fx| { fx.c64(ret as i64); true });
                let e = program.entries.index(target);
                if let Some((f, s)) = quiet(program, fx.summaries, target, e) {
                    // To a function that never goes out: only what it may touch is moved, and its depth not counted.
                    fx.note_low();
                    fx.sync_in(true, s.reads | s.writes);
                    fx.c32(0); fx.call(FIRST_GUEST + f);
                    fx.set(l_t(0));
                    fx.after_call((ret, to[0]), next, Some(s.writes));
                } else {
                    fx.save();
                    fx.enter_call(handed.handed_at(e), |fx| fx.c64(target as i64));
                    match e.map(|e| program.entries.at(e)) {
                        Some((f, b)) => { fx.c32(b as i32); fx.call(FIRST_GUEST + f); }
                        None => { fx.c64(target as i64); fx.call(F_DISPATCH); }
                    }
                    fx.set(l_t(0));
                    fx.leave_call();
                    fx.after_call((ret, to[0]), next, None);
                }
            }
            Exit::IndirectCall { ret } => {
                // The target is read before the return address is pushed.
                fx.read(&term, 0, 8);
                fx.set(l_t(2));
                fx.push_with(|fx| { fx.c64(ret as i64); true });
                fx.save();
                fx.enter_call(ALL_FLAGS, |fx| fx.get(l_t(2)));
                fx.get(l_t(2)); fx.call(F_DISPATCH);
                fx.set(l_t(0));
                fx.leave_call();
                fx.after_call((ret, to[0]), next, None);
            }
            Exit::Return => {
                fx.pop_value(l_t(0));
                if term.op_count() == 1 { fx.get(l_reg(RSP)); fx.c64(term.immediate16() as i64); fx.op(I64_ADD); fx.set(l_reg(RSP)); }
                fx.save();
                fx.get(l_t(0)); fx.op(RETURN);
            }
            Exit::Trap => {
                fx.c64(term.ip() as i64);
                fx.c32(match term.mnemonic() { Mnemonic::Ud2 => TRAP_UD2, Mnemonic::Int3 => TRAP_INT3, Mnemonic::Hlt => TRAP_HLT, _ => TRAP_UNDECODED });
                fx.call(F_TRAP);
                fx.op(UNREACHABLE);
            }
        }
        // The loops this is the last block of end here, the innermost first.
        while let Some(&Lab::Loop(l)) = fx.labels.last() {
            if fx.loops[l].last != k { break; }
            fx.end();
            fx.close(Lab::Loop(l));
        }
    }
    if !resume {
        fx.op(UNREACHABLE);
        fx.end();
        return finish(fx, (code, needed, s.marks, s.cold, s.entered, s.masks), frame, out);
    }
    if !lean { fx.end(); }
    fx.op(UNREACHABLE);
    fx.end();
    // The resume: a call came back to an address not its own (after_call), in l_t(0). One of this function's entries
    // is entered again here, registers and flags from their globals, so a longjmp to a frame of this function's goes
    // on in it; anything else goes up, at once when rsp is above where this frame began.
    fx.gget(RSP); fx.get(L_SP0); fx.op(I64_GT_U);
    fx.if_();
    fx.get(l_t(0)); fx.op(RETURN);
    fx.end();
    fx.get(l_t(0)); fx.call(F_RESOLVE); fx.set(l_t(1));
    if lean {
        fx.get(l_t(1)); fx.c64(((base + index) as i64) << 32); fx.op(I64_EQ);
        fx.br_if(0);
    } else {
        fx.get(l_t(1)); fx.c64(32); fx.op(I64_SHR_U); fx.c64((base + index) as i64); fx.op(I64_EQ);
        fx.if_();
        fx.get(l_t(1)); fx.op(I32_WRAP_I64); fx.set(L_ENTRY);
        fx.br(1);
        fx.end();
    }
    fx.get(l_t(0)); fx.op(RETURN);
    fx.end();
    fx.op(UNREACHABLE);
    fx.end();
    finish(fx, (code, needed, s.marks, s.cold, s.entered, s.masks), frame, out)
}

/// The rest of a frame, handed back with the function's own buffers.
type Rest = (Vec<Instruction>, Vec<u32>, (Vec<usize>, Vec<usize>), Vec<bool>, Vec<bool>, Masks);

/// Onto `out`: the function's size, its locals, then its code with each sync put in, only the registers it must move
/// (sync_masks: one the function never touches stays in its global, where code it calls and the host find it); and
/// every buffer back into `frame`.
fn finish(mut fx: Fx, rest: Rest, frame: &mut Frame, out: &mut Vec<u8>) {
    let (code, needed, marks, cold, entered, mut masks) = rest;
    fx.end_run();
    sync_masks(&fx, &mut masks);
    if fx.budget { fx.slot(L_BUDGET); }
    let (used, budget, slots) = (fx.used, fx.budget, fx.slots);
    // Room for the size (five bytes at most), then the body; the size written in at the end, and the body moved up
    // to it.
    let at = out.len();
    out.extend_from_slice(&[0; 5]);
    let groups = 1 + fx.kinds.windows(2).filter(|w| w[0] != w[1]).count() - fx.kinds.is_empty() as usize;
    uleb(out, groups as u64);
    let mut k = 0;
    while k < fx.kinds.len() {
        let run = fx.kinds[k..].iter().take_while(|&&t| t == fx.kinds[k]).count();
        uleb(out, run as u64);
        out.push(fx.kinds[k]);
        k += run;
    }
    // A move: local.get, global.set (a save), or global.get, local.set (a load).
    let pair = |f: &mut Vec<u8>, save: bool, local: u32, global: u32| {
        let (first, a, second, b) = if save { (0x20, local, 0x24, global) } else { (0x23, global, 0x21, local) };
        if a < 0x80 && b < 0x80 { f.extend_from_slice(&[first, a as u8, second, b as u8]) } else { f.push(first); uleb(f, a as u64); f.push(second); uleb(f, b as u64); }
    };
    let mut from = 0;
    for (&(offset, save, scope), &m) in fx.syncs.iter().zip(&masks.mask) {
        out.extend_from_slice(&fx.f[from..offset]);
        let mut moved = used & m;
        while moved != 0 {
            let n = moved.trailing_zeros();
            moved &= moved - 1;
            let (local, global) = if n < 16 { (l_reg(n), n) } else { (l_x(n - 16), g_xmm(n - 16)) };
            pair(out, save, slots[local as usize], global);
        }
        // (A call to a function that never goes out leaves the budget alone: it has no loop, and counts no call.)
        if budget && scope == ALL { pair(out, save, slots[L_BUDGET as usize], G_BUDGET); }
        from = offset;
    }
    out.extend_from_slice(&fx.f[from..]);
    let body = out.len() - at - 5;
    let mut size = [0u8; 5];
    let mut n = 0;
    let mut v = body;
    loop { size[n] = (v & 0x7f) as u8 | if v >= 0x80 { 0x80 } else { 0 }; n += 1; v >>= 7; if v == 0 { break; } }
    out[at..at + n].copy_from_slice(&size[..n]);
    out.copy_within(at + 5.., at + n);
    out.truncate(out.len() - (5 - n));
    *frame = Frame {
        f: fx.f, ev: fx.ev, ev_at: fx.ev_at, syncs: fx.syncs, kinds: fx.kinds, entry: fx.entry, loops: fx.loops, within: fx.within,
        heads: fx.heads, labels: fx.labels, block_at: fx.block_at, loop_at: fx.loop_at, code, needed, marks, cold, entered, masks, tables: fx.tables,
    };
}
