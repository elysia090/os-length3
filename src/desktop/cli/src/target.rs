//! What the words in a call name. A repo is checked to be here; a path is
//! read from where you are in a repo; an issue is found by its number. A
//! repo written in full, `owner:repo` (DESIGN.md §5, "Names"), is read only
//! in a REPO, path or issue slot, never in text: "Docs:readme" as a title
//! is a title.

use crate::args::{owner_shaped, Call};
use crate::cmd::Ctx;
use crate::out::{Error, Result};
use length3_core::names::{self, Name};
use length3_core::{inbox, remote, repos, tr};

/// A repo written `owner:repo[/path][#n]` is one's own, read as `repo[/path][#n]`; another's is not here.
fn own(w: &str) -> Result<String> {
    if !owner_shaped(w) { return Ok(w.to_string()); }
    let Name::Repo { owner: Some(p), repo, path, issue } = names::read(w, false)? else { return Ok(w.to_string()) };
    let me = inbox::me()?;
    if !me.addresses.iter().any(|a| p.is(&a.address, &me.domain)) {
        return Err(Error::Refused(tr!("{} is not yours: a repo here is its person's (a server's own repos come next)", "{} はあなたのものではありません。ここの repo はその人のものです（サーバーの repo はこの先）", w)));
    }
    Ok(format!("{repo}{}{}", if path.is_empty() { String::new() } else { format!("/{path}") }, issue.map(|n| format!("#{n}")).unwrap_or_default()))
}

/// Not here: say so, and where it is if the Remote has it.
fn missing(ctx: &Ctx, repo: &str) -> Error {
    if !repos::valid_name(repo) {
        return Error::Usage(tr!("{:?} is not a repo name (letters, digits, . _ -)", "{:?} は repo の名前になりません（英数字と . _ -）", repo));
    }
    let there = !ctx.prompt && remote::connection().is_some() && remote::remote_repos().is_ok_and(|l| l.iter().any(|r| r.name == repo));
    Error::NotFound(if there { tr!("{} is only on the Remote (l3 repo open {} brings it here)", "{} は Remote にだけあります（l3 repo open {} でこの端末に）", repo, repo) } else { tr!("There is no repo {} here", "この端末に repo {} はありません", repo) })
}

/// The repo a word names (or, none given, the one you are in), once it is here.
pub fn repo_named(ctx: &Ctx, word: Option<&str>) -> Result<String> {
    let name = match word {
        Some(w) => own(w)?,
        None => ctx.here.as_ref().map(|h| h.repo.clone())
            .ok_or_else(|| Error::Usage(tr!("Name a repo, or run this in one", "repo を書くか、repo の中で実行してください")))?,
    };
    if ctx.has_repo(&name) { Ok(name) } else { Err(missing(ctx, &name)) }
}

/// The repo in slot `i`.
pub fn repo(ctx: &Ctx, call: &Call, i: usize) -> Result<String> {
    repo_named(ctx, call.word(i))
}

/// A path as l3 is given it, as (repo, path from its top): `/root/REPO/…`
/// and, outside a repo, `REPO/…` from the repos' top; in a repo, from where
/// you are (`/…` from its top, `..` up and out of it to another repo).
/// The repo is checked to be here; the path is not.
pub fn path_of(ctx: &Ctx, word: Option<&str>) -> Result<(String, String)> {
    let Some(w) = word else {
        let h = ctx.here.as_ref().ok_or_else(|| Error::Usage(tr!("Name a path: REPO/PATH, or run this in a repo", "パスを書いてください：REPO/PATH、または repo の中で")))?;
        return Ok((h.repo.clone(), h.folder.clone()));
    };
    let split = |s: &str| -> (String, String) {
        let s = s.trim_matches('/');
        let (r, p) = s.split_once('/').unwrap_or((s, ""));
        (r.to_string(), normal(p))
    };
    let (repo, rel) = if let Some(abs) = w.strip_prefix("/root/") {
        split(abs)
    } else if owner_shaped(w) && (ctx.here.is_none() || w.split_once(':').is_some_and(|(o, _)| o.contains('@'))) {
        // In a repo, `a.txt:3` is a file's name; there an owner is written with its domain.
        split(&own(w)?)
    } else if let Some(h) = &ctx.here {
        let (r, p) = joined(h, w);
        let first = w.split('/').next().unwrap_or_default();
        // At the top of a repo, a word naming another repo here (and nothing in this one) is that repo.
        if !w.starts_with(['.', '/']) && first != h.repo && !ctx.exists(&r, &p) && ctx.has_repo(first) { split(w) } else { (r, p) }
    } else {
        split(w)
    };
    if repo.is_empty() { return Err(Error::Usage(tr!("{} names no repo", "{} は repo を指していません", w))); }
    if !ctx.has_repo(&repo) { return Err(missing(ctx, &repo)); }
    Ok((repo, rel))
}

