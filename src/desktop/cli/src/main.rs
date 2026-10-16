//! l3: Length³ OS on the command line. Its words are the app's words: the
//! same repos, files, issues, TODO and device, read and written through the
//! same core, so what one does here is what the app shows, and back.
//!
//!   l3                       what is here
//!   l3 repo [new NAME [-t standard|c|empty]]
//!   l3 file [REPO[/PATH]]    a directory's entries, or a file's text
//!   l3 file write REPO/PATH  replace an existing file with standard input
//!   l3 issue [REPO | REPO/NNN.md | new REPO "Kind：title" [-m detail]]
//!   l3 git [REPO]            the Git page: issues, and changes handed in
//!   l3 git changes|cuts REPO changes not yet cut, by folder; the cuts so far
//!   l3 issue cut REPO/NNN.md cut them into history under that issue
//!   l3 git cut REPO "Kind：title"  …or without one
//!   l3 todo [add "Kind：title" [-m detail] | done N]
//!   l3 runtime               this device's room
//!
//! Paths may be written as File shows them: /root/<repo>/… is <repo>/….

use length3_core::{git, home, paths, repos::Repos, system, templates, text};
use std::io::{Read, Write};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

struct Args {
    words: Vec<String>,
    json: bool,
    detail: String,
    template: String,
}

fn parse(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { words: Vec::new(), json: false, detail: String::new(), template: "standard".into() };
    let mut it = raw.into_iter();
    while let Some(w) = it.next() {
        match w.as_str() {
            "--json" => a.json = true,
            "-m" | "--detail" => a.detail = it.next().ok_or("-m の後に詳細を書いてください")?,
            "-t" | "--template" => a.template = it.next().ok_or("-t の後にテンプレートを書いてください")?,
            "-h" | "--help" => a.words.insert(0, "help".into()),
            _ => a.words.push(w),
        }
    }
    Ok(a)
}

/// "hello-c/src/main.c" or "/root/hello-c/src/main.c" → ("hello-c", "src/main.c").
fn split(path: &str) -> (String, String) {
    let p = path.trim_start_matches("/root/").trim_start_matches('/').trim_end_matches('/');
    match p.split_once('/') {
        Some((repo, rest)) => (repo.to_string(), rest.to_string()),
        None => (p.to_string(), String::new()),
    }
}

fn out(s: impl AsRef<str>) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{}", s.as_ref());
}

fn json(v: impl serde::Serialize) -> Result<(), String> {
    out(serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?);
    Ok(())
}

