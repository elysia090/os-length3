use super::*;

fn bind(inside: &str, from: &str) -> Bind {
    Bind { inside: inside.into(), from: from.into(), read_only: false }
}

fn lent() -> Lent {
    Lent {
        root: "/data/system/aa/root".into(), written: false,
        binds: vec![bind("root", "/data/boxes/7/home"), bind("root/t", "/home/me/repos/a \"b\"\\c\n"), bind("var/cache", "/data/caches/t/var-cache"),
            Bind { inside: "etc/ssl".into(), from: "/etc/ssl".into(), read_only: true }],
        uid: 1000, gid: 1000, network: Some("/proc/self/ns/net".into()),
        resolver: Some(("/data/boxes/7/resolv.conf".into(), "/etc/resolv.conf".into())), console: None,
    }
}

#[test]
fn a_bundle_is_written_once_into_memory_asked_for_once_at_its_size() {
    let argv = vec!["/bin/sh".to_string(), "-c".into(), "printf 'a\tb\u{1}\n' \"$HOME\"".into()];
    let env = environment(&argv, &Told { term: "xterm-256color".into(), zone: Some("Asia/Tokyo".into()), more: vec![("TASK".into(), "say \"hi\"".into())] });
    for (screen, l) in [(None, lent()), (Some((80, 24)), Lent { console: Some("/dev/pts/0".into()), network: None, resolver: None, written: true, ..lent() }), (None, Lent::default())] {
        let run = Run { argv: &argv, env: &env, cwd: "/root/t", hostname: "box", screen };
        let b = bundle(&run, &l);
        // As long as it was counted, in the memory it was given: it never grew, so nothing was copied after it was written.
        assert_eq!(b.config.len(), length(&run, &l));
        assert_eq!(b.config.capacity(), b.config.len());
    }
}