pub fn path(ctx: &Ctx, call: &Call, i: usize) -> Result<(String, String)> {
    path_of(ctx, call.word(i))
}

/// `w` read from where `h` is: (repo, path); `..` past the repo's top reaches the repos beside it.
fn joined(h: &length3_core::work::Here, w: &str) -> (String, String) {
    let mut at: Vec<String> = if w.starts_with('/') { vec![h.repo.clone()] } else { std::iter::once(h.repo.clone()).chain(h.folder.split('/').filter(|p| !p.is_empty()).map(String::from)).collect() };
    for part in w.split('/') {
        match part { "" | "." => {} ".." => { at.pop(); } p => at.push(p.to_string()) }
    }
    if at.is_empty() { return (String::new(), String::new()); }
    let repo = at.remove(0);
    (repo, at.join("/"))
}

fn normal(p: &str) -> String {
    p.split('/').filter(|s| !s.is_empty() && *s != ".").collect::<Vec<_>>().join("/")
}

/// An issue, as it is named and found.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueRef {
    pub repo: String,
    /// Its file in issue/ ("001.md").
    pub file: String,
}

impl IssueRef {
    /// Its line of work ("001").
    pub fn line(&self) -> String { self.file.trim_end_matches(".md").to_string() }
    /// "issue/001.md"
    pub fn path(&self) -> String { format!("issue/{}", self.file) }
    /// How a person calls it: hello#1.
    pub fn name(&self) -> String { format!("{}{}", self.repo, length3_core::issues::number(&self.file)) }
}

/// The repo an issue's word names, and which issue in it ("3", "003.md").
pub fn issue_parts(ctx: &Ctx, word: &str) -> Result<(String, String)> {
    let w = word.trim_start_matches("/root/");
    let (repo, which) = if let Some(n) = w.strip_prefix('#') {
        let h = ctx.here.as_ref().ok_or_else(|| Error::Usage(tr!("#{} names an issue of the repo you are in; elsewhere write REPO#{}", "#{} は今いる repo の Issue です。外では REPO#{} と書きます", n, n)))?;
        (h.repo.clone(), n.to_string())
    } else if let Some((r, n)) = w.split_once('#') {
        let full = own(&format!("{r}#{n}"))?;
        let (r, n) = full.split_once('#').unwrap_or((&full, ""));
        (r.to_string(), n.to_string())
    } else if let Some(file) = w.strip_prefix("issue/") {
        let h = ctx.here.as_ref().ok_or_else(|| Error::Usage(tr!("Write the repo too: REPO/issue/{}", "repo も書いてください：REPO/issue/{}", file)))?;
        (h.repo.clone(), file.to_string())
    } else {
        let full = own(w)?;
        let (r, file) = full.split_once("/issue/").ok_or_else(|| Error::Usage(tr!("{} names no issue: REPO#N or REPO/issue/NNN.md", "{} は Issue を指していません：REPO#N か REPO/issue/NNN.md", w)))?;
        (r.to_string(), file.to_string())
    };
    if which.is_empty() { return Err(Error::Usage(tr!("Which issue of {}? {}#N", "{} のどの Issue ですか？ {}#N", repo, repo))); }
    Ok((repo, which))
}

