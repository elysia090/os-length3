//! The keys let in: the Runtime dotfile `.authorized_keys`, one OpenSSH public key a line, read and named by
//! fingerprint.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]


/// Standard base64, padded or not; None when it is not that.
pub(super) fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for b in s.bytes() {
        acc = acc << 6 | B64.iter().position(|&x| x == b)? as u32;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); }
    }
    // What is left over is padding's zero bits; a lone character is not base64.
    (bits < 6 && acc & ((1 << bits) - 1) == 0).then_some(out)
}

pub(super) fn base64_encode(bytes: &[u8]) -> String {
    let mut s = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            s.push(if k <= c.len() { B64[(n >> (18 - 6 * k) & 63) as usize] as char } else { '=' });
        }
    }
    s
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// A key's fingerprint as OpenSSH writes it: SHA256: and the digest in base64 without padding.
pub fn fingerprint(blob: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("SHA256:{}", base64_encode(&Sha256::digest(blob)).trim_end_matches('='))
}

/// The kind a key blob names first (a string: a 4-byte length, then its bytes).
fn blob_kind(blob: &[u8]) -> Option<&str> {
    let n = u32::from_be_bytes(blob.get(..4)?.try_into().ok()?) as usize;
    std::str::from_utf8(blob.get(4..4 + n)?).ok()
}

/// The keys in Home's `.authorized_keys` as this device took it (home.rs dotfiles_in_effect): a key the Remote's
/// copy holds and the person at this device never took is let in nowhere.
pub fn keys() -> Keys {
    crate::home::dotfiles_in_effect().into_iter().find(|(n, _)| n == KEYS).map(|(_, t)| parse_keys(&t)).unwrap_or_default()
}

/// Read an authorized_keys text: `kind base64 [comment]` a line; blank lines and `#` lines are nothing. A line
/// with options before its key (`from=…`, `command=…`, `restrict`) is left out, not taken without them: the
/// listener does not honour them, and a key meant to be held to them must not reach a shell unheld.
pub fn parse_keys(text: &str) -> Keys {
    let mut out = Keys::default();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let mut words = line.split_whitespace();
        let kind = words.next().unwrap_or_default();
        let why = if kind == "ssh-rsa" || kind.starts_with("rsa-sha2") {
            crate::tr!("an RSA key is not taken; make an Ed25519 one (ssh-keygen -t ed25519)", "RSA の鍵は使えません。Ed25519 の鍵を作ってください（ssh-keygen -t ed25519）")
        } else if !KINDS.contains(&kind) {
            if words.clone().any(|w| KINDS.contains(&w)) || kind.contains('=') || kind.contains(',') {
                crate::tr!("options before a key are not honoured, so the line is left out", "鍵の前のオプションは守れないので、この行は使いません")
            } else {
                crate::tr!("not a public key of a kind taken here ({})", "ここで使える種類の公開鍵ではありません（{}）", KINDS.join(", "))
            }
        } else {
            match words.next().and_then(base64_decode) {
                Some(blob) if blob_kind(&blob) == Some(kind) => {
                    out.keys.push(Key { kind: kind.into(), blob, comment: words.collect::<Vec<_>>().join(" ") });
                    continue;
                }
                _ => crate::tr!("its key is not a {} key", "鍵が {} の鍵になっていません", kind),
            }
        };
        out.skipped.push((i + 1, why));
    }
    out
}

/// What a key file holds: the keys taken, and each line left out (its number from 1, and why).
#[derive(Debug, Default, PartialEq)]
pub struct Keys {
    pub keys: Vec<Key>,
    pub skipped: Vec<(usize, String)>,
}

/// One key from `.authorized_keys`: its kind, its public blob (as the SSH wire has it), and what it says of itself.
#[derive(Debug, Clone, PartialEq)]
pub struct Key {
    pub kind: String,
    pub blob: Vec<u8>,
    pub comment: String,
}

impl Key {
    /// Its fingerprint as `ssh-keygen -l` writes it.
    pub fn fingerprint(&self) -> String {
        fingerprint(&self.blob)
    }
}

/// The kinds of key taken: what the listener can check a signature of. RSA is not among them (an Ed25519 key is
/// what `ssh-keygen` makes by default, and every OpenSSH of the last ten years can).
pub const KINDS: [&str; 4] = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"];

/// The dotfile the keys are in.
pub const KEYS: &str = ".authorized_keys";

