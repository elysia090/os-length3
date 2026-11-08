//! The roots this root3 knows by their pins: each release and distribution, by its sha256 and size, and where it is
//! fetched from (the Remote by digest first, then its makers).

/// Where a pinned root is fetched from, in turn: the Remote this device
/// uses; the publisher's Remote (remote::DEFAULT_URL), which each of its
/// deploys fills with every root pinned here (src/remote/bytes/mirror.ts), when the
/// device uses another; then the release channel (`github_url`). Each is
/// taken only at the pinned digest.
pub fn sources(remote: &str, r: &Release) -> Vec<String> {
    let mut urls = vec![release_url(remote, r)];
    let ours = release_url(crate::remote::DEFAULT_URL, r);
    if !urls.contains(&ours) { urls.push(ours); }
    urls.push(github_url(r));
    urls
}

pub(super) fn by_digest(remote: &str, sha256: &str) -> String {
    format!("{}/v1/os/{}", remote.trim_end_matches('/'), sha256)
}

/// The Remote serves roots by digest, to anyone (src/remote/serve/app.ts, /v1/os).
pub fn release_url(remote: &str, r: &Release) -> String {
    by_digest(remote, r.sha256)
}

/// Where the publisher's release channel keeps it, for anyone: the repository
/// is public.
pub fn github_url(r: &Release) -> String {
    format!("https://github.com/elysia090/os-length3/releases/download/{}/{}", r.tag, r.file)
}

pub fn distro(id: &str) -> Option<&'static Distro> {
    DISTROS.iter().find(|d| d.id == id)
}

/// The other roots root3 trusts: Ubuntu's base and Debian's official image root, each at a URL that names that one
/// build (Debian's at the commit of its makers' branch that holds it: the branch itself moves with each build). The
/// deploy puts each on the Remote by its digest (src/remote/bytes/mirror.ts), where a device asks first.
pub const DISTROS: &[Distro] = &[Distro {
    id: "ubuntu",
    name: "Ubuntu",
    version: "26.04.1 LTS",
    url: "https://cdimage.ubuntu.com/ubuntu-base/releases/26.04/release/ubuntu-base-26.04.1-base-amd64.tar.gz",
    sha256: "a496a960472ce474a59590b8987d3a1135d3cbef1991f3b1abe8cacfea8bf85a",
    bytes: 34_931_253,
}, Distro {
    id: "debian",
    name: "Debian",
    version: "13.7",
    url: "https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/69faaf492e77aff83e4c7fc401017c9d25ecde24/trixie/oci/blobs/rootfs.tar.gz",
    sha256: "a1d156b0aab5fb07d822a7f4681f6d3ed1689073531c34f5668818c233633f11",
    bytes: 49_407_895,
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

/// The releases root3 trusts, newest first. Nothing else is installed.
pub const RELEASES: &[Release] = &[Release {
    name: "OS Length3 Linux",
    version: "0.6.4",
    sha256: "aa5b0dc6a71f924da5b83e5f11ca93262d8bcd6bb19350a4b2acd746e14132e7",
    bytes: 114_940_014,
    file: "os-length3-linux-0.6.4-x86_64-aa5b0dc6a71f924da5b83e5f11ca93262d8bcd6bb19350a4b2acd746e14132e7.tar.zst",
    tag: "os-length3-linux-v0.6.4",
    web: "dc174e9900a75a75eed65699adafb1b3e98c2047a136f1073daa21723e453c5d",
}];

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
    /// The same root as a browser reads it: the sha256 of root3's index for the
    /// web (scripts/webroot.ts), made from this bundle in the same release.
    /// Empty for a release made before there was one. The app never reads it;
    /// it is here so one entry is the whole of root3's pin, for both.
    pub web: &'static str,
}

