//! What a thing is by its bytes: their sha256, written in lowercase hex, as the Remote names a file, a pin names a
//! release, and a run, an environment or a kernel is named here.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

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

/// `bytes` in lowercase hex: two digits a byte, from a table (not a formatter called per byte).
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = Vec::with_capacity(bytes.len() * 2);
    for b in bytes { out.extend_from_slice(&[DIGITS[(b >> 4) as usize], DIGITS[(b & 15) as usize]]); }
    // Only ASCII digits were written.
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_digest_is_the_sha256_of_the_bytes_in_lowercase_hex() {
        assert_eq!(sha256(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_read(&mut &b"abc"[..]).unwrap(), ("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(), 3));
        assert_eq!(hex(&[0, 0x0f, 0xa0, 0xff]), "000fa0ff");
    }
}
