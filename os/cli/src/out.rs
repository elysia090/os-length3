//! What l3 says, and how. A command answers with a Reply (a sentence or
//! lines, and the same as data for --json) or an Error of one kind, each
//! kind its exit code. Everything for standard output goes through one
//! writer: a reader that stops early (`| head`) ends l3 quietly, never with
//! a panic. Numbers, sizes and times are said one way everywhere.

use length3_core::remote::{last_failure, Failure};
use length3_core::tr;
use serde_json::Value;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

pub enum Reply {
    /// Something was done: the sentence saying so, and the same as data.
    Done { text: String, json: Value },
    /// Something read: the lines showing it, and the same as data.
    Data { text: String, json: Value },
    /// Text shown exactly as it is (a file), and as data.
    Raw { text: String, json: Value },
    /// Nothing more to say (it was said as it went).
    Nothing,
}

impl Reply {
    pub fn done(text: impl Into<String>, json: Value) -> Reply { Reply::Done { text: text.into(), json } }
    pub fn data(text: impl Into<String>, json: Value) -> Reply { Reply::Data { text: text.into(), json } }
}

#[derive(Debug, PartialEq)]
pub enum Error {
    /// Not how a command is written (2).
    Usage(String),
    /// No Remote to ask: not connected, not known to it, or not reachable (3).
    Offline(String),
    /// What was named is not there (4).
    NotFound(String),
    /// It could not be done, and why (1).
    Refused(String),
    /// The Remote refused, with what it said (1).
    Remote { status: u16, message: String },
    /// The device's files or streams failed (1).
    Io(String),
    /// What was asked for is turned off on this device, and the answer says how to turn it on (5): `l3 address`
    /// when SSH is off.
    Off(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn code(&self) -> u8 {
        match self { Error::Usage(_) => 2, Error::Offline(_) => 3, Error::NotFound(_) => 4, Error::Off(_) => 5, _ => 1 }
    }
    pub fn kind(&self) -> &'static str {
        match self {
            Error::Usage(_) => "usage", Error::Offline(_) => "offline", Error::NotFound(_) => "notFound",
            Error::Refused(_) => "refused", Error::Remote { .. } => "remote", Error::Io(_) => "io", Error::Off(_) => "off",
        }
    }
    pub fn message(&self) -> &str {
        match self {
            Error::Usage(m) | Error::Offline(m) | Error::NotFound(m) | Error::Refused(m) | Error::Io(m) | Error::Off(m) => m,
            Error::Remote { message, .. } => message,
        }
    }
}

/// An error from the core (text) is of the kind the Remote's last failure
/// says, when it is that failure's text; otherwise a refusal.
impl From<String> for Error {
    fn from(e: String) -> Error {
        match last_failure() {
            Some((f, said)) if e.contains(&said) => match f {
                Failure::NotConnected | Failure::Unknown | Failure::Unreachable => Error::Offline(e),
                Failure::Status(404) => Error::NotFound(e),
                Failure::Status(status) => Error::Remote { status, message: e },
            },
            _ => Error::Refused(e),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error { Error::Io(e.to_string()) }
}

/// Write to standard output, all of it, now. A reader gone (EPIPE) ends l3 at once, quietly.
pub fn write(s: &str) {
    let mut o = std::io::stdout().lock();
    if let Err(e) = o.write_all(s.as_bytes()).and_then(|_| o.flush()) {
        std::process::exit(if e.kind() == std::io::ErrorKind::BrokenPipe { 0 } else { 1 });
    }
}

/// A line to standard output, now (what must be seen before l3 waits).
pub fn line(s: &str) {
    write(&format!("{s}\n"));
}

/// Words someone else wrote (a message, a guest's post), safe to print: a
/// terminal takes ESC and the other control characters as commands (to move
/// the cursor over what was said, retitle the window, set the clipboard), so
/// each shows as U+FFFD. Lines and tabs stay.
pub fn plain(s: &str) -> String {
    s.chars().map(|c| if c.is_control() && c != '\n' && c != '\t' { '\u{FFFD}' } else { c }).collect()
}

/// A note beside the answer, on standard error ("l3: …"); never fails. Notes and errors carry what the
/// Remote said in its own words (its `error`), so they are printed plain: a terminal never takes them as commands.
pub fn note(s: &str) {
    let _ = writeln!(std::io::stderr().lock(), "l3: {}", plain(s));
}

/// The answer: its text, or with --json its data (keys in camelCase).
pub fn emit(r: Reply, json: bool) {
    match r {
        Reply::Nothing => {}
        Reply::Done { text, json: v } | Reply::Data { text, json: v } | Reply::Raw { text, json: v } if json => {
            let _ = text;
            write(&format!("{}\n", serde_json::to_string_pretty(&camel(v)).unwrap_or_default()));
        }
        Reply::Done { text, .. } | Reply::Data { text, .. } => if !text.is_empty() { write(&format!("{}\n", text.trim_end_matches('\n'))) },
        Reply::Raw { text, .. } => write(&text),
    }
}

/// Say what went wrong (with --json as {"error":{"kind","message"}} on
/// standard output), and the exit code it means.
pub fn fail(e: &Error, json: bool) -> std::process::ExitCode {
    if json {
        write(&format!("{}\n", serde_json::to_string_pretty(&serde_json::json!({"error": {"kind": e.kind(), "message": e.message()}})).unwrap_or_default()));
    } else {
        let mut lines = e.message().lines();
        note(lines.next().unwrap_or_default());
        for l in lines { let _ = writeln!(std::io::stderr().lock(), "{}", plain(l)); }
    }
    std::process::ExitCode::from(e.code())
}

/// Keys as the app writes them (camelCase): `host_free` → `hostFree`. Only
/// keys that are words joined by `_` change; l3's data never keys by a name.
pub fn camel(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.into_iter().map(|(k, v)| (camel_key(&k), camel(v))).collect()),
        Value::Array(a) => Value::Array(a.into_iter().map(camel).collect()),
        v => v,
    }
}

