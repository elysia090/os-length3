//! The tests of /space.rs.

use super::*;

#[test]
fn only_this_oss_dead_old_temporaries_are_reclaimed() {
    let data = crate::fs::testing::dir("length3-usage");
    let _ = fs::remove_dir_all(&data);
    let repo = data.join("repos/a");
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::write(repo.join("main.c"), vec![b'x'; 10_000]).unwrap();
    fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    // A leftover of a writer that died (pid 1 is never this OS's writer:
    // it runs, so pick a pid that cannot exist).
    let dead = repo.join(".main.c.length3-4000000-0");
    fs::write(&dead, vec![b'y'; 50_000]).unwrap();
    // Same name, but its writer is alive: this process.
    let live = repo.join(format!(".x.length3-{}", std::process::id()));
    fs::write(&live, "z").unwrap();
    // Looks like one, but lives in .git: never touched.
    let in_git = repo.join(".git/.HEAD.length3-4000000");
    fs::write(&in_git, "q").unwrap();
    // A person's own file with a similar name.
    let mine = repo.join("notes.length3-draft");
    fs::write(&mine, "mine").unwrap();
    // Named like a setting's temporary, but in a repo: a person's file.
    let dated = repo.join("data.json.2024");
    fs::write(&dated, "{}").unwrap();
    // A setting's temporary whose writer died.
    fs::create_dir_all(data.join("home")).unwrap();
    let setting = data.join("home/ui.json.4000000");
    fs::write(&setting, "{").unwrap();
    let old = SystemTime::now() - Duration::from_secs(3600);
    for p in [&dead, &live, &in_git, &mine, &dated, &setting] {
        fs::File::options().write(true).open(p).unwrap().set_modified(old).unwrap();
    }
    let u = space(&data, &data.join("repos"), &[]);
    let mut found: Vec<PathBuf> = u.items.iter().filter_map(|i| i.id.strip_prefix("path:").map(PathBuf::from)).collect();
    found.sort();
    assert_eq!(found, [setting.clone(), dead.clone()]);
    assert!(u.freeable >= 50_000 / 4096 * 4096, "{}", u.freeable);
    // Without a Remote, a repo stays, and says how it could go.
    let a = u.items.iter().find(|i| i.id == "repo:a").unwrap();
    assert!(a.allocated >= 10_000 && a.room == Room::Keep && a.why.contains("Remote"), "{a:?}");
    // Largest first.
    assert!(u.items.windows(2).all(|w| w[0].allocated >= w[1].allocated));
    let ids: Vec<String> = all_freeable(&u);
    let r = free(&data, &data.join("repos"), &[ids, vec!["repo:a".into()]].concat(), &[]);
    assert_eq!((r.removed.len(), r.freed_certainty), (2, Certainty::Verified));
    assert!(r.kept.iter().any(|(id, _)| id == "repo:a"));
    assert!(!dead.exists() && !setting.exists());
    assert!(live.exists() && in_git.exists() && mine.exists() && dated.exists());
    // The host's free space is shared with every other writer, so it is
    // only an observation: labelled so, never asserted.
    assert_eq!(r.host_change, Certainty::Estimated);
    let _ = fs::remove_dir_all(&data);
}

#[test]
fn a_sparse_file_counts_what_it_holds() {
    let data = crate::fs::testing::dir("length3-sparse");
    let _ = fs::remove_dir_all(&data);
    let repo = data.join("repos/s");
    fs::create_dir_all(&repo).unwrap();
    let f = fs::File::create(repo.join("big")).unwrap();
    f.set_len(1 << 30).unwrap(); // 1 GiB logical, nothing written
    let u = space(&data, &data.join("repos"), &[]);
    let s = u.items.iter().find(|i| i.id == "repo:s").unwrap();
    assert!(s.allocated < 1 << 20, "{s:?}");
    let _ = fs::remove_dir_all(&data);
}

mod system_tests {
    use super::super::*;

    fn root_dir(data: &Path, sha: char, version: &str) -> PathBuf {
        let d = crate::root::system_dir(data).join(sha.to_string().repeat(64));
        fs::create_dir_all(d.join("root/bin")).unwrap();
        fs::write(d.join("root/bin/busybox"), vec![b'x'; 20_000]).unwrap();
        // Applets are hard links: the bytes are there once.
        for a in ["sh", "ls", "cat"] { fs::hard_link(d.join("root/bin/busybox"), d.join(format!("root/bin/{a}"))).unwrap(); }
        let about = crate::root::Installed { name: "OS".into(), version: version.into(), sha256: sha.to_string().repeat(64), files: 4, bytes: 20_000, allocated: None, distro: None };
        fs::write(d.join("installed.json"), serde_json::to_string(&about).unwrap()).unwrap();
        d
    }

