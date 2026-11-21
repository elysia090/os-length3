//! Translations kept between runs, each under its identity (`identity::Key`): immutable, private to one user.
//! A translation is never invalidated in place: what changes it (the program, the translator, the ABI, an option)
//! changes its key, and the old entry is simply never asked for again. A held Entry pins its validated bytes.
//! Linux filesystem calls are the interface; where there is no Linux, `runtime/linux` answers them.
#![forbid(unsafe_code)]
use crate::identity::{digest, Key};
use std::{fs::{self, File, OpenOptions}, io::{self, Read, Write}, path::{Path, PathBuf},
    os::{fd::AsRawFd, unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt}}, sync::{Arc, OnceLock}};

const MAGIC: &[u8;8] = b"SODSKEPT";
const HEADER: usize = 80;
const MAX_BYTES: u64 = 256 << 20;
const NOFOLLOW: i32 = 0x20000;
const NONBLOCK: i32 = 0x800;
const DIRECTORY: i32 = 0x10000;

struct Root { directory: File, uid: u32 }
#[derive(Clone)]
pub struct Cache(Arc<Root>);
pub struct Entry { root: Arc<Root>, key: Key, path: PathBuf, ready: OnceLock<Arc<[u8]>> }

fn invalid(message: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, message) }
fn current_uid() -> io::Result<u32> {
    let text=fs::read_to_string("/proc/self/status")?;
    text.lines().find_map(|l| l.strip_prefix("Uid:")?.split_whitespace().nth(1)?.parse().ok())
        .ok_or_else(|| invalid("no effective uid in /proc/self/status"))
}
fn private_file(file: &File, uid:u32) -> io::Result<fs::Metadata> {
    let m=file.metadata()?;
    if !m.is_file() || m.uid()!=uid || m.mode() & 0o077 != 0 || m.nlink()!=1 {
        return Err(invalid("cache file is not private, singly linked and owned by this user"));
    }
    Ok(m)
}
impl Root {
    fn path(&self, name:&str)->PathBuf { PathBuf::from(format!("/proc/self/fd/{}/{}",self.directory.as_raw_fd(),name)) }
}
impl Cache {
    /// The directory must be private to this user. An open directory handle pins all subsequent operations.
    pub fn open(path: impl AsRef<Path>)->io::Result<Self> {
        match fs::DirBuilder::new().mode(0o700).create(path.as_ref()) {
            Ok(())=>{}, Err(e) if e.kind()==io::ErrorKind::AlreadyExists=>{}, Err(e)=>return Err(e)
        }
        let directory=OpenOptions::new().read(true).custom_flags(DIRECTORY|NOFOLLOW|NONBLOCK).open(path)?;
        let m=directory.metadata()?; let uid=current_uid()?;
        if !m.is_dir() || m.uid()!=uid || m.mode() & 0o077 != 0 { return Err(invalid("cache directory must be owned by this user with mode 0700")); }
        Ok(Self(Arc::new(Root{directory,uid})))
    }
    /// Acquire once outside the hot loop. Separate handles and processes coordinate through the same key lock.
    pub fn entry(&self,key:Key)->Entry {
        let hex=key.hex(); let name=std::str::from_utf8(&hex).expect("hex is ASCII");
        Entry{root:self.0.clone(), key, path:self.0.path(name), ready:OnceLock::new()}
    }
}
impl Entry {
    /// The hot borrowed hit: no allocation, refcount increment, lock, syscall or digest.
    #[inline]
    pub fn cached(&self)->Option<&[u8]> { self.ready.get().map(|v|v.as_ref()) }
    pub fn get(&self)->io::Result<Option<Arc<[u8]>>> {
        if let Some(bytes)=self.ready.get() { return Ok(Some(bytes.clone())); }
        let mut file=match OpenOptions::new().read(true).custom_flags(NOFOLLOW|NONBLOCK).open(&self.path) {
            Ok(f)=>f, Err(e) if e.kind()==io::ErrorKind::NotFound || e.raw_os_error()==Some(40)=>return Ok(None), Err(e)=>return Err(e)
        };
        let metadata=match private_file(&file,self.root.uid) {
            Ok(m)=>m, Err(e) if e.kind()==io::ErrorKind::InvalidData=>return Ok(None), Err(e)=>return Err(e)
        };
        let mut header=[0;HEADER];
        if file.read_exact(&mut header).is_err() || &header[..8]!=MAGIC || &header[8..40]!=self.key.bytes() { return Ok(None); }
        let len=u64::from_le_bytes(header[40..48].try_into().unwrap());
        if len>MAX_BYTES || metadata.len()!=HEADER as u64+len { return Ok(None); }
        let mut bytes=Vec::new();
        bytes.try_reserve_exact(len as usize).map_err(|_|io::Error::other("translation does not fit in memory"))?;
        bytes.resize(len as usize,0);
        if file.read_exact(&mut bytes).is_err() || digest(&bytes)!=header[48..80] { return Ok(None); }
        let _=self.ready.set(bytes.into());
        Ok(self.ready.get().cloned())
    }
    /// A miss is built once per key across handles, threads and processes. A failed build is retried.
    pub fn get_or_try_insert(&self,build:impl FnOnce()->io::Result<Vec<u8>>)->io::Result<Arc<[u8]>> {
        if let Some(bytes)=self.get()? { return Ok(bytes); }
        let lock_path=self.path.with_extension("lock");
        let lock=OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).custom_flags(NOFOLLOW|NONBLOCK).open(lock_path)?;
        private_file(&lock,self.root.uid)?;
        lock.lock()?; // Released by close even after a panic or process exit. Lock files are never unlinked live.
        if let Some(bytes)=self.get()? { return Ok(bytes); }
        let bytes=build()?;
        if bytes.len() as u64>MAX_BYTES { return Err(invalid("translation is larger than the cache entry bound")); }
        self.publish(&bytes)?;
        let _=self.ready.set(bytes.into());
        Ok(self.ready.get().unwrap().clone())
    }
    fn publish(&self,bytes:&[u8])->io::Result<()> {
        // The key lock is held. A previous process may have died after creating this one temporary.
        let temp=Temporary(self.path.with_extension("tmp"));
        let open=||OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(NOFOLLOW).open(&temp.0);
        let mut file=match open() {
            Ok(file)=>file,
            Err(e) if e.kind()==io::ErrorKind::AlreadyExists=>{fs::remove_file(&temp.0)?;open()?},
            Err(e)=>return Err(e),
        };
        let mut header=[0;HEADER]; header[..8].copy_from_slice(MAGIC); header[8..40].copy_from_slice(self.key.bytes());
        header[40..48].copy_from_slice(&(bytes.len() as u64).to_le_bytes()); header[48..].copy_from_slice(&digest(bytes));
        file.write_all(&header)?;file.write_all(bytes)?;file.sync_all()?;
        fs::rename(&temp.0,&self.path)?;self.root.directory.sync_all()?;
        Ok(())
    }
}
struct Temporary(PathBuf);
impl Drop for Temporary { fn drop(&mut self) { let _=fs::remove_file(&self.0); } }
