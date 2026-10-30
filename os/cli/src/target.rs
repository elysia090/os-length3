//! What the words in a call name. A repo is checked to be here; a path is
//! read from where you are in a repo; an issue is found by its number. A
//! repo written in full, `owner:repo` (DESIGN.md §5, "Names"), is read only
//! in a REPO, path or issue slot, never in text: "Docs:readme" as a title
//! is a title.

use crate::args::{owner_shaped, Call};
use crate::cmd::Ctx;
use crate::out::{Error, Result};
use length3_core::names::{self, Name};
use length3_core::{inbox, issues, remote, repos, text, tr};

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

/// The repo in slot `i`. None named outside a repo, the mistake says the form with REPO in it and the repos
/// there are to put there (bug: "Name a repo, or run this in one", and neither which form nor which repos).
pub fn repo(ctx: &Ctx, call: &Call, i: usize) -> Result<String> {
    repo_named(ctx, call.word(i)).map_err(|e| match e {
        Error::Usage(_) if call.word(i).is_none() => {
            let form = crate::spec::usage(call.command, call.form).replacen("[REPO]", "REPO", 1);
            let here: Option<Vec<String>> = ctx.repos().and_then(|r| Ok(r.list()?)).ok().map(|l| l.into_iter().map(|s| s.name).collect());
            let some = match here {
                None => String::new(),
                Some(h) if h.is_empty() => tr!(" (there is none yet: l3 repo new NAME)", "（まだありません：l3 repo new NAME）"),
                Some(h) if h.len() <= 5 => tr!(": {}", "：{}", h.join(", ")),
                Some(h) => tr!(": {}, … (l3 repo)", "：{}、…（l3 repo）", h[..5].join(", ")),
            };
            Error::Usage(tr!("Name a repo ({}), or run it in one{}", "repo を書くか（{}）、repo の中で実行してください{}", form, some))
        }
        e => e,
    })
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
    } else if w.starts_with('/') {
        // Outside a repo, / is the device's own: l3 reads the repos only, kept under /root (as a Prompt sees them).
        if w.trim_end_matches('/') == "/root" {
            return Err(Error::Usage(tr!("Name a repo in /root: /root/REPO/PATH (l3 file lists them)", "/root の中の repo を書いてください：/root/REPO/PATH（l3 file で一覧）")));
        }
        return Err(Error::NotFound(tr!("{} is not in your repos: l3 reads them as /root/REPO/PATH or REPO/PATH (the rest of / is a Prompt's root, seen inside it)",
            "{} は repo の中ではありません。l3 が読むのは /root/REPO/PATH か REPO/PATH です（/ のほかは Prompt の root で、その中から見えます）", w)));
    } else {
        split(w)
    };
    if repo.is_empty() { return Err(Error::Usage(tr!("{} names no repo", "{} は repo を指していません", w))); }
    if !ctx.has_repo(&repo) { return Err(missing(ctx, &repo)); }
    // `..` is read from where you are only; in REPO/PATH it leaves the repo, as the core says, before anything outside is looked at.
    if rel.split('/').any(|p| p == "..") { return Err(Error::Refused(tr!("{} leaves the repo", "{} は repo の外です", w))); }
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

/// An issue, as it is named and found. A person names it by its number or
/// its title; which file holds it is the OS's to know (it is in data only).
#[derive(Debug, Clone, PartialEq)]
pub struct IssueRef {
    pub repo: String,
    /// The file that holds it ("001.md"), never shown in text.
    pub file: String,
    /// Its first line: "Fix：title".
    pub title: String,
}

impl IssueRef {
    /// Its line of work ("001").
    pub fn line(&self) -> String { self.file.trim_end_matches(".md").to_string() }
    /// Where the core keeps it ("issue/001.md").
    pub fn path(&self) -> String { format!("issue/{}", self.file) }
    /// How a person calls it: hello#1; one still without a number, by its words.
    pub fn name(&self) -> String { called(&self.repo, &self.file, &self.title) }
    /// hello#1 Fix：title
    pub fn shown(&self) -> String {
        if issues::number_of(&self.file).is_some() { format!("{} {}", self.name(), self.title) } else { format!("{} {}", self.repo, self.title) }
    }
}

