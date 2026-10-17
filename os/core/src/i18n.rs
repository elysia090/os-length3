//! The OS's words in English by default and in Japanese when chosen: Home's
//! `lang` setting (the same one the app writes), or $LENGTH3_LANG over it.
//! `tr!("English {}", "日本語 {}", x)` picks one; both take the same arguments.

use std::sync::OnceLock;

/// Whether this process speaks Japanese (read once).
pub fn ja() -> bool {
    static JA: OnceLock<bool> = OnceLock::new();
    *JA.get_or_init(|| {
        if let Some(v) = std::env::var("LENGTH3_LANG").ok().filter(|v| !v.is_empty()) {
            return v.starts_with("ja");
        }
        crate::home::get("lang").ok().flatten().and_then(|t| serde_json::from_str::<String>(&t).ok()).is_some_and(|l| l == "ja")
    })
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
