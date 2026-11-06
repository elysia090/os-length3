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
