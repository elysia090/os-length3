//! The distribution's root, as l3 holds it on a device. The canonical copy
//! is the release: a `.tar.zst` bundle named by its sha256, pinned here. It
//! is l3: the desktop app installs it, and the web reads the same tree from
//! it (os/scripts/l3.mjs), so one entry here pins both.
//! Installing checks the bundle against the pin before reading a byte of
//! it, unpacks it into a fresh directory (refusing any entry that would land
//! outside, follow a link, or be a device), and moves that into place in one
//! step. The root is then only read: a Prompt mounts it read-only.
//!
//!   <data>/system/<sha256>/root       the tree
//!   <data>/system/<sha256>/manifest   the release's own record
//!   <data>/system/current             which one Prompts use
//!
//! One known-good previous root is kept, so a bad update can be undone;
//! older ones are what 空ける gives back.
//!
//! Other distributions' roots (Ubuntu, Debian) are held the same way: their
//! makers' own root archive, taken only at the digest pinned here, unpacked
//! by the same rules. A Prompt runs whichever root is current.

use std::fs;
use std::io::{self, Read};
#[cfg(unix)]
use std::os::unix::fs::symlink;

/// Built for the web there is no root to fetch or install (a Prompt there runs the web's own), but the
/// roots held are read, counted and let go by this same code.
#[cfg(not(unix))]
fn symlink(_: impl AsRef<Path>, _: impl AsRef<Path>) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}
use std::path::{Component, Path, PathBuf};

/// A release the device may install, as published.
#[derive(Debug)]
pub struct Release {
    pub name: &'static str,
    pub version: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
    pub file: &'static str,
    /// The GitHub release it was published under (its tag).
    pub tag: &'static str,
    /// The same root as a browser reads it: the sha256 of l3's index for the
    /// web (os/scripts/l3.mjs), made from this bundle in the same release.
    /// Empty for a release made before there was one. The app never reads it;
    /// it is here so one entry is the whole of l3's pin, for both.
    pub web: &'static str,
}

/// The releases l3 trusts, newest first. Nothing else is installed.
pub const RELEASES: &[Release] = &[Release {
    name: "OS Length3 Linux",
    version: "0.5.0",
    sha256: "8c646888694e6b7d20173950bf66799debed5a231fac30f539569f5e0cd60dd4",
    bytes: 59_133_286,
    file: "os-length3-linux-0.5.0-x86_64-8c646888694e6b7d20173950bf66799debed5a231fac30f539569f5e0cd60dd4.tar.zst",
    tag: "os-length3-linux-v0.5.0",
    web: "61e5efe33526185b1e337f5d2c0b93ecaac2b778510e2e19bd7623bb93d96288",
}, Release {
    name: "OS Length3 Linux",
    version: "0.4.1",
    sha256: "e5b393a96c826d198f30ced37db740d4e17c1743af4de06eb393fc758de45ed9",
    bytes: 58_883_079,
    file: "os-length3-linux-0.4.1-x86_64-e5b393a96c826d198f30ced37db740d4e17c1743af4de06eb393fc758de45ed9.tar.zst",
    tag: "os-length3-linux-v0.4.1",
    web: "",
}, Release {
    name: "OS Length3 Linux",
    version: "0.4.0",
    sha256: "3746fbcc9ad191825505e37491b478a0032702d8f062cd5f92eb8716f512ab86",
    bytes: 58_877_895,
    file: "os-length3-linux-0.4.0-x86_64-3746fbcc9ad191825505e37491b478a0032702d8f062cd5f92eb8716f512ab86.tar.zst",
    tag: "os-length3-linux-v0.4.0",
    web: "",
}, Release {
    name: "OS Length3 Linux",
    version: "0.3.0",
    sha256: "48b75f1d119670fbf697ac6dd30a2787a9e2fc783af16c75c94f9a6cdf5c7c1f",
    bytes: 65_041_390,
    file: "os-length3-linux-0.3.0-x86_64-48b75f1d119670fbf697ac6dd30a2787a9e2fc783af16c75c94f9a6cdf5c7c1f.tar.zst",
    tag: "os-length3-linux-v0.3.0",
    web: "",
}, Release {
    name: "OS Length3 Linux",
    version: "0.1.0",
    sha256: "56229f242fd8860583cb8b17b5f64f21aced1abad99770b306a0432fc260d7b4",
    bytes: 63_651_568,
    file: "os-length3-linux-0.1.0-x86_64-ffb53450f0f41900f1cda2cd072b9405b43c7b44f97c400794c57019578f32a9.tar.zst",
    tag: "os-length3-linux-v0.1.0",
    web: "",
}];