fn bytes(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < units.len() - 1 { v /= 1024.0; u += 1; }
    if u == 0 { format!("{n} B") } else { format!("{v:.1} {}", units[u]) }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

const HELP: &str = "l3 — Length³ OS をコマンドで。アプリと同じ repo・file・Issue・TODO を扱います。

  l3                         いま何があるか
  l3 repo                    repo の一覧
  l3 repo new NAME [-t standard|c|empty]
  l3 file [REPO[/PATH]]      ディレクトリなら中身の一覧、ファイルなら本文
  l3 file write REPO/PATH    標準入力で既存のファイルを置き換える
  l3 issue [REPO]            Issue の一覧（新しく書いた順）
  l3 issue REPO/NNN.md       1件を全文で
  l3 issue new REPO \"Fix：件名\" [-m 詳細]
  l3 git [REPO]              Git：Issue と、届いた変更
  l3 git changes REPO        まだ区切っていない変更（フォルダーごと）
  l3 issue cut REPO/NNN.md [-m メモ]   その Issue として変更を区切る
  l3 git cut REPO \"Fix：件名\"   Issue なしで区切る
  l3 git cuts REPO           区切った変更
  l3 todo                    Home の TODO
  l3 todo add \"Fix：件名\" [-m 詳細]
  l3 todo done N             N 番目を完了にする（もう一度で戻す）
  l3 runtime                 この端末の容量

  --json で一覧を JSON に。パスは File と同じ /root/<repo>/… でも書けます。
  置き場所: $LENGTH3_HOME（なければアプリと同じデータの場所）";

/// Inside the app's Prompt only the open repo is here (under /root) and is
/// written back; Home's TODO, making repos and the device belong to the app.
fn in_prompt() -> bool {
    std::env::var_os("L3_PROMPT").is_some()
}

fn run(a: Args) -> Result<(), String> {
    let w: Vec<&str> = a.words.iter().map(String::as_str).collect();
    if in_prompt() {
        match w.first().copied() {
            Some("todo") => return Err("Home の TODO はこの Prompt からは見えません。アプリの Home か、端末の l3 で扱えます".into()),
            Some("runtime") => return Err("この Prompt からは端末の容量は見えません。アプリの Runtime か、端末の l3 で見られます".into()),
            Some("repo") if w.get(1) == Some(&"new") => return Err("repo は Rail の + か、端末の l3 で作ります".into()),
            _ => {}
        }
    }
    match w.as_slice() {
        [] => overview(&a),
        ["help"] | ["help", ..] => {
            out(HELP);
            let t: Vec<String> = templates::all().into_iter().map(|t| format!("{}（{}）", t.id, t.label)).collect();
            out(format!("  テンプレート: {}", t.join(" ")));
            Ok(())
        }
        ["repo"] | ["repo", "ls"] => repo_list(&a),
        ["repo", "new", name] => {
            let s = Repos::open()?.create(name, &a.template)?;
            if a.json { return json(s); }
            out(format!("{} を作りました（{} · {} ファイル）", s.name, a.template, s.files));
            Ok(())
        }
        ["file"] => repo_list(&a),
        ["file", "write", path] => {
            let (repo, rel) = split(path);
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).map_err(|e| e.to_string())?;
            let n = Repos::open()?.write(&repo, &rel, &text, 256 * 1024)?;
            out(format!("{repo}/{rel} を保存しました（{}）", bytes(n)));
            Ok(())
        }
        ["file", path] => file(&a, path),
        ["issue"] | ["git"] => issues(&a, None, w[0] == "git"),
        ["issue", "new", repo, line] => {
            let (kind, title) = text::kind_of(line);
            let name = Repos::open()?.add_issue(repo, kind.as_deref(), &title, &a.detail)?;
            out(format!("{repo}/issue/{name} に書きました"));
            Ok(())
        }
        ["issue", target] if target.trim_end_matches('/').contains('/') => issue_one(&a, target),
        ["issue", repo] => issues(&a, Some(repo), false),
        ["git", "changes", repo] => git_status(&a, repo),
        ["git", "cut", repo, line] => cut_done(&a, git::cut_in(&Repos::open()?, repo, None, line, &a.detail)?),
        ["issue", "cut", target] => {
            let (repo, rel) = split(target);
            cut_done(&a, git::cut_in(&Repos::open()?, &repo, Some(&rel), "", &a.detail)?)
        }
        ["git", "cuts", repo] => {
            let list = git::log(&Repos::open()?.dir(repo)?, 50)?;
            if a.json { return json(&list); }
            if list.is_empty() { out("区切った変更はまだありません"); }
            for c in &list { cut_line(repo, c); }
            Ok(())
        }
        ["git", repo] => issues(&a, Some(repo), true),
        ["todo"] | ["todo", "ls"] => todo_list(&a),
        ["todo", "add", line] => {
            let mut list = home::todos()?;
            let item = home::todo_from(line, &a.detail, now()).ok_or("TODO の1行目が空です")?;
            list.push(item);
            home::save_todos(&list)?;
            out(format!("TODO に足しました（{} 件）", list.len()));
            Ok(())
        }
        ["todo", "done", n] => {
            let mut list = home::todos()?;
            let k: usize = n.parse().map_err(|_| format!("{n} は番号ではありません"))?;
            let item = list.get_mut(k.wrapping_sub(1)).ok_or(format!("{k} 番目の TODO はありません"))?;
            item.done = !item.done;
            let line = format!("{} {}", if item.done { "完了にしました:" } else { "未完了に戻しました:" }, text::named(item.kind.as_deref(), &item.title));
            home::save_todos(&list)?;
            out(line);
            Ok(())
        }
        ["runtime"] => {
            let c = system::capacity(&paths::data_dir())?;
            if a.json { return json(c); }
            out(format!("この端末の容量  {}", paths::data_dir().display()));
            out(format!("  このOS   {}", bytes(c.app)));
            out(format!("  空き     {}", bytes(c.free)));
            out(format!("  全体     {}", bytes(c.total)));
            Ok(())
        }
        _ => Err(format!("わからないコマンドです: l3 {}\n`l3 help` で使い方を見られます", w.join(" "))),
    }
}

