//! What a file must not carry to the Remote: a secret. A Prompt started here has the Agent's key in its environment
//! (device/agent_key.rs), and whatever runs there can write it into a file of the repo; the Remote would then keep it, and
//! show it to everyone a repo is shared with. So a file about to be sent is read for one first, as GitHub's push
//! protection reads a push, and one that holds a secret stays on this device, named as what cannot be sent (as a file
//! over 16 MB is): a Commit then says which and why until it is taken out. Only forms nothing else has are looked
//! for, so nothing ordinary is held back: the models' makers' keys (as device/agent_key.rs knows them), Stripe's live keys,
//! GitHub's tokens, and this device's own sign-in, whole.

use crate::device::agent_key;

/// Whether `b` may be part of a key: the letters, digits, `-` and `_` every form here is made of.
const fn key_byte(b: u8) -> bool {
    ((b | 0x20).wrapping_sub(b'a') < 26) | (b.wrapping_sub(b'0') < 10) | (b == b'_') | (b == b'-')
}

/// A word as eight bytes side by side: 0x01 in each, and each one's high bit, and the seven bits below it.
const ONES: u64 = u64::from_ne_bytes([1; 8]);
const HIGH: u64 = ONES * 0x80;
const LOW: u64 = ONES * 0x7f;
/// The bit that makes an ASCII letter lower case, in each byte.
const LOWER: u64 = ONES * 0x20;

/// The high bit of each byte of `x`: whether that byte is within `lo..=hi` (both ASCII). All eight at once, none
/// carrying into the next: a byte's low seven bits plus at most 0x80 stay within it.
const fn within(x: u64, lo: u8, hi: u8) -> u64 {
    let t = x & LOW;
    (t + ONES * (0x80 - lo as u64)) & !(t + ONES * (0x7f - hi as u64)) & !x & HIGH
}

/// Bit k: whether byte k of `block` may be part of a key (`key_byte`), eight bytes to a word and no branch: the
/// letters as their lower case, the digits, `_` and `-`, and each byte's answer gathered into a bit by one multiply.
fn key_bytes(block: &[u8; 64]) -> u64 {
    block.as_chunks::<8>().0.iter().enumerate().fold(0, |m, (n, word)| {
        let x = u64::from_le_bytes(*word);
        let key = within(x | LOWER, b'a', b'z') | within(x, b'0', b'9') | within(x, b'_', b'_') | within(x, b'-', b'-');
        m | ((key >> 7).wrapping_mul(0x0102_0408_1020_4080) >> 56) << (8 * n)
    })
}

/// `run` as it may be shown (its start and its last four), when it is a key of a form known here.
fn known(run: &str) -> Option<String> {
    if agent_key::kind(run).is_some() { return Some(agent_key::shown(run)); }
    let tail = |start: &str| format!("{start}…{}", &run[run.len() - 4..]);
    let all = |r: &str, n: std::ops::RangeInclusive<usize>, ok: fn(u8) -> bool| n.contains(&r.len()) && r.bytes().all(ok);
    let alnum = |b: u8| b.is_ascii_alphanumeric();
    // Stripe's: a live secret key or a restricted one (a test key opens no money).
    for start in ["sk_live_", "rk_live_"] {
        if run.strip_prefix(start).is_some_and(|r| all(r, 24..=247, alnum)) { return Some(tail(start)); }
    }
    // GitHub's: a classic token of each kind, or a fine-grained one.
    for start in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        if run.strip_prefix(start).is_some_and(|r| all(r, 36..=36, alnum)) { return Some(tail(start)); }
    }
    if run.strip_prefix("github_pat_").is_some_and(|r| all(r, 82..=82, |b| b.is_ascii_alphanumeric() || b == b'_')) { return Some(tail("github_pat_")); }
    None
}

/// A secret found: a key, as it may be shown (its start and last four, never whole), or this device's own sign-in.
#[derive(Debug, PartialEq)]
pub enum Found { Key(String), Own }

impl Found {
    /// Why the file is not sent, as a person reads it beside the file's name.
    pub fn said(&self) -> String {
        match self {
            Found::Key(k) => crate::tr!("secret {}", "シークレット {}", k),
            Found::Own => crate::tr!("this device's sign-in", "このデバイスのサインイン情報"),
        }
    }
}

/// The first secret `bytes` holds; None when it holds none. `own` is this device's own secrets besides (its session on
/// the Remote), found anywhere in it, and said by what they are, not by any part of them.
pub fn found(bytes: &[u8], own: &[&str]) -> Option<Found> {
    if own.iter().filter(|s| s.len() >= 16).any(|s| memchr::memmem::find(bytes, s.as_bytes()).is_some()) {
        return Some(Found::Own);
    }
    // Only a run of key bytes as long as a key (16 at least: OpenAI's `sk-proj-` and the eight letters each of its
    // keys holds), starting where no key byte comes before it, is read for one. Where runs start and how long they
    // are is asked of 64 bytes at a time: their key bytes as a mask, the next 64's above it for a run that goes on
    // into them, and in it, by halving, where 16 come in a row. Most blocks have none, so no byte is branched on
    // alone, nor read twice. The last block is padded with bytes no key has, and a block of none follows it.
    let (blocks, rest) = bytes.as_chunks::<64>();
    let mut last = [0u8; 64];
    last[..rest.len()].copy_from_slice(rest);
    let mut masks = blocks.iter().chain([&last]).map(key_bytes).chain([0]);
    let (mut here, mut before) = (masks.next().unwrap_or(0), 0u64);
    for (n, next) in masks.enumerate() {
        let w = u128::from(here) | u128::from(next) << 64;
        let mut long = w & w >> 1;
        long &= long >> 2;
        long &= long >> 4;
        long &= long >> 8;
        let mut starts = long as u64 & !(here << 1 | before >> 63);
        while starts != 0 {
            let run = &bytes[n * 64 + starts.trailing_zeros() as usize..];
            starts &= starts - 1;
            let run = &run[..run.iter().position(|b| !key_byte(*b)).unwrap_or(run.len())];
            if matches!(run[0], b's' | b'r' | b'x' | b'g' | b'A' | b'p' | b'f' | b'h') {
                if let Some(shown) = std::str::from_utf8(run).ok().and_then(known) { return Some(Found::Key(shown)); }
            }
        }
        (before, here) = (here, next);
    }
    None
}

#[cfg(test)]
#[path = "tests/secrets.rs"]
mod tests;
