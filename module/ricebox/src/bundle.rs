//! A root run in a box: the bundle muk is given for it, said once. On every host a root's programs are started one
//! way, `muk run` of this bundle: on a Linux machine by the host's kernel (run.rs), anywhere else by the same muk over
//! the Linux sods answers (layers/worker.ts). Nothing here makes a namespace, a mount or a filter: this is what is
//! asked for, in the words muk reads (the OCI runtime's config.json) and the words it is run with (what is lent).
//!
//!   /                 the root, read-only, or written where it is the box's own to write
//!   what is lent      each directory or file of the host's, where the box is to have it, in the order given
//!   /tmp, /run        empty, gone with it
//!   /dev, /dev/pts, /proc
//!                     its own, as muk makes every box's
//!   network           none but its loopback; the host's where it is lent (with the resolver's file)
//!   who               root of a user namespace of its own, mapped onto the one who runs muk
//!   calls             muk's filter: no box asks less
//!
//! The environment is set, not inherited: nothing of the host's comes in. What a product puts in a box (a repo, a
//! home, its own variables) it says as what is lent and what is told besides; nothing of a product is named here.
//!
//! Its bound, counted by hand: config.json is n bytes, so it is n bytes written, each once, into one piece of memory
//! asked for once at its size. It is said twice by one function (`say`): first to one that only counts (no memory),
//! then to the text itself, which is then exactly full. No tree of values is made on the way and nothing is copied
//! after it is written. bundle.test.rs holds it there: the text is as long as it was counted, in the memory it was
//! given.

#![forbid(unsafe_code)]

use serde::Deserialize;

/// Where a Prompt's programs are looked for.
pub const PATH: &str = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// A directory or a file of the host's lent to a box: where it is inside (from /, as `root/.cache`), its path as the
/// one who runs muk names it, and whether the box only reads it.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Bind {
    pub inside: String,
    pub from: String,
    pub read_only: bool,
}

/// What of the host's a box is lent, each by its path as the one who runs muk names it. config.json asks; these are
/// what muk is told it may give (`--lend`, `--ids`): a path asked for and not lent is refused by muk, not here.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Lent {
    /// The root.
    pub root: String,
    /// It is written (a tree that is the box's own to write), not read-only.
    pub written: bool,
    /// What else is lent, mounted in this order (a directory before what lies in it).
    pub binds: Vec<Bind>,
    /// The user and the group root in the box is.
    pub uid: u32,
    pub gid: u32,
    /// The network: the namespace lent, by its path. None: one of the box's own, its loopback alone.
    pub network: Option<String>,
    /// The resolver's file, and where the root looks for it.
    pub resolver: Option<(String, String)>,
    /// A terminal lent by its own name, to be the box's /dev/console (the one the box is started at, where that is
    /// the machine's own: sods' console).
    pub console: Option<String>,
}

/// What a box runs.
#[derive(Clone, Copy, Debug)]
pub struct Run<'a> {
    pub argv: &'a [String],
    /// Its whole environment (`environment`).
    pub env: &'a [String],
    /// Where it starts, inside.
    pub cwd: &'a str,
    /// The box's name for itself.
    pub hostname: &'a str,
    /// A terminal of its own, this many columns and rows (muk makes it and gives its other end away); none, it has
    /// the descriptors of the one who runs muk.
    pub screen: Option<(u16, u16)>,
}

/// A bundle: config.json, and the words muk is run with.
#[derive(Debug)]
pub struct Bundle {
    pub config: String,
    /// What is lent, each a path (`--lend`).
    pub lends: Vec<String>,
    /// The host's users and groups lent (`--ids`), where the kernel does not lend them itself: root's muk is lent
    /// none until told.
    pub ids: Option<(u32, u32)>,
}

