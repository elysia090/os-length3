//! The tests of device/agent_key.rs.

use super::*;

/// A key of the form `start` + `body`, its body `n` of `c` (with `mid` at `at`, when given).
fn key(start: &str, n: usize, c: char, mid: Option<(usize, &str)>) -> String {
    let mut b: String = std::iter::repeat_n(c, n).collect();
    if let Some((at, m)) = mid { b.replace_range(at..at + m.len(), m); }
    format!("{start}{b}")
}

#[test]
fn a_key_is_known_by_its_whole_form_and_an_admin_key_or_one_of_no_form_is_not() {
    let var = |k: &str| kind(k).map(|k| k.1);
    assert_eq!(var(&format!("{}AA", key("sk-ant-api03-", 93, 'x', None))), Some("ANTHROPIC_API_KEY"));
    assert_eq!(var(&key("sk-ant-api03-", 95, 'x', None)), None, "no AA at its end");
    assert_eq!(var(&format!("{}AA", key("sk-ant-admin01-", 93, 'x', None))), None, "an admin key opens no model");
    assert_eq!(var(&key("sk-proj-", 140, 'a', Some((74, "T3BlbkFJ")))), Some("OPENAI_API_KEY"));
    assert_eq!(var(&key("sk-svcacct-", 124, 'a', Some((58, "T3BlbkFJ")))), Some("OPENAI_API_KEY"));
    assert_eq!(var(&key("sk-", 48, 'a', Some((20, "T3BlbkFJ")))), Some("OPENAI_API_KEY"));
    assert_eq!(var(&key("sk-admin-", 140, 'a', Some((74, "T3BlbkFJ")))), None);
    assert_eq!(var(&key("sk-", 32, '7', None)), Some("DEEPSEEK_API_KEY"));
    assert_eq!(var(&key("sk-or-v1-", 64, 'f', None)), Some("OPENROUTER_API_KEY"));
    assert_eq!(var(&key("xai-", 80, 'Q', None)), Some("XAI_API_KEY"));
    assert_eq!(var(&key("gsk_", 52, 'Q', None)), Some("GROQ_API_KEY"));
    assert_eq!(var(&key("AIzaSy", 33, 'Q', None)), Some("GEMINI_API_KEY"));
    assert_eq!(var(&key("pplx-", 48, 'Q', None)), Some("PERPLEXITY_API_KEY"));
    assert_eq!(var(&key("fw_", 24, 'Q', None)), Some("FIREWORKS_API_KEY"));
    assert_eq!(var(&key("hf_", 34, 'Q', None)), Some("HF_TOKEN"));
    // Mistral's and Cohere's: letters and digits alone, nothing to tell them by.
    assert_eq!(var(&"a".repeat(32)), None);
    assert_eq!(var(&"a".repeat(40)), None);
    assert_eq!(var(&key("gsk_", 51, 'Q', None)), None, "one short");
}

#[test]
fn kept_as_given_shown_by_its_start_and_last_four() {
    let given = format!("{}a9AA", key("sk-ant-api03-", 91, 'x', None));
    let k = read(&written(&format!(" {given} "), " m ").unwrap()).unwrap();
    assert_eq!(k, Held::Given(Kept { key: given.clone(), model: "m".into() }));
    assert_eq!(shown(&given), "sk-ant-…a9AA");
}

#[test]
fn a_key_sealed_is_kept_as_a_page_seals_one_and_nothing_else_is() {
    let sealed = |v: serde_json::Value| Sealed { sealed: v, shown: "sk-ant-…a9AA".into(), variable: "ANTHROPIC_API_KEY".into(), model: "m".into() };
    let good = serde_json::json!({"v": 1, "credential": "Y3JlZA", "salt": "c2FsdA", "iv": "aXY", "data": "ZGF0YQ"});
    let s = sealed(good.clone());
    assert_eq!(read(&serde_json::to_string(&s).unwrap()), Some(Held::Sealed(s)));
    // The key itself is never taken for sealed, nor anything but the four fields of base64url.
    for bad in [serde_json::json!({"v": 1, "credential": "c", "salt": "s", "iv": "i"}), serde_json::json!({"v": 2, "credential": "c", "salt": "s", "iv": "i", "data": "d"}),
        serde_json::json!({"v": 1, "credential": "c", "salt": "s", "iv": "i", "data": "sk-ant-api03 key"}), serde_json::json!("text")] {
        assert!(!sealed_well(&sealed(bad.clone())), "{bad}");
    }
    assert!(!sealed_well(&Sealed { variable: "PATH".into(), ..sealed(good.clone()) }), "a maker's variable only");
    assert!(!sealed_well(&Sealed { shown: format!("{}a9AA", key("sk-ant-api03-", 91, 'x', None)), ..sealed(good) }), "shown, never whole");
    // Every maker's variable is one a sealed key may be read from.
    for k in [format!("{}AA", key("sk-ant-api03-", 93, 'x', None)), key("sk-or-v1-", 64, 'f', None), key("hf_", 34, 'Q', None)] {
        assert!(VARIABLES.contains(&kind(&k).unwrap().1));
    }
}

#[test]
fn what_is_no_known_key_is_refused_and_nothing_is_kept() {
    for bad in ["", "sk-ant", "password1234567890", "sk-ant-api03- with spaces in it", &format!("sk-ant-api03-{}", "x".repeat(600))] {
        assert!(written(bad, "").is_err(), "{bad:?}");
    }
    // What is read is a key of a known form, whatever was written there.
    assert_eq!(read(r#"{"key":"password1234567890","model":"m"}"#), None);
    assert_eq!(read("not json"), None);
}
