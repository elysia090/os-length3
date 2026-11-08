//! What a thing is by its bytes: their sha256, written in lowercase hex, as the Remote names a file, a pin names a
//! release, and a run, an environment or a kernel is named here.

use sha2::{Digest, Sha256};
use std::io;

/// The sha256 of `bytes`, in hex.
pub fn sha256(bytes: impl AsRef<[u8]>) -> String {
    hex(&Sha256::digest(bytes))
}

/// The sha256 of all `r` reads (in hex), and how many bytes that was.
pub fn sha256_read(r: &mut impl io::Read) -> io::Result<(String, u64)> {
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut n = 0u64;
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(k) => { h.update(&buf[..k]); n += k as u64; }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok((hex(&h.finalize()), n))
}

/// `bytes` in lowercase hex: two digits a byte, from a table, into a buffer of the length they take.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = vec![0u8; bytes.len() * 2];
    for (pair, b) in out.as_chunks_mut::<2>().0.iter_mut().zip(bytes) {
        *pair = [DIGITS[usize::from(b >> 4)], DIGITS[usize::from(b & 15)]];
    }
    // Only ASCII digits were written.
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
#[path = "tests/hash.rs"]
mod tests;
