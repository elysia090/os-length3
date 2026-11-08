//! A root's bundle unpacked: zstd frames one after another, then tar, every entry placed under the top and never
//! through a link, its mode kept.

use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use super::held::symlink;

/// Unpack a tar stream into the empty directory `top`; returns (files, bytes).
pub fn unpack(stream: impl Read, top: &Path) -> io::Result<(u64, u64)> {
    let mut r = io::BufReader::with_capacity(1 << 20, stream);
    let (mut files, mut bytes) = (0u64, 0u64);
    let mut long_name: Option<String> = None;
    let mut long_link: Option<String> = None;
    let mut block = [0u8; 512];
    loop {
        r.read_exact(&mut block)?;
        if block.iter().all(|&b| b == 0) {
            return Ok((files, bytes));
        }
        let sum = octal(&block[148..156])?;
        let mut check: u64 = block.iter().map(|&b| b as u64).sum();
        check = check - block[148..156].iter().map(|&b| b as u64).sum::<u64>() + 8 * 32;
        if sum != check {
            return Err(bad("tar: a header's checksum is wrong"));
        }
        let size = octal(&block[124..136])?;
        let mode = octal(&block[100..108])? as u32 & 0o7777;
        let kind = block[156];
        let mut name = text(&block[0..100]);
        if &block[257..262] == b"ustar" && block[345] != 0 {
            name = format!("{}/{}", text(&block[345..500]), name);
        }
        let link = text(&block[157..257]);
        let padded = size.div_ceil(512) * 512;
        // A pax header sets path and linkpath for the member after it.
        if kind == b'x' || kind == b'g' {
            let mut body = vec![0u8; padded as usize];
            r.read_exact(&mut body)?;
            if kind == b'x' {
                let mut rest = &body[..size as usize];
                while let Some(sp) = rest.iter().position(|&b| b == b' ') {
                    let len: usize = std::str::from_utf8(&rest[..sp]).map_err(bad)?.parse().map_err(bad)?;
                    // "LEN key=value\n": at least the space, one byte and the newline after the length.
                    if len < sp + 2 || len > rest.len() {
                        return Err(bad("tar: a pax record is cut"));
                    }
                    let record = String::from_utf8_lossy(&rest[sp + 1..len - 1]).into_owned();
                    if let Some(v) = record.strip_prefix("path=") { long_name = Some(v.into()); }
                    if let Some(v) = record.strip_prefix("linkpath=") { long_link = Some(v.into()); }
                    if record.starts_with("size=") { return Err(bad("tar: pax sizes are not taken")); }
                    rest = &rest[len..];
                }
            }
            continue;
        }
        let name = long_name.take().unwrap_or(name);
        let link = long_link.take().unwrap_or(link);
        let what = match kind {
            b'0' | 0 | b'7' => Kind::File,
            b'5' => Kind::Dir,
            b'2' => Kind::Symlink(link),
            b'1' => Kind::Hardlink(link),
            other => return Err(bad(format!("tar: {name}: kind {:?} is not part of a root", other as char))),
        };
        // The archive's own top (`./`, as Debian's has) is `top` itself.
        if matches!(what, Kind::Dir) && Path::new(&name).components().all(|c| c == Component::CurDir) { continue; }
        let rel = place(&name)?;
        through_no_link(top, &rel)?;
        let path = top.join(&rel);
        match what {
            Kind::Dir => {
                match fs::create_dir(&path) {
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists && fs::symlink_metadata(&path)?.is_dir() => {}
                    other => other?,
                }
                set_mode(&path, mode | 0o700)?;
            }
            Kind::File => {
                // create_new: never over something already there (a link above all).
                let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
                io::copy(&mut (&mut r).take(size), &mut f)?;
                let mut pad = vec![0u8; (padded - size) as usize];
                r.read_exact(&mut pad)?;
                drop(f);
                // No set-id bits come from an archive.
                set_mode(&path, mode & 0o777)?;
                files += 1;
                bytes += size;
                continue;
            }
            Kind::Symlink(target) => symlink(&target, &path)?,
            Kind::Hardlink(target) => {
                // Its target is a file already in the tree, reached through no link (a link
                // made earlier in the archive could otherwise lead it to a file outside).
                let rel_target = place(&target)?;
                through_no_link(top, &rel_target)?;
                let from = top.join(&rel_target);
                if !fs::symlink_metadata(&from)?.is_file() {
                    return Err(bad(format!("tar: {name} links to something not a file")));
                }
                fs::hard_link(&from, &path)?;
                files += 1;
            }
        }
        // Members without content still occupy their padding.
        if padded > 0 {
            io::copy(&mut (&mut r).take(padded), &mut io::sink())?;
        }
    }
}

/// Give `path` its mode, where the host keeps modes (unix); elsewhere it has the host's own.
#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) -> io::Result<()> { Ok(()) }

/// Make sure no part of `rel` under `top` is a link: a member must never
/// be written through one (a symlink made earlier in the same archive).
fn through_no_link(top: &Path, rel: &Path) -> io::Result<()> {
    let mut at = top.to_path_buf();
    let parts: Vec<_> = rel.components().collect();
    for c in &parts[..parts.len().saturating_sub(1)] {
        at.push(c);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Err(bad(format!("tar: {} goes through a link", rel.display()))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => fs::create_dir(&at)?,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// A member path made safe: relative, normal parts only, under `root/`.
/// The release's tree is its `root/`; its `manifest` is kept beside it.
fn place(name: &str) -> io::Result<PathBuf> {
    let p = Path::new(name.trim_end_matches('/'));
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(x) => out.push(x),
            Component::CurDir => {}
            _ => return Err(bad(format!("tar: {name} leaves the tree"))),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(bad("tar: an empty name"));
    }
    Ok(out)
}

fn text(field: &[u8]) -> String {
    String::from_utf8_lossy(field.split(|&b| b == 0).next().unwrap_or(&[])).into_owned()
}

fn octal(field: &[u8]) -> io::Result<u64> {
    let t = field.iter().take_while(|&&b| b != 0 && b != b' ').copied().collect::<Vec<u8>>();
    let t = std::str::from_utf8(&t).map_err(bad)?.trim_start();
    if t.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(t, 8).map_err(|_| bad("tar: a number is not octal"))
}

fn bad(e: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// Every frame of a zstd stream, one after another.
pub(super) struct Frames<R: Read> {
    inner: Option<Decoder<R>>,
}

impl<R: Read> Frames<R> {
    pub(super) fn new(source: R) -> io::Result<Frames<R>> {
        Ok(Frames { inner: Some(Decoder::new(io::BufReader::new(source)).map_err(bad)?) })
    }
}

impl<R: Read> Read for Frames<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        loop {
            let Some(d) = self.inner.as_mut() else { return Ok(0) };
            let n = d.read(out)?;
            if n > 0 || out.is_empty() {
                return Ok(n);
            }
            // This frame is done: the next one, if more follows.
            let (mut source, decoder) = self.inner.take().unwrap().into_parts();
            if io::BufRead::fill_buf(&mut source)?.is_empty() {
                return Ok(0);
            }
            self.inner = Some(ruzstd::decoding::StreamingDecoder::new_with_decoder(source, decoder).map_err(bad)?);
        }
    }
}

/// One tar member, as far as a root needs: these four kinds and nothing else.
enum Kind {
    File,
    Dir,
    Symlink(String),
    Hardlink(String),
}

type Decoder<R> = ruzstd::decoding::StreamingDecoder<io::BufReader<R>, ruzstd::decoding::FrameDecoder>;