impl Bundle {
    /// `muk`'s words for this bundle in the directory `dir`: run … `id`. `console`: where its terminal's other end
    /// is waited for (a socket), when it asks for one.
    pub fn words(&self, dir: &str, console: Option<&str>, id: &str) -> Vec<String> {
        let mut w = vec!["run".to_string()];
        if let Some(c) = console { w.extend(["--console-socket".into(), c.into()]); }
        for l in &self.lends { w.extend(["--lend".into(), l.clone()]); }
        if let Some((first, last)) = self.ids { w.extend(["--ids".into(), format!("{first}-{last}")]); }
        w.extend(["-b".into(), dir.into(), id.into()]);
        w
    }
}

/// What a root of a user namespace may do in its box: what a container is given by default, less the making of devices.
const CAPS: &str = "[\"CAP_CHOWN\",\"CAP_DAC_OVERRIDE\",\"CAP_FSETID\",\"CAP_FOWNER\",\"CAP_NET_RAW\",\"CAP_SETGID\",\"CAP_SETUID\",\"CAP_SETFCAP\",\"CAP_SETPCAP\",\"CAP_NET_BIND_SERVICE\",\"CAP_SYS_CHROOT\",\"CAP_KILL\",\"CAP_AUDIT_WRITE\"]";

/// What config.json is said to: text, or only its length.
trait Sink {
    fn put(&mut self, s: &str);
}
struct Count(usize);
impl Sink for Count {
    fn put(&mut self, s: &str) { self.0 += s.len(); }
}
impl Sink for String {
    fn put(&mut self, s: &str) { self.push_str(s); }
}

/// `s` as JSON says a string: what needs no escape goes as it lies, a run at a time.
fn string(out: &mut impl Sink, s: &str) {
    out.put("\"");
    string_body(out, s);
    out.put("\"");
}

/// `s` as it stands between a JSON string's quotes.
fn string_body(out: &mut impl Sink, s: &str) {
    let bytes = s.as_bytes();
    let mut from = 0;
    for (i, &b) in bytes.iter().enumerate() {
        let escaped: &str = match b {
            b'"' => "\\\"",
            b'\\' => "\\\\",
            b'\n' => "\\n",
            b'\t' => "\\t",
            b'\r' => "\\r",
            0..=0x1f => "",
            _ => continue,
        };
        out.put(&s[from..i]);
        if escaped.is_empty() {
            const HEX: &[u8; 16] = b"0123456789abcdef";
            let u = [b'\\', b'u', b'0', b'0', HEX[(b >> 4) as usize], HEX[(b & 15) as usize]];
            // (six ASCII bytes: always text)
            out.put(std::str::from_utf8(&u).unwrap_or(""));
        } else {
            out.put(escaped);
        }
        from = i + 1;
    }
    out.put(&s[from..]);
}

/// `n` in decimal.
fn number(out: &mut impl Sink, n: u32) {
    let mut digits = [0u8; 10];
    let mut at = digits.len();
    let mut n = n;
    loop {
        at -= 1;
        digits[at] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 { break; }
    }
    out.put(std::str::from_utf8(&digits[at..]).unwrap_or("0"));
}

/// A list of strings.
fn strings(out: &mut impl Sink, all: &[String]) {
    out.put("[");
    for (i, s) in all.iter().enumerate() {
        if i > 0 { out.put(","); }
        string(out, s);
    }
    out.put("]");
}

/// A directory of the host's bound at `to`.
fn bind(out: &mut impl Sink, to: &str, from: &str, options: &str) {
    out.put(",{\"destination\":");
    string(out, to);
    out.put(",\"type\":\"bind\",\"source\":");
    string(out, from);
    out.put(",\"options\":");
    out.put(options);
    out.put("}");
}

