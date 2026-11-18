//! Metadata-only, atomic preparation of a root-owned sealed/lazy namespace.
//!
//! Wire v1 uses little-endian integers and has no alignment/padding. Its 72-byte
//! header is `SODSROOT`, version:u32=1, reserved:u32=0, generation:[u8;32], then
//! pack/dir/link/file/AOT counts:u32 and reserved:u32=0. In that order:
//! - pack: digest:[u8;32], stored:u64;
//! - dir: path_len:u32, mode:u32, path;
//! - link: path_len:u32, target_len:u32, path, target;
//! - file: path_len:u32, mode:u32, size:u64, pack:u32, raw:u32,
//!   at:u64, stored:u64, path;
//! - AOT: path_len:u32, shared:u32, source/artifact/translator digests:[u8;32], path.
//!
//! Paths are canonical absolute byte paths, excluding the implicit root `/`;
//! modes are permission bits only. Root is 0755, symlinks 0777, all uid/gid 0.
//! Parents must be inventory directories, never followed symlinks. Whole AOT
//! mode is fixed. Digests/locators are captured facts, NOT Rust cryptographic
//! verification, decompression, module validation or executable authorization.
//! Lazy files fix their declared decoded size: a matching wrong-length success
//! settles as a failed source attempt without adopting bytes or metadata drift.
//!
//! The entire input is bounded to 16 MiB. All fallible construction stays private
//! until success; errors drop it without callbacks, payload loads or publication.
//! Count limits and max single-file bytes are logical limits, not heap ceilings.
//! Temporary maps borrow wire paths; only Tree retains component names/targets.
//! Directory sorting and hashing add implementation work, not a universal lower
//! bound. Hash lookup is expected, not worst-case constant time; the same Wasm
//! RandomState caveat as inode::Tree applies. The caller must issue a unique owner
//! incarnation and must not recreate it while any old identity is retained.
use crate::inode::{self, Creation, Inode, Tree};
use std::collections::{HashMap, HashSet};

const MAX_WIRE: usize = 16 * 1024 * 1024;
const HEADER: usize = 72;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Limits {
    pub(crate) inodes: usize,
    pub(crate) entries: usize,
    pub(crate) file_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Error {
    TooLarge,
    Truncated,
    Magic,
    Version,
    Reserved,
    Trailing,
    Capacity,
    InvalidPath,
    InvalidMode,
    InvalidTarget,
    DuplicatePath,
    MissingParent,
    ParentNotDirectory,
    DuplicatePack,
    InvalidRegion,
    RegionConflict,
    InvalidAot,
    AotConflict,
    Tree(inode::Error),
}
impl From<inode::Error> for Error {
    fn from(error: inode::Error) -> Self {
        Self::Tree(error)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Pack {
    pub(crate) digest: [u8; 32],
    pub(crate) stored: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Source {
    pub(crate) pack: u32,
    pub(crate) at: u64,
    pub(crate) stored: u64,
    pub(crate) size: u64,
    pub(crate) raw: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Artifact {
    pub(crate) inode: Inode,
    pub(crate) source: u32,
    pub(crate) source_digest: [u8; 32],
    pub(crate) artifact_digest: [u8; 32],
    pub(crate) translator_digest: [u8; 32],
    pub(crate) shared: bool,
}

/// IDs are root-local, stable, nonzero, and never recycled. Pack ordinals alone
/// are zero-based. A SourceId identifies one nonempty stored region, assigned in
/// first wire-file occurrence order. An ArtifactId identifies one inode's exact
/// association, assigned in first AOT occurrence order; identical aliases reuse
/// it. No catalog method resolves guest paths or grants access.
pub(crate) struct RootCatalog {
    owner: u64,
    generation: [u8; 32],
    packs: Vec<Pack>,
    sources: Vec<Source>,
    artifacts: Vec<Artifact>,
    by_inode: HashMap<u64, u32>,
}
impl RootCatalog {
    pub(crate) fn generation(&self) -> &[u8; 32] {
        &self.generation
    }
    pub(crate) fn pack_count(&self) -> usize {
        self.packs.len()
    }
    pub(crate) fn pack(&self, ordinal: u32) -> Option<&Pack> {
        self.packs.get(ordinal as usize)
    }
    pub(crate) fn source_count(&self) -> usize {
        self.sources.len()
    }
    pub(crate) fn source(&self, id: u32) -> Option<&Source> {
        self.sources.get(id.checked_sub(1)? as usize)
    }
    pub(crate) fn artifact_count(&self) -> usize {
        self.artifacts.len()
    }
    pub(crate) fn artifact(&self, id: u32) -> Option<&Artifact> {
        self.artifacts.get(id.checked_sub(1)? as usize)
    }
    pub(crate) fn artifact_for(&self, inode: Inode) -> Option<(u32, &Artifact)> {
        if inode.owner() != self.owner {
            return None;
        }
        let id = *self.by_inode.get(&inode.number())?;
        let artifact = self.artifact(id)?;
        (artifact.inode == inode).then_some((id, artifact))
    }
}

pub(crate) struct RootImage {
    tree: Tree,
    catalog: RootCatalog,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self.at.checked_add(n).ok_or(Error::Truncated)?;
        let bytes = self.bytes.get(self.at..end).ok_or(Error::Truncated)?;
        self.at = end;
        Ok(bytes)
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        let mut bytes = [0; N];
        bytes.copy_from_slice(self.take(N)?);
        Ok(bytes)
    }
    fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_le_bytes(self.array()?))
    }
    fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_le_bytes(self.array()?))
    }
    fn boolean(&mut self, error: Error) -> Result<bool, Error> {
        match self.u32()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(error),
        }
    }
}