/// Another distribution's root, as its makers publish it (a .tar.gz of the
/// tree). Its programs are linked as they run, so it runs in the app only.
#[derive(Debug)]
pub struct Distro {
    pub id: &'static str,
    pub name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

/// The other roots l3 trusts: Ubuntu's base and Debian's official image root.
pub const DISTROS: &[Distro] = &[Distro {
    id: "ubuntu",
    name: "Ubuntu",
    version: "24.04.5 LTS",
    url: "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-amd64.tar.gz",
    sha256: "e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86",
    bytes: 30_028_293,
}, Distro {
    id: "debian",
    name: "Debian",
    version: "13",
    url: "https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/dist-amd64/trixie/oci/blobs/rootfs.tar.gz",
    sha256: "4846f29007305297af653c57bf9b60ba8f676a38695c68d98460063442581671",
    bytes: 49_393_200,
}];

pub fn distro(id: &str) -> Option<&'static Distro> {
    DISTROS.iter().find(|d| d.id == id)
}

/// Where the publisher's release channel keeps it. It answers anyone only
/// while the repository is public; it is private, so a device without the
/// publisher's credentials is answered 404 there, and the Remote is where a
/// root comes from.
pub fn github_url(r: &Release) -> String {
    format!("https://github.com/elysia090/os-length3/releases/download/{}/{}", r.tag, r.file)
}

/// The Remote serves roots by digest, to anyone (service/app.ts, /v1/os).
pub fn release_url(remote: &str, r: &Release) -> String {
    by_digest(remote, r.sha256)
}

fn by_digest(remote: &str, sha256: &str) -> String {
    format!("{}/v1/os/{}", remote.trim_end_matches('/'), sha256)
}

/// Where a pinned root is fetched from, in turn: the Remote this device
/// uses; the publisher's Remote (remote::DEFAULT_URL), which each of its
/// deploys fills with every root pinned here (service/mirror.ts), when the
/// device uses another; then the release channel (`github_url`). Each is
/// taken only at the pinned digest.
pub fn sources(remote: &str, r: &Release) -> Vec<String> {
    let mut urls = vec![release_url(remote, r)];
    let ours = release_url(crate::remote::DEFAULT_URL, r);
    if !urls.contains(&ours) { urls.push(ours); }
    urls.push(github_url(r));
    urls
}

/// The first of `urls` that gives the pinned file; when none does, what each said.
#[cfg(not(target_os = "wasi"))]
fn fetch_first(urls: &[String], sha256: &str, bytes: u64, dest: &Path, mut progress: impl FnMut(crate::fetch::Progress)) -> Result<(), String> {
    let mut said = Vec::new();
    for url in urls {
        match crate::fetch::fetch(url, sha256, bytes, dest, &mut progress) {
            Ok(()) => return Ok(()),
            Err(e) => said.push(e),
        }
    }
    Err(crate::tr!("No source has this root yet ({}). The Remote has every root pinned here once its deploy has put it there.",
        "この root はまだどこからも取れません（{}）。ここで固定した root は、デプロイのときに Remote に置かれます。", said.join(" / ")))
}

/// Fetch another distribution's root (the Remote by digest first, then its
/// makers), install it, and make it the one Prompts use.
#[cfg(not(target_os = "wasi"))]
pub fn fetch_distro(data: &Path, remote: &str, d: &Distro, progress: impl FnMut(crate::fetch::Progress)) -> Result<Installed, String> {
    if let Some(had) = use_held(data, d.sha256) { return Ok(had); }
    let bundles = system_dir(data).join(".bundles");
    crate::boundary::private_dir(&system_dir(data)).map_err(|e| e.to_string())?;
    fs::create_dir_all(&bundles).map_err(|e| e.to_string())?;
    let archive = bundles.join(format!("{}.tar.gz", d.sha256));
    // Its bundle and its tree: room made for them first, by itself (usage.rs make_room).
    crate::usage::make_room(data, &crate::paths::repos_dir(), d.bytes.saturating_mul(3));
    let mut progress = progress;
    if let Err(first) = crate::fetch::fetch(&by_digest(remote, d.sha256), d.sha256, d.bytes, &archive, &mut progress) {
        crate::fetch::fetch(d.url, d.sha256, d.bytes, &archive, &mut progress).map_err(|e| format!("{first} / {e}"))?;
    }
    let installed = install_distro(data, d, &archive);
    let _ = fs::remove_file(&archive);
    installed
}