/// config.json, said to `out`.
fn say(out: &mut impl Sink, run: &Run, lent: &Lent) {
    out.put("{\"ociVersion\":\"1.0.2\",\"process\":{");
    if let Some((cols, rows)) = run.screen {
        out.put("\"terminal\":true,\"consoleSize\":{\"height\":");
        number(out, rows as u32);
        out.put(",\"width\":");
        number(out, cols as u32);
        out.put("},");
    }
    out.put("\"args\":");
    strings(out, run.argv);
    out.put(",\"env\":");
    strings(out, run.env);
    out.put(",\"cwd\":");
    string(out, run.cwd);
    out.put(",\"capabilities\":{\"bounding\":");
    out.put(CAPS);
    out.put(",\"effective\":");
    out.put(CAPS);
    out.put(",\"permitted\":");
    out.put(CAPS);
    out.put("},\"noNewPrivileges\":true},\"root\":{\"path\":");
    string(out, &lent.root);
    out.put(if lent.written { ",\"readonly\":false}" } else { ",\"readonly\":true}" });
    out.put(",\"hostname\":");
    string(out, run.hostname);
    out.put(concat!(
        ",\"mounts\":[",
        "{\"destination\":\"/proc\",\"type\":\"proc\",\"source\":\"proc\"}",
        ",{\"destination\":\"/dev\",\"type\":\"tmpfs\",\"source\":\"tmpfs\",\"options\":[\"nosuid\",\"strictatime\",\"mode=755\",\"size=65536k\"]}",
        ",{\"destination\":\"/dev/pts\",\"type\":\"devpts\",\"source\":\"devpts\",\"options\":[\"nosuid\",\"noexec\",\"newinstance\",\"ptmxmode=0666\",\"mode=0620\"]}",
    ));
    if let Some(console) = &lent.console { bind(out, "/dev/console", console, "[\"bind\"]"); }
    out.put(concat!(
        ",{\"destination\":\"/tmp\",\"type\":\"tmpfs\",\"source\":\"tmpfs\",\"options\":[\"nosuid\",\"nodev\",\"mode=1777\",\"size=1g\"]}",
        ",{\"destination\":\"/run\",\"type\":\"tmpfs\",\"source\":\"tmpfs\",\"options\":[\"nosuid\",\"nodev\",\"mode=1777\",\"size=64m\"]}",
    ));
    for b in &lent.binds {
        out.put(",{\"destination\":\"/");
        // (a path inside, as whoever lends it wrote it: names and slashes)
        string_body(out, &b.inside);
        out.put("\",\"type\":\"bind\",\"source\":");
        string(out, &b.from);
        out.put(if b.read_only { ",\"options\":[\"rbind\",\"ro\",\"nosuid\"]}" } else { ",\"options\":[\"rbind\",\"rw\",\"nosuid\"]}" });
    }
    if let Some((file, inside)) = &lent.resolver { bind(out, inside, file, "[\"bind\",\"ro\"]"); }
    out.put("],\"linux\":{\"namespaces\":[{\"type\":\"pid\"},{\"type\":\"ipc\"},{\"type\":\"uts\"},{\"type\":\"mount\"},{\"type\":\"user\"},{\"type\":\"network\"");
    if let Some(ns) = &lent.network {
        out.put(",\"path\":");
        string(out, ns);
    }
    out.put("}],\"uidMappings\":[{\"containerID\":0,\"hostID\":");
    number(out, lent.uid);
    out.put(",\"size\":1}],\"gidMappings\":[{\"containerID\":0,\"hostID\":");
    number(out, lent.gid);
    out.put(",\"size\":1}]}}");
}

/// How long config.json is.
pub fn length(run: &Run, lent: &Lent) -> usize {
    let mut n = Count(0);
    say(&mut n, run, lent);
    n.0
}

/// The bundle for `run` over what is `lent`.
pub fn bundle(run: &Run, lent: &Lent) -> Bundle {
    let mut config = String::with_capacity(length(run, lent));
    say(&mut config, run, lent);
    let mut lends = Vec::with_capacity(4 + lent.binds.len());
    lends.push(lent.root.clone());
    lends.extend(lent.binds.iter().map(|b| b.from.clone()));
    lends.extend(lent.network.iter().cloned());
    lends.extend(lent.resolver.iter().map(|(file, _)| file.clone()));
    lends.extend(lent.console.iter().cloned());
    // To one who is not root the kernel lends the one it is; root's muk lends none until told.
    let ids = (lent.uid == 0).then_some((0, 0));
    Bundle { config, lends, ids }
}