#[test]
fn config_json_says_what_was_asked_whatever_the_words_hold() {
    let argv = vec!["/bin/sh".to_string(), "-c".into(), "printf 'a\tb\u{1}\r\n' \"$HOME\" \\ é 日本".into()];
    let env = vec!["A=1".to_string(), "B=\"q\"".into()];
    let l = lent();
    let b = bundle(&Run { argv: &argv, env: &env, cwd: "/root/t", hostname: "a \"box\"", screen: Some((132, 43)) }, &l);
    let v: serde_json::Value = serde_json::from_str(&b.config).expect("config.json is JSON");
    let words = |at: &str| -> Vec<String> { v.pointer(at).and_then(|a| a.as_array()).map(|a| a.iter().map(|s| s.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default() };
    assert_eq!(words("/process/args"), argv);
    assert_eq!(words("/process/env"), env);
    assert_eq!(v.pointer("/process/cwd").and_then(|c| c.as_str()), Some("/root/t"));
    assert_eq!(v.pointer("/hostname").and_then(|c| c.as_str()), Some("a \"box\""));
    assert_eq!(v.pointer("/process/terminal"), Some(&serde_json::json!(true)));
    assert_eq!(v.pointer("/process/consoleSize"), Some(&serde_json::json!({"height": 43, "width": 132})));
    assert_eq!(v.pointer("/root"), Some(&serde_json::json!({"path": "/data/system/aa/root", "readonly": true})));
    assert_eq!(v.pointer("/linux/uidMappings/0/hostID"), Some(&serde_json::json!(1000)));
    // Each thing lent is mounted where the box is to have it, in the order it was lent; what is only read is read-only.
    let mounts = v.pointer("/mounts").and_then(|m| m.as_array()).expect("mounts");
    let at = |to: &str| mounts.iter().position(|m| m["destination"] == to).unwrap_or_else(|| panic!("no mount at {to}"));
    assert!(at("/root") < at("/root/t") && at("/root/t") < at("/var/cache") && at("/run") < at("/etc/resolv.conf"));
    assert_eq!(mounts[at("/root/t")]["source"].as_str(), Some(l.binds[1].from.as_str()));
    assert_eq!(mounts[at("/root/t")]["options"], serde_json::json!(["rbind", "rw", "nosuid"]));
    assert_eq!(mounts[at("/etc/ssl")]["options"], serde_json::json!(["rbind", "ro", "nosuid"]));
    // The network lent is joined by its path; with none lent, the box's own is made.
    let net = |v: &serde_json::Value| v.pointer("/linux/namespaces").and_then(|n| n.as_array()).and_then(|n| n.iter().find(|s| s["type"] == "network").cloned());
    assert_eq!(net(&v), Some(serde_json::json!({"type": "network", "path": "/proc/self/ns/net"})));
    let alone: serde_json::Value = serde_json::from_str(&bundle(&Run { argv: &argv, env: &env, cwd: "/", hostname: "box", screen: None }, &Lent { network: None, ..lent() }).config).expect("JSON");
    assert_eq!(net(&alone), Some(serde_json::json!({"type": "network"})));
    assert_eq!(alone.pointer("/process/terminal"), None);
}

#[test]
fn muk_is_told_each_thing_lent_by_its_path() {
    let run = Run { argv: &[], env: &[], cwd: "/", hostname: "box", screen: None };
    let w = bundle(&run, &lent()).words("/data/boxes/7", Some("/data/boxes/7/console"), "t");
    assert_eq!(w.first().map(String::as_str), Some("run"));
    assert_eq!(&w[w.len() - 3..], ["-b", "/data/boxes/7", "t"]);
    let lends: Vec<&str> = w.windows(2).filter(|p| p[0] == "--lend").map(|p| p[1].as_str()).collect();
    assert_eq!(lends, ["/data/system/aa/root", "/data/boxes/7/home", "/home/me/repos/a \"b\"\\c\n", "/data/caches/t/var-cache", "/etc/ssl",
        "/proc/self/ns/net", "/data/boxes/7/resolv.conf"]);
    // One who is not root is lent itself by the kernel; root's muk is told.
    assert!(!w.contains(&"--ids".to_string()));
    assert!(bundle(&run, &Lent { uid: 0, gid: 0, ..lent() }).words("/b", None, "t").windows(2).any(|p| p[0] == "--ids" && p[1] == "0-0"));
}

#[test]
fn a_time_zone_passes_by_its_name_and_nothing_that_leaves_zoneinfo() {
    for z in ["Asia/Tokyo", "Etc/GMT+9", "JST-9", "America/Argentina/Buenos_Aires", "UTC"] { assert!(plain_zone(z), "{z}"); }
    for z in ["", "../etc/passwd", "/etc/localtime", "Asia/Tokyo;rm", "a b", &"x".repeat(65)] { assert!(!plain_zone(z), "{z}"); }
}

#[test]
fn a_box_runs_with_what_is_set_here_and_what_it_is_told_under_no_name_of_those() {
    let argv = vec!["/bin/bash".to_string()];
    let env = environment(&argv, &Told { term: "xterm; rm".into(), zone: Some("../x".into()),
        more: vec![("PATH".into(), "/evil".into()), ("lower".into(), "x".into()), ("TASK_1".into(), "a\0b".into()), ("".into(), "x".into())] });
    let get = |k: &str| env.iter().filter_map(|e| e.split_once('=')).filter(|(name, _)| *name == k).map(|(_, v)| v.to_string()).collect::<Vec<_>>();
    assert_eq!(get("PATH"), [PATH]);
    assert_eq!(get("TERM"), ["dumb"]);
    assert_eq!(get("SHELL"), ["/bin/bash"]);
    assert_eq!(get("ENV"), ["/etc/length3/shrc"]);
    assert_eq!(get("TZ"), Vec::<String>::new());
    assert_eq!(get("TASK_1"), ["ab"]);
    assert_eq!(get("lower"), Vec::<String>::new());
    assert_eq!(environment(&["/bin/sh".to_string()], &Told::default()).iter().find(|e| e.starts_with("SHELL=")).map(String::as_str), Some("SHELL=/bin/sh"));
}

#[test]
fn the_shell_is_bash_as_the_root_sets_it_up_and_edits_its_line_only_at_a_terminal() {
    assert_eq!(shell(Shell { bash: true, other: false, edits: false }), ["/bin/bash", "--noediting", "--rcfile", "/etc/length3/shrc", "-i"]);
    assert_eq!(shell(Shell { bash: true, other: false, edits: true }), ["/bin/bash", "--rcfile", "/etc/length3/shrc", "-i"]);
    assert_eq!(shell(Shell { bash: true, other: true, edits: true }), ["/bin/bash", "-i"]);
    assert_eq!(shell(Shell { bash: true, other: true, edits: false }), ["/bin/sh", "-i"]);
    assert_eq!(shell(Shell { bash: false, other: false, edits: true }), ["/bin/sh", "-i"]);
}
