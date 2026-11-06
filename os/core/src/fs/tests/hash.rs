//! The tests of disk/digest.rs.

use super::*;

#[test]
fn a_digest_is_the_sha256_of_the_bytes_in_lowercase_hex() {
    assert_eq!(sha256(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(sha256_read(&mut &b"abc"[..]).unwrap(), ("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(), 3));
    assert_eq!(hex(&[0, 0x0f, 0xa0, 0xff]), "000fa0ff");
}