/// The root's shell: what is run when nothing else is asked for.
#[derive(Deserialize, Default, Clone, Copy, Debug)]
#[serde(default)]
pub struct Shell {
    /// The root has bash.
    pub bash: bool,
    /// The root is another distribution's (Ubuntu, Debian): its bash is as that distribution sets it up.
    pub other: bool,
    /// It is at a terminal it edits its line on; else what is typed is edited by what shows it, and sent a line at a time.
    pub edits: bool,
}

/// The shell: bash, interactive. On this distribution's root it reads the root's settings (/etc/length3/shrc: how
/// a run ended, told before each prompt line; z, direnv), and edits its line itself only at a terminal. Another distribution's bash is as that distribution sets it up, at a terminal; sh is the
/// shell where there is no bash, or no terminal for another's.
pub fn shell(s: Shell) -> Vec<String> {
    let words: &[&str] = match (s.bash, s.other, s.edits) {
        (true, false, true) => &["/bin/bash", "--rcfile", "/etc/length3/shrc", "-i"],
        (true, false, false) => &["/bin/bash", "--noediting", "--rcfile", "/etc/length3/shrc", "-i"],
        (true, true, true) => &["/bin/bash", "-i"],
        _ => &["/bin/sh", "-i"],
    };
    words.iter().map(|w| w.to_string()).collect()
}

/// What a box's programs are told of where they are.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Told {
    /// The terminal it is drawn on, by its name (a real one's; else dumb).
    pub term: String,
    /// The person's time zone by its name; none, UTC.
    pub zone: Option<String>,
    /// What it is told besides (a product's own variables, a key under its maker's variable), each by a name of
    /// capitals, digits and _.
    pub more: Vec<(String, String)>,
}

/// What a box's programs run with: set here, never taken from the host; then what it is told besides
/// (`told.more`), each by a name of capitals, digits and _ that is none of these, its words without a NUL. `argv`:
/// what it runs (the shell a person's programs start for them, an editor's :! or tmux's panes, is the one they were
/// given).
pub fn environment(argv: &[String], told: &Told) -> Vec<String> {
    let shell = if argv.first().is_some_and(|a| a.ends_with("/bash")) { "/bin/bash" } else { "/bin/sh" };
    let term = if plain_term(&told.term) { told.term.as_str() } else { "dumb" };
    let mut all: Vec<String> = Vec::with_capacity(10 + told.more.len());
    all.extend([
        format!("PATH={PATH}"),
        "HOME=/root".into(),
        "USER=root".into(),
        "LOGNAME=root".into(),
        format!("SHELL={shell}"),
        format!("TERM={term}"),
        "LANG=C.UTF-8".into(),
        "PS1=$PWD $ ".into(),
        // Where an interactive sh finds the root's settings (the name the root released as 0.6.4 keeps them by).
        "ENV=/etc/length3/shrc".into(),
    ]);
    // The person's clock: the root has every zone the host may name, so date, ls -l and git's log read as theirs.
    if let Some(z) = told.zone.as_deref().filter(|z| plain_zone(z)) { all.push(format!("TZ={z}")); }
    let fixed = all.len();
    for (k, v) in &told.more {
        let named = !k.is_empty() && k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
        if !named || all[..fixed].iter().any(|e| e.split_once('=').is_some_and(|(name, _)| name == k)) { continue; }
        all.push(format!("{k}={}", v.replace('\0', "")));
    }
    all
}

/// A zone's name as zoneinfo has them (Asia/Tokyo, Etc/GMT+9), or a POSIX rule (JST-9): nothing that leaves it.
pub fn plain_zone(z: &str) -> bool {
    !z.is_empty() && z.len() <= 64 && !z.contains("..") && !z.starts_with('/')
        && z.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b))
}

/// A terminal's name as terminfo has them: nothing else of the host's passes.
pub fn plain_term(t: &str) -> bool {
    !t.is_empty() && t.len() <= 64 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._+".contains(&b))
}

#[cfg(test)]
#[path = "bundle.test.rs"]
mod tests;
