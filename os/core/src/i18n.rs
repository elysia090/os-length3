//! The OS's words in English by default and in Japanese when chosen: Home's
//! `lang` setting (the same one the app writes), or $LENGTH3_LANG over it.
//! `tr!("English {}", "日本語 {}", x)` picks one; both take the same arguments.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use std::sync::atomic::{AtomicU8, Ordering};

/// The language as last read: 0 not read yet, 1 English, 2 Japanese.
static SPOKEN: AtomicU8 = AtomicU8::new(0);

/// Whether this process speaks Japanese: read once, and again after Home's `lang` is set (the app's core lives as
/// long as its tab, and the person may change the language in it; l3 reads it once per command).
pub fn ja() -> bool {
    match SPOKEN.load(Ordering::Relaxed) {
        1 => return false,
        2 => return true,
        _ => {}
    }
    let ja = match std::env::var("LENGTH3_LANG").ok().filter(|v| !v.is_empty()) {
        Some(v) => v.starts_with("ja"),
        None => crate::home::get("lang").ok().flatten().and_then(|t| serde_json::from_str::<String>(&t).ok()).is_some_and(|l| l == "ja"),
    };
    SPOKEN.store(if ja { 2 } else { 1 }, Ordering::Relaxed);
    ja
}

/// Home's `lang` was just written: the words chosen next are in the language it says now.
pub(crate) fn changed() {
    SPOKEN.store(0, Ordering::Relaxed);
}

/// The languages the OS speaks.
pub const LANGS: [&str; 2] = ["en", "ja"];

/// The language Home keeps (what the app and l3 speak unless $LENGTH3_LANG says otherwise).
pub fn lang() -> String {
    crate::home::get("lang").ok().flatten().and_then(|t| serde_json::from_str::<String>(&t).ok())
        .filter(|l| LANGS.contains(&l.as_str())).unwrap_or_else(|| "en".into())
}

/// Choose the language Home keeps, for the app and l3 alike.
pub fn set_lang(lang: &str) -> crate::Result<()> {
    if !LANGS.contains(&lang) { return Err(crate::tr!("The OS speaks en or ja", "OS が話すのは en か ja です")); }
    crate::home::set("lang", &serde_json::to_string(lang).map_err(|e| e.to_string())?)
}

#[macro_export]
macro_rules! tr {
    ($en:literal, $ja:literal) => {
        if $crate::i18n::ja() { $ja.to_string() } else { $en.to_string() }
    };
    ($en:literal, $ja:literal, $($arg:tt)*) => {
        if $crate::i18n::ja() { format!($ja, $($arg)*) } else { format!($en, $($arg)*) }
    };
}
