//! The terminal, for the menu (menu.rs): whether l3 talks with a person at
//! all, keys read one at a time, and a few lines drawn again in place under
//! what is already there. Nothing takes the screen over: the menu is lines in
//! the scrollback, the cursor moves only within the lines it last drew, and
//! what stays when a choice is made is plain text.

use std::io::{IsTerminal, Write};

/// Whether l3 may offer and ask: standard input and output are both a
/// terminal, the answer is text (not --json), the terminal can move its
/// cursor (not TERM=dumb), and the person has not asked for the plain
/// command (L3_PLAIN, any value but empty). Otherwise l3 is exactly the
/// command it was: it writes its answer and exits.
pub fn interactive(json: bool) -> bool {
    !json && std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
        && std::env::var("TERM").map_or(true, |t| t != "dumb")
        && std::env::var_os("L3_PLAIN").map_or(true, |v| v.is_empty())
        && cfg!(unix)
}

/// Bold, dim and the mark of the chosen deed, unless NO_COLOR asks for none
/// (the focus is still a › and brackets, so nothing depends on colour).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Style { pub color: bool }

impl Style {
    pub fn now() -> Style { Style { color: std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty()) } }
    #[cfg(test)]
    pub const PLAIN: Style = Style { color: false };
    fn sgr(self, code: &str, s: &str) -> String { if self.color && !s.is_empty() { format!("\x1b[{code}m{s}\x1b[0m") } else { s.to_string() } }
    pub fn bold(self, s: &str) -> String { self.sgr("1", s) }
    pub fn dim(self, s: &str) -> String { self.sgr("2", s) }
}

/// How many columns `s` takes, its escapes aside.
pub fn width(s: &str) -> usize {
    let mut plain = String::new();
    let mut esc = false;
    for c in s.chars() {
        if esc { if c.is_ascii_alphabetic() { esc = false; } continue; }
        if c == '\x1b' { esc = true; continue; }
        plain.push(c);
    }
    crate::help::width(&plain)
}

/// `s` cut to `cols` columns (escapes kept whole), with … where it was cut.
pub fn fit(s: &str, cols: usize) -> String {
    if width(s) <= cols { return s.to_string(); }
    let mut out = String::new();
    let (mut used, mut esc) = (0, false);
    for c in s.chars() {
        if esc { out.push(c); if c.is_ascii_alphabetic() { esc = false; } continue; }
        if c == '\x1b' { esc = true; out.push(c); continue; }
        let w = crate::help::width(c.encode_utf8(&mut [0; 4]));
        if used + w + 1 > cols { break; }
        out.push(c);
        used += w;
    }
    out.push('…');
    if out.contains('\x1b') { out.push_str("\x1b[0m"); }
    out
}

/// The terminal's columns and rows (80×24 when it does not say).
pub fn size() -> (usize, usize) {
    #[cfg(unix)]
    unsafe {
        let mut w: libc::winsize = std::mem::zeroed();
        if libc::ioctl(1, libc::TIOCGWINSZ, &mut w) == 0 && w.ws_col > 0 && w.ws_row > 0 { return (w.ws_col as usize, w.ws_row as usize); }
    }
    (80, 24)
}

/// Whether the person has typed ahead (keys waiting): then nothing is offered, so no key is taken from them.
pub fn typed_ahead() -> bool {
    #[cfg(unix)]
    unsafe {
        let mut n: libc::c_int = 0;
        if libc::ioctl(0, libc::FIONREAD, &mut n) == 0 { return n > 0; }
    }
    false
}

/// A key as the menu reads it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Key { Up, Down, Left, Right, Home, End, Enter, Esc, Back, Tab, BackTab, Quit, Char(char), Other }

/// The terminal one key at a time, without echo, while this lives; the
/// cursor hidden. Dropped (or l3 ending any way), it is as it was.
pub struct Keys {
    #[cfg(unix)]
    saved: libc::termios,
}