fn camel_key(k: &str) -> String {
    let word = |w: &str| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if !k.contains('_') || !k.split('_').all(word) { return k.to_string(); }
    let mut out = String::new();
    for (i, w) in k.split('_').enumerate() {
        if i == 0 { out.push_str(w); } else { out.push_str(&w[..1].to_ascii_uppercase()); out.push_str(&w[1..]); }
    }
    out
}

// ---- saying numbers, sizes and times ----

pub fn bytes(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < units.len() - 1 { v /= 1024.0; u += 1; }
    if u == 0 { format!("{n} B") } else { format!("{v:.1} {}", units[u]) }
}

/// `n` things: English says one and many apart; Japanese puts the counter right after the number (3件).
fn count(n: usize, one: &str, many: &str, ja: &str) -> String {
    if length3_core::i18n::ja() { ja.replace("{}", &n.to_string()) } else if n == 1 { format!("1 {one}") } else { format!("{n} {many}") }
}

pub fn files(n: usize) -> String { count(n, "file", "files", "{}ファイル") }
pub fn things(n: usize) -> String { count(n, "thing", "things", "{}件") }
pub fn commits(n: usize) -> String { count(n, "commit", "commits", "{}件のコミット") }
pub fn issues(n: usize) -> String { count(n, "issue", "issues", "{}件の Issue") }
pub fn lines_more(n: usize) -> String { count(n, "more line", "more lines", "ほか{}行") }

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// How long ago `ms` (since the epoch) was.
pub fn ago(ms: u64) -> String {
    let s = now_ms().saturating_sub(ms) / 1000;
    match s {
        0..=59 => tr!("just now", "たった今"),
        60..=3599 => count((s / 60) as usize, "min ago", "min ago", "{}分前"),
        3600..=86399 => count((s / 3600) as usize, "hour ago", "hours ago", "{}時間前"),
        _ => count((s / 86400) as usize, "day ago", "days ago", "{}日前"),
    }
}

/// How long until `until` (ms since the epoch): days, or hours on the last day.
pub fn left(until: u64) -> String {
    let h = until.saturating_sub(now_ms()) / 3_600_000;
    if h >= 24 { count((h / 24) as usize, "day", "days", "{}日") } else { count(h.max(1) as usize, "hour", "hours", "{}時間") }
}

