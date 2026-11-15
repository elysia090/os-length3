//! The tests of device/secrets.rs.

use super::*;

fn anthropic(tail: &str) -> String { format!("sk-ant-api03-{}{tail}AA", "x".repeat(93 - tail.len())) }

#[test]
fn a_key_in_a_file_is_found_wherever_it_stands_and_shown_by_its_start_and_last_four() {
    let key = anthropic("a9");
    for text in [format!("ANTHROPIC_API_KEY={key}\n"), format!("{{\"key\": \"{key}\"}}"), key.clone(), format!("export K='{key}'")] {
        assert_eq!(found(text.as_bytes(), &[]), Some(Found::Key("sk-ant-…a9AA".into())), "{text}");
    }
    let gh = format!("token = ghp_{}", "A1".repeat(18));
    assert_eq!(found(gh.as_bytes(), &[]), Some(Found::Key("ghp_…A1A1".into())));
    let stripe = format!("STRIPE={}", format_args!("sk_live_{}", "z9".repeat(14)));
    assert_eq!(found(stripe.as_bytes(), &[]), Some(Found::Key("sk_live_…z9z9".into())));
    // Bytes that are not text around it, too.
    let mut bin = vec![0u8, 159, 146, 150, b' '];
    bin.extend_from_slice(key.as_bytes());
    assert!(found(&bin, &[]).is_some());
}

#[test]
fn nothing_ordinary_is_taken_for_one() {
    let key = anthropic("a9");
    for text in [
        "sk-ant-api03-xxxx (a placeholder in a README)".to_string(),
        "let sk_test = 1; // sk_test_ keys open no money".to_string(),
        format!("sk_test_{}", "z9".repeat(14)),
        "ghp_short".to_string(),
        "hf_ is how its tokens start; AIza is how Google's do".to_string(),
        // Part of a longer word: not a key that begins there.
        format!("prefix{key}"),
        "the session token is token.signature".to_string(),
    ] {
        assert_eq!(found(text.as_bytes(), &[]), None, "{text}");
    }
}

#[test]
fn this_devices_own_sign_in_is_found_whole_and_never_shown() {
    let session = "Zq3sR8vN1kLm0pXy.abcDEF123ghiJKL456mno";
    let said = found(format!("leaked: {session}\n").as_bytes(), &[session]).unwrap();
    assert_eq!(said, Found::Own);
    assert!(!said.said().contains("Zq3s") && !said.said().contains("mno"));
    // Too short to be told from ordinary words: not looked for.
    assert_eq!(found(b"abc", &["abc"]), None);
}

#[test]
fn eight_bytes_at_once_are_read_as_each_alone() {
    for b in 0..=255u8 {
        for at in 0..64 {
            let mut block = [b'!'; 64];
            block[at] = b;
            assert_eq!(key_bytes(&block), u64::from(key_byte(b)) << at, "byte {b:#04x} at {at}");
        }
    }
    let mixed: [u8; 64] = std::array::from_fn(|k| (k * 37 + 11) as u8);
    let one_by_one = mixed.iter().enumerate().fold(0u64, |m, (k, &b)| m | u64::from(key_byte(b)) << k);
    assert_eq!(key_bytes(&mixed), one_by_one);
}

/// What `found` finds, read the plain way: each run of key bytes on its own.
fn as_runs(bytes: &[u8]) -> Option<Found> {
    bytes.split(|b| !key_byte(*b)).filter(|r| r.len() >= 16).find_map(|r| known(std::str::from_utf8(r).ok()?)).map(Found::Key)
}

#[test]
fn a_key_is_found_wherever_the_blocks_fall_and_only_where_a_run_starts() {
    // The shortest form a key has here (made at run time, as every key in these tests: no key is in the source).
    let shortest = ["sk-proj-", "T3Blbk", "FJ"].concat();
    let keys = [anthropic("a9"), format!("ghp_{}", "A1".repeat(18)), format!("sk_live_{}", "z9".repeat(14)), shortest.clone()];
    let fill = [b' ', b'x', b'\n', b'-', 0xE3];
    let mut seed = 7u64;
    let mut next = |n: u64| { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (seed >> 33) % n };
    for case in 0..3000 {
        let len = next(300) as usize;
        let mut bytes: Vec<u8> = (0..len).map(|_| fill[next(fill.len() as u64) as usize]).collect();
        if case % 3 != 0 {
            let key = &keys[next(keys.len() as u64) as usize];
            // Around a block's edge, at the start, or running to the end.
            let at = match case % 4 { 0 => 64 - next(20) as usize, 1 => 0, 2 => len, _ => next(len as u64 + 1) as usize };
            let at = at.min(bytes.len());
            bytes.splice(at..at, key.bytes());
        }
        assert_eq!(found(&bytes, &[]), as_runs(&bytes), "case {case}: {:?}", String::from_utf8_lossy(&bytes));
    }
    // The shortest form, alone, then ended by the file, then part of a longer run (no key starts there).
    let after = |fill: &[u8]| fill.iter().chain(shortest.as_bytes()).copied().collect::<Vec<_>>();
    assert!(found(shortest.as_bytes(), &[]).is_some());
    assert!(found(&after(&[b' '; 48]), &[]).is_some());
    assert_eq!(found(&after(&[b'x'; 63]), &[]), None);
}