fn overview(a: &Args) -> Result<(), String> {
    let r = Repos::open()?;
    let list = r.list()?;
    let todos = if in_prompt() { Vec::new() } else { home::todos()? };
    let open = todos.iter().filter(|t| !t.done).count();
    let issues: usize = list.iter().map(|s| r.issues(&s.name).ok().flatten().map_or(0, |v| v.len())).sum();
    if a.json {
        return json(serde_json::json!({"repos": list.len(), "issues": issues, "todo": {"open": open, "all": todos.len()},
            "home": paths::data_dir()}));
    }
    if in_prompt() {
        out(format!("Length³ OS  {}（この Prompt の repo。変えたファイルは repo に書き戻されます）", paths::repos_dir().display()));
    } else {
        out(format!("Length³ OS  {}", paths::data_dir().display()));
    }
    out(format!("  repo   {}", list.len()));
    out(format!("  Issue  {issues}"));
    if !in_prompt() { out(format!("  TODO   残り {open} / {}", todos.len())); }
    out("`l3 help` で使い方を見られます");
    Ok(())
}

fn repo_list(a: &Args) -> Result<(), String> {
    let list = Repos::open()?.list()?;
    if a.json { return json(&list); }
    if list.is_empty() { out("repo はまだありません（l3 repo new NAME で作れます）"); return Ok(()); }
    for s in list {
        out(format!("{}\t{} ファイル · {}{}", s.name, s.files, bytes(s.bytes), if s.git { "" } else { " · gitなし" }));
    }
    Ok(())
}

fn file(a: &Args, path: &str) -> Result<(), String> {
    let (repo, rel) = split(path);
    let r = Repos::open()?;
    match r.tree(&repo, &rel) {
        Ok(entries) => {
            if a.json { return json(&entries); }
            // Directories first, like File.
            for e in entries {
                out(match e.kind { "dir" => format!("{}/", e.name), "link" => format!("{}@", e.name), _ => format!("{}\t{}", e.name, bytes(e.size)) });
            }
            Ok(())
        }
        Err(_) => {
            let c = r.read(&repo, &rel, 256 * 1024)?;
            match c.text {
                Some(t) => {
                    print!("{t}");
                    if c.truncated { eprintln!("l3: 先頭 {} だけ表示しました（全体 {}）", bytes(t.len() as u64), bytes(c.size)); }
                    Ok(())
                }
                None => Err(format!("{repo}/{rel} はバイナリです（{}）", bytes(c.size))),
            }
        }
    }
}

fn issues(a: &Args, only: Option<&str>, page: bool) -> Result<(), String> {
    let r = Repos::open()?;
    let names: Vec<String> = match only {
        Some(repo) => vec![repo.to_string()],
        None => r.list()?.into_iter().map(|s| s.name).collect(),
    };
    let mut all = Vec::new();
    let mut missing = Vec::new();
    for n in &names {
        match r.issues(n)? {
            Some(list) => all.extend(list),
            None => missing.push(n.clone()),
        }
    }
    if a.json { return json(&all); }
    if all.is_empty() { out("Issue はまだありません（l3 issue new REPO \"Fix：件名\" で書けます）"); }
    for i in &all {
        out(text::named(i.kind.as_deref(), &i.title));
        out(format!("    {} · issue/{}", i.repo, i.file));
    }
    if !missing.is_empty() { out(format!("issue/ がない repo: {}", missing.join(", "))); }
    if page {
        out("");
        out("提出された変更: まだ届いた変更はありません。Remote とつながると、誰がいつ push した変更かがここに並びます。");
    }
    Ok(())
}

