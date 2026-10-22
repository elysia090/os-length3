//! The one way a first line is named in this OS: a kind and a title,
//! "Fix：再起動すると保存内容が消える". TODO items and issues both use it.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

/// Split "Kind：title" (full- or half-width colon). A kind is a short word
/// starting with a letter; anything else is a plain line. An address's
/// scheme (https://) is no kind: the line is its title whole.
pub fn kind_of(text: &str) -> (Option<String>, String) {
    let t = text.trim_start();
    let word: String = t.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let starts = word.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    if starts && word.chars().count() <= 16 {
        let rest = t[word.len()..].trim_start();
        if let Some(after) = rest.strip_prefix('：').or_else(|| rest.strip_prefix(':').filter(|a| !a.starts_with("//"))) {
            return (Some(word), after.trim_start().to_string());
        }
    }
    (None, text.trim().to_string())
}

/// The first line again: "Kind：title", or the title alone.
pub fn named(kind: Option<&str>, title: &str) -> String {
    match kind {
        Some(k) => format!("{k}：{}", title.trim()),
        None => title.trim().to_string(),
    }
}