/// How an issue is called where a command names it: hello#1; one without a
/// number yet, by its first line in quotes (as l3 finds it by its words).
pub fn called(repo: &str, file: &str, first_line: &str) -> String {
    match issues::number_of(file) { Some(n) => format!("{repo}#{n}"), None => format!("\"{first_line}\"") }
}

/// Whether a word names an issue by its number (3, #3, hello#3), or by the
/// file that holds it (still read, never asked for).
pub fn numbered(w: &str) -> bool {
    w.contains('#') || w.contains("issue/") || (!w.is_empty() && w.bytes().all(|b| b.is_ascii_digit()))
}

/// The repo an issue's number names, and which issue in it ("3"). A bare
/// number is of the repo you are in (outside one, see `issue`).
pub fn issue_parts(ctx: &Ctx, word: &str) -> Result<(String, String)> {
    let w = word.trim_start_matches("/root/");
    let bare = !w.is_empty() && w.bytes().all(|b| b.is_ascii_digit());
    let (repo, which) = if let Some(n) = w.strip_prefix('#').or(if bare { Some(w) } else { None }) {
        let h = ctx.here.as_ref().ok_or_else(|| Error::Usage(tr!("#{} names an issue of the repo you are in; elsewhere write REPO#{}", "#{} は今いる repo の Issue です。外では REPO#{} と書きます", n, n)))?;
        (h.repo.clone(), n.to_string())
    } else if let Some((r, n)) = w.split_once('#') {
        let full = own(&format!("{r}#{n}"))?;
        let (r, n) = full.split_once('#').unwrap_or((&full, ""));
        (r.to_string(), n.to_string())
    } else if let Some(file) = w.strip_prefix("issue/") {
        let h = ctx.here.as_ref().ok_or_else(|| Error::Usage(tr!("Name the issue by its number: REPO#N", "Issue は番号で書いてください：REPO#N")))?;
        (h.repo.clone(), file.to_string())
    } else {
        let full = own(w)?;
        let (r, file) = full.split_once("/issue/").ok_or_else(|| Error::Usage(tr!("{} names no issue: #N in its repo, REPO#N, or words of its title", "{} は Issue を指していません：repo の中なら #N、外なら REPO#N、またはその件名の言葉", w)))?;
        (r.to_string(), file.to_string())
    };
    if which.is_empty() { return Err(Error::Usage(tr!("Which issue of {}? {}#N", "{} のどの Issue ですか？ {}#N", repo, repo))); }
    Ok((repo, which))
}

/// The issue in slot `i`: by its number (#3 in its repo, REPO#3), or by the
/// words of its title, among the repo you are in (else every repo here).
pub fn issue(ctx: &Ctx, call: &Call, i: usize) -> Result<IssueRef> {
    let w = call.word(i).unwrap_or_default();
    // Issues are main's, whatever work the repo shows.
    let r = ctx.repos()?.on_main();
    let bare = !w.is_empty() && w.bytes().all(|b| b.is_ascii_digit());
    let (repo, file) = if bare && ctx.here.is_none() {
        by_number(&r, w)?
    } else if numbered(w) {
        let (repo, which) = issue_parts(ctx, w)?;
        let repo = repo_named(ctx, Some(&repo))?;
        let file = r.issue_file(&repo, &which).map_err(Error::NotFound)?;
        (repo, file)
    } else {
        by_title(ctx, &r, w)?
    };
    let title = r.read(&repo, &format!("issue/{file}"), 256 * 1024).ok().and_then(|c| c.text)
        .map(|t| { let i = issues::parse(&repo, &file, &t); text::named(i.kind.as_deref(), &i.title) }).unwrap_or_default();
    Ok(IssueRef { repo, file, title })
}