/// The issue in slot `i`, once its repo is here and it is in its issue/.
pub fn issue(ctx: &Ctx, call: &Call, i: usize) -> Result<IssueRef> {
    let (repo, which) = issue_parts(ctx, call.word(i).unwrap_or_default())?;
    let repo = repo_named(ctx, Some(&repo))?;
    let file = ctx.repos()?.issue_file(&repo, &which).map_err(Error::NotFound)?;
    Ok(IssueRef { repo, file })
}

/// An address as the Remote takes it: name@domain; a name alone is on your own Remote.
pub fn address(word: &str) -> Result<String> {
    if word.contains('@') { return Ok(word.to_ascii_lowercase()); }
    Ok(inbox::me()?.full(word))
}

#[cfg(test)]
mod tests {
    use super::*;
    use length3_core::work::Here;

    fn here(repo: &str, folder: &str) -> Here { Here { repo: repo.into(), line: "main".into(), folder: folder.into() } }

    #[test]
    fn a_path_is_read_from_where_you_are() {
        assert_eq!(joined(&here("hello", "src"), "main.c"), ("hello".into(), "src/main.c".into()));
        assert_eq!(joined(&here("hello", "src"), "/README.md"), ("hello".into(), "README.md".into()));
        assert_eq!(joined(&here("hello", "src/net"), "../a.c"), ("hello".into(), "src/a.c".into()));
        assert_eq!(joined(&here("hello", ""), "../other/x"), ("other".into(), "x".into()));
        assert_eq!(joined(&here("hello", ""), "."), ("hello".into(), "".into()));
        assert_eq!(joined(&here("hello", ""), "../.."), ("".into(), "".into()));
        assert_eq!(normal("/a//b/./c/"), "a/b/c");
    }

    #[test]
    fn paths_and_issues_from_names() {
        let out = Ctx::test(None, vec!["hello", "other"]);
        assert_eq!(path_of(&out, Some("hello/README.md")).unwrap(), ("hello".into(), "README.md".into()));
        assert_eq!(path_of(&out, Some("/root/hello/src/")).unwrap(), ("hello".into(), "src".into()));
        // A colon in a path is a path's (bug: it was read as owner:repo).
        assert_eq!(path_of(&out, Some("hello/README.md:3")).unwrap(), ("hello".into(), "README.md:3".into()));
        assert!(matches!(path_of(&out, Some("nope/x")), Err(Error::NotFound(_))));
        assert!(matches!(path_of(&out, None), Err(Error::Usage(_))));
        let inside = Ctx::test(Some("hello"), vec!["hello", "other"]);
        assert_eq!(path_of(&inside, Some("src/a.c")).unwrap(), ("hello".into(), "src/a.c".into()));
        assert_eq!(path_of(&inside, Some("other")).unwrap(), ("other".into(), "".into()));
        assert_eq!(path_of(&inside, None).unwrap(), ("hello".into(), "".into()));
        assert_eq!(issue_parts(&out, "hello#3").unwrap(), ("hello".into(), "3".into()));
        assert_eq!(issue_parts(&out, "/root/hello/issue/003.md").unwrap(), ("hello".into(), "003.md".into()));
        assert_eq!(issue_parts(&inside, "#2").unwrap(), ("hello".into(), "2".into()));
        assert_eq!(issue_parts(&inside, "issue/002.md").unwrap(), ("hello".into(), "002.md".into()));
        assert!(matches!(issue_parts(&out, "#2"), Err(Error::Usage(_))));
        assert!(matches!(issue_parts(&out, "hello#"), Err(Error::Usage(_))));
        assert!(matches!(repo_named(&out, Some("nope")), Err(Error::NotFound(_))));
        assert!(matches!(repo_named(&out, Some("a b")), Err(Error::Usage(_))));
        assert!(matches!(repo_named(&out, None), Err(Error::Usage(_))));
        assert_eq!(repo_named(&inside, None).unwrap(), "hello");
        assert_eq!(IssueRef { repo: "hello".into(), file: "003.md".into() }.name(), "hello#3");
    }
}
