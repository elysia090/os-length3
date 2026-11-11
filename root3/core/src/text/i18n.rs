//! The OS's words in English by default and in Japanese when chosen: Home's
//! `lang` setting (the same one the app writes), or $LENGTH3_LANG over it.
//! `tr!("English {}", "日本語 {}", x)` picks one; both take the same arguments.

use std::sync::atomic::{AtomicU8, Ordering};

/// The language as last read: 0 not read yet, 1 English, 2 Japanese.
static SPOKEN: AtomicU8 = AtomicU8::new(0);

/// Whether this process speaks Japanese: read once, and again after Home's `lang` is set (the app's core lives as
/// long as its tab, and the person may change the language in it; root3 reads it once per command). Asked by every
/// `tr!`, so the asking is a load and a compare where it is written; the reading stays out of line.
#[inline]
pub fn ja() -> bool {
    match SPOKEN.load(Ordering::Relaxed) {
        1 => false,
        2 => true,
        _ => read(),
    }
}

/// The language read where it is said: $LENGTH3_LANG, else Home's `lang`; kept for the next asking.
#[cold]
#[inline(never)]
fn read() -> bool {
    let ja = match std::env::var("LENGTH3_LANG").ok().filter(|v| !v.is_empty()) {
        Some(v) => v.starts_with("ja"),
        // Home's `lang`, read where Home keeps it (home/), as the one setting the words hang on.
        None => std::fs::read_to_string(crate::fs::paths::home_dir().join("lang.json")).ok()
            .and_then(|t| serde_json::from_str::<String>(&t).ok()).is_some_and(|l| l == "ja"),
    };
    SPOKEN.store(if ja { 2 } else { 1 }, Ordering::Relaxed);
    ja
}

/// Home's `lang` was just written: the words chosen next are in the language it says now.
pub(crate) fn changed() {
    SPOKEN.store(0, Ordering::Relaxed);
}

#[macro_export]
macro_rules! tr {
    ($en:literal, $ja:literal) => {
        if $crate::text::i18n::ja() { $ja.to_string() } else { $en.to_string() }
    };
    ($en:literal, $ja:literal, $($arg:tt)*) => {
        if $crate::text::i18n::ja() { format!($ja, $($arg)*) } else { format!($en, $($arg)*) }
    };
}

/// An error of the file system about `at` (a repo, or repo/path), in the OS's words.
pub fn io_error(at: impl std::fmt::Display, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => tr!("There is no {}", "{} はありません", at),
        std::io::ErrorKind::PermissionDenied => tr!("{}: not allowed", "{}：許可されていません", at),
        std::io::ErrorKind::AlreadyExists => tr!("{} is there already", "{} はもうあります", at),
        _ => tr!("{}: {}", "{}：{}", at, e),
    }
}

