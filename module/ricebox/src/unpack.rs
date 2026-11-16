//! A root's archive unpacked: a tar stream, every entry made beneath the top and through no link, its mode kept.
//!
//! The kernel holds the rule, not a check before the call: a directory come into is opened beneath the top with no
//! link followed on the way (openat2: RESOLVE_BENEATH, RESOLVE_NO_SYMLINKS), and what is made in it is made by its
//! own name there (never a path), never over anything (O_EXCL) and never through a link (O_NOFOLLOW). A link made
//! earlier in the same archive therefore leads nothing anywhere, whatever it names.
//!
//! The bound (lib.rs): a file is three calls (made, written, closed) where it fits what is decoded at a time, a
//! directory or a link one; a directory come into is one call, held while its entries are made. A mode the
//! process's umask would cut is put back by one more call on what is already open; the umask is read once.

use std::io::{self, BufRead, Read};
use std::path::Path;

use rustix::fd::{AsFd, BorrowedFd, OwnedFd};
use rustix::fs::{self as rfs, AtFlags, Mode, OFlags, ResolveFlags};

use crate::read::bad;

/// What was unpacked: its files and their bytes, and the calls it took of the host.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Unpacked {
    pub files: u64,
    pub bytes: u64,
    pub calls: u64,
}

/// What is decoded and held at a time: a file no longer than this is written by one call.
const HELD: usize = 1 << 20;

/// The tree being made: its top, and the directory in hand.
struct Tree {
    top: OwnedFd,
    /// The directory in hand, by its path from the top ("" the top itself), and it.
    at: String,
    dir: Option<OwnedFd>,
    /// The bits a mode loses as a file or a directory is made (the process's umask).
    cut: u32,
    calls: u64,
}

fn errno(what: &str) -> impl Fn(rustix::io::Errno) -> io::Error + '_ {
    move |e| { let e = io::Error::from(e); io::Error::new(e.kind(), format!("tar: {what}: {e}")) }
}

/// The process's umask, read where the kernel says it (one that cannot be read cuts every mode: each is then set).
fn umask() -> u32 {
    std::fs::read_to_string("/proc/self/status").ok()
        .and_then(|s| s.lines().find_map(|l| l.strip_prefix("Umask:").and_then(|v| u32::from_str_radix(v.trim(), 8).ok())))
        .unwrap_or(0o777)
}

impl Tree {
    fn open(top: &Path) -> io::Result<Tree> {
        let top = rfs::open(top, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty())?;
        Ok(Tree { top, at: String::new(), dir: None, cut: umask(), calls: 1 })
    }

    /// The directory `path` (from the top; "" the top), beneath the top and through no link.
    fn beneath(&mut self, path: &str) -> io::Result<OwnedFd> {
        self.calls += 1;
        match rfs::openat2(&self.top, path, OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty(), ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS) {
            Ok(d) => Ok(d),
            // A directory the archive names no entry for: made, a name at a time, each beneath the one before.
            Err(rustix::io::Errno::NOENT) => {
                let mut held: Option<OwnedFd> = None;
                for name in path.split('/') {
                    let dir = held.as_ref().map_or(self.top.as_fd(), |d| d.as_fd());
                    self.calls += 2;
                    match rfs::mkdirat(dir, name, Mode::from_raw_mode(0o755)) { Ok(()) | Err(rustix::io::Errno::EXIST) => {}, Err(e) => return Err(errno(path)(e)) }
                    held = Some(rfs::openat(dir, name, OFlags::PATH | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty()).map_err(errno(path))?);
                }
                held.ok_or_else(|| bad("tar: an empty name"))
            }
            Err(e) => Err(errno(path)(e)),
        }
    }

    /// The directory `parent` in hand: the one held where it is that one, else come into (and the one before let go).
    fn hold(&mut self, parent: &str) -> io::Result<()> {
        if parent == self.at && (parent.is_empty() || self.dir.is_some()) { return Ok(()); }
        if self.dir.take().is_some() { self.calls += 1; }
        self.dir = if parent.is_empty() { None } else { Some(self.beneath(parent)?) };
        self.at.clear();
        self.at.push_str(parent);
        Ok(())
    }

