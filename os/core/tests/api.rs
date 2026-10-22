//! The core's one dispatcher, as a host asks it: by name, arguments as JSON, `{ok}` or `{error}` back.

use length3_core::api;
use serde_json::json;

#[test]
fn a_page_asks_the_core_by_name() {
    let home = std::env::temp_dir().join(format!("length3-api-{}", std::process::id()));
    std::env::set_var("LENGTH3_HOME", &home);
    std::env::set_var("LENGTH3_REMOTE", "");

    let made = api::answer("repo_create", &json!({"name": "notes", "template": "empty"}));
    assert_eq!(made["ok"]["name"], "notes", "{made}");
    let added = api::answer("repo_add", &json!({"repo": "notes", "dir": "", "name": "a.txt", "text": "hello\n"}));
    assert!(added.get("ok").is_some(), "{added}");
    let wrote = api::answer("repo_write", &json!({"repo": "notes", "path": "a.txt", "text": "hi\n"}));
    assert_eq!(wrote["ok"], 3, "{wrote}");
    assert_eq!(api::answer("repo_read", &json!({"repo": "notes", "path": "a.txt"}))["ok"]["text"], "hi\n");
    let list = api::answer("repo_list", &json!({}));
    assert!(list["ok"].as_array().is_some_and(|l| l.iter().any(|r| r["name"] == "notes")), "{list}");

    // A missing argument is said by its name; a command there is not, by its.
    let missing = api::answer("repo_read", &json!({"repo": "notes"}));
    assert!(missing["error"].as_str().is_some_and(|e| e.starts_with("path")), "{missing}");
    let none = api::answer("format_disk", &json!({}));
    assert!(none["error"].as_str().is_some_and(|e| e.contains("format_disk")), "{none}");

    let _ = std::fs::remove_dir_all(&home);
}
