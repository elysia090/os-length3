//! Makes src/scan_table.rs: `cargo run --release --example scan_table > src/scan_table.rs`.
//!
//! Every opcode of the four legacy maps is asked of the decoder (sods::scan::asked), each way it may be prefixed
//! (F3 or F2, 66, REX.W) and each way its ModRM may read (its reg, and whether it names a register, then which),
//! with what follows filled three ways: what it says there (whether it is an instruction, its immediate's size, its
//! flow, class and target, whether LOCK may stand before it) is a cell. Where it does not say the same whatever
//! follows, or says what scan() would not make of the cell, the cell is ASK: scan() asks the decoder there.

use sods::scan::*;

const AT: u64 = 0x40_1000;

/// The bytes: `head` (prefixes, map, opcode), a ModRM, a SIB, then `fill`.
fn bytes(head: &[u8], m: u8, sib: Option<u8>, fill: u8) -> Vec<u8> {
    let mut b = head.to_vec();
    b.push(m);
    b.extend(sib);
    b.resize(head.len() + 20, fill);
    b
}

/// How many bytes a ModRM `m` and what it asks for take.
fn part(m: u8, sib: Option<u8>) -> usize {
    if m >= 0xc0 { return 1; }
    let base = sib.map_or(m & 7, |s| s & 7);
    1 + sib.is_some() as usize + match m >> 6 { 1 => 1, 2 => 4, _ if base == 5 => 4, _ => 0 }
}

/// The cell for `head` followed by each of `tails`: one however what follows is filled; or one but for its flags,
/// which are its class's where the count in its last byte is not nothing and none where it is (a shift by an
/// immediate, the count the byte's low five bits or six); else ASK.
fn cell(head: &[u8], tails: &[(u8, Option<u8>)], modrm: bool) -> u32 {
    let plain = cell_with(head, tails, modrm, &[0xff, 0x00, 0x01]);
    if plain & ASK == 0 { return plain; }
    let counts = [1u8, 0, 2, 8, 9, 16, 17, 18, 31, 32, 33, 63, 64, 65, 0x80, 0xa0, 0xff];
    let said: Vec<u32> = counts.iter().map(|&v| cell_with(head, tails, modrm, &[v])).collect();
    let (class, rest) = (|c: u32| c >> 9 & 63, |c: u32| c & !(63 << 9));
    let with = said[0];
    if said.iter().any(|&c| c & (ASK | VALID) != VALID || rest(c) != rest(with)) || with >> IMM_AT & 7 != 1 { return ASK; }
    for (mask, wide) in [(0x1f, 0), (0x3f, COUNT_WIDE)] {
        if counts.iter().zip(&said).all(|(&v, &c)| class(c) == if v & mask == 0 { 0 } else { class(with) }) { return with | COUNTED | wide; }
    }
    ASK
}

