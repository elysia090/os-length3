//! Names asked for, and the addresses given them. A query is answered here: a name is given an address of cowboy's
//! own the first time it is asked for, and the same one after; the address is the name's place in the table, so an
//! address is named again by one index. No resolver is asked and nothing leaves the device: where the name really
//! is, is whoever makes the link's to find (a page's own request, a relay), who is given the name.
//!
//! The addresses are 198.18.0.0/15 (set aside for testing between networks, RFC 2544: on no network a box would
//! reach), from 198.18.0.16 up; 198.18.0.1 is the resolver itself (what a box's resolv.conf names).
//!
//! Laid out once, allocated never:
//!
//!   slots    4,096 of two bytes: a name's number and one, or nothing; found by the name's hash, the next slot on
//!            a miss. At most half are ever taken, so a look ends within a few
//!   places   2,048 names: where each one's bytes begin, how long it is, and its hash
//!   text     131,072 bytes: the names, lower case, dots between their labels; and after the last of them, room for
//!            one more (253 bytes), where a name asked for is written as it is read: it is found from there, and
//!            if it is new it is kept where it lies
//!
//! Full (2,048 names, or their bytes), it gives no new name an address: the query is refused (SERVFAIL), said so,
//! and the names it has stay as they are (an address given is never another name's).

/// How many names are kept, the slots they are found by (twice as many: a look is short), and their bytes.
pub const MOST: usize = 2048;
const SLOTS: usize = 4096;
const TEXT: usize = 131072;
/// The longest a name is, as DNS has it.
const LONGEST: usize = 253;

/// The resolver's own address, and the first of those given to names.
pub const RESOLVER: [u8; 4] = [198, 18, 0, 1];
const FIRST: u32 = 16;

/// How long an answer lives with whoever asked (seconds): a name's address does not change while cowboy does.
const TTL: u32 = 3600;

pub struct Names {
    slots: [u16; SLOTS],
    at: [u32; MOST],
    len: [u8; MOST],
    hash: [u32; MOST],
    text: [u8; TEXT],
    count: u16,
    used: u32,
    /// The slots looked at by the last look (its bound, for a test to hold).
    pub looked: u32,
}

/// A name's address: its number in the table, as 198.18.x.y.
pub fn address(number: u16) -> [u8; 4] {
    let n = FIRST + number as u32;
    [198, 18 + (n >> 16) as u8, (n >> 8) as u8, n as u8]
}

/// The number of the name `address` was given to, if it is one of cowboy's.
pub fn number(address: [u8; 4]) -> Option<u16> {
    if address[0] != 198 || (address[1] != 18 && address[1] != 19) { return None; }
    let n = ((address[1] as u32 - 18) << 16) | ((address[2] as u32) << 8) | address[3] as u32;
    n.checked_sub(FIRST).filter(|&n| n < MOST as u32).map(|n| n as u16)
}

const QUERY: u16 = 1 << 15;
const A: u16 = 1;
const IN: u16 = 1;

impl Names {
    pub const fn new() -> Names {
        Names { slots: [0; SLOTS], at: [0; MOST], len: [0; MOST], hash: [0; MOST], text: [0; TEXT], count: 0, used: 0, looked: 0 }
    }

    /// How many names have an address.
    pub fn count(&self) -> usize { self.count as usize }

    /// The name number `n` was given to.
    pub fn name(&self, n: u16) -> Option<&[u8]> {
        if n >= self.count { return None; }
        let at = self.at[n as usize] as usize;
        Some(&self.text[at..at + self.len[n as usize] as usize])
    }

    /// The number of the name whose bytes are the last `len` kept at the end of the text (written there by whoever
    /// asks, lower case): the one it has, or a new one. None: no room for another.
    fn number_of(&mut self, len: usize, hash: u32) -> Option<u16> {
        let from = self.used as usize;
        let mut slot = hash as usize & (SLOTS - 1);
        self.looked = 0;
        loop {
            self.looked += 1;
            let held = self.slots[slot];
            if held == 0 { break; }
            let n = (held - 1) as usize;
            if self.hash[n] == hash && self.len[n] as usize == len {
                let at = self.at[n] as usize;
                // (the same bytes: both lie in the text, the one asked for after every name kept)
                let (kept, asked) = self.text.split_at(from);
                if kept[at..at + len] == asked[..len] { return Some(n as u16); }
            }
            slot = (slot + 1) & (SLOTS - 1);
        }
        // (no room for another: as many as are kept, or none left to read the next one into)
        if self.count as usize == MOST || from + len > TEXT - LONGEST { return None; }
        let n = self.count;
        self.slots[slot] = n + 1;
        self.at[n as usize] = from as u32;
        self.len[n as usize] = len as u8;
        self.hash[n as usize] = hash;
        self.count += 1;
        // (kept where it was written: its bytes are the name's from now on)
        self.used += len as u32;
        Some(n)
    }