impl Keys {
    /// None where the terminal will not be set (it is then not one l3 can ask in).
    pub fn take() -> Option<Keys> {
        #[cfg(unix)]
        unsafe {
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut t) != 0 { return None; }
            let saved = t;
            t.c_lflag &= !(libc::ICANON | libc::ECHO | libc::ISIG | libc::IEXTEN);
            t.c_iflag &= !(libc::IXON | libc::ICRNL);
            t.c_cc[libc::VMIN] = 1;
            t.c_cc[libc::VTIME] = 0;
            if libc::tcsetattr(0, libc::TCSANOW, &t) != 0 { return None; }
            put("\x1b[?25l");
            Some(Keys { saved })
        }
        #[cfg(not(unix))]
        None
    }

    /// The next key; Quit when standard input ends.
    pub fn next(&self) -> Key {
        let Some(b) = byte(None) else { return Key::Quit };
        match b {
            0x1b => match byte(Some(40)) {
                None => Key::Esc,
                Some(b'[') => csi(),
                Some(b'O') => match byte(Some(40)) { Some(b'A') => Key::Up, Some(b'B') => Key::Down, Some(b'C') => Key::Right, Some(b'D') => Key::Left, Some(b'H') => Key::Home, Some(b'F') => Key::End, _ => Key::Other },
                Some(_) => Key::Other,
            },
            b'\r' | b'\n' => Key::Enter,
            0x7f | 0x08 => Key::Back,
            b'\t' => Key::Tab,
            0x03 | 0x04 => Key::Quit,
            b if b < 0x20 => Key::Other,
            b if b < 0x80 => Key::Char(b as char),
            lead => {
                // The rest of one character in UTF-8.
                let more = if lead >= 0xf0 { 3 } else if lead >= 0xe0 { 2 } else { 1 };
                let mut v = vec![lead];
                for _ in 0..more { match byte(Some(40)) { Some(c) => v.push(c), None => break } }
                String::from_utf8(v).ok().and_then(|s| s.chars().next()).map_or(Key::Other, Key::Char)
            }
        }
    }
}

impl Drop for Keys {
    fn drop(&mut self) {
        put("\x1b[?25h");
        #[cfg(unix)]
        unsafe { libc::tcsetattr(0, libc::TCSANOW, &self.saved); }
    }
}

/// After ESC [: the rest of the sequence, as a key.
fn csi() -> Key {
    let mut params = String::new();
    loop {
        let Some(b) = byte(Some(40)) else { return Key::Other };
        if (0x40..=0x7e).contains(&b) {
            return match (b, params.as_str()) {
                (b'A', _) => Key::Up, (b'B', _) => Key::Down, (b'C', _) => Key::Right, (b'D', _) => Key::Left,
                (b'H', _) => Key::Home, (b'F', _) => Key::End, (b'Z', _) => Key::BackTab,
                (b'~', "1" | "7") => Key::Home, (b'~', "4" | "8") => Key::End,
                _ => Key::Other,
            };
        }
        params.push(b as char);
    }
}

/// One byte of standard input; with `wait` (ms), None if none comes by then.
fn byte(wait: Option<i32>) -> Option<u8> {
    #[cfg(unix)]
    unsafe {
        if let Some(ms) = wait {
            let mut p = libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 };
            if libc::poll(&mut p, 1, ms) <= 0 { return None; }
        }
        let mut b = 0u8;
        loop {
            let n = libc::read(0, (&mut b as *mut u8).cast(), 1);
            if n == 1 { return Some(b); }
            if n < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted { continue; }
            return None;
        }
    }
    #[cfg(not(unix))]
    { let _ = wait; None }
}

/// Write to the terminal now.
pub fn put(s: &str) {
    let mut o = std::io::stdout().lock();
    let _ = o.write_all(s.as_bytes()).and_then(|_| o.flush());
}

/// Lines drawn under what is there and drawn again in their place: the
/// cursor goes back up over only these lines (each cut to the width, so none
/// wraps) and what is below it is cleared.
#[derive(Default)]
pub struct Block { drawn: usize }

impl Block {
    pub fn draw(&mut self, lines: &[String]) {
        let cols = size().0.saturating_sub(1).max(10);
        let body: Vec<String> = lines.iter().map(|l| fit(l, cols)).collect();
        put(&format!("{}{}", self.erasing(), body.join("\r\n")));
        self.drawn = body.len();
    }

    /// Take the lines away; the cursor is where the first was.
    pub fn clear(&mut self) {
        put(&self.erasing());
        self.drawn = 0;
    }

    /// Leave the lines as they are and go on under them.
    pub fn keep(&mut self) {
        if self.drawn > 0 { put("\r\n"); }
        self.drawn = 0;
    }

    fn erasing(&self) -> String {
        match self.drawn {
            0 => String::new(),
            1 => "\r\x1b[J".to_string(),
            n => format!("\r\x1b[{}A\x1b[J", n - 1),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_skip_escapes_and_count_wide_characters_twice() {
        assert_eq!(width("\x1b[1mGit\x1b[0m"), 3);
        assert_eq!(width("Issue を書く"), 12);
        assert_eq!(fit("Issue を書く", 8), "Issue …");
        assert_eq!(fit("short", 8), "short");
    }
}
