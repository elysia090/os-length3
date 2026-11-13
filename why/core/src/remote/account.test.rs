//! The tests of remote/account.rs.

#[test]
fn the_plan_is_bought_only_on_stripes_pages_or_the_remotes_own() {
    let r = "https://os.length3.com";
    for ok in ["https://checkout.stripe.com/c/pay/cs_1", "https://billing.stripe.com/p/session/x", "https://os.length3.com/dev-billing/checkout?x"] { assert!(super::plan_page_ok(r, ok), "{ok}"); }
    for no in ["http://checkout.stripe.com/c", "https://stripe.com.evil.example/", "https://evilstripe.com/", "https://os.length3.com.evil/", "javascript:alert(1)", ""] { assert!(!super::plan_page_ok(r, no), "{no}"); }
    // A browser reads a backslash as a slash, and what is before an @ as no host at all: each of these opens
    // evil.example (or names someone at a host), whatever the text ends with.
    for no in ["https://evil.example\\.stripe.com/", "https://evil.example\\@checkout.stripe.com/c", "https://evil.example@checkout.stripe.com/c",
        "https://os.length3.com\\@evil.example/", "https://evil.example%2f.stripe.com/", "https://checkout.stripe.com:443@evil.example/"] {
        assert!(!super::plan_page_ok(r, no), "{no}");
    }
    assert!(super::plan_page_ok("http://127.0.0.1:8950", "http://127.0.0.1:8950/dev-billing/portal?c=1"));
    assert!(!super::plan_page_ok("http://127.0.0.1:8950", "http://127.0.0.1:8951/dev-billing/portal"));
}

#[test]
fn an_ask_names_only_the_account_page_and_a_plain_repo() {
    let b = "https://os.length3.com/";
    assert_eq!(super::ask_page(b, "sign-in", None).unwrap(), "https://os.length3.com/?account=sign-in");
    assert_eq!(super::ask_page(b, "off", Some("notes-2")).unwrap(), "https://os.length3.com/?account=off&repo=notes-2");
    for no in [None, Some(""), Some("a&b=c"), Some("../x"), Some(".git"), Some("a#b")] { assert!(super::ask_page(b, "discard", no).is_err(), "{no:?}"); }
    assert!(super::app_page("delete-everything", None).is_err());
}

#[test]
fn a_plan_reads_as_the_remote_says_it() {
    let p: super::Plan = serde_json::from_str(r#"{"plan":"free","status":null,"usage":{"repos":2,"bytes":25000000,"names":1},"free":{"repos":3,"bytes":100000000,"names":1},"buy":true,"manage":false}"#).unwrap();
    assert_eq!((p.plan.as_str(), p.usage.unwrap().repos, p.free.unwrap().bytes, p.buy), ("free", 2, 100_000_000, true));
    let none: super::Plan = serde_json::from_str(r#"{"plan":"none"}"#).unwrap();
    assert!(none.usage.is_none() && !none.buy);
    // A tier: what it keeps (as many repos as fit: none said), and the tiers beside it with their prices.
    let pro: super::Plan = serde_json::from_str(r#"{"plan":"paid","tier":"pro","allowance":{"repos":null,"bytes":256000000000,"names":10},
            "tiers":[{"tier":"free","allowance":{"repos":3,"bytes":100000000,"names":1}},{"tier":"pro","allowance":{"repos":null,"bytes":256000000000,"names":10},"sold":true,
            "price":{"amount":1400,"currency":"usd","interval":"month","every":1}}],"buy":true,"manage":true}"#).unwrap();
    let a = pro.allowance.unwrap();
    assert_eq!((pro.tier.as_deref(), a.repos, a.bytes, a.names, pro.tiers.len(), pro.tiers[1].price.as_ref().map(|p| p.amount)),
        (Some("pro"), None, 256_000_000_000, Some(10), 2, Some(1400)));
    assert_eq!(super::tier_name("max"), "Max");
}

#[test]
fn a_devices_token_is_never_written_out() {
    let d: super::Device = serde_json::from_str(r#"{"token":"secret","userAgent":"why","updatedAt":"2026-10-17"}"#).unwrap();
    assert_eq!(d.token, "secret");
    let out = serde_json::to_string(&d).unwrap();
    assert!(!out.contains("secret") && !out.contains("token"), "{out}");
}