fn reserved_vec<T>(count: usize) -> Result<Vec<T>, Error> {
    let mut result = Vec::new();
    result
        .try_reserve_exact(count)
        .map_err(|_| Error::Capacity)?;
    Ok(result)
}
fn creation(mode: u32) -> Creation {
    Creation {
        mode,
        uid: 0,
        gid: 0,
    }
}
fn check_mode(mode: u32) -> Result<(), Error> {
    if mode & !0o7777 != 0 {
        Err(Error::InvalidMode)
    } else {
        Ok(())
    }
}
fn check_path(path: &[u8]) -> Result<(), Error> {
    if path.len() < 2 || path.len() > 4095 || path[0] != b'/' {
        return Err(Error::InvalidPath);
    }
    for name in path[1..].split(|b| *b == b'/') {
        if name.is_empty() || name.len() > 255 || name == b"." || name == b".." || name.contains(&0)
        {
            return Err(Error::InvalidPath);
        }
    }
    Ok(())
}
fn parent_name(path: &[u8]) -> (&[u8], &[u8]) {
    // Only validated absolute paths reach here; the initial slash always exists.
    let split = path.iter().rposition(|b| *b == b'/').unwrap();
    let parent = if split == 0 {
        &path[..1]
    } else {
        &path[..split]
    };
    (parent, &path[split + 1..])
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Directory,
    Link,
    File,
}
struct Name {
    kind: Kind,
    inode: Option<Inode>,
    source: u32,
}
struct Directory<'a> {
    path: &'a [u8],
    mode: u32,
}
struct Link<'a> {
    path: &'a [u8],
    target: &'a [u8],
}
struct File<'a> {
    path: &'a [u8],
    mode: u32,
    size: u64,
    pack: u32,
    at: u64,
    stored: u64,
    raw: bool,
    source: u32,
}
struct Aot<'a> {
    path: &'a [u8],
    source_digest: [u8; 32],
    artifact_digest: [u8; 32],
    translator_digest: [u8; 32],
    shared: bool,
}
fn add_name<'a>(
    names: &mut HashMap<&'a [u8], Name>,
    path: &'a [u8],
    kind: Kind,
) -> Result<(), Error> {
    check_path(path)?;
    if names
        .insert(
            path,
            Name {
                kind,
                inode: None,
                source: 0,
            },
        )
        .is_some()
    {
        return Err(Error::DuplicatePath);
    }
    Ok(())
}
fn parent_inode(names: &HashMap<&[u8], Name>, root: Inode, path: &[u8]) -> Inode {
    let (parent, _) = parent_name(path);
    if parent == b"/" {
        root
    } else {
        names.get(parent).unwrap().inode.unwrap()
    }
}