/// Install a distribution's root from its archive and make it current. The archive is checked against
/// its pin through the handle it is then unpacked from (open_pinned).
pub fn install_distro(data: &Path, d: &Distro, archive: &Path) -> Result<Installed, String> {
    let file = open_pinned(archive, |sha, n| (sha == d.sha256 && n == d.bytes).then_some(()).ok_or_else(|| not_pinned(sha, n)))?.0;
    unpack_distro(data, d, file)
}

fn unpack_distro(data: &Path, d: &Distro, archive: fs::File) -> Result<Installed, String> {
    put_in_place(data, d.sha256, d.name, d.version, Some(d.id), |aside| {
        let tree = aside.join("root");
        fs::create_dir(&tree)?;
        let counted = unpack(flate2::read::MultiGzDecoder::new(io::BufReader::new(archive)), &tree)?;
        ready_for_a_prompt(&tree)?;
        Ok(counted)
    })
}

/// What a distribution's root needs to work in a Prompt: there is one user
/// in a Prompt's namespace, so apt does not drop to another for downloads,
/// and dpkg need not wait on syncs the overlay makes cheap anyway.
fn ready_for_a_prompt(tree: &Path) -> io::Result<()> {
    let apt = tree.join("etc/apt/apt.conf.d");
    if apt.is_dir() {
        fs::write(apt.join("00length3"), "// A Prompt has one user: apt fetches as it, not as _apt,\n// and its log is not handed to a group (adm) the Prompt does not have.\nAPT::Sandbox::User \"root\";\nDir::Log::Terminal \"\";\n")?;
    }
    let dpkg = tree.join("etc/dpkg/dpkg.cfg.d");
    if dpkg.is_dir() {
        fs::write(dpkg.join("length3"), "force-unsafe-io\n")?;
    }
    Ok(())
}

/// Make a root held here the one Prompts use; None if it is not held.
pub fn use_held(data: &Path, sha256: &str) -> Option<Installed> {
    let dir = system_dir(data).join(sha256);
    let about: Installed = serde_json::from_str(&fs::read_to_string(dir.join("installed.json")).ok()?).ok()?;
    point_current(data, sha256).ok()?;
    Some(about)
}

fn point_current(data: &Path, sha256: &str) -> Result<(), String> {
    // Under the lock 空ける looks again under (usage::lock), and only at a root still whole: one freed since
    // it was found here is not made current, and the one made current is not freed after.
    let _still = crate::usage::lock(data).map_err(|e| e.to_string())?;
    if !system_dir(data).join(sha256).join("installed.json").is_file() {
        return Err(crate::tr!("That root was freed meanwhile; fetch it again", "その root はそのあいだに空けられました。もう一度取ってください"));
    }
    // A new link renamed over the old one: never a moment without one.
    let link = system_dir(data).join(format!(".current.length3-{}-0", crate::pid()));
    let _ = fs::remove_file(&link);
    symlink(sha256, &link).map_err(|e| e.to_string())?;
    fs::rename(&link, current_link(data)).map_err(|e| e.to_string())
}

