use sods::cache::Cache;
use sods::identity::{digest,Key,Mode,Profile};
use std::{fs, io::{self,Write}, path::{Path,PathBuf}, process::{Command,Stdio}, sync::{Arc,Barrier,atomic::{AtomicUsize,Ordering}}, time::{Duration,Instant}};
use std::os::unix::fs::{DirBuilderExt,PermissionsExt,symlink};
static NEXT:AtomicUsize=AtomicUsize::new(0);
struct Temp(PathBuf);
impl Temp {fn new()->Self {let p=std::env::temp_dir().join(format!("sods-cache-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));fs::DirBuilder::new().mode(0o700).create(&p).unwrap();Self(p)}}
impl Drop for Temp {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
fn key()->Key {Key::new(digest(b"elf"),digest(b"translator"),Profile::default(),Mode::Entry)}
fn filename()->String {String::from_utf8(key().hex().to_vec()).unwrap()}
fn artifact(p:&Path)->PathBuf {p.join(filename())}

#[test]
fn pinned_hit_and_identity_invalidation() {
    let temp=Temp::new();let cache=Cache::open(&temp.0).unwrap();let entry=cache.entry(key());
    assert!(entry.cached().is_none());assert!(entry.get().unwrap().is_none());
    let bytes=entry.get_or_try_insert(||Ok(b"wasm".to_vec())).unwrap();
    assert_eq!(entry.cached().unwrap().as_ptr(),bytes.as_ptr());
    assert!(Arc::ptr_eq(&bytes,&entry.get().unwrap().unwrap()));
    assert_eq!(&*cache.entry(key()).get().unwrap().unwrap(),b"wasm");
    let other=Key::new(digest(b"elf"),digest(b"other translator"),Profile::default(),Mode::Entry);
    assert!(cache.entry(other).get().unwrap().is_none());
    // A validated held entry is immutable even if its backing file is replaced or collected later.
    fs::remove_file(artifact(&temp.0)).unwrap();assert_eq!(entry.cached().unwrap(),b"wasm");
}
#[test]
fn one_build_across_threads_and_distinct_handles() {
    let temp=Temp::new();let cache=Cache::open(&temp.0).unwrap();let barrier=Arc::new(Barrier::new(12));let count=Arc::new(AtomicUsize::new(0));
    std::thread::scope(|scope| {
        for _ in 0..12 {let c=cache.clone();let b=barrier.clone();let n=count.clone();scope.spawn(move||{
            b.wait();let result=c.entry(key()).get_or_try_insert(||{n.fetch_add(1,Ordering::SeqCst);std::thread::sleep(Duration::from_millis(20));Ok(vec![9;1024])}).unwrap();assert_eq!(&*result,&vec![9;1024]);
        });}
    });assert_eq!(count.load(Ordering::SeqCst),1);
}
#[test]
fn corruption_truncation_wrong_key_and_trailing_data_are_misses_then_rebuilt() {
    let temp=Temp::new();let cache=Cache::open(&temp.0).unwrap();
    cache.entry(key()).get_or_try_insert(||Ok(b"body".to_vec())).unwrap();let valid=fs::read(artifact(&temp.0)).unwrap();
    for variant in 0..6 {
        let mut broken=valid.clone();
        match variant {0=>broken.truncate(12),1=>broken[8]^=1,2=>broken[83]^=1,3=>broken.extend(b"extra"),4=>broken[40..48].copy_from_slice(&u64::MAX.to_le_bytes()),_=>broken[0]=0}
        fs::write(artifact(&temp.0),broken).unwrap();
        assert!(cache.entry(key()).get().unwrap().is_none(),"variant {variant}");
        assert_eq!(&*cache.entry(key()).get_or_try_insert(||Ok(b"body".to_vec())).unwrap(),b"body");
    }
}
#[test]
fn failure_and_unpublished_temporary_leave_no_false_hit() {
    let temp=Temp::new();let cache=Cache::open(&temp.0).unwrap();let entry=cache.entry(key());
    assert!(entry.get_or_try_insert(||Err(io::Error::other("build failed"))).is_err());
    assert!(entry.get().unwrap().is_none());
    fs::write(artifact(&temp.0).with_extension("tmp"),b"interrupted write").unwrap();
    assert_eq!(&*entry.get_or_try_insert(||Ok(b"complete".to_vec())).unwrap(),b"complete");
    assert!(!artifact(&temp.0).with_extension("tmp").exists());
}
#[test]
fn symlinks_private_permissions_and_pinned_directory() {
    let temp=Temp::new();let outside=temp.0.join("outside");fs::write(&outside,b"untouched").unwrap();
    let data=temp.0.join("data");let cache=Cache::open(&data).unwrap();
    symlink(&outside,artifact(&data)).unwrap();assert!(cache.entry(key()).get().unwrap().is_none());
    cache.entry(key()).get_or_try_insert(||Ok(b"artifact".to_vec())).unwrap();assert_eq!(fs::read(&outside).unwrap(),b"untouched");
    fs::set_permissions(artifact(&data),fs::Permissions::from_mode(0o666)).unwrap();assert!(cache.entry(key()).get().unwrap().is_none());
    let moved=temp.0.join("moved");fs::rename(&data,&moved).unwrap();fs::create_dir(&data).unwrap();
    cache.entry(key()).get_or_try_insert(||Ok(b"pinned".to_vec())).unwrap();
    assert!(artifact(&moved).exists());assert!(!artifact(&data).exists());
    fs::set_permissions(&data,fs::Permissions::from_mode(0o777)).unwrap();assert!(Cache::open(&data).is_err());
}
#[test]
fn a_lock_symlink_is_rejected_without_touching_the_target() {
    let temp=Temp::new();let cache=Cache::open(&temp.0).unwrap();let outside=temp.0.join("outside");fs::write(&outside,b"untouched").unwrap();
    symlink(&outside,artifact(&temp.0).with_extension("lock")).unwrap();
    assert!(cache.entry(key()).get_or_try_insert(||Ok(vec![1])).is_err());assert_eq!(fs::read(&outside).unwrap(),b"untouched");
}
#[test]
fn readers_observe_only_complete_artifacts() {
    let temp=Temp::new();let cache=Cache::open(&temp.0).unwrap();let payload=vec![0xa5;256<<10];
    std::thread::scope(|scope| {
        let writer=cache.clone();let expected=&payload;
        scope.spawn(move||{writer.entry(key()).get_or_try_insert(||{std::thread::sleep(Duration::from_millis(15));Ok(expected.clone())}).unwrap();});
        for _ in 0..6 {let reader=cache.clone();let expected=&payload;scope.spawn(move||{
            let until=Instant::now()+Duration::from_secs(3);
            loop {if let Some(bytes)=reader.entry(key()).get().unwrap(){assert_eq!(&*bytes,expected);break}assert!(Instant::now()<until);std::thread::yield_now();}
        });}
    });
}
#[test]
fn subprocess_worker() {
    let Some(path)=std::env::var_os("SODS_CACHE_TEST_ROOT") else{return};
    let cache=Cache::open(&path).unwrap();
    cache.entry(key()).get_or_try_insert(||{
        let path=PathBuf::from(&path);let mut marks=fs::OpenOptions::new().append(true).create(true).open(path.join("builds")).unwrap();writeln!(marks,"build").unwrap();
        if std::env::var_os("COWBOY_CACHE_TEST_CRASH").is_some() {
            fs::write(artifact(&path).with_extension("tmp"),b"partial").unwrap();fs::write(path.join("ready"),b"ready").unwrap();loop{std::thread::park();}
        }
        std::thread::sleep(Duration::from_millis(20));Ok(b"complete".to_vec())
    }).unwrap();
}
fn child(path:&Path)->Command {let mut c=Command::new(std::env::current_exe().unwrap());c.args(["--exact","subprocess_worker","--nocapture"]).env("SODS_CACHE_TEST_ROOT",path).stdout(Stdio::null()).stderr(Stdio::inherit());c}
#[test]
fn one_build_across_processes_and_recovery_after_process_death() {
    let temp=Temp::new();let mut children=Vec::new();
    for _ in 0..6 {children.push(child(&temp.0).spawn().unwrap());}for mut c in children{assert!(c.wait().unwrap().success());}
    assert_eq!(fs::read_to_string(temp.0.join("builds")).unwrap().lines().count(),1);
    let crash=Temp::new();let mut stopped=child(&crash.0).env("COWBOY_CACHE_TEST_CRASH","1").spawn().unwrap();
    let until=Instant::now()+Duration::from_secs(3);while !crash.0.join("ready").exists(){assert!(Instant::now()<until);std::thread::sleep(Duration::from_millis(2));}
    stopped.kill().unwrap();stopped.wait().unwrap();
    let cache=Cache::open(&crash.0).unwrap();assert!(cache.entry(key()).get().unwrap().is_none());
    assert_eq!(&*cache.entry(key()).get_or_try_insert(||Ok(b"recovered".to_vec())).unwrap(),b"recovered");
}