/// A bare number outside a repo: the one repo here that has an issue of that number.
fn by_number(r: &repos::Repos, n: &str) -> Result<(String, String)> {
    let mut found = Vec::new();
    for s in r.list()? {
        if let Ok(file) = r.issue_file(&s.name, n) { found.push((s.name, file)); }
    }
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(Error::NotFound(tr!("No repo here has an issue #{}", "#{} の Issue がある repo はありません", n.trim_start_matches('0')))),
        _ => Err(Error::Usage(tr!("#{} is in more than one repo: {}", "#{} は複数の repo にあります：{}", n.trim_start_matches('0'),
            found.iter().map(|(repo, _)| format!("{repo}#{}", n.trim_start_matches('0'))).collect::<Vec<_>>().join(", ")))),
    }
}

/// The one issue whose title the words name; several are a choice to make, not a guess.
fn by_title(ctx: &Ctx, r: &repos::Repos, words: &str) -> Result<(String, String)> {
    let names: Vec<String> = match &ctx.here { Some(h) => vec![h.repo.clone()], None => r.list()?.into_iter().map(|s| s.name).collect() };
    let mut all = Vec::new();
    for n in &names { all.extend(r.issues(n)?); }
    all.sort_by(|a, b| a.repo.cmp(&b.repo).then(a.n.unwrap_or(u64::MAX).cmp(&b.n.unwrap_or(u64::MAX))).then(a.file.cmp(&b.file)));
    match issues::by_title(&all, words).as_slice() {
        [one] => Ok((one.repo.clone(), one.file.clone())),
        [] => Err(Error::NotFound(match &ctx.here {
            Some(h) => tr!("No issue of {} is called \"{}\" (l3 git lists them)", "{} に「{}」という Issue はありません（l3 git で一覧）", h.repo, words),
            None => tr!("No issue here is called \"{}\" (l3 git lists them)", "「{}」という Issue はここにありません（l3 git で一覧）", words),
        })),
        many => {
            let rows: Vec<String> = many.iter().map(|i| {
                let at = i.n.map_or_else(|| i.repo.clone(), |n| format!("{}#{n}", i.repo));
                format!("  {at} {}", text::named(i.kind.as_deref(), &i.title))
            }).collect();
            Err(Error::Usage(tr!("\"{}\" could be any of these; name one by its number:\n{}", "「{}」はどれのことか決まりません。番号で書いてください：\n{}", words, rows.join("\n"))))
        }
    }
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
        // `..` in REPO/PATH leaves the repo (bug: kept, so what is outside was looked at, and said not to be there).
        for w in ["hello/../other/x", "/root/hello/../../etc", "hello/src/../../x"] {
            assert!(matches!(path_of(&out, Some(w)), Err(Error::Refused(_))), "{w}");
        }
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
        // None named outside a repo: the form with REPO in it (bug: "Name a repo, or run this in one").
        let call = crate::args::parse(&["commit".to_string()], &out).unwrap();
        let Err(Error::Usage(m)) = repo(&out, &call, 0) else { panic!() };
        assert!(m.contains(&format!("l3 commit REPO [-m {}]", crate::spec::placeholder("note"))), "{m}");
        let i = IssueRef { repo: "hello".into(), file: "003.md".into(), title: "Fix：x".into() };
        assert_eq!((i.name(), i.shown(), i.line()), ("hello#3".into(), "hello#3 Fix：x".into(), "003".into()));
        assert!(numbered("#3") && numbered("hello#3") && numbered("3") && !numbered("restart loses") && !numbered("3rd"));
        assert_eq!(issue_parts(&inside, "3").unwrap(), ("hello".into(), "3".into()));
        let loose = IssueRef { repo: "hello".into(), file: "notes.md".into(), title: "Docs：notes".into() };
        assert_eq!((loose.name(), loose.shown()), ("\"Docs：notes\"".into(), "hello Docs：notes".into()));
    }
}
