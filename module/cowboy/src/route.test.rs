use super::*;
use crate::names::tests::query;

#[test]
fn an_address_cowboy_gave_is_its_name_any_other_stands_as_it_is_and_the_machines_own_has_no_way() {
    let mut n = Box::new(Names::new());
    let mut out = [0u8; 512];
    let q = query(1, "example.org", 1);
    n.answer(&q, &mut out);
    assert_eq!(to(&n, [198, 18, 0, 16]), Some(Way::Name(b"example.org")));
    assert_eq!(to(&n, [1, 1, 1, 1]), Some(Way::Address([1, 1, 1, 1])));
    // An address of cowboy's own no name was given, the resolver's, the machine's: no way.
    for none in [[198, 18, 0, 17], [198, 18, 0, 1], [198, 19, 9, 9], [127, 0, 0, 1], [127, 1, 2, 3], [0, 0, 0, 0]] { assert_eq!(to(&n, none), None, "{none:?}"); }
}
