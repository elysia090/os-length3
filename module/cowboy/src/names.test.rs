use super::*;

/// A query for `name` of kind `kind`, numbered `id`, as a resolver sends one.
pub(crate) fn query(id: u16, name: &str, kind: u16) -> Vec<u8> {
    let mut q = vec![(id >> 8) as u8, id as u8, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in name.split('.').filter(|l| !l.is_empty()) { q.push(label.len() as u8); q.extend(label.as_bytes()); }
    q.push(0);
    q.extend(kind.to_be_bytes());
    q.extend(1u16.to_be_bytes());
    q
}

/// What an answer says: its number, its flags, how many answers, and the address given, if one is.
fn read(answer: &[u8], asked: usize) -> (u16, u16, u16, Option<[u8; 4]>) {
    let word = |at: usize| u16::from_be_bytes([answer[at], answer[at + 1]]);
    let given = (answer.len() == asked + 16).then(|| {
        let a = &answer[asked..];
        assert_eq!((&a[0..2], word(asked + 2), word(asked + 4), word(asked + 10)), (&[0xc0, 12][..], 1, 1, 4));
        [a[12], a[13], a[14], a[15]]
    });
    (word(0), word(2), word(6), given)
}

fn names() -> Box<Names> {
    // (on the heap for a test: it is a hundred kilobytes; where it runs it is the module's own memory)
    let mut n: Box<std::mem::MaybeUninit<Names>> = Box::new_uninit();
    unsafe { n.as_mut_ptr().write_bytes(0, 1); n.assume_init() }
}

#[test]
fn a_name_asked_for_is_given_an_address_of_cowboys_own_and_the_same_one_after() {
    let mut n = names();
    let mut out = [0u8; 512];
    let q = query(0xbeef, "Example.ORG", 1);
    let len = n.answer(&q, &mut out);
    let (id, flags, answers, given) = read(&out[..len], q.len());
    // Its number and its question as they were sent; an answer, to one that asked for recursion, with no error.
    assert_eq!((id, flags, answers), (0xbeef, 0x8180, 1));
    assert_eq!(&out[12..q.len()], &q[12..]);
    assert_eq!(given, Some([198, 18, 0, 16]));
    // Asked again, however it is written: the same address. Another name: the next.
    for again in ["example.org", "EXAMPLE.org.", "example.ORG"] {
        let q = query(1, again, 1);
        let len = n.answer(&q, &mut out);
        assert_eq!(read(&out[..len], q.len()).3, Some([198, 18, 0, 16]), "{again}");
    }
    let q = query(2, "example.com", 1);
    let len = n.answer(&q, &mut out);
    assert_eq!(read(&out[..len], q.len()).3, Some([198, 18, 0, 17]));
    assert_eq!(n.count(), 2);
    // An address is its name's place: named again by one index.
    assert_eq!(number([198, 18, 0, 16]).and_then(|k| n.name(k)), Some(&b"example.org"[..]));
    assert_eq!(number([198, 18, 0, 17]).and_then(|k| n.name(k)), Some(&b"example.com"[..]));
    assert_eq!(number([198, 18, 0, 18]).and_then(|k| n.name(k)), None);
    for not in [[198, 18, 0, 1], [198, 18, 0, 15], [198, 20, 0, 16], [10, 0, 0, 1], [198, 19, 255, 255]] { assert_eq!(number(not).and_then(|k| n.name(k)), None, "{not:?}"); }
}

#[test]
fn a_name_asked_for_anything_but_its_address_is_there_and_has_none_of_that_kind() {
    let mut n = names();
    let mut out = [0u8; 512];
    // AAAA, MX, TXT: no error and no answer, so whoever asked goes on to ask for its address. No name is kept for it.
    for kind in [28u16, 15, 16] {
        let q = query(7, "example.org", kind);
        let len = n.answer(&q, &mut out);
        assert_eq!(len, q.len());
        assert_eq!(read(&out[..len], q.len()), (7, 0x8180, 0, None));
    }
    assert_eq!(n.count(), 0);
    // The machine's own name is the machine's own address, and takes no place.
    let q = query(8, "localhost", 1);
    let len = n.answer(&q, &mut out);
    assert_eq!(read(&out[..len], q.len()).3, Some([127, 0, 0, 1]));
    assert_eq!(n.count(), 0);
}

#[test]
fn what_is_no_query_is_given_no_answer_whatever_its_bytes() {
    let mut n = names();
    let mut out = [0u8; 512];
    let good = query(1, "a.example.org", 1);
    // Cut short at every length; an answer itself; two questions; a label that points; a name too long; no room.
    for cut in 0..good.len() { assert_eq!(n.answer(&good[..cut], &mut out), 0, "cut at {cut}"); }
    let mut answer = good.clone(); answer[2] |= 0x80;
    let mut two = good.clone(); two[5] = 2;
    let mut points = good.clone(); points[12] = 0xc0;
    let long = query(1, &["a".repeat(63).as_str(); 4].join("."), 1);
    for (what, q) in [("an answer", &answer), ("two questions", &two), ("a pointer", &points), ("too long", &long)] { assert_eq!(n.answer(q, &mut out), 0, "{what}"); }
    assert_eq!(n.answer(&good, &mut out[..good.len() + 15]), 0);
    assert_eq!(n.count(), 1, "(the last was a name all the same: only its answer had no room)");
    // Every byte of a query changed to every value: an answer or none, never past what it was given.
    for at in 0..good.len() { for v in [0u8, 1, 63, 64, 0x80, 0xc0, 0xff] { let mut q = good.clone(); q[at] = v; let len = n.answer(&q, &mut out); assert!(len <= q.len() + 16); } }
}

#[test]
fn full_it_gives_no_new_name_an_address_and_keeps_those_it_has() {
    let mut n = names();
    let mut out = [0u8; 512];
    for k in 0..MOST {
        let q = query(k as u16, &format!("host-{k}.example.org"), 1);
        let len = n.answer(&q, &mut out);
        assert_eq!(read(&out[..len], q.len()).3, Some(address(k as u16)), "{k}");
    }
    assert_eq!(n.count(), MOST);
    // One more: refused (SERVFAIL), and no address is another name's.
    let q = query(9, "one-more.example.org", 1);
    let len = n.answer(&q, &mut out);
    assert_eq!(read(&out[..len], q.len()), (9, 0x8182, 0, None));
    let q = query(9, "host-7.example.org", 1);
    let len = n.answer(&q, &mut out);
    assert_eq!(read(&out[..len], q.len()).3, Some(address(7)));
    assert_eq!(n.name(MOST as u16 - 1), Some(format!("host-{}.example.org", MOST - 1).as_bytes()));
}

/// The bound, held: full (every name it can keep), a name is found by looking at a few slots, never many: at most
/// half the slots are taken. And an answer is the query's own bytes and sixteen more.
#[test]
fn a_name_is_found_within_a_few_slots_however_many_are_kept() {
    let mut n = names();
    let mut out = [0u8; 512];
    let (mut most, mut sum) = (0u32, 0u64);
    for k in 0..MOST {
        let q = query(k as u16, &format!("svc{k}.cluster-{}.internal.example", k % 37), 1);
        assert_eq!(n.answer(&q, &mut out), q.len() + 16);
    }
    for k in 0..MOST {
        let q = query(k as u16, &format!("svc{k}.cluster-{}.internal.example", k % 37), 1);
        n.answer(&q, &mut out);
        most = most.max(n.looked);
        sum += n.looked as u64;
    }
    assert!(sum < 2 * MOST as u64, "{} slots looked at on average", sum as f64 / MOST as f64);
    assert!(most <= 24, "{most} slots looked at for one name");
}
