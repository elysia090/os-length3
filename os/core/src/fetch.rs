//! Fetching a release from the Remote, the way the web loader does
//! (src/fetch.ts): what came is kept in a `.part` file, a cut or stalled
//! transfer is taken up again from the byte it reached, and the result is
//! accepted only when it is the file the pin names. Nothing else is read
//! from the network by l3.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Seek, Write};
use std::path::Path;
use std::time::Duration;

const STALL: Duration = Duration::from_secs(20);
const ATTEMPTS: u32 = 6;

/// How far a fetch is: bytes so far of all; a retry with its reason.
pub enum Progress<'a> {
    Bytes(u64, u64),
    Retry(u32, &'a str),
}

fn digest_of(path: &Path) -> io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    io::copy(&mut f, &mut h)?;
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Fetch `url` into `dest` (via `dest.part`), resuming after cuts; checked
/// against `sha256` and `size` before it is moved into place.
pub fn fetch(url: &str, sha256: &str, size: u64, dest: &Path, mut progress: impl FnMut(Progress)) -> Result<(), String> {
    if dest.exists() && digest_of(dest).ok().as_deref() == Some(sha256) {
        return Ok(());
    }
    let part = dest.with_extension("part");
    let agent = crate::net::agent(url, STALL);
    let mut why = String::new();
    for attempt in 1..=ATTEMPTS {
        if attempt > 1 {
            progress(Progress::Retry(attempt, &why));
            std::thread::sleep(Duration::from_millis(500 << (attempt - 2).min(4)));
        }
        let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if have > size {
            let _ = fs::remove_file(&part);
            continue;
        }
        if have < size {
            let mut req = agent.get(url);
            if have > 0 {
                req = req.set("Range", &format!("bytes={have}-"));
            }
            let r = match req.call() {
                Ok(r) => r,
                Err(ureq::Error::Status(code, _)) if code == 404 || code == 403 || code == 401 => return Err(format!("{url}: {code}")),
                Err(e) => { why = e.to_string(); continue; }
            };
            // A server that cannot continue sends it all again: start the file over.
            let resumed = r.status() == 206 && r.header("Content-Range").is_some_and(|c| c.starts_with(&format!("bytes {have}-")));
            let mut file = fs::OpenOptions::new().create(true).write(true).truncate(!resumed).open(&part).map_err(|e| e.to_string())?;
            let mut got = if resumed { file.seek(io::SeekFrom::End(0)).map_err(|e| e.to_string())? } else { 0 };
            let mut body = r.into_reader().take(size - got);
            let mut buf = vec![0u8; 256 * 1024];
            let broken = loop {
                match body.read(&mut buf) {
                    Ok(0) => break None,
                    Ok(n) => {
                        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                        got += n as u64;
                        progress(Progress::Bytes(got, size));
                    }
                    Err(e) => break Some(e.to_string()),
                }
            };
            file.sync_all().map_err(|e| e.to_string())?;
            if let Some(e) = broken {
                why = crate::tr!("The connection broke ({})", "回線が切れました（{}）", e);
                continue;
            }
            if got < size {
                why = crate::tr!("The connection broke", "回線が切れました");
                continue;
            }
        }
        if digest_of(&part).map_err(|e| e.to_string())? != sha256 {
            let _ = fs::remove_file(&part);
            why = crate::tr!("The contents do not match", "中身が合いません");
            continue;
        }
        fs::rename(&part, dest).map_err(|e| e.to_string())?;
        return Ok(());
    }
    // What came stays in the .part file for the next try.
    Err(if why.is_empty() { crate::tr!("Could not load", "読み込めませんでした") } else { why })
}