    /// A query answered into `out`: how long the answer is; 0 where what was sent is no query to answer (too short,
    /// an answer itself, more or fewer than one question, a name that is not one) or `out` has no room. A name asked
    /// for its address (A, IN) is given one; asked for anything else it has nothing of that kind, and is there.
    pub fn answer(&mut self, query: &[u8], out: &mut [u8]) -> usize {
        if query.len() < 12 + 5 { return 0; }
        let flags = u16::from_be_bytes([query[2], query[3]]);
        // A query, of the one kind there is (opcode 0), with one question.
        if flags & QUERY != 0 || (flags >> 11) & 15 != 0 || query[4] != 0 || query[5] != 1 { return 0; }
        // The name: its labels read once, each byte made lower case, hashed and kept as it is read.
        let from = self.used as usize;
        let (mut at, mut len, mut hash) = (12usize, 0usize, 0x811c_9dc5u32);
        loop {
            let Some(&label) = query.get(at) else { return 0 };
            at += 1;
            if label == 0 { break; }
            // (a label is its length and its bytes; one that points elsewhere is no question's)
            if label > 63 || at + label as usize > query.len() { return 0; }
            if len > 0 {
                if len + 1 > LONGEST { return 0; }
                self.text[from + len] = b'.';
                hash = (hash ^ b'.' as u32).wrapping_mul(0x0100_0193);
                len += 1;
            }
            if len + label as usize > LONGEST { return 0; }
            for &b in &query[at..at + label as usize] {
                let b = b.to_ascii_lowercase();
                self.text[from + len] = b;
                hash = (hash ^ b as u32).wrapping_mul(0x0100_0193);
                len += 1;
            }
            at += label as usize;
        }
        if at + 4 > query.len() || len == 0 { return 0; }
        let kind = u16::from_be_bytes([query[at], query[at + 1]]);
        let class = u16::from_be_bytes([query[at + 2], query[at + 3]]);
        let asked = at + 4;
        // The address of the name, where its address is what is asked: the machine's own for its own name.
        let gives = kind == A && class == IN;
        let mut code = 0u16;
        let mut given = [0u8; 4];
        if gives {
            if &self.text[from..from + len] == b"localhost" { given = [127, 0, 0, 1]; }
            else { match self.number_of(len, hash) { Some(n) => given = address(n), None => code = 2 } }
        }
        let answers = gives && code == 0;
        let total = asked + if answers { 16 } else { 0 };
        if out.len() < total { return 0; }
        // The answer: the query's own bytes (its number, its question), said to be an answer; then the address.
        out[..asked].copy_from_slice(&query[..asked]);
        let said = QUERY | (flags & 0x0100) | 0x0080 | code;
        out[2..4].copy_from_slice(&said.to_be_bytes());
        out[6..8].copy_from_slice(&(answers as u16).to_be_bytes());
        out[8..12].fill(0);
        if answers {
            let a = &mut out[asked..total];
            // (the name is the question's: two bytes that point at it)
            a[0..2].copy_from_slice(&[0xc0, 12]);
            a[2..4].copy_from_slice(&A.to_be_bytes());
            a[4..6].copy_from_slice(&IN.to_be_bytes());
            a[6..10].copy_from_slice(&TTL.to_be_bytes());
            a[10..12].copy_from_slice(&4u16.to_be_bytes());
            a[12..16].copy_from_slice(&given);
        }
        total
    }
}

impl Default for Names {
    fn default() -> Names { Names::new() }
}

#[cfg(test)]
#[path = "names.test.rs"]
pub(crate) mod tests;
