//! The tests of text/names.rs.

use super::*;
fn p(n: &str, d: Option<&str>) -> Principal { Principal { name: n.into(), domain: d.map(Into::into) } }

#[test]
fn a_names_kind_is_read_from_its_shape() {
    assert_eq!(read("ren@length3.com", false).unwrap(), Name::Principal(p("ren", Some("length3.com"))));
    assert_eq!(read("trip", true).unwrap(), Name::Principal(p("trip", None)));
    assert_eq!(read("hello", false).unwrap(), Name::Repo { owner: None, repo: "hello".into(), path: "".into(), issue: None });
    assert_eq!(read("/root/hello/src/a.c", false).unwrap(), Name::Repo { owner: None, repo: "hello".into(), path: "src/a.c".into(), issue: None });
    assert_eq!(read("hello#3", false).unwrap(), Name::Repo { owner: None, repo: "hello".into(), path: "".into(), issue: Some(3) });
    assert_eq!(read("trip@length3.com:hello#3", false).unwrap(), Name::Repo { owner: Some(p("trip", Some("length3.com"))), repo: "hello".into(), path: "".into(), issue: Some(3) });
    assert_eq!(read("trip:hello/src", false).unwrap(), Name::Repo { owner: Some(p("trip", None)), repo: "hello".into(), path: "src".into(), issue: None });
    assert_eq!(read("trip#general", false).unwrap(), Name::Board { server: Some(p("trip", None)), board: "general".into() });
    assert_eq!(read("#general", false).unwrap(), Name::Board { server: None, board: "general".into() });
    assert!(read("hello#x3", false).is_ok_and(|n| matches!(n, Name::Board { .. })));
    assert!(read("a b:c", false).is_err());
    assert!(read("hello#", false).is_err());
    assert!(p("trip", None).is("trip@length3.com", "length3.com"));
    assert!(p("trip", None).is("Trip@Length3.com", "length3.com"));
    assert!(!p("trip", Some("ren.dev")).is("trip@length3.com", "length3.com"));
    assert!(!p("trip", None).is("trip", "length3.com") && !p("trip", None).is("tri@length3.com", "length3.com"));
}

#[test]
fn a_git_folder_is_known_however_it_is_spelt() {
    for git in [".git", ".GIT", ".Git.", ".git ", ".git. .", "git~1", "GIT~1", ".g\u{200c}it", "\u{feff}.git", ".git\u{200d}"] {
        assert!(is_git_name(git), "{git:?}");
    }
    for not in ["", ".", "git", ".gi", ".gitignore", "..git", ".git.git", ".gi t", "x.git", "git~2", "main.rs", ".github"] {
        assert!(!is_git_name(not), "{not:?}");
    }
}
