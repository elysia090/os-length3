use super::*;

#[test]
fn a_prompt_is_told_its_repo_and_language_and_what_a_task_says_under_no_name_of_those() {
    let all = told("t", "fr", &[("WHY_REPO".into(), "other".into()), ("TASK".into(), "x".into())]);
    let get = |k: &str| all.iter().filter(|(name, _)| name == k).map(|(_, v)| v.as_str()).collect::<Vec<_>>();
    assert_eq!(get("WHY_REPO"), ["t"]);
    assert_eq!(get("WHY_LANG"), ["en"]);
    assert_eq!(get("LENGTH3_REPO"), ["t"]);
    assert_eq!(get("TASK"), ["x"]);
    assert_eq!(told("t", "ja", &[]).iter().find(|(k, _)| k == "WHY_LANG").map(|(_, v)| v.as_str()), Some("ja"));
}

#[test]
fn a_page_is_given_the_bundle_of_what_it_lends_the_repo_where_the_box_starts() {
    let a: Asked = serde_json::from_value(serde_json::json!({"repo": "hello", "shell": {"bash": true}, "lang": "ja",
        "told": {"term": "xterm-256color", "zone": "Asia/Tokyo", "more": [["COLORTERM", "truecolor"]]},
        "lent": {"root": "/", "written": true, "console": "/dev/pts/0"}, "dir": "/run/box"})).unwrap();
    let (config, words) = asked(&a);
    let v: serde_json::Value = serde_json::from_str(&config).unwrap();
    assert_eq!(v["process"]["cwd"], "/root/hello");
    assert_eq!(v["process"]["args"], serde_json::json!(["/bin/bash", "--noediting", "--rcfile", "/etc/length3/shrc", "-i"]));
    let env: Vec<&str> = v["process"]["env"].as_array().unwrap().iter().filter_map(|e| e.as_str()).collect();
    for e in ["TERM=xterm-256color", "TZ=Asia/Tokyo", "COLORTERM=truecolor", "WHY_REPO=hello", "WHY_LANG=ja", "ENV=/etc/length3/shrc", "HOME=/root"] { assert!(env.contains(&e), "{e}: {env:?}"); }
    assert_eq!(v["hostname"], "why");
    assert_eq!(v["root"], serde_json::json!({"path": "/", "readonly": false}));
    assert_eq!(words, ["run", "--lend", "/", "--lend", "/dev/pts/0", "--ids", "0-0", "-b", "/run/box", "box"]);
    // No repo yet (a Prompt readied ahead): it starts at home.
    let (config, _) = asked(&Asked { repo: String::new(), ..a });
    assert_eq!(serde_json::from_str::<serde_json::Value>(&config).unwrap()["process"]["cwd"], "/root");
}