    fn held(&self) -> BorrowedFd<'_> {
        self.dir.as_ref().map_or(self.top.as_fd(), |d| d.as_fd())
    }

    fn dir(&mut self, name: &str, mode: u32) -> io::Result<()> {
        let mode = mode | 0o700;
        self.calls += 1;
        match rfs::mkdirat(self.held(), name, Mode::from_raw_mode(mode)) {
            Ok(()) => {}
            // There already (made on the way to an entry in it), and a directory itself: its mode is the archive's.
            Err(rustix::io::Errno::EXIST) => {
                self.calls += 1;
                let st = rfs::statat(self.held(), name, AtFlags::SYMLINK_NOFOLLOW).map_err(errno(name))?;
                if rfs::FileType::from_raw_mode(st.st_mode) != rfs::FileType::Directory { return Err(bad(format!("tar: {name} is there and is no directory"))); }
                self.calls += 1;
                return rfs::chmodat(self.held(), name, Mode::from_raw_mode(mode), AtFlags::empty()).map_err(errno(name));
            }
            Err(e) => return Err(errno(name)(e)),
        }
        if mode & self.cut != 0 {
            self.calls += 1;
            rfs::chmodat(self.held(), name, Mode::from_raw_mode(mode), AtFlags::empty()).map_err(errno(name))?;
        }
        Ok(())
    }

    /// A file of `size` bytes read from `r`: made by its name in the directory in hand, never over anything.
    fn file(&mut self, name: &str, mode: u32, size: u64, r: &mut impl BufRead) -> io::Result<()> {
        // No set-id bits come from an archive.
        let mode = mode & 0o777;
        self.calls += 1;
        let f = rfs::openat(self.held(), name, OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::from_raw_mode(mode)).map_err(errno(name))?;
        let mut left = size;
        while left > 0 {
            let have = r.fill_buf()?;
            if have.is_empty() { return Err(bad(format!("tar: {name} is cut short"))); }
            let n = have.len().min(usize::try_from(left).unwrap_or(usize::MAX));
            let mut at = 0;
            while at < n {
                self.calls += 1;
                at += match rustix::io::write(&f, &have[at..n]) { Ok(w) => w, Err(rustix::io::Errno::INTR) => 0, Err(e) => return Err(errno(name)(e)) };
            }
            r.consume(n);
            left -= n as u64;
        }
        if mode & self.cut != 0 {
            self.calls += 1;
            rfs::fchmod(&f, Mode::from_raw_mode(mode)).map_err(errno(name))?;
        }
        self.calls += 1;
        drop(f);
        Ok(())
    }

    fn symlink(&mut self, name: &str, target: &str) -> io::Result<()> {
        self.calls += 1;
        rfs::symlinkat(target, self.held(), name).map_err(errno(name))
    }

    /// Another name for the file `target` (from the top), which is a file already in the tree, reached through no
    /// link (one made earlier in the archive could otherwise lead it to a file outside).
    fn link(&mut self, name: &str, target: &str) -> io::Result<()> {
        let (tparent, tname) = target.rsplit_once('/').unwrap_or(("", target));
        let other = if tparent == self.at || tparent.is_empty() { None } else { Some(self.beneath(tparent)?) };
        // (looked at, linked; and the directory it lies in let go, where that is not the one in hand)
        self.calls += 2 + other.is_some() as u64;
        let from = match &other { Some(d) => d.as_fd(), None if tparent == self.at => self.held(), None => self.top.as_fd() };
        let st = rfs::statat(from, tname, AtFlags::SYMLINK_NOFOLLOW).map_err(errno(target))?;
        if rfs::FileType::from_raw_mode(st.st_mode) != rfs::FileType::RegularFile { return Err(bad(format!("tar: {name} links to something not a file"))); }
        rfs::linkat(from, tname, self.held(), name, AtFlags::empty()).map_err(errno(name))
    }
}


/// A member's path made safe: relative, of plain names only ("a/b/c"; none: the archive's own top).
fn place(name: &str) -> io::Result<String> {
    if name.starts_with('/') { return Err(bad(format!("tar: {name} leaves the tree"))); }
    let mut out = String::with_capacity(name.len());
    for part in name.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(bad(format!("tar: {name} leaves the tree"))),
            p if p.contains('\0') => return Err(bad("tar: a name with a NUL")),
            p => { if !out.is_empty() { out.push('/'); } out.push_str(p); }
        }
    }
    Ok(out)
}

fn text(field: &[u8]) -> String {
    String::from_utf8_lossy(field.split(|&b| b == 0).next().unwrap_or(&[])).into_owned()
}

