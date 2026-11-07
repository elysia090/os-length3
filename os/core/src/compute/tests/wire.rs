//! The tests of compute/wire.rs.

use super::*;

#[test]
fn frames_go_across_whole_in_order_and_a_line_cut_between_them_ends_cleanly() {
    let mut line = Vec::new();
    for f in [Frame::Spec(b"{}".to_vec()), Frame::Out(b"hi\n".to_vec()), Frame::Err(Vec::new()), Frame::Files(vec![0; 3]), Frame::Exit(-3)] {
        write(&mut line, &f).unwrap();
    }
    let mut r = &line[..];
    let mut got = Vec::new();
    while let Some(f) = read(&mut r).unwrap() { got.push(f); }
    assert_eq!(got, [Frame::Spec(b"{}".to_vec()), Frame::Out(b"hi\n".to_vec()), Frame::Err(Vec::new()), Frame::Files(vec![0; 3]), Frame::Exit(-3)]);
    // Cut inside a frame, or a frame claiming more than FRAME: no frame.
    assert!(read(&mut &line[..6]).is_err());
    let mut big = vec![2u8];
    big.extend_from_slice(&((FRAME as u32) + 1).to_be_bytes());
    assert!(read(&mut &big[..]).is_err());
}