/// Fetch the newest pinned release from the Remote and install it; the
/// bundle is let go once its root is in place.
#[cfg(not(target_os = "wasi"))]
pub fn fetch_and_install(data: &Path, remote: &str, progress: impl FnMut(crate::fetch::Progress)) -> Result<Installed, String> {
    let r = &RELEASES[0];
    let bundles = system_dir(data).join(".bundles");
    crate::boundary::private_dir(&system_dir(data)).map_err(|e| e.to_string())?;
    fs::create_dir_all(&bundles).map_err(|e| e.to_string())?;
    let bundle = bundles.join(format!("{}.tar.zst", r.sha256));
    crate::usage::make_room(data, &crate::paths::repos_dir(), r.bytes.saturating_mul(3));
    // The Remote first, then the publisher's, then the release channel
    // (`sources`). Whichever gives it, the bytes are only kept if they are
    // the pinned digest.
    fetch_first(&sources(remote, r), r.sha256, r.bytes, &bundle, progress)?;
    let installed = install(data, &bundle)?;
    let _ = fs::remove_file(&bundle);
    Ok(installed)
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct Installed {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub files: u64,
    pub bytes: u64,
    /// What the host set aside for it (st_blocks), counted once when it was
    /// put in place: a root does not change, so it is never walked again to
    /// say its size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allocated: Option<u64>,
    /// Another distribution's root (its id: ubuntu, debian); none for l3's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
}

pub fn system_dir(data: &Path) -> PathBuf {
    data.join("system")
}

/// The sha256 of all `r` reads (in hex), and how many bytes that was.
pub(crate) fn sha256_read(r: &mut impl io::Read) -> io::Result<(String, u64)> {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut n = 0u64;
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(k) => { h.update(&buf[..k]); n += k as u64; }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok((h.finalize().iter().map(|b| format!("{b:02x}")).collect(), n))
}

/// The release a bundle is, by its digest; anything not pinned is refused.
pub fn identify(bundle: &Path) -> Result<&'static Release, String> {
    open_pinned(bundle, release_of).map(|(_, r)| r)
}

fn release_of(sha: &str, n: u64) -> Result<&'static Release, String> {
    RELEASES.iter().find(|r| r.sha256 == sha && r.bytes == n).ok_or_else(|| not_pinned(sha, n))
}

fn not_pinned(sha: &str, n: u64) -> String {
    crate::tr!("Not a known release (sha256 {}…, {} bytes)", "知らないリリースです（sha256 {}…, {} bytes）", &sha[..12], n)
}

/// Open `path` and check it against a pin by its sha256 and size (`pinned` says what it is, or why not),
/// read through the handle that is returned, wound back to its start, for the caller to unpack. What was
/// checked is then what is read: a check by name and a second open could read two different files (one
/// put in its place between them, or a disk that answers twice differently).
fn open_pinned<T>(path: &Path, pinned: impl FnOnce(&str, u64) -> Result<T, String>) -> Result<(fs::File, T), String> {
    let mut f = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let (sha, n) = sha256_read(&mut f).map_err(|e| format!("{}: {e}", path.display()))?;
    let what = pinned(&sha, n)?;
    io::Seek::rewind(&mut f).map_err(|e| e.to_string())?;
    Ok((f, what))
}

type Decoder<R> = ruzstd::decoding::StreamingDecoder<io::BufReader<R>, ruzstd::decoding::FrameDecoder>;

/// Every frame of a zstd stream, one after another.
struct Frames<R: Read> {
    inner: Option<Decoder<R>>,
}