/// The cell the decoder's answers make for `head` followed by each of `tails` (a ModRM and a SIB) filled each of
/// `fills`; `modrm`: whether what follows the opcode is a ModRM. ASK where they do not make one cell.
fn cell_with(head: &[u8], tails: &[(u8, Option<u8>)], modrm: bool, fills: &[u8]) -> u32 {
    let mut cell: Option<u32> = None;
    for &fill in fills {
        for &(m, sib) in tails {
            let b = bytes(head, m, sib, fill);
            let s = asked(&b, AT);
            let here = if s.entry == INVALID { 0 } else {
                let len = (s.entry & 15) as usize;
                let taken = head.len() + if modrm { part(m, sib) } else { 0 };
                let Some(imm) = len.checked_sub(taken) else { return ASK };
                let code = match imm { 0..=4 => imm as u32, 8 => 5, _ => return ASK };
                if s.entry >> 7 & 3 == ASKED { return ASK; }
                // Its number is its last four bytes or eight, and what it names from rip is after its displacement:
                // as scan() says of every cell.
                if s.number as u32 != 0 && imm != if s.number as u32 == IMM_WIDE { 8 } else { 4 } { return ASK; }
                let relative = if modrm && m < 0x40 && m & 7 == 5 { taken } else { 0 };
                if relative != s.relative as usize { return ASK; }
                VALID | code << IMM_AT | if modrm { MODRM } else { 0 } | (s.entry & !15) as u32 | (s.number as u32) << NUMBER
            };
            if cell.is_some_and(|c| c != here) { return ASK; }
            cell = Some(here);
        }
    }
    let mut cell = cell.unwrap_or(ASK);
    if cell & VALID == 0 { return cell; }
    // LOCK before it: an instruction only where it writes memory (so scan() takes it), and then for each way.
    let (m, sib) = tails[0];
    let locked: Vec<bool> = tails.iter().map(|&(m, sib)| { let mut b = vec![0xf0]; b.extend(bytes(head, m, sib, 0)); asked(&b, AT).entry != INVALID }).collect();
    if locked.iter().any(|&l| l != locked[0]) { return ASK; }
    if locked[0] { if modrm && m < 0xc0 { cell |= LOCKS; } else { return ASK; } }
    // The address size made 32 bits: its length the same, but for an address given whole (8 bytes, then 4).
    let mut b = vec![0x67];
    b.extend(bytes(head, m, sib, 0));
    let (with, without) = (asked(&b, AT), asked(&bytes(head, m, sib, 0), AT));
    if with.entry == INVALID { return ASK; }
    let (short, long) = ((with.entry & 15) as usize - 1, (without.entry & 15) as usize);
    if short != long {
        if !modrm && cell >> IMM_AT & 7 == 5 && long == head.len() + 8 && short == head.len() + 4 { cell = cell & !IMM | MOFFS << IMM_AT; } else { return ASK; }
    }
    if with.entry >> 4 != without.entry >> 4 { return ASK; }
    cell
}

fn place<T: PartialEq>(all: &mut Vec<T>, x: T) -> u16 {
    let at = all.iter().position(|y| *y == x).unwrap_or_else(|| { all.push(x); all.len() - 1 });
    u16::try_from(at).expect("a table's rows are counted in 16 bits")
}