    #[test]
    fn the_root_in_use_and_the_one_before_are_held_older_ones_go() {
        let data = crate::fs::testing::dir("length3-system");
        let _ = fs::remove_dir_all(&data);
        let old = root_dir(&data, 'a', "0.0.1");
        std::thread::sleep(Duration::from_millis(20));
        let before = root_dir(&data, 'b', "0.0.2");
        std::thread::sleep(Duration::from_millis(20));
        root_dir(&data, 'c', "0.1.0");
        // `before` is newer than `old`: the one to go back to.
        let t = SystemTime::now();
        fs::File::open(&old).unwrap().set_modified(t - Duration::from_secs(7200)).unwrap();
        fs::File::open(&before).unwrap().set_modified(t - Duration::from_secs(3600)).unwrap();
        std::os::unix::fs::symlink("c".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        let held: Vec<(String, Held)> = system(&data).into_iter().map(|(s, _)| (s.version, s.held)).collect();
        assert!(held.contains(&("0.1.0".into(), Held::Current)) && held.contains(&("0.0.2".into(), Held::Previous)) && held.contains(&("0.0.1".into(), Held::Older)), "{held:?}");
        let u = space(&data, &data.join("repos"), &[]);
        let room = |v: &str| u.items.iter().find(|i| i.what == format!("OS {v}")).unwrap();
        // The root in use stays; the others can be fetched again, so they can go.
        assert_eq!((room("0.1.0").room, room("0.0.2").room, room("0.0.1").room), (Room::Keep, Room::Free, Room::Free));
        // Four names, one file's worth of blocks.
        assert!(room("0.1.0").allocated < 4 * 20_000, "{}", room("0.1.0").allocated);
        let r = free(&data, &data.join("repos"), &all_freeable(&u), &[]);
        assert_eq!(r.removed.len(), 2);
        assert!(!old.exists() && !before.exists() && crate::root::system_dir(&data).join("c".repeat(64)).exists());
        let _ = fs::remove_dir_all(&data);
    }

    fn room_of(u: &Space, sha: char) -> (Room, String) {
        let i = u.items.iter().find(|i| i.id == format!("root:{}", sha.to_string().repeat(64))).expect("the root is listed");
        (i.room, i.why.clone())
    }

    #[test]
    fn a_root_a_prompt_runs_on_stays_when_another_is_made_current_and_goes_once_it_ends() {
        let data = crate::fs::testing::dir("length3-system-held");
        let _ = fs::remove_dir_all(&data);
        let repos = data.join("repos");
        let l3 = root_dir(&data, 'a', "0.5.0");
        std::os::unix::fs::symlink("a".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        // A web server's Prompt on l3's root (this process stands for it), then Ubuntu made current, as `l3 root use ubuntu` does.
        let mut prompt = crate::prompt::running::record(&data, "os-web", true, &l3.join("root")).unwrap();
        prompt.ready().unwrap();
        root_dir(&data, 'b', "24.04.5");
        assert!(crate::root::use_held(&data, &"b".repeat(64)).is_some());
        let running = crate::tr!("A Prompt running uses it", "動いている Prompt が使っています");
        let u = space(&data, &repos, &[]);
        assert_eq!(room_of(&u, 'a'), (Room::Keep, running.clone()), "the root the Prompt runs on stays");
        // The current one stays as ever, with no Prompt on it (#46).
        assert_eq!(room_of(&u, 'b').0, Room::Keep);
        assert!(!all_freeable(&u).iter().any(|id| id.starts_with("root:")));
        // Asked for by name, it is looked at again and stays; so with the host's own `open` (the app's) told nothing.
        let r = free(&data, &repos, &[format!("root:{}", "a".repeat(64))], &[]);
        assert!(r.removed.is_empty() && r.kept == [(format!("root:{}", "a".repeat(64)), running)], "{:?}", r.kept);
        assert!(l3.join("root/bin/busybox").is_file(), "its programs are still there to run");
        // The Prompt ends: the root before is one that can go, as it always was.
        drop(prompt);
        let u = space(&data, &repos, &[]);
        assert_eq!(room_of(&u, 'a').0, Room::Free);
        assert_eq!(free(&data, &repos, &all_freeable(&u), &[]).removed, [format!("root:{}", "a".repeat(64))]);
        assert!(!l3.exists() && crate::root::current(&data).is_some_and(|(_, r)| r.version == "24.04.5"));
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_record_older_l3_made_without_its_root_keeps_every_root() {
        let data = crate::fs::testing::dir("length3-system-unsaid");
        let _ = fs::remove_dir_all(&data);
        root_dir(&data, 'a', "1");
        root_dir(&data, 'b', "2");
        std::os::unix::fs::symlink("b".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        // This process's own, as an l3 before roots were recorded wrote it.
        let me = std::process::id();
        fs::create_dir_all(data.join("prompts")).unwrap();
        fs::write(data.join(format!("prompts/{me}.json")), format!(r#"{{"repo":"x","pid":{me},"network":false,"started":1,"startTicks":{}}}"#, crate::prompt::running::start_ticks(me).unwrap())).unwrap();
        let u = space(&data, &data.join("repos"), &[]);
        assert_eq!(room_of(&u, 'a').0, Room::Keep, "{:?}", room_of(&u, 'a'));
        fs::remove_file(data.join(format!("prompts/{me}.json"))).unwrap();
        assert_eq!(room_of(&space(&data, &data.join("repos"), &[]), 'a').0, Room::Free);
        let _ = fs::remove_dir_all(&data);
    }

    /// 空ける looks again under the lock a Prompt records itself under: one that recorded the root while the
    /// free waited keeps it, however the free decided before.
    #[test]
    fn a_prompt_recorded_while_a_free_waits_keeps_its_root() {
        let data = crate::fs::testing::dir("length3-system-race");
        let _ = fs::remove_dir_all(&data);
        let old = root_dir(&data, 'a', "1");
        root_dir(&data, 'b', "2");
        std::os::unix::fs::symlink("b".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        let id = format!("root:{}", "a".repeat(64));
        assert!(all_freeable(&space(&data, &data.join("repos"), &[])).contains(&id), "nothing holds it yet");
        // A Prompt starting on it holds the lock (prompt::record), and the free waits for it.
        let still = lock(&data).unwrap();
        let freeing = { let (data, id) = (data.clone(), id.clone()); std::thread::spawn(move || free(&data, &data.join("repos"), &[id], &[])) };
        std::thread::sleep(Duration::from_millis(200));
        let me = std::process::id();
        let r = crate::prompt::running::Running { repo: "x".into(), pid: me, network: false, root: Some("a".repeat(64)), preparing: true, started: 1, start_ticks: crate::prompt::running::start_ticks(me).unwrap() };
        fs::write(data.join(format!("prompts/{me}.json")), serde_json::to_vec(&r).unwrap()).unwrap();
        drop(still);
        let r = freeing.join().unwrap();
        assert!(r.removed.is_empty() && r.kept.iter().any(|(k, _)| *k == id), "{:?}", r.kept);
        assert!(old.join("installed.json").is_file());
        let _ = fs::remove_dir_all(&data);
    }

    /// The root made current under the same lock: one freed meanwhile is not made current.
    #[test]
    fn a_root_freed_as_it_is_made_current_is_not_made_current() {
        let data = crate::fs::testing::dir("length3-system-switch");
        let _ = fs::remove_dir_all(&data);
        root_dir(&data, 'a', "1");
        let other = root_dir(&data, 'b', "2");
        std::os::unix::fs::symlink("a".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        let still = lock(&data).unwrap();
        let switching = { let data = data.clone(); std::thread::spawn(move || crate::root::use_held(&data, &"b".repeat(64)).is_some()) };
        std::thread::sleep(Duration::from_millis(200));
        // Freed while it waited (as `free` removes a root, under the lock).
        fs::remove_dir_all(&other).unwrap();
        drop(still);
        assert!(!switching.join().unwrap());
        assert_eq!(crate::root::current(&data).map(|(_, r)| r.version), Some("1".into()));
        let _ = fs::remove_dir_all(&data);
    }
}

mod owned_tests {
    use super::super::*;

    #[test]
    fn a_repos_environment_and_caches_are_listed_as_its_and_go_with_it() {
        use std::os::unix::fs::PermissionsExt;
        let data = crate::fs::testing::dir("length3-owned");
        let _ = fs::remove_dir_all(&data);
        let repos = data.join("repos");
        fs::create_dir_all(repos.join("here")).unwrap();
        // What its package manager put over the root, and the overlay's scratch, which no one may read.
        let env = crate::prompt::writes::env_dir(&data, "here");
        fs::create_dir_all(env.join("upper/usr/bin")).unwrap();
        fs::write(env.join("upper/usr/bin/tool"), vec![b'x'; 30_000]).unwrap();
        // A temporary-looking name inside an environment is the environment's, not a leftover.
        fs::write(env.join("upper/usr/bin/.tool.length3-4000000-0"), "x").unwrap();
        fs::create_dir_all(env.join("work/work")).unwrap();
        fs::set_permissions(env.join("work/work"), fs::Permissions::from_mode(0o000)).unwrap();
        // Caches of a repo that is no longer on this device: nothing owns them here.
        let gone = crate::prompt::writes::cache_dir(&data, "gone");
        fs::create_dir_all(gone.join("var-cache")).unwrap();
        fs::write(gone.join("var-cache/blob"), vec![b'y'; 20_000]).unwrap();

        // Derived from its own files: node_modules beside package.json, a directory that says it is a cache.
        fs::write(repos.join("here/package.json"), "{}").unwrap();
        fs::create_dir_all(repos.join("here/node_modules/x")).unwrap();
        fs::write(repos.join("here/node_modules/x/index.js"), vec![b'z'; 40_000]).unwrap();
        fs::create_dir_all(repos.join("here/out")).unwrap();
        fs::write(repos.join("here/out/CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55").unwrap();
        // Not proven: a node_modules with no package.json beside it is the person's.
        fs::create_dir_all(repos.join("here/vendor/node_modules")).unwrap();
        fs::write(repos.join("here/vendor/node_modules/keep.js"), "mine").unwrap();
        let tree = crate::remote::local_tree(&repos.join("here"));
        assert_eq!(tree.tree.keys().cloned().collect::<Vec<_>>(), ["package.json", "vendor/node_modules/keep.js"]);
        assert!(crate::prompt::writes::within_derived(&repos.join("here"), "node_modules/x/index.js"));
        assert!(!crate::prompt::writes::within_derived(&repos.join("here"), "vendor/node_modules/keep.js"));

        let s = space(&data, &repos, &[]);
        let find = |id: &str| s.items.iter().find(|i| i.id == id).cloned();
        let d = find("derived:here").expect("what is derived is listed");
        assert!(d.room == Room::Free && d.allocated >= 40_000 && d.detail.contains("node_modules") && d.detail.contains("out"), "{d:?}");
        assert!(find("repo:here").is_some_and(|r| r.allocated < 40_000), "the repo's size leaves it out");
        let e = find("env:here").expect("the environment is listed");
        assert!(e.room == Room::Free && e.allocated >= 30_000, "{e:?}");
        let c = find("cache:gone").expect("the orphaned caches are listed");
        // In the language spoken (it failed in Japanese).
        assert!(c.room == Room::Free && c.why == crate::tr!("Its repo is not on this device", "その repo はこの端末にありません"), "{c:?}");
        assert!(!s.items.iter().any(|i| i.id.starts_with("path:")), "nothing in an environment is a leftover");
        // Open in a Prompt, it stays.
        assert_eq!(item(&data, &repos, "env:here", &InUse::now(&data, &["here".into()])).unwrap().room, Room::Keep);

        let f = free(&data, &repos, &["env:here".into(), "cache:gone".into(), "derived:here".into()], &[]);
        assert_eq!(f.removed.len(), 3, "{:?}", f.kept);
        assert!(!env.exists() && !gone.exists() && !repos.join("here/node_modules").exists() && !repos.join("here/out").exists());
        assert!(repos.join("here/package.json").is_file() && repos.join("here/vendor/node_modules/keep.js").is_file(), "the repo's own files stay");
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn what_a_prompt_being_prepared_holds_stays_and_says_so() {
        let data = crate::fs::testing::dir("length3-owned-prep");
        let _ = fs::remove_dir_all(&data);
        let repos = data.join("repos");
        fs::create_dir_all(repos.join("os-starting")).unwrap();
        fs::write(repos.join("os-starting/package.json"), "{}").unwrap();
        fs::create_dir_all(repos.join("os-starting/node_modules/x")).unwrap();
        let root = crate::root::system_dir(&data).join("a".repeat(64));
        fs::create_dir_all(root.join("root/bin")).unwrap();
        fs::write(root.join("installed.json"), format!(r#"{{"name":"Ubuntu","version":"24.04.5 LTS","sha256":"{}","files":0,"bytes":0}}"#, "a".repeat(64))).unwrap();
        std::os::unix::fs::symlink("a".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        // apt and .setup writing (this process stands for the l3 preparing it).
        let mut prompt = crate::prompt::running::record(&data, "os-starting", false, &root.join("root")).unwrap();
        let env = crate::prompt::writes::env_over(&data, "os-starting", &root.join("root"));
        fs::create_dir_all(env.join("upper/usr/bin")).unwrap();
        fs::write(env.join("upper/usr/bin/jq"), vec![b'x'; 10_000]).unwrap();
        let cache = crate::prompt::writes::cache_dir(&data, "os-starting");
        fs::create_dir_all(cache.join("var-cache/apt")).unwrap();
        fs::write(cache.join("var-cache/apt/pkgcache.bin"), vec![b'y'; 10_000]).unwrap();
        let ids = ["env:os-starting", "cache:os-starting", "derived:os-starting"].map(String::from);
        let why = |s: &Space, id: &str| s.items.iter().find(|i| i.id == id).map(|i| (i.room, i.why.clone()));
        let s = space(&data, &repos, &[]);
        let preparing = crate::tr!("A Prompt being prepared uses it (.packages, .setup)", "用意中の Prompt が使っています（.packages、.setup）");
        for id in ids.iter().chain([&"repo:os-starting".to_string()]) {
            assert_eq!(why(&s, id), Some((Room::Keep, preparing.clone())), "{id}");
        }
        // The app tells its own Prompts as open: their records say more, and are what is said.
        assert_eq!(why(&space(&data, &repos, &["os-starting".into()]), "env:os-starting"), Some((Room::Keep, preparing.clone())));
        // Neither one by one nor all at once: each looked at again, it is still held.
        let f = free(&data, &repos, &[all_freeable(&s), ids.to_vec()].concat(), &[]);
        assert!(f.removed.is_empty(), "{:?}", f.removed);
        assert!(env.join("upper/usr/bin/jq").is_file() && cache.join("var-cache/apt/pkgcache.bin").is_file());
        // Prepared, it holds them as running.
        prompt.ready().unwrap();
        assert_eq!(why(&space(&data, &repos, &[]), "env:os-starting").map(|(r, _)| r), Some(Room::Keep));
        // Its process lost while it was prepared (killed: its record left behind) holds nothing.
        drop(prompt);
        fs::create_dir_all(data.join("prompts")).unwrap();
        fs::write(data.join("prompts/4194304.json"), format!(r#"{{"repo":"os-starting","pid":4194304,"network":false,"root":"{}","preparing":true,"started":1,"startTicks":1}}"#, "a".repeat(64))).unwrap();
        let s = space(&data, &repos, &[]);
        assert!(ids.iter().all(|id| why(&s, id).is_some_and(|(r, _)| r == Room::Free)), "{:?}", s.items);
        assert_eq!(free(&data, &repos, &ids, &[]).removed.len(), 3);
        assert!(!env.exists() && !cache.exists() && repos.join("os-starting/package.json").is_file());
        let _ = fs::remove_dir_all(&data);
    }
}

mod id_tests {
    use super::super::*;

    #[test]
    fn an_id_from_the_page_cannot_lead_out_of_the_data_directory() {
        let top = crate::fs::testing::dir("length3-ids");
        let data = top.join("data");
        std::fs::create_dir_all(&data).unwrap();
        // Named like a temporary file left by a process long gone, but outside.
        let outside = top.join(".x.length3-4194300-0");
        std::fs::write(&outside, b"keep").unwrap();
        std::fs::File::options().write(true).open(&outside).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3 * 86_400)).unwrap();
        let id = format!("path:{}/../.x.length3-4194300-0", data.display());
        assert!(item(&data, &data.join("repos"), &id, &InUse::now(&data, &[])).is_none());
        let _ = std::fs::remove_dir_all(&top);
    }
}

mod room_tests {
    use super::super::*;

    #[test]
    fn room_is_made_from_what_comes_back_first_and_never_from_what_only_this_device_has() {
        let item = |id: &str, allocated: u64, room: Room| Item { id: id.into(), what: String::new(), detail: String::new(), allocated, room, why: String::new() };
        let items = [item("repo:old", 500, Room::Free), item("repo:fresh", 900, Room::Free), item("repo:unsent", 900, Room::SyncFree),
            item("env:old", 900, Room::Free), item("cache:a", 10, Room::Free), item("cache:b", 30, Room::Free), item("derived:a", 20, Room::Free),
            item("root:prev", 300, Room::Free), item("root:older", 5, Room::Free), item("path:/x", 1, Room::Free), item("home", 1, Room::Keep)];
        let day = 24 * 60 * 60 * 1000;
        let touched = [("repo:old".to_string(), 0), ("repo:fresh".to_string(), 9 * day)].into_iter().collect();
        let all = room_order(&items, &["root:prev".into()], &touched, 10 * day, u64::MAX);
        assert_eq!(all, ["root:older", "path:/x", "cache:b", "cache:a", "derived:a", "root:prev", "repo:old"]);
        // Only as much as is wanted.
        assert_eq!(room_order(&items, &["root:prev".into()], &touched, 10 * day, 30), ["root:older", "path:/x", "cache:b"]);
    }
}