/// A day as l3 says it (UTC, YYYY-MM-DD), from ms since the epoch.
pub fn day(ms: u64) -> String {
    let d = (ms / 86_400_000) as i64;
    // Civil from days (Howard Hinnant's algorithm).
    let z = d + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (dd, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    format!("{}-{m:02}-{dd:02}", yoe + era * 400 + i64::from(m <= 2))
}

/// Rows of a name and what is said of it, the words after each name starting in one column, as `l3 help`
/// lines up its own: as wide as the widest name (CJK counted as two columns), but never past 24, a longer
/// name keeping two spaces after it alone. A row with nothing to say is its name alone, with nothing after
/// it (bug: NAME<TAB>, which a terminal put at the next tab stop, so a name of eight letters or more stood
/// out of line with the rest).
pub fn columns(rows: &[(String, String)]) -> Vec<String> {
    let cols = rows.iter().filter(|(_, w)| !w.is_empty()).map(|(n, _)| crate::help::width(n)).filter(|w| *w <= 24).max().unwrap_or(0);
    rows.iter().map(|(n, w)| if w.is_empty() { n.clone() } else { format!("{}  {w}", crate::help::pad(n, cols)) }).collect()
}

/// The first 12 characters of an id.
pub fn short(id: &str) -> &str { &id[..12.min(id.len())] }

/// Lines added and removed, when they were counted (a merge or a repo's first commit is not).
pub fn added_removed(added: u64, removed: u64) -> String {
    if added == 0 && removed == 0 { String::new() } else { format!(" +{added} −{removed}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_become_camel_case_and_names_do_not() {
        let v = camel(serde_json::json!({"host_free": 1, "items": [{"freed_certainty": "x", "reflected_ms": null}], "url": "u", "a_B": 2, "_x": 3}));
        assert_eq!(v, serde_json::json!({"hostFree": 1, "items": [{"freedCertainty": "x", "reflectedMs": null}], "url": "u", "a_B": 2, "_x": 3}));
    }

    #[test]
    fn errors_have_their_exit_codes() {
        assert_eq!(Error::Usage("x".into()).code(), 2);
        assert_eq!(Error::Offline("x".into()).code(), 3);
        assert_eq!(Error::NotFound("x".into()).code(), 4);
        // SSH off, when l3 address cannot ask (a script): a code of its own, so a script can tell it from a failure.
        assert_eq!((Error::Off("x".into()).code(), Error::Off("x".into()).kind()), (5, "off"));
        assert_eq!(Error::Refused("x".into()).code(), 1);
        assert_eq!(Error::Remote { status: 400, message: "x".into() }.code(), 1);
        assert_eq!(Error::Remote { status: 400, message: "m".into() }.kind(), "remote");
        // A plain core error is a refusal.
        assert_eq!(Error::from("Nothing to commit".to_string()), Error::Refused("Nothing to commit".into()));
    }

    #[test]
    fn numbers_and_days_are_said_one_way() {
        assert_eq!(bytes(512), "512 B");
        assert_eq!(bytes(1536), "1.5 KB");
        assert_eq!(day(0), "1970-01-01");
        assert_eq!(day(1_792_195_200_000), "2026-10-17");
        assert_eq!(short("0123456789abcdef"), "0123456789ab");
        assert_eq!(added_removed(0, 0), "");
        assert_eq!(added_removed(3, 1), " +3 −1");
    }

    #[test]
    fn a_listing_lines_up_what_follows_each_name() {
        let rows = |r: &[(&str, &str)]| columns(&r.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>());
        // Past eight letters a name stayed in line too (bug: a tab, and the terminal's next stop).
        assert_eq!(rows(&[("notes", "4 files"), ("os-length3", "812 files"), ("docs/", "")]), ["notes       4 files", "os-length3  812 files", "docs/"]);
        // Japanese takes two columns a character; a name too long for a column keeps two spaces after it alone.
        assert_eq!(rows(&[("メモ.md", "8 B"), ("a", "1 B")]), ["メモ.md  8 B", "a        1 B"]);
        let long = "a-name-longer-than-any-column-should-be";
        assert_eq!(rows(&[(long, "x"), ("b", "y")]), [format!("{long}  x"), "b  y".to_string()]);
    }

    #[test]
    fn what_others_wrote_cannot_command_the_terminal() {
        assert_eq!(plain("hi\x1b]52;c;eA==\x07\x1b[2K\r\u{9b}31m"), "hi\u{FFFD}]52;c;eA==\u{FFFD}\u{FFFD}[2K\u{FFFD}\u{FFFD}31m");
        assert_eq!(plain("two\nlines\tand 日本語"), "two\nlines\tand 日本語");
    }
}