fn main() {
    let (mut cells, mut l4, mut l3, mut l2) = (vec![ASK], vec![[0u16; 8]], vec![[0u16; 16]], vec![[0u16; 12]]);
    let mut l1 = [[0u16; 256]; 4];
    let maps: [&[u8]; 4] = [&[], &[0x0f], &[0x0f, 0x38], &[0x0f, 0x3a]];
    // A ModRM that names memory, each way it may: by each register, with each displacement, through a SIB, from rip.
    let memory: [(u8, Option<u8>); 14] = [
        (0x00, None), (0x01, None), (0x03, None), (0x07, None), (0x40, None), (0x45, None), (0x80, None), (0x86, None),
        (0x04, Some(0x00)), (0x04, Some(0x25)), (0x04, Some(0x05)), (0x44, Some(0x24)), (0x84, Some(0x24)), (0x05, None),
    ];
    for (map, escape) in maps.iter().enumerate() {
        for op in 0..=255u8 {
            // What scan() takes before it looks: prefixes, the escapes, VEX and EVEX.
            let never = match map {
                0 => matches!(op, 0x0f | 0x26 | 0x2e | 0x36 | 0x3e | 0x40..=0x4f | 0x62 | 0x64..=0x67 | 0xc4 | 0xc5 | 0xf0 | 0xf2 | 0xf3),
                1 => matches!(op, 0x0f | 0x38 | 0x3a),
                _ => false,
            };
            if never { continue; }
            let mut row2 = [0u16; 12];
            for (k2, slot) in row2.iter_mut().enumerate() {
                // Each REX that is not W asked too: a cell is what it is whichever of them is set.
                let mut rows: Vec<[u16; 16]> = Vec::new();
                for low in [0u8, 7] {
                    let mut head: Vec<u8> = Vec::new();
                    match k2 / 4 { 1 => head.push(0xf3), 2 => head.push(0xf2), _ => {} }
                    if k2 & 2 != 0 { head.push(0x66); }
                    let rex = if k2 & 1 != 0 { 0x48 | low } else { 0x40 | low };
                    if rex != 0x40 { head.push(rex); }
                    head.extend_from_slice(escape);
                    head.push(op);
                    // Whether a ModRM follows: its length goes with the ModRM's displacement, or it is an instruction
                    // only with some of them.
                    let said: Vec<u16> = (0..=255u8).map(|m| asked(&bytes(&head, m, None, 0), AT).entry).collect();
                    let len = |m: u8| (said[m as usize] & 15) as usize;
                    let by_length = (0..8u8).any(|r| { let m = r << 3; said[m as usize] != INVALID && said[0x40 | m as usize] != INVALID && said[0x80 | m as usize] != INVALID && len(0x40 | m) == len(m) + 1 && len(0x80 | m) == len(m) + 4 });
                    let modrm = by_length || said.iter().any(|&s| (s == INVALID) != (said[0] == INVALID));
                    let mut row3 = [0u16; 16];
                    for (key, slot) in row3.iter_mut().enumerate() {
                        let r = (key as u8 & 7) << 3;
                        *slot = if !modrm {
                            // (Whatever follows is not its ModRM: asked with several, and it must say the same.)
                            place(&mut cells, cell(&head, &[(0xff, None), (0x00, None), (0x05, None), (0x45, None), (0xc0, None), (r, None)], false))
                        } else if key < 8 {
                            let tails: Vec<(u8, Option<u8>)> = memory.iter().map(|&(m, sib)| (m | r, sib)).collect();
                            place(&mut cells, cell(&head, &tails, true))
                        } else {
                            let by_rm: [u16; 8] = std::array::from_fn(|rm| place(&mut cells, cell(&head, &[(0xc0 | r | rm as u8, None)], true)));
                            if by_rm.iter().all(|&c| c == by_rm[0]) { by_rm[0] } else { BY_RM | place(&mut l4, by_rm) }
                        };
                    }
                    rows.push(row3);
                }
                // (Where the two differ, each cell that does is asked.)
                let row3: [u16; 16] = std::array::from_fn(|k| if rows[0][k] == rows[1][k] { rows[0][k] } else { 0 });
                *slot = place(&mut l3, row3);
            }
            // (An opcode that is one cell however it is prefixed and whatever follows says so at once.)
            let all: Vec<u16> = row2.iter().flat_map(|&r| l3[r as usize]).collect();
            l1[map][op as usize] = if all.iter().all(|&c| c == all[0] && c & BY_RM == 0) { ONE | all[0] } else { place(&mut l2, row2) };
        }
    }
    println!("//! Made by examples/scan_table.rs (cargo run --release --example scan_table > src/scan_table.rs): not written by hand.");
    println!("//! What scan.rs reads: by an opcode's map and byte (L1: a cell at once, or a row of L2), then its prefixes (L2,");
    println!("//! sixteen to a row: F3 or F2, 66, REX.W), then its ModRM's reg and whether it names a register (L3, sixteen to a");
    println!("//! row; then which, L4, eight to a row), a cell (CELLS).");
    let line = |row: &[u16]| row.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ");
    println!("pub(crate) static L1: [u16; 1024] = [");
    for chunk in l1.as_flattened().chunks(24) { println!("    {},", line(chunk)); }
    println!("];");
    println!("pub(crate) static L2: [u16; {}] = [", l2.len() * 16);
    for row in &l2 { println!("    {}, 0, 0, 0, 0,", line(row)); }
    println!("];");
    println!("pub(crate) static L3: [u16; {}] = [", l3.len() * 16);
    for row in &l3 { println!("    {},", line(row)); }
    println!("];");
    println!("pub(crate) static L4: [u16; {}] = [", l4.len() * 8);
    for row in &l4 { println!("    {},", line(row)); }
    println!("];");
    println!("pub(crate) static CELLS: [u32; {}] = [", cells.len());
    for chunk in cells.chunks(10) { println!("    {},", chunk.iter().map(|c| format!("{c:#x}")).collect::<Vec<_>>().join(", ")); }
    println!("];");
    eprintln!("{} rows by prefix, {} by reg, {} by rm, {} cells", l2.len(), l3.len(), l4.len(), cells.len());
}