fn bad(e: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

impl<R: Read> Frames<R> {
    fn new(source: R) -> io::Result<Frames<R>> {
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

fn octal(field: &[u8]) -> io::Result<u64> {
    let t = field.iter().take_while(|&&b| b != 0 && b != b' ').copied().collect::<Vec<u8>>();
    let t = std::str::from_utf8(&t).map_err(bad)?.trim_start();
    if t.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(t, 8).map_err(|_| bad("tar: a number is not octal"))
}

fn text(field: &[u8]) -> String {
    String::from_utf8_lossy(field.split(|&b| b == 0).next().unwrap_or(&[])).into_owned()
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

/// Give `path` its mode, where the host keeps modes (unix); elsewhere it has the host's own.
#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}
#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) -> io::Result<()> { Ok(()) }

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

fn current_link(data: &Path) -> PathBuf {
    system_dir(data).join("current")
}

/// The root Prompts use, if one is installed.
pub fn current(data: &Path) -> Option<(PathBuf, Installed)> {
    let dir = system_dir(data).join(fs::read_link(current_link(data)).ok()?);
    let about: Installed = serde_json::from_str(&fs::read_to_string(dir.join("installed.json")).ok()?).ok()?;
    Some((dir.join("root"), about))
}

/// One entry of a directory of the current root, as File's tree of "/" shows it in the app (a browser reads the
/// same tree from l3's index instead).
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Entry {
    pub name: String,
    /// "dir", "file" or "link".
    pub kind: &'static str,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// What `path` (absolute, as the Prompt sees it) holds in the current root, by name. Only the root's own
/// directories are read: a path with `..`, or through a link (which inside the root may name anything on the
/// host), is refused rather than followed.
pub fn list(data: &Path, path: &str) -> Result<Vec<Entry>, String> {
    let (root, _) = current(data).ok_or_else(|| crate::tr!("There is no root", "root がありません"))?;
    let rel = Path::new(path).strip_prefix("/").map_err(|_| crate::tr!("Not a path from /: {}", "/ からのパスではありません：{}", path))?;
    let mut dir = root;
    for c in rel.components() {
        let Component::Normal(name) = c else { return Err(crate::tr!("Not a path from /: {}", "/ からのパスではありません：{}", path)) };
        dir.push(name);
        if !fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
            return Err(crate::tr!("Not a directory of the root: {}", "root のディレクトリではありません：{}", path));
        }
    }
    let base = path.trim_end_matches('/');
    let mut out: Vec<Entry> = fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().filter_map(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        let meta = e.path().symlink_metadata().ok()?;
        let path = format!("{base}/{name}");
        Some(if meta.file_type().is_symlink() {
            Entry { name, kind: "link", path, size: None, target: fs::read_link(e.path()).ok().map(|t| t.to_string_lossy().into_owned()) }
        } else if meta.is_dir() {
            Entry { name, kind: "dir", path, size: None, target: None }
        } else {
            Entry { name, kind: "file", path, size: Some(meta.len()), target: None }
        })
    }).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Every root held here, the current one first.
pub fn held(data: &Path) -> Vec<(Installed, bool)> {
    let now = current(data).map(|(_, a)| a.sha256);
    // Each root once: by its own directory, not through `current` or one being made.
    let mut out: Vec<(Installed, bool)> = fs::read_dir(system_dir(data)).into_iter().flatten().flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| fs::read_to_string(e.path().join("installed.json")).ok())
        .filter_map(|t| serde_json::from_str::<Installed>(&t).ok())
        .map(|a| { let c = now.as_deref() == Some(&a.sha256); (a, c) })
        .collect();
    out.sort_by_key(|(_, c)| !c);
    out
}

/// Install a release bundle: checked, unpacked aside, then made current in
/// one rename. The root before stays, as the one to go back to.
pub fn install(data: &Path, bundle: &Path) -> Result<Installed, String> {
    let (file, release) = open_pinned(bundle, release_of)?;
    put_in_place(data, release.sha256, release.name, release.version, None, |aside| Frames::new(file).and_then(|z| unpack(z, aside)))
}

/// Unpack a root (by `fill`, into a directory aside), check it, then move it
/// into place in one rename and make it current. Held already: only made current.
fn put_in_place(data: &Path, sha256: &str, name: &str, version: &str, distro: Option<&str>, fill: impl FnOnce(&Path) -> io::Result<(u64, u64)>) -> Result<Installed, String> {
    let system = system_dir(data);
    crate::boundary::private_dir(&system).map_err(|e| e.to_string())?;
    let dir = system.join(sha256);
    if !dir.join("installed.json").exists() {
        let aside = system.join(format!(".{sha256}.length3-{}-0", crate::pid()));
        let _ = fs::remove_dir_all(&aside);
        fs::create_dir(&aside).map_err(|e| e.to_string())?;
        let (files, bytes) = match fill(&aside) {
            Ok(v) => v,
            Err(e) => { let _ = fs::remove_dir_all(&aside); return Err(crate::tr!("Could not unpack: {}", "展開できませんでした：{}", e)); }
        };
        if !aside.join("root/bin/sh").exists() && fs::symlink_metadata(aside.join("root/bin/sh")).is_err() {
            let _ = fs::remove_dir_all(&aside);
            return Err(crate::tr!("This release has no root/bin/sh", "このリリースには root/bin/sh がありません"));
        }
        let about = Installed { name: name.into(), version: version.into(), sha256: sha256.into(), files, bytes,
            allocated: Some(crate::usage::allocated(&aside)), distro: distro.map(String::from) };
        fs::write(aside.join("installed.json"), serde_json::to_string(&about).unwrap()).map_err(|e| e.to_string())?;
        // installed.json says the root is whole, and nothing checks it again: the tree is on the disk before
        // it is renamed into place, or a crash soon after could leave a root that says so with empty files.
        flush(&aside).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(&dir);
        fs::rename(&aside, &dir).map_err(|e| e.to_string())?;
    }
    point_current(data, sha256)?;
    serde_json::from_str(&fs::read_to_string(dir.join("installed.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Put what was written on the filesystem holding `dir` on the disk.
fn flush(dir: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let d = fs::File::open(dir)?;
        // SAFETY: syncfs on a descriptor this function owns.
        if unsafe { libc::syncfs(d.as_raw_fd()) } != 0 { return Err(io::Error::last_os_error()); }
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let _ = dir;
        unsafe { libc::sync() };
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, kind: u8, size: usize, link: &str) -> Vec<u8> {
        let mut h = vec![0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..107].copy_from_slice(b"0000644");
        h[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
        h[156] = kind;
        h[157..157 + link.len()].copy_from_slice(link.as_bytes());
        h[257..262].copy_from_slice(b"ustar");
        h[148..156].copy_from_slice(b"        ");
        let sum: u64 = h.iter().map(|&b| b as u64).sum();
        h[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        h
    }

    fn tar(members: &[(&str, u8, &[u8], &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, kind, body, link) in members {
            out.extend(header(name, *kind, body.len(), link));
            out.extend(*body);
            out.resize(out.len().div_ceil(512) * 512, 0);
        }
        out.extend([0u8; 1024]);
        out
    }

    fn fresh(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("length3-root-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    #[cfg(unix)]
    fn the_current_roots_directories_are_listed_and_nothing_through_a_link_or_up() {
        let data = fresh("list");
        let sys = system_dir(&data);
        let root = sys.join("abc").join("root");
        fs::create_dir_all(root.join("usr/bin")).unwrap();
        fs::write(root.join("usr/bin/busybox"), b"#!elf").unwrap();
        symlink("busybox", root.join("usr/bin/sh")).unwrap();
        symlink("usr/bin", root.join("bin")).unwrap();
        fs::write(sys.join("abc/installed.json"), r#"{"name":"l3","version":"1","sha256":"abc","files":1,"bytes":5}"#).unwrap();
        assert!(list(&data, "/").is_err(), "no root current yet");
        symlink("abc", sys.join("current")).unwrap();
        let top = list(&data, "/").unwrap();
        assert_eq!(top.iter().map(|e| (e.name.as_str(), e.kind)).collect::<Vec<_>>(), [("bin", "link"), ("usr", "dir")]);
        assert_eq!(top[0].target.as_deref(), Some("usr/bin"));
        let bin = list(&data, "/usr/bin").unwrap();
        assert_eq!(bin[0], Entry { name: "busybox".into(), kind: "file", path: "/usr/bin/busybox".into(), size: Some(5), target: None });
        assert_eq!(bin[1].kind, "link");
        for no in ["/bin", "/usr/../..", "usr", "/usr/bin/busybox", "/nothing"] { assert!(list(&data, no).is_err(), "{no}"); }
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_root_unpacks_with_its_links() {
        let d = fresh("ok");
        let t = tar(&[("root/", b'5', b"", ""), ("root/bin/", b'5', b"", ""), ("root/bin/busybox", b'0', b"#!elf", ""),
            ("root/bin/sh", b'2', b"", "busybox"), ("root/bin/ash", b'1', b"", "root/bin/busybox")]);
        assert_eq!(unpack(&t[..], &d).unwrap(), (2, 5));
        assert_eq!(fs::read_link(d.join("root/bin/sh")).unwrap(), PathBuf::from("busybox"));
        assert_eq!(fs::read(d.join("root/bin/ash")).unwrap(), b"#!elf");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn nothing_lands_outside_or_through_a_link() {
        for (members, what) in [
            (vec![("../x", b'0', &b"x"[..], "")], "leaves"),
            (vec![("/etc/x", b'0', &b"x"[..], "")], "leaves"),
            (vec![("root/", b'5', &b""[..], ""), ("root/l", b'2', &b""[..], "/etc"), ("root/l/passwd", b'0', &b"x"[..], "")], "through a link"),
            (vec![("root/dev", b'3', &b""[..], "")], "not part of a root"),
            (vec![("root/a", b'0', &b"x"[..], ""), ("root/a", b'0', &b"y"[..], "")], "exists"),
            (vec![("root/", b'5', &b""[..], ""), ("root/l", b'2', &b""[..], "/etc"), ("root/h", b'1', &b""[..], "root/l/passwd")], "through a link"),
        ] {
            let d = fresh("bad");
            let e = unpack(&tar(&members)[..], &d).unwrap_err().to_string();
            assert!(e.contains(what), "{e}");
            assert!(!Path::new("/etc/x").exists());
            let _ = fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn a_distribution_root_goes_in_from_its_tar_gz_and_back_out_by_its_digest() {
        use std::io::Write;
        let d = fresh("distro");
        let t = tar(&[("etc/", b'5', b"", ""), ("etc/apt/", b'5', b"", ""), ("etc/apt/apt.conf.d/", b'5', b"", ""),
            ("./", b'5', b"", ""), ("usr/", b'5', b"", ""), ("usr/bin/", b'5', b"", ""), ("usr/bin/dash", b'0', b"#!elf", ""), ("bin", b'2', b"", "usr/bin"), ("usr/bin/sh", b'2', b"", "dash")]);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&t).unwrap();
        fs::write(d.join("a.tar.gz"), gz.finish().unwrap()).unwrap();
        let ubuntu = distro("ubuntu").unwrap();
        let data = d.join("data");
        // Not Ubuntu's own archive: taken by its pin, it is refused.
        assert!(install_distro(&data, ubuntu, &d.join("a.tar.gz")).unwrap_err().contains("Not a known release"));
        let r = unpack_distro(&data, ubuntu, fs::File::open(d.join("a.tar.gz")).unwrap()).unwrap();
        assert_eq!((r.distro.as_deref(), r.files), (Some("ubuntu"), 1));
        let (tree, about) = current(&data).unwrap();
        assert_eq!(about.sha256, ubuntu.sha256);
        // Ready for a Prompt's one user, and reached through its own /bin link.
        assert!(fs::read_to_string(tree.join("etc/apt/apt.conf.d/00length3")).unwrap().contains("APT::Sandbox::User \"root\""));
        assert!(tree.join("bin/sh").exists());
        // Another made current, then this one again without fetching: it is held.
        fs::remove_file(system_dir(&data).join("current")).unwrap();
        assert!(current(&data).is_none());
        assert_eq!(use_held(&data, ubuntu.sha256).unwrap().version, ubuntu.version);
        assert!(use_held(&data, &"0".repeat(64)).is_none());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_cut_pax_record_is_refused_not_a_crash() {
        let d = fresh("pax");
        let mut t = header("pax", b'x', 3, "");
        t.extend(b"2 x");
        t.resize(1024, 0);
        t.extend([0u8; 1024]);
        assert!(unpack(&t[..], &d).unwrap_err().to_string().contains("pax"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn only_a_pinned_release_is_taken() {
        let d = fresh("pin");
        fs::write(d.join("b.tar.zst"), b"not the release").unwrap();
        let e = identify(&d.join("b.tar.zst")).unwrap_err();
        assert!(e.contains("Not a known release") || e.contains("知らないリリース"), "{e}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_root_comes_from_the_remote_then_the_publishers_then_the_release_channel() {
        let r = &RELEASES[0];
        let ours = format!("{}/v1/os/{}", crate::remote::DEFAULT_URL, r.sha256);
        assert_eq!(sources("http://127.0.0.1:8787/", r), [format!("http://127.0.0.1:8787/v1/os/{}", r.sha256), ours.clone(), github_url(r)]);
        // A device on the publisher's Remote asks it once.
        assert_eq!(sources(crate::remote::DEFAULT_URL, r), [ours, github_url(r)]);
    }
}