fn cut_done(a: &Args, c: git::Commit) -> Result<(), String> {
    if a.json { return json(c); }
    out(format!("区切りました {}  {}（{} ファイル +{} −{}）", c.id, text::named(c.kind.as_deref(), &c.title), c.files, c.added, c.removed));
    Ok(())
}

fn cut_line(repo: &str, c: &git::Commit) {
    out(text::named(c.kind.as_deref(), &c.title));
    let places: Vec<String> = c.folders.iter().map(|f| if f.is_empty() { format!("{repo}/") } else { format!("{f}/") }).collect();
    let issue = c.issue.as_deref().map(|i| format!(" · {i}")).unwrap_or_default();
    out(format!("    {} · {} · {} · {} ファイル +{} −{}{issue}", c.id, c.author, ago(c.time), c.files, c.added, c.removed));
    out(format!("    {}", places.join(" ")));
}

fn ago(ms: u64) -> String {
    let s = now().saturating_sub(ms) / 1000;
    match s {
        0..=59 => "たった今".into(),
        60..=3599 => format!("{} 分前", s / 60),
        3600..=86399 => format!("{} 時間前", s / 3600),
        _ => format!("{} 日前", s / 86400),
    }
}

/// What is not yet definite, folder by folder, as Git shows it.
fn git_status(a: &Args, repo: &str) -> Result<(), String> {
    let c = git::changes(&Repos::open()?.dir(repo)?)?;
    if a.json { return json(&c); }
    if !c.git { out(format!("{repo} には .git がありません")); return Ok(()); }
    if c.files == 0 { out("まだ区切っていない変更はありません"); return Ok(()); }
    out(format!("まだ区切っていない変更  {} ファイル +{} −{}", c.files, c.added, c.removed));
    for f in &c.folders {
        out(format!("  {}/  +{} −{}", if f.folder.is_empty() { repo } else { &f.folder }, f.added, f.removed));
        for x in &f.files {
            let word = match x.status { "added" => "追加", "removed" => "削除", "renamed" => "名前変更", _ => "変更" };
            out(format!("      {word}  {}{}", x.path, if x.binary { "  （バイナリ）".to_string() } else { format!("  +{} −{}", x.added, x.removed) }));
        }
    }
    out("区切るには: l3 issue cut REPO/NNN.md（その Issue として）か l3 git cut REPO \"Fix：件名\"");
    Ok(())
}

fn issue_one(a: &Args, target: &str) -> Result<(), String> {
    let (repo, rel) = split(target);
    let file = rel.trim_start_matches("issue/");
    let r = Repos::open()?;
    let c = r.read(&repo, &format!("issue/{file}"), 256 * 1024)?;
    let i = length3_core::issues::parse(&repo, file, &c.text.ok_or("バイナリです")?);
    if a.json { return json(&i); }
    out(text::named(i.kind.as_deref(), &i.title));
    out(format!("{} · issue/{}", i.repo, i.file));
    if !i.detail.is_empty() { out(""); out(&i.detail); }
    let path = format!("issue/{}", i.file);
    let cuts: Vec<git::Commit> = git::log(&r.dir(&repo)?, 200)?.into_iter().filter(|c| c.issue.as_deref() == Some(&path)).collect();
    out("");
    if cuts.is_empty() { out("この Issue の区切りはまだありません（l3 issue cut で区切れます）"); }
    for c in &cuts { cut_line(&repo, c); }
    Ok(())
}

fn todo_list(a: &Args) -> Result<(), String> {
    let list = home::todos()?;
    if a.json { return json(&list); }
    if list.is_empty() { out("TODO はまだありません（l3 todo add \"Fix：件名\" で足せます）"); return Ok(()); }
    for (k, t) in list.iter().enumerate() {
        out(format!("{:>3} {} {}", k + 1, if t.done { "✓" } else { "○" }, text::named(t.kind.as_deref(), &t.title)));
        if !t.detail.is_empty() {
            for line in t.detail.lines() { out(format!("        {line}")); }
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    match parse(raw).and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("l3: {e}");
            ExitCode::from(1)
        }
    }
}
