use super::*;

#[test]
fn a_links_first_line_is_where_to_in_letters_and_nothing_else() {
    let mut out = [0u8; LINE];
    let n = line(&Way::Name(b"example.org"), 443, &mut out);
    assert_eq!(&out[..n], b"example.org:443\n");
    let n = line(&Way::Address([10, 0, 200, 1]), 8, &mut out);
    assert_eq!(&out[..n], b"10.0.200.1:8\n");
    let n = line(&Way::Address([255, 255, 255, 255]), 65535, &mut out);
    assert_eq!(&out[..n], b"255.255.255.255:65535\n");
    // The longest there is fits; with less room than a line takes, none is written.
    let long = [b'a'; 253];
    assert_eq!(line(&Way::Name(&long), 65535, &mut out), LINE);
    for room in 0..16 { assert_eq!(line(&Way::Name(b"example.org"), 443, &mut out[..room]), 0, "{room}"); }
}