fn octal(field: &[u8]) -> io::Result<u64> {
    let mut n: u64 = 0;
    let mut any = false;
    for &b in field.iter().skip_while(|&&b| b == b' ').take_while(|&&b| b != 0 && b != b' ') {
        if !(b'0'..=b'7').contains(&b) { return Err(bad("tar: a number is not octal")); }
        n = n.checked_mul(8).and_then(|n| n.checked_add((b - b'0') as u64)).ok_or_else(|| bad("tar: a number is too large"))?;
        any = true;
    }
    Ok(if any { n } else { 0 })
}

/// So many bytes of `r` passed over.
fn skip(r: &mut impl BufRead, mut n: u64) -> io::Result<()> {
    while n > 0 {
        let have = r.fill_buf()?.len();
        if have == 0 { return Err(bad("tar: cut short")); }
        let k = have.min(usize::try_from(n).unwrap_or(usize::MAX));
        r.consume(k);
        n -= k as u64;
    }
    Ok(())
}

/// Unpack a tar stream into the empty directory `top`.
pub fn unpack(stream: impl Read, top: &Path) -> io::Result<Unpacked> {
    let mut r = io::BufReader::with_capacity(HELD, stream);
    let mut tree = Tree::open(top)?;
    let (mut files, mut bytes) = (0u64, 0u64);
    let mut long_name: Option<String> = None;
    let mut long_link: Option<String> = None;
    let mut block = [0u8; 512];
    loop {
        r.read_exact(&mut block)?;
        if block.iter().all(|&b| b == 0) {
            if tree.dir.take().is_some() { tree.calls += 1; }
            // (and the top let go)
            return Ok(Unpacked { files, bytes, calls: tree.calls + 1 });
        }
        let sum = octal(&block[148..156])?;
        let all: u64 = block.iter().map(|&b| b as u64).sum();
        let check = all - block[148..156].iter().map(|&b| b as u64).sum::<u64>() + 8 * 32;
        if sum != check { return Err(bad("tar: a header's checksum is wrong")); }
        let size = octal(&block[124..136])?;
        let mode = octal(&block[100..108])? as u32 & 0o7777;
        let kind = block[156];
        let mut name = text(&block[0..100]);
        if &block[257..262] == b"ustar" && block[345] != 0 { name = format!("{}/{}", text(&block[345..500]), name); }
        let link = text(&block[157..257]);
        let padded = size.div_ceil(512) * 512;
        // A pax header sets path and linkpath for the member after it.
        if kind == b'x' || kind == b'g' {
            if padded > 1 << 20 { return Err(bad("tar: a pax header is too long")); }
            let mut body = vec![0u8; padded as usize];
            r.read_exact(&mut body)?;
            if kind == b'x' {
                let mut rest = &body[..size as usize];
                while let Some(sp) = rest.iter().position(|&b| b == b' ') {
                    let len: usize = std::str::from_utf8(&rest[..sp]).map_err(bad)?.parse().map_err(bad)?;
                    // "LEN key=value\n": at least the space, one byte and the newline after the length.
                    if len < sp + 2 || len > rest.len() { return Err(bad("tar: a pax record is cut")); }
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
        if !matches!(kind, b'0' | 0 | b'7' | b'5' | b'2' | b'1') { return Err(bad(format!("tar: {name}: kind {:?} is not part of a root", kind as char))); }
        let rel = place(&name)?;
        // The archive's own top (`./`, as Debian's has) is `top` itself.
        if rel.is_empty() {
            if kind == b'5' { skip(&mut r, padded)?; continue; }
            return Err(bad("tar: an empty name"));
        }
        let (parent, last) = rel.rsplit_once('/').unwrap_or(("", &rel));
        tree.hold(parent)?;
        match kind {
            b'5' => tree.dir(last, mode)?,
            b'2' => tree.symlink(last, &link)?,
            b'1' => { tree.link(last, &place(&link)?)?; files += 1; }
            _ => {
                tree.file(last, mode, size, &mut r)?;
                skip(&mut r, padded - size)?;
                files += 1;
                bytes += size;
                continue;
            }
        }
        // Members without content still occupy their padding.
        skip(&mut r, padded)?;
    }
}

#[cfg(test)]
#[path = "unpack.test.rs"]
pub(crate) mod tests;
