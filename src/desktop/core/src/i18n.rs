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

#[macro_export]
macro_rules! tr {
    ($en:literal, $ja:literal) => {
        if $crate::i18n::ja() { $ja.to_string() } else { $en.to_string() }
    };
    ($en:literal, $ja:literal, $($arg:tt)*) => {
        if $crate::i18n::ja() { format!($ja, $($arg)*) } else { format!($en, $($arg)*) }
    };
}
