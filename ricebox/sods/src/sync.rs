//! Which registers each sync of a function moves between its locals and their globals: from what the frame noted
//! as it was made (frame.rs), the least that leaves every path right.

use crate::frame::*;
use crate::program::*;

/// What sync_masks keeps: each block's flow, the syncs noted on the way and their masks, and the blocks an indirect
/// jump within may go to.
#[derive(Default)]
pub(crate) struct Masks { flow: Vec<Flow>, notes: Vec<(usize, usize, u32, u32)>, pub(crate) mask: Vec<u32>, starts: Vec<usize> }

/// A block as the sync masks see it: where it goes within (up to two, or INDIRECT: any entry), whether a block at
/// or after it goes to it (`back`), its forward and backward transfers (`value & P | G`), and what is dirty into it
/// and live into it.
#[derive(Clone, Copy, Default)]
struct Flow { to: [u32; 2], n: u8, edged: bool, back: bool, forward: (u32, u32), backward: (u32, u32), dirty: u32, live: u32 }
const TO_ENTRIES: u8 = u8::MAX;

/// Which registers each sync must move (into `mask`, by sync). Between syncs a register lives in its local; its
/// global is what code outside reads and writes. A save stores only what was written since last stored or loaded on
/// some path here; a load takes in only what is read before it is surely written again; a save's stores count as
/// reads. Both flows through a block are `value & P | G` of the value coming in, so each block's events are gone
/// through once for its P and G, and the fixed points found block by block.
pub(crate) fn sync_masks(fx: &Fx, Masks { flow, notes, mask, starts }: &mut Masks) {
    let (function, syncs, events, ev_at) = (fx.function, &fx.syncs, &fx.ev, &fx.ev_at);
    let n = function.blocks.len();
    let ev = |k: usize| &events[ev_at[k]..ev_at.get(k + 1).copied().unwrap_or(events.len())];
    // Where the prologue's dispatch, and an indirect jump within, may go; each block's successors within.
    starts.clear();
    starts.extend((0..n).filter(|&k| k == 0 || fx.entry[k]));
    flow.clear();
    flow.extend(function.blocks.iter().zip(fx.succ).map(|(b, to)| {
        let mut f = Flow::default();
        if b.exit == Exit::IndirectJump { f.n = TO_ENTRIES; return f; }
        for &k in to.iter().filter(|&&k| k != NO) { f.to[f.n as usize] = k; f.n += 1; }
        f
    }));
    let to = |flow: &[Flow], k: usize, each: &mut dyn FnMut(usize)| {
        let f = &flow[k];
        if f.n == TO_ENTRIES { for &s in starts.iter() { each(s) } } else { for &s in &f.to[..f.n as usize] { each(s as usize) } }
    };
    // The blocks one at or after them goes to: where a round may hand something to what it has gone through.
    let mut anywhere = false;
    for k in 0..n {
        let (to, count) = (flow[k].to, flow[k].n);
        if count == TO_ENTRIES { anywhere = true; } else { for &s in &to[..count as usize] { if s as usize <= k { flow[s as usize].back = true; } } }
    }
    if anywhere { for &s in starts.iter() { flow[s].back = true; } }
    mask.clear();
    mask.resize(syncs.len(), 0);
    notes.clear();
    // Forward: written since the last sync on some path. A save takes what is dirty where it is.
    for (k, f) in flow.iter_mut().enumerate() {
        let (mut p, mut g, mut out_p, mut out_g) = (ALL, 0, 0, 0);
        for e in ev(k + 1) {
            match *e {
                Ev::Run([_, _, w]) => g |= w,
                Ev::Sync(m, top) if syncs[m as usize].1 => { let m = m as usize; notes.push((m, k, p, g)); if top { p &= !syncs[m].2; g &= !syncs[m].2; } }
                Ev::Edge => { out_p |= p; out_g |= g; f.edged = true; }
                _ => {}
            }
        }
        if !f.edged { out_p |= p; out_g |= g; }
        f.forward = (out_p, out_g);
    }
    // (Blocks gone through in order: what one hands a block after it is taken up in the same round, so another round
    // is made only where one handed something new to itself or a block before it.)
    loop {
        let mut again = false;
        for k in 0..n {
            let out = (flow[k].dirty & flow[k].forward.0) | flow[k].forward.1;
            let (to, count) = (flow[k].to, flow[k].n);
            let mut go = |s: usize| if flow[s].dirty | out != flow[s].dirty { flow[s].dirty |= out; again |= s <= k; };
            if count == TO_ENTRIES { for &s in starts.iter() { go(s) } } else { for &s in &to[..count as usize] { go(s as usize) } }
        }
        if !again { break; }
    }
    for &(m, k, p, g) in notes.iter() { mask[m] |= ((flow[k].dirty & p) | g) & syncs[m].2; }
    notes.clear();
    // Backward: read before surely written again. A load takes what is live where it is.
    for (k, f) in flow.iter_mut().enumerate() {
        let (mut p, mut g) = (if f.edged { 0 } else { ALL }, 0);
        for e in ev(k + 1).iter().rev() {
            match *e {
                Ev::Run([u, k, _]) => { p &= !k; g = (g & !k) | u; }
                Ev::Sync(m, _) if syncs[m as usize].1 => g |= mask[m as usize],
                Ev::Sync(m, top) => { let m = m as usize; notes.push((m, k, p, g)); if top { p &= !syncs[m].2; g &= !syncs[m].2; } }
                Ev::Edge => p = ALL,
            }
        }
        f.backward = (p, g);
    }
    let after = |flow: &[Flow], k: usize| { let mut a = 0; to(flow, k, &mut |s| a |= flow[s].live); a };
    // (From the last block back: another round only where a block that one at or after it goes to has grown.)
    loop {
        let mut again = false;
        for k in (0..n).rev() {
            let l = (after(flow, k) & flow[k].backward.0) | flow[k].backward.1;
            if flow[k].live | l != flow[k].live { flow[k].live |= l; again |= flow[k].back; }
        }
        if !again { break; }
    }
    for &(m, k, p, g) in notes.iter() { mask[m] |= ((after(flow, k) & p) | g) & syncs[m].2; }
    // The prologue takes in what any block it may start at reads.
    let start = starts.iter().fold(0, |acc, &k| acc | flow[k].live);
    for e in ev(0) { if let Ev::Sync(m, _) = *e { if !syncs[m as usize].1 { mask[m as usize] |= start; } } }
}