impl RootImage {
    pub(crate) fn build(owner: u64, input: &[u8], limits: Limits) -> Result<Self, Error> {
        if input.len() > MAX_WIRE {
            return Err(Error::TooLarge);
        }
        if input.len() < HEADER {
            return Err(Error::Truncated);
        }
        let mut reader = Reader {
            bytes: input,
            at: 0,
        };
        if reader.take(8)? != b"SODSROOT" {
            return Err(Error::Magic);
        }
        if reader.u32()? != 1 {
            return Err(Error::Version);
        }
        if reader.u32()? != 0 {
            return Err(Error::Reserved);
        }
        let generation = reader.array()?;
        let packs_len = reader.u32()? as usize;
        let dirs_len = reader.u32()? as usize;
        let links_len = reader.u32()? as usize;
        let files_len = reader.u32()? as usize;
        let aot_len = reader.u32()? as usize;
        if reader.u32()? != 0 {
            return Err(Error::Reserved);
        }
        // Reject impossible counts before any count-sized reservation. The fixed
        // portions alone must fit the bounded wire; variable names add bytes.
        let mut minimum = HEADER;
        for (count, fixed) in [
            (packs_len, 40),
            (dirs_len, 8),
            (links_len, 8),
            (files_len, 40),
            (aot_len, 104),
        ] {
            minimum = minimum
                .checked_add(count.checked_mul(fixed).ok_or(Error::Truncated)?)
                .ok_or(Error::Truncated)?;
        }
        if minimum > input.len() {
            return Err(Error::Truncated);
        }
        let entries = dirs_len
            .checked_add(links_len)
            .and_then(|n| n.checked_add(files_len))
            .ok_or(Error::Capacity)?;
        if entries > limits.entries
            || dirs_len
                .checked_add(links_len)
                .and_then(|n| n.checked_add(1))
                .is_none_or(|n| n > limits.inodes)
        {
            return Err(Error::Capacity);
        }
        let mut packs = reserved_vec(packs_len)?;
        let mut digests = HashSet::new();
        digests
            .try_reserve(packs_len)
            .map_err(|_| Error::Capacity)?;
        for _ in 0..packs_len {
            let digest = reader.array()?;
            let stored = reader.u64()?;
            if !digests.insert(digest) {
                return Err(Error::DuplicatePack);
            }
            packs.push(Pack { digest, stored });
        }
        let mut names = HashMap::new();
        names.try_reserve(entries).map_err(|_| Error::Capacity)?;
        let mut dirs = reserved_vec(dirs_len)?;
        for _ in 0..dirs_len {
            let length = reader.u32()? as usize;
            let mode = reader.u32()?;
            check_mode(mode)?;
            let path = reader.take(length)?;
            add_name(&mut names, path, Kind::Directory)?;
            dirs.push(Directory { path, mode });
        }
        let mut links = reserved_vec(links_len)?;
        for _ in 0..links_len {
            let length = reader.u32()? as usize;
            let target_length = reader.u32()? as usize;
            let path = reader.take(length)?;
            let target = reader.take(target_length)?;
            if target.is_empty() || target.len() > 4095 || target.contains(&0) {
                return Err(Error::InvalidTarget);
            }
            add_name(&mut names, path, Kind::Link)?;
            links.push(Link { path, target });
        }
        let mut files = reserved_vec(files_len)?;
        for _ in 0..files_len {
            let length = reader.u32()? as usize;
            let mode = reader.u32()?;
            check_mode(mode)?;
            let size = reader.u64()?;
            let pack = reader.u32()?;
            let raw = reader.boolean(Error::InvalidRegion)?;
            let at = reader.u64()?;
            let stored = reader.u64()?;
            let path = reader.take(length)?;
            add_name(&mut names, path, Kind::File)?;
            if usize::try_from(size)
                .ok()
                .is_none_or(|n| n > limits.file_bytes)
            {
                return Err(Error::Capacity);
            }
            let packed: &Pack = packs.get(pack as usize).ok_or(Error::InvalidRegion)?;
            if at.checked_add(stored).is_none_or(|end| end > packed.stored)
                || (stored == 0 && (at != 0 || size != 0))
                || (raw && size != stored)
            {
                return Err(Error::InvalidRegion);
            }
            files.push(File {
                path,
                mode,
                size,
                pack,
                at,
                stored,
                raw,
                source: 0,
            });
        }
        let mut aots = reserved_vec(aot_len)?;
        for _ in 0..aot_len {
            let length = reader.u32()? as usize;
            let shared = reader.boolean(Error::InvalidAot)?;
            let source_digest = reader.array()?;
            let artifact_digest = reader.array()?;
            let translator_digest = reader.array()?;
            let path = reader.take(length)?;
            check_path(path)?;
            aots.push(Aot {
                path,
                source_digest,
                artifact_digest,
                translator_digest,
                shared,
            });
        }
        if reader.at != input.len() {
            return Err(Error::Trailing);
        }
        for path in names.keys() {
            let (parent, _) = parent_name(path);
            if parent != b"/" {
                match names.get(parent) {
                    None => return Err(Error::MissingParent),
                    Some(name) if name.kind != Kind::Directory => {
                        return Err(Error::ParentNotDirectory)
                    }
                    Some(_) => (),
                }
            }
        }

        let mut sources: Vec<Source> = reserved_vec(files_len)?;
        let mut regions = HashMap::new();
        regions
            .try_reserve(files_len)
            .map_err(|_| Error::Capacity)?;
        let mut empty = 0usize;
        for file in &mut files {
            if file.stored == 0 {
                empty += 1;
                continue;
            }
            let key = (file.pack, file.at, file.stored);
            let source = match regions.get(&key) {
                Some(&(id, mode)) => {
                    let existing = &sources[id as usize - 1];
                    if mode != file.mode || existing.size != file.size || existing.raw != file.raw {
                        return Err(Error::RegionConflict);
                    }
                    id
                }
                None => {
                    let id = u32::try_from(sources.len() + 1).map_err(|_| Error::Capacity)?;
                    if id > i32::MAX as u32 {
                        return Err(Error::Capacity);
                    }
                    sources.push(Source {
                        pack: file.pack,
                        at: file.at,
                        stored: file.stored,
                        size: file.size,
                        raw: file.raw,
                    });
                    regions.insert(key, (id, file.mode));
                    id
                }
            };
            file.source = source;
        }
        let inodes = 1usize
            .checked_add(dirs_len)
            .and_then(|n| n.checked_add(links_len))
            .and_then(|n| n.checked_add(empty))
            .and_then(|n| n.checked_add(sources.len()))
            .ok_or(Error::Capacity)?;
        if inodes > limits.inodes {
            return Err(Error::Capacity);
        }
        // Tree capacity is the exact validated need, not the caller's possibly
        // huge upper bound. All still-private mutations are discarded on error.
        let mut tree = Tree::new(owner, inodes, entries, limits.file_bytes, creation(0o755))?;
        let root = tree.root();
        dirs.sort_unstable_by(|a, b| a.path.cmp(b.path));
        for dir in dirs {
            let parent = parent_inode(&names, root, dir.path);
            let inode = tree.directory(parent, parent_name(dir.path).1, creation(dir.mode))?;
            names.get_mut(dir.path).unwrap().inode = Some(inode);
        }
        for link in links {
            let parent = parent_inode(&names, root, link.path);
            let inode = tree.symlink(
                parent,
                parent_name(link.path).1,
                link.target,
                creation(0o777),
            )?;
            names.get_mut(link.path).unwrap().inode = Some(inode);
        }
        let mut source_inodes = reserved_vec(sources.len())?;
        source_inodes.resize(sources.len(), None);
        for file in files {
            let parent = parent_inode(&names, root, file.path);
            let component = parent_name(file.path).1;
            let inode = if file.source == 0 {
                tree.file_take(parent, component, creation(file.mode), &mut Vec::new())?
            } else if let Some(inode) = source_inodes[file.source as usize - 1] {
                tree.hardlink(parent, component, inode)?;
                inode
            } else {
                let inode = tree.lazy_file_exact(
                    parent,
                    component,
                    creation(file.mode),
                    file.source,
                    file.size as usize,
                )?;
                source_inodes[file.source as usize - 1] = Some(inode);
                inode
            };
            let name = names.get_mut(file.path).unwrap();
            name.inode = Some(inode);
            name.source = file.source;
        }
        let mut artifacts = reserved_vec(aot_len)?;
        let mut by_inode = HashMap::new();
        by_inode.try_reserve(aot_len).map_err(|_| Error::Capacity)?;
        for aot in aots {
            let file = names.get(aot.path).ok_or(Error::InvalidAot)?;
            if file.kind != Kind::File
                || file.source == 0
                || sources[file.source as usize - 1].size == 0
            {
                return Err(Error::InvalidAot);
            }
            let inode = file.inode.unwrap();
            let artifact = Artifact {
                inode,
                source: file.source,
                source_digest: aot.source_digest,
                artifact_digest: aot.artifact_digest,
                translator_digest: aot.translator_digest,
                shared: aot.shared,
            };
            if let Some(&id) = by_inode.get(&inode.number()) {
                if artifacts[id as usize - 1] != artifact {
                    return Err(Error::AotConflict);
                }
            } else {
                let id = u32::try_from(artifacts.len() + 1).map_err(|_| Error::Capacity)?;
                artifacts.push(artifact);
                by_inode.insert(inode.number(), id);
            }
        }
        Ok(Self {
            tree,
            catalog: RootCatalog {
                owner,
                generation,
                packs,
                sources,
                artifacts,
                by_inode,
            },
        })
    }
    pub(crate) fn into_parts(self) -> (Tree, RootCatalog) {
        (self.tree, self.catalog)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Wire {
        generation: [u8; 32],
        packs: Vec<([u8; 32], u64)>,
        dirs: Vec<(Vec<u8>, u32)>,
        links: Vec<(Vec<u8>, Vec<u8>)>,
        files: Vec<(Vec<u8>, u32, u64, u32, bool, u64, u64)>,
        aots: Vec<(Vec<u8>, bool, [u8; 32], [u8; 32], [u8; 32])>,
    }
    impl Wire {
        fn new() -> Self {
            Self {
                generation: [9; 32],
                packs: vec![([7; 32], 128)],
                dirs: vec![],
                links: vec![],
                files: vec![],
                aots: vec![],
            }
        }
        fn file(&mut self, path: &[u8], at: u64, stored: u64, size: u64) {
            self.files
                .push((path.to_vec(), 0o644, size, 0, false, at, stored));
        }
        fn aot(&mut self, path: &[u8]) {
            self.aots
                .push((path.to_vec(), true, [1; 32], [2; 32], [3; 32]));
        }
        fn bytes(&self) -> Vec<u8> {
            let mut out = b"SODSROOT".to_vec();
            fn u32(out: &mut Vec<u8>, n: u32) {
                out.extend_from_slice(&n.to_le_bytes());
            }
            fn u64(out: &mut Vec<u8>, n: u64) {
                out.extend_from_slice(&n.to_le_bytes());
            }
            u32(&mut out, 1);
            u32(&mut out, 0);
            out.extend_from_slice(&self.generation);
            for n in [
                self.packs.len(),
                self.dirs.len(),
                self.links.len(),
                self.files.len(),
                self.aots.len(),
                0,
            ] {
                u32(&mut out, n as u32);
            }
            assert_eq!(out.len(), HEADER);
            for (digest, stored) in &self.packs {
                out.extend_from_slice(digest);
                u64(&mut out, *stored);
            }
            for (path, mode) in &self.dirs {
                u32(&mut out, path.len() as u32);
                u32(&mut out, *mode);
                out.extend_from_slice(path);
            }
            for (path, target) in &self.links {
                u32(&mut out, path.len() as u32);
                u32(&mut out, target.len() as u32);
                out.extend_from_slice(path);
                out.extend_from_slice(target);
            }
            for (path, mode, size, pack, raw, at, stored) in &self.files {
                u32(&mut out, path.len() as u32);
                u32(&mut out, *mode);
                u64(&mut out, *size);
                u32(&mut out, *pack);
                u32(&mut out, u32::from(*raw));
                u64(&mut out, *at);
                u64(&mut out, *stored);
                out.extend_from_slice(path);
            }
            for (path, shared, source, artifact, translator) in &self.aots {
                u32(&mut out, path.len() as u32);
                u32(&mut out, u32::from(*shared));
                out.extend_from_slice(source);
                out.extend_from_slice(artifact);
                out.extend_from_slice(translator);
                out.extend_from_slice(path);
            }
            out
        }
    }
    fn limits() -> Limits {
        Limits {
            inodes: 64,
            entries: 64,
            file_bytes: 1024,
        }
    }
    fn reject(bytes: &[u8], error: Error) {
        assert_eq!(RootImage::build(5, bytes, limits()).err(), Some(error));
    }
    fn lookup(tree: &Tree, path: &[u8]) -> Inode {
        path[1..]
            .split(|b| *b == b'/')
            .fold(tree.root(), |parent, name| {
                tree.lookup(parent, name).unwrap().unwrap()
            })
    }

    #[test]
    fn header_reserved_trailing_truncation_and_impossible_counts() {
        let bytes = Wire::new().bytes();
        for length in 0..bytes.len() {
            reject(&bytes[..length], Error::Truncated);
        }
        for (at, error) in [
            (0, Error::Magic),
            (8, Error::Version),
            (12, Error::Reserved),
            (68, Error::Reserved),
        ] {
            let mut bad = bytes.clone();
            bad[at] ^= 2;
            reject(&bad, error);
        }
        let mut bad = bytes.clone();
        bad.push(0);
        reject(&bad, Error::Trailing);
        let mut bad = bytes;
        bad[48..52].copy_from_slice(&u32::MAX.to_le_bytes());
        reject(&bad, Error::Truncated);
        reject(&vec![0; MAX_WIRE + 1], Error::TooLarge);
    }

    #[test]
    fn unordered_directories_and_byte_names_are_built_without_payload() {
        let mut wire = Wire::new();
        wire.dirs = vec![(b"/a/b".to_vec(), 0o711), (b"/a".to_vec(), 0o750)];
        wire.links.push((b"/a/link".to_vec(), b"../a/b".to_vec()));
        wire.file(b"/a/b/\xff", 32, 8, 100);
        let mut bytes = wire.bytes();
        let (mut tree, catalog) = RootImage::build(5, &bytes, limits()).unwrap().into_parts();
        bytes.fill(0); // No wire path, target, digest or locator is retained by alias.
        let file = lookup(&tree, b"/a/b/\xff");
        assert_eq!(tree.metadata(lookup(&tree, b"/a")).unwrap().mode, 0o040750);
        assert_eq!(
            tree.metadata(tree.root()).unwrap(),
            inode::Metadata {
                mode: 0o040755,
                uid: 0,
                gid: 0,
                nlink: 3
            }
        );
        assert_eq!(tree.target(lookup(&tree, b"/a/link")).unwrap(), b"../a/b");
        assert_eq!(tree.source(file), Ok(1));
        assert_eq!(tree.size(file), Ok(100));
        assert_eq!(
            tree.read(file, 0, 1),
            Err(inode::Error::Payload(
                sods_file_store::store::Error::LoadConflict
            ))
        );
        let attempt = tree.load_begin(file).unwrap();
        assert_eq!(attempt, 1); // Construction neither dispatched nor left an attempt.
        tree.load_finish(file, attempt, false, &mut Vec::new())
            .unwrap();
        assert_eq!(
            catalog.source(1),
            Some(&Source {
                pack: 0,
                at: 32,
                stored: 8,
                size: 100,
                raw: false
            })
        );
        assert_eq!(catalog.generation(), &[9; 32]);
        assert_eq!(catalog.pack_count(), 1);
        assert_eq!(
            catalog.pack(0),
            Some(&Pack {
                digest: [7; 32],
                stored: 128
            })
        );
        assert_eq!(catalog.pack(1), None);
        assert_eq!(catalog.source(0), None);
        assert_eq!(catalog.source(2), None);
    }

    #[test]
    fn malformed_paths_and_modes_are_not_normalized() {
        for path in [
            &b""[..],
            b"/",
            b"relative",
            b"//a",
            b"/a/",
            b"/a//b",
            b"/a/./b",
            b"/a/../b",
            b"/a\0b",
        ] {
            let mut wire = Wire::new();
            wire.dirs.push((path.to_vec(), 0o755));
            reject(&wire.bytes(), Error::InvalidPath);
        }
        let mut wire = Wire::new();
        let mut path = vec![b'/'];
        path.extend_from_slice(&[b'a'; 256]);
        wire.dirs.push((path, 0o755));
        reject(&wire.bytes(), Error::InvalidPath);
        let mut wire = Wire::new();
        wire.dirs.push((b"/a".to_vec(), 0o040755));
        reject(&wire.bytes(), Error::InvalidMode);
        let mut wire = Wire::new();
        wire.file(b"/a", 1, 1, 1);
        wire.files[0].1 = 0o100644;
        reject(&wire.bytes(), Error::InvalidMode);
    }

    #[test]
    fn canonical_path_and_component_limits_are_inclusive() {
        let mut wire = Wire::new();
        let mut path = Vec::new();
        for _ in 0..15 {
            path.push(b'/');
            path.extend_from_slice(&[b'a'; 255]);
            wire.dirs.push((path.clone(), 0o755));
        }
        path.push(b'/');
        path.extend_from_slice(&[b'b'; 254]);
        assert_eq!(path.len(), 4095);
        wire.dirs.push((path.clone(), 0o755));
        let (tree, _) = RootImage::build(5, &wire.bytes(), limits())
            .unwrap()
            .into_parts();
        assert_eq!(tree.metadata(lookup(&tree, &path)).unwrap().mode, 0o040755);
        wire.dirs.last_mut().unwrap().0.push(b'b');
        assert_eq!(wire.dirs.last().unwrap().0.len(), 4096);
        reject(&wire.bytes(), Error::InvalidPath);
    }

    #[test]
    fn collisions_missing_parents_and_symlink_parents_fail_atomically() {
        let mut wire = Wire::new();
        wire.dirs = vec![(b"/a".to_vec(), 0o755), (b"/a".to_vec(), 0o700)];
        reject(&wire.bytes(), Error::DuplicatePath);
        let mut wire = Wire::new();
        wire.dirs.push((b"/a".to_vec(), 0o755));
        wire.file(b"/a", 1, 1, 1);
        reject(&wire.bytes(), Error::DuplicatePath);
        let mut wire = Wire::new();
        wire.file(b"/missing/a", 1, 1, 1);
        reject(&wire.bytes(), Error::MissingParent);
        let mut wire = Wire::new();
        wire.links.push((b"/a".to_vec(), b"/".to_vec()));
        wire.file(b"/a/file", 1, 1, 1);
        reject(&wire.bytes(), Error::ParentNotDirectory);
        let mut wire = Wire::new();
        wire.file(b"/a", 1, 1, 1);
        wire.file(b"/a/file", 2, 1, 1);
        reject(&wire.bytes(), Error::ParentNotDirectory);
        // A rejected private build does not leave state in a later fresh owner.
        assert!(RootImage::build(6, &Wire::new().bytes(), limits()).is_ok());
    }

    #[test]
    fn symlink_targets_match_tree_rules_and_are_never_resolved() {
        for target in [vec![], vec![b'a', 0, b'b'], vec![b'a'; 4096]] {
            let mut wire = Wire::new();
            wire.links.push((b"/l".to_vec(), target));
            reject(&wire.bytes(), Error::InvalidTarget);
        }
        let mut wire = Wire::new();
        wire.links
            .push((b"/l".to_vec(), b"../absent//./target".to_vec()));
        let (tree, _) = RootImage::build(5, &wire.bytes(), limits())
            .unwrap()
            .into_parts();
        assert_eq!(
            tree.target(lookup(&tree, b"/l")).unwrap(),
            b"../absent//./target"
        );
    }

    #[test]
    fn hardlink_identity_and_empty_independence_use_exact_regions() {
        let mut wire = Wire::new();
        wire.file(b"/a", 32, 8, 100);
        wire.file(b"/alias", 32, 8, 100);
        wire.file(b"/other", 40, 8, 100);
        wire.file(b"/zero", 0, 0, 0);
        wire.file(b"/zero2", 0, 0, 0);
        let caps = Limits {
            inodes: 5,
            entries: 5,
            file_bytes: 100,
        };
        let (mut tree, catalog) = RootImage::build(5, &wire.bytes(), caps)
            .unwrap()
            .into_parts();
        let a = lookup(&tree, b"/a");
        assert_eq!(a, lookup(&tree, b"/alias"));
        assert_ne!(a, lookup(&tree, b"/other"));
        let z = lookup(&tree, b"/zero");
        let z2 = lookup(&tree, b"/zero2");
        assert_ne!(z, z2);
        assert_eq!(tree.source(z), Ok(0));
        assert_eq!(tree.source(z2), Ok(0));
        assert_eq!(tree.read(z, 0, 1), Ok(&[][..]));
        assert_eq!(tree.metadata(a).unwrap().nlink, 2);
        assert_eq!(catalog.source_count(), 2);
        assert_eq!(tree.source(a), Ok(1));
        assert_eq!(tree.source(lookup(&tree, b"/other")), Ok(2));
        assert_eq!(
            RootImage::build(6, &wire.bytes(), Limits { inodes: 4, ..caps }).err(),
            Some(Error::Capacity)
        );
        assert_eq!(
            RootImage::build(6, &wire.bytes(), Limits { entries: 4, ..caps }).err(),
            Some(Error::Capacity)
        );
    }

    #[test]
    fn hardlink_metadata_conflicts_and_pack_errors_fail() {
        let mut base = Wire::new();
        base.file(b"/a", 32, 8, 8);
        base.file(b"/alias", 32, 8, 8);
        for field in 0..3 {
            let mut wire = base.clone();
            match field {
                0 => wire.files[1].1 = 0o600,
                1 => wire.files[1].2 = 9,
                _ => wire.files[1].4 = true,
            };
            reject(&wire.bytes(), Error::RegionConflict);
        }
        let mut wire = Wire::new();
        wire.packs.push(([7; 32], 128));
        reject(&wire.bytes(), Error::DuplicatePack);
        let mut wire = Wire::new();
        wire.file(b"/a", 128, 1, 1);
        reject(&wire.bytes(), Error::InvalidRegion);
        let mut wire = Wire::new();
        wire.file(b"/a", u64::MAX, 2, 1);
        reject(&wire.bytes(), Error::InvalidRegion);
        let mut wire = Wire::new();
        wire.file(b"/a", 1, 1, 1);
        wire.files[0].3 = 1;
        reject(&wire.bytes(), Error::InvalidRegion);
        let mut wire = Wire::new();
        wire.file(b"/a", 1, 8, 7);
        wire.files[0].4 = true;
        reject(&wire.bytes(), Error::InvalidRegion);
        for (at, size) in [(1, 0), (0, 1)] {
            let mut wire = Wire::new();
            wire.file(b"/a", at, 0, size);
            reject(&wire.bytes(), Error::InvalidRegion);
        }
    }

    #[test]
    fn caps_include_root_and_single_decoded_file_but_not_alias_duplication() {
        let bytes = Wire::new().bytes();
        assert_eq!(
            RootImage::build(
                5,
                &bytes,
                Limits {
                    inodes: 0,
                    ..limits()
                }
            )
            .err(),
            Some(Error::Capacity)
        );
        let mut wire = Wire::new();
        wire.file(b"/a", 1, 1, 1025);
        reject(&wire.bytes(), Error::Capacity);
        let mut wire = Wire::new();
        wire.file(b"/a", 1, 1, u64::MAX);
        reject(&wire.bytes(), Error::Capacity);
        let mut empty = Wire::new();
        empty.packs.clear();
        let (tree, catalog) = RootImage::build(
            5,
            &empty.bytes(),
            Limits {
                inodes: 1,
                entries: 0,
                file_bytes: 0,
            },
        )
        .unwrap()
        .into_parts();
        assert_eq!(tree.root().number(), 1);
        assert_eq!(catalog.pack_count(), 0);
        assert_eq!(catalog.source_count(), 0);
        assert_eq!(catalog.artifact_count(), 0);
    }

    #[test]
    fn aot_aliases_bind_exact_inode_source_and_generation() {
        let mut wire = Wire::new();
        wire.file(b"/a", 32, 8, 100);
        wire.file(b"/alias", 32, 8, 100);
        wire.file(b"/other", 40, 8, 100);
        wire.aot(b"/alias");
        wire.aot(b"/a");
        wire.aot(b"/other");
        let (tree, catalog) = RootImage::build(51, &wire.bytes(), limits())
            .unwrap()
            .into_parts();
        let a = lookup(&tree, b"/a");
        let (id, artifact) = catalog.artifact_for(a).unwrap();
        assert_eq!(id, 1);
        assert_eq!(artifact.source, 1);
        assert_eq!(artifact.source_digest, [1; 32]);
        assert_eq!(catalog.artifact_count(), 2);
        assert_eq!(
            catalog.artifact_for(lookup(&tree, b"/alias")),
            Some((id, artifact))
        );
        assert_eq!(catalog.artifact_for(lookup(&tree, b"/other")).unwrap().0, 2);
        assert_eq!(catalog.artifact(0), None);
        assert_eq!(catalog.artifact(3), None);
        assert_eq!(
            catalog.artifact_for(Inode::from_parts(52, a.number())),
            None
        );
        assert_eq!(catalog.artifact_for(tree.root()), None);
        assert_eq!(catalog.artifact_for(Inode::from_parts(51, 999)), None);
        let mut changed = wire.clone();
        changed.generation = [10; 32];
        let (_, other) = RootImage::build(52, &changed.bytes(), limits())
            .unwrap()
            .into_parts();
        assert_eq!(other.generation(), &[10; 32]);
        assert_eq!(other.artifact_for(a), None);
    }

    #[test]
    fn aot_conflicts_and_nonfile_or_empty_associations_fail() {
        let mut base = Wire::new();
        base.file(b"/a", 32, 8, 100);
        base.file(b"/alias", 32, 8, 100);
        base.aot(b"/a");
        base.aot(b"/alias");
        for field in 0..4 {
            let mut wire = base.clone();
            match field {
                0 => wire.aots[1].1 = false,
                1 => wire.aots[1].2[0] ^= 1,
                2 => wire.aots[1].3[0] ^= 1,
                _ => wire.aots[1].4[0] ^= 1,
            };
            reject(&wire.bytes(), Error::AotConflict);
        }
        let mut wire = Wire::new();
        wire.aot(b"/missing");
        reject(&wire.bytes(), Error::InvalidAot);
        let mut wire = Wire::new();
        wire.dirs.push((b"/dir".to_vec(), 0o755));
        wire.aot(b"/dir");
        reject(&wire.bytes(), Error::InvalidAot);
        let mut wire = Wire::new();
        wire.links.push((b"/link".to_vec(), b"/a".to_vec()));
        wire.file(b"/a", 32, 8, 100);
        wire.aot(b"/link");
        reject(&wire.bytes(), Error::InvalidAot);
        let mut wire = Wire::new();
        wire.file(b"/empty", 0, 0, 0);
        wire.aot(b"/empty");
        reject(&wire.bytes(), Error::InvalidAot);
        let mut wire = Wire::new();
        wire.file(b"/compressed-empty", 1, 8, 0);
        wire.aot(b"/compressed-empty");
        reject(&wire.bytes(), Error::InvalidAot);
    }

    #[test]
    fn non_boolean_flags_and_record_truncation_fail_without_publication() {
        let mut wire = Wire::new();
        wire.file(b"/a", 1, 1, 1);
        wire.aot(b"/a");
        let bytes = wire.bytes();
        let mut raw = bytes.clone();
        raw[72 + 40 + 20..72 + 40 + 24].copy_from_slice(&2u32.to_le_bytes());
        reject(&raw, Error::InvalidRegion);
        let aot_at = 72 + 40 + 40 + 2;
        let mut shared = bytes.clone();
        shared[aot_at + 4..aot_at + 8].copy_from_slice(&2u32.to_le_bytes());
        reject(&shared, Error::InvalidAot);
        for length in HEADER..bytes.len() {
            assert!(RootImage::build(5, &bytes[..length], limits()).is_err());
        }
        assert!(RootImage::build(6, &bytes, limits()).is_ok());
    }

    #[test]
    fn distinct_packs_and_compressed_empty_regions_are_not_content_interned() {
        let mut wire = Wire::new();
        wire.packs.push(([8; 32], 128));
        wire.file(b"/a", 32, 8, 0);
        wire.file(b"/other-pack", 32, 8, 0);
        wire.files[1].3 = 1;
        wire.file(b"/other-region", 40, 8, 0);
        wire.file(b"/alias", 32, 8, 0);
        let (mut tree, catalog) = RootImage::build(5, &wire.bytes(), limits())
            .unwrap()
            .into_parts();
        let a = lookup(&tree, b"/a");
        let pack = lookup(&tree, b"/other-pack");
        let region = lookup(&tree, b"/other-region");
        assert_ne!(a, pack);
        assert_ne!(a, region);
        assert_ne!(pack, region);
        assert_eq!(a, lookup(&tree, b"/alias"));
        assert_eq!(tree.source(a), Ok(1));
        assert_eq!(tree.source(pack), Ok(2));
        assert_eq!(tree.source(region), Ok(3));
        assert_eq!(catalog.source_count(), 3);
        assert_eq!(catalog.source(1).unwrap().pack, 0);
        assert_eq!(catalog.source(2).unwrap().pack, 1);
        let attempt = tree.load_begin(a).unwrap();
        let mut bad = vec![1];
        assert_eq!(
            tree.load_finish(a, attempt, true, &mut bad),
            Err(inode::Error::InvalidSize)
        );
        assert_eq!(bad, [1]);
        assert_eq!(tree.size(a), Ok(0));
        let next = tree.load_begin(a).unwrap();
        tree.load_finish(a, next, true, &mut Vec::new()).unwrap();
        assert_eq!(tree.read(a, 0, 1), Ok(&[][..]));
    }

    #[test]
    fn each_maximum_record_count_and_variable_length_is_rejected_before_reservation_or_copy() {
        let mut empty = Wire::new();
        empty.packs.clear();
        let header = empty.bytes();
        for at in [48, 52, 56, 60, 64] {
            let mut bytes = header.clone();
            bytes[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            reject(&bytes, Error::Truncated);
        }
        let mut directory = Wire::new();
        directory.dirs.push((b"/d".to_vec(), 0o755));
        let mut link = Wire::new();
        link.links.push((b"/l".to_vec(), b"target".to_vec()));
        let mut file = Wire::new();
        file.file(b"/a", 1, 1, 1);
        let mut aot = file.clone();
        aot.aot(b"/a");
        for (mut bytes, at) in [
            (directory.bytes(), 112),
            (link.bytes(), 112),
            (link.bytes(), 116),
            (file.bytes(), 112),
            (aot.bytes(), 154),
        ] {
            bytes[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            reject(&bytes, Error::Truncated);
        }
    }
}
