//! l3: Length³ OS on the command line. Its words and its order are the
//! app's rail: Home, Forge (and its Prompt), File, Git, Runtime, Remote.
//! The same repos, issues, TODO and device, read and written through the
//! same core, so what one does here is what the app shows, and back. It
//! speaks English, or Japanese when Home's language is (or LENGTH3_LANG=ja).
//!
//! The canonical copy is the Remote's. Every change made here is sent at
//! once (the draft). Work on an issue has its own copy, which the repo
//! shows while you work on it; commit and push hand it to
//! main, where it is reviewed and merged or rejected.

mod git;
mod help;

use length3_core::{account, history, home, inbox, paths, remote, repos::Repos, templates, text, tr, usage, work};
use std::io::{Read, Write};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

struct Args {
    words: Vec<String>,
    json: bool,
    detail: String,
    template: String,
    network: bool,
}

fn parse(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { words: Vec::new(), json: false, detail: String::new(), template: "standard".into(), network: false };
    let mut it = raw.into_iter();
    while let Some(w) = it.next() {
        match w.as_str() {
            // What follows -- is a command to run, untouched.
            "--" => { a.words.push(w); a.words.extend(it.by_ref()); }
            "--json" => a.json = true,
            "--network" => a.network = true,
            "-m" | "--detail" => a.detail = it.next().ok_or_else(|| tr!("-m needs the text after it", "-m の後に詳細を書いてください"))?,
            "-t" | "--template" => a.template = it.next().ok_or_else(|| tr!("-t needs a template after it", "-t の後にテンプレートを書いてください"))?,
            "-h" | "--help" => a.words.insert(0, "help".into()),
            "-V" | "--version" => a.words.insert(0, "version".into()),
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

/// The repo you are in, and where in it: from the working directory (a
/// repo's copy, or an issue's copy of it), else the Prompt's repo.
fn here() -> Option<(String, String)> {
    let cwd = std::env::current_dir().ok()?;
    let parts = |rel: &std::path::Path, skip: usize| -> Option<(String, String)> {
        let mut it = rel.iter().map(|p| p.to_string_lossy().into_owned());
        let repo = it.next()?;
        let rest: Vec<String> = it.skip(skip).collect();
        Some((repo, rest.join("/")))
    };
    let repos = paths::repos_dir();
    if let Some(at) = cwd.strip_prefix(&repos).ok().and_then(|r| parts(r, 0)) { return Some(at); }
    // An issue's copy: <data>/work/<repo>/<line>/….
    let work = paths::data_dir().join("work");
    if let Some(at) = cwd.strip_prefix(&work).ok().filter(|r| r.iter().count() >= 2).and_then(|r| parts(r, 1)) { return Some(at); }
    std::env::var("LENGTH3_REPO").ok().filter(|r| !r.is_empty()).map(|r| (r, String::new()))
}

/// `at` (a path written from `rel` in a repo), as a path from the repo's top.
fn from_here(rel: &str, at: &str) -> String {
    let mut out: Vec<&str> = if at.starts_with('/') { Vec::new() } else { rel.split('/').filter(|p| !p.is_empty()).collect() };
    for p in at.split('/') {
        match p { "" | "." => {} ".." => { out.pop(); } _ => out.push(p) }
    }
    out.join("/")
}

/// Fill in what being in a repo says: the repo where a command takes one
/// and none is written, `#N` as that repo's issue N, and a file's path from
/// where you are.
fn fill(mut w: Vec<String>) -> Vec<String> {
    let Some(c) = w.first().and_then(|f| help::find(f)) else { return w };
    if !c.repo { return w; }
    let Some((repo, rel)) = here() else { return w };
    let named = |s: &str| Repos::open().is_ok_and(|r| r.dir(split(s).0.as_str()).is_ok());
    let end = w.iter().position(|x| x == "--").unwrap_or(w.len());
    for x in &mut w[1..end] {
        if x.len() > 1 && x.starts_with('#') && x[1..].bytes().all(|b| b.is_ascii_digit()) { *x = format!("{repo}{x}"); }
    }
    let path = |at: &str| format!("{repo}/{}", from_here(&rel, at)).trim_end_matches('/').to_string();
    match (c.name, end) {
        ("prompt", 1) => w.insert(1, repo),
        ("file", 1) => w.push(path(".")),
        ("file", 2) if w[1] != "write" && !(named(&w[1]) && rel.is_empty()) => w[1] = path(&w[1].clone()),
        ("file", 3) if w[1] == "write" && !(named(&w[2]) && rel.is_empty()) => w[2] = path(&w[2].clone()),
        ("issue", 3) if w[1] == "new" => w.insert(2, repo),
        ("git" | "main" | "commit" | "push" | "reset" | "diff" | "log", 1) => w.push(repo),
        ("commit", 2) if !named(&w[1]) && !w[1].contains('/') => w.insert(1, repo),
        _ => {}
    }
    w
}

/// Inside the app's Prompt only the open repo is here (under /root) and is
/// written back by the app, which also sends it; Home, the Remote and the
/// device belong to the app.
fn in_prompt() -> bool {
    std::env::var_os("L3_PROMPT").is_some()
}

/// After a change: send it, if this device is on a Remote (taking in what
/// the Remote has that is newer). Offline, it waits here and says so.
fn send(repo: &str) {
    if in_prompt() || remote::connection().is_none() { return; }
    match Repos::open().and_then(|r| remote::sync(&r, repo)) {
        Ok(s) => {
            for p in &s.both { eprintln!("{}", tr!("l3: {} changed on another device too; theirs is beside it as \"{}\"", "l3: {} は別の端末でも変わっていました。そちらを「{}」に置きました", p, remote::beside(p))); }
        }
        Err(e) => eprintln!("{}", tr!("l3: {}: not sent yet ({}); it goes after the next command", "l3: {}: まだ送れていません（{}）。次のコマンドのあとに送ります", repo, e)),
    }
}

/// There is no command to sync: the Remote and this device keep in step by
/// themselves. A command that reads a repo takes in the Remote's changes to
/// it first; after every command, each repo whose files differ from what was
/// last agreed is sent. Which differ is seen here, from the digests kept,
/// so a repo in step costs no request.
fn take_in(words: &[String]) {
    if in_prompt() || remote::connection().is_none() { return; }
    let w: Vec<&str> = words.iter().map(String::as_str).collect();
    let named = match w.as_slice() {
        ["prompt", repo, ..] | ["file", repo] | ["diff", repo] | ["log", repo] | ["issue", repo] => *repo,
        _ => return,
    };
    let (repo, _) = split(named.split('#').next().unwrap_or(named));
    let Ok(r) = Repos::open() else { return };
    if r.dir(&repo).is_ok() { send(&repo); }
}

fn send_changed(words: &[String]) {
    if in_prompt() || remote::connection().is_none() { return; }
    // These bring every repo into step themselves, or leave the Remote.
    if matches!(words.first().map(String::as_str), Some("help" | "login" | "logout" | "remote" | "version" | "completion" | "complete")) { return; }
    let Ok(r) = Repos::open() else { return };
    for s in r.list().unwrap_or_default() {
        if matches!(remote::status_of(&r, &s.name), Ok(st) if st.fresh || st.changed > 0) { send(&s.name); }
    }
}

#[cfg(target_os = "linux")]
fn prompt(a: &Args, repo: &str, rest: &[&str]) -> Result<(), String> {
    let (root, _) = length3_core::root::current(&paths::data_dir()).ok_or_else(|| tr!("No root yet (l3 root fetch)", "root がありません（l3 root fetch）"))?;
    let dir = Repos::open()?.dir(repo)?;
    let argv: Vec<String> = match rest {
        ["--", cmd @ ..] if !cmd.is_empty() => cmd.iter().map(|s| s.to_string()).collect(),
        [] => vec!["/bin/sh".into(), "-i".into()],
        _ => return Err("l3 prompt [REPO] [-- CMD…]".into()),
    };
    let s = length3_core::launch::Sandbox { root, repo: dir, name: repo.to_string(), argv, network: a.network, dotfiles: length3_core::launch::dotfiles(), data: Some(paths::data_dir()) };
    let code = length3_core::launch::run(&s).map_err(|e| e.to_string())?;
    send(repo);
    std::process::exit(code);
}

#[cfg(not(target_os = "linux"))]
fn prompt(_: &Args, _: &str, _: &[&str]) -> Result<(), String> {
    Err(tr!("l3 prompt is Linux only for now", "l3 prompt はいま Linux だけです"))
}

fn run(a: Args) -> Result<(), String> {
    let w: Vec<&str> = a.words.iter().map(String::as_str).collect();
    if in_prompt() {
        let elsewhere = match w.first().copied() {
            Some("todo") => Some(tr!("Home's TODO", "Home の TODO")),
            Some("runtime") | Some("free") | Some("root") => Some(tr!("this device's room and roots", "この端末の容量と root")),
            Some("inbox" | "address") => Some(tr!("the Inbox", "Inbox")),
            Some("remote" | "login" | "logout" | "start" | "main" | "commit" | "push" | "reset" | "review" | "merge" | "reject" | "log") =>
                Some(tr!("the Remote and history", "Remote と履歴")),
            Some("repo") if w.len() > 1 => Some(tr!("making or bringing repos", "repo を作ること・持ってくること")),
            Some("prompt") => Some(tr!("opening a Prompt", "Prompt を開くこと")),
            _ => None,
        };
        if let Some(what) = elsewhere {
            return Err(tr!("{} cannot be reached from this Prompt; use the app, or l3 on the device", "{} はこの Prompt からは扱えません。アプリか、端末の l3 でどうぞ", what));
        }
    }
    match w.as_slice() {
        [] => overview(&a),
        ["help"] => { out(help::overview()); Ok(()) }
        ["help", "all"] => { out(help::all()); Ok(()) }
        ["help", name, ..] => match help::find(name) {
            Some(c) => {
                out(help::command(c));
                if c.name == "repo" {
                    let t: Vec<String> = templates::all().into_iter().map(|t| format!("{} ({})", t.id, t.label)).collect();
                    out(tr!("  templates: {}", "  テンプレート: {}", t.join(" ")));
                }
                Ok(())
            }
            None => Err(help::not_a_command(&[name])),
        },
        ["version"] => {
            out(format!("l3 {}", include_str!("../../RELEASE").trim()));
            if let Some((_, i)) = length3_core::root::current(&paths::data_dir()) { out(format!("root {} {} ({})", i.name, i.version, short(&i.sha256))); }
            Ok(())
        }
        ["completion", shell] => { out(help::completion(shell)?); Ok(()) }
        ["completion"] => Err(help::completion("").unwrap_err()),
        // For completion: the repos here, one a line.
        ["complete", "repos"] => {
            for s in Repos::open()?.list()? { out(s.name); }
            Ok(())
        }
        // Home
        ["todo"] | ["todo", "ls"] => todo_list(&a),
        ["todo", "add", line] => {
            let mut list = home::todos()?;
            let item = home::todo_from(line, &a.detail, now()).ok_or_else(|| tr!("The TODO's first line is empty", "TODO の1行目が空です"))?;
            list.push(item);
            home::save_todos(&list)?;
            out(tr!("Added to TODO ({} in all)", "TODO に足しました（{} 件）", list.len()));
            Ok(())
        }
        ["todo", "done", n] => {
            let mut list = home::todos()?;
            let k: usize = n.parse().map_err(|_| tr!("{} is not a number", "{} は番号ではありません", n))?;
            let item = list.get_mut(k.wrapping_sub(1)).ok_or_else(|| tr!("There is no TODO number {}", "{} 番目の TODO はありません", k))?;
            item.done = !item.done;
            let name = text::named(item.kind.as_deref(), &item.title);
            let line = if item.done { tr!("Done: {}", "完了にしました: {}", name) } else { tr!("Not done again: {}", "未完了に戻しました: {}", name) };
            home::save_todos(&list)?;
            out(line);
            Ok(())
        }
        // Forge
        ["repo"] | ["repo", "ls"] => repo_list(&a),
        ["repo", "new", name] => {
            let s = Repos::open()?.create(name, &a.template)?;
            send(name);
            if a.json { return json(s); }
            out(tr!("Made {} ({} · {} files)", "{} を作りました（{} · {} ファイル）", s.name, a.template, s.files));
            Ok(())
        }
        ["repo", "open", name] => {
            let s = remote::fetch(&Repos::open()?, name)?;
            if a.json { return json(s); }
            out(tr!("{} is here now ({} taken in)", "{} をこの端末に開きました（{} 件を取り込み）", name, s.taken));
            Ok(())
        }
        ["prompt", repo, rest @ ..] => prompt(&a, repo, rest),
        // File
        ["file"] => repo_list(&a),
        ["file", "write", path] => {
            let (repo, rel) = split(path);
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).map_err(|e| e.to_string())?;
            let n = Repos::open()?.write(&repo, &rel, &text, 256 * 1024)?;
            send(&repo);
            out(tr!("Saved {}/{} ({})", "{}/{} を保存しました（{}）", repo, rel, bytes(n)));
            Ok(())
        }
        ["file", path] => file(&a, path),
        // Git
        ["git"] | ["issue"] => git::page(&a, None),
        ["git", repo] => git::page(&a, Some(repo)),
        ["issue", "new", repo, line] => {
            let (kind, title) = text::kind_of(line);
            let name = Repos::open()?.add_issue(repo, kind.as_deref(), &title, &a.detail)?;
            send(repo);
            out(tr!("Wrote {}/issue/{}", "{}/issue/{} に書きました", repo, name));
            Ok(())
        }
        ["issue", target] if target.contains('#') || target.trim_end_matches('/').contains('/') => git::one(&a, target),
        ["issue", repo] => git::page(&a, Some(repo)),
        ["main", repo] => {
            work::switch(&Repos::open()?, repo, work::MAIN)?;
            out(tr!("{} shows main now", "{} は main を見せています", repo));
            Ok(())
        }
        ["start", target] => {
            let r = Repos::open()?;
            let (repo, file) = git::issue_ref(&r, target)?;
            let rel = format!("issue/{file}");
            let l = work::start(&r, &repo, &rel)?;
            if a.json { return json(l); }
            out(tr!("Working on {}{} — {} shows its copy now (back with: l3 main {})", "{}{} を始めました。{} はその写しを見せています（戻るには l3 main {}）", repo, git::number(&file), repo, repo));
            Ok(())
        }
        ["commit", target] if target.contains('/') => {
            let (repo, rel) = split(target);
            cut_done(&a, history::cut(&Repos::open()?, &repo, Some(&rel), "", &a.detail)?)
        }
        ["commit", repo] => cut_done(&a, history::cut(&Repos::open()?, repo, None, "", &a.detail)?),
        ["commit", repo, line] => cut_done(&a, history::cut(&Repos::open()?, repo, None, line, &a.detail)?),
        ["push", repo] => {
            // As the app's Push: what is pushed is handed to main as the change (its next version).
            let r = Repos::open()?;
            let head = history::push(&r, repo)?;
            if head.is_empty() { out(tr!("Nothing new to push", "Push するものはありません")); } else { out(tr!("Pushed {}", "Push しました {}", short(&head))); }
            let c = history::submit(&r, repo, &a.detail)?;
            out(tr!("Handed {} to main as version {}", "{} を main に渡しました（第 {} 版）", text::named(Some(&c.kind).filter(|k| !k.is_empty()).map(|s| s.as_str()), &c.title), c.version));
            Ok(())
        }
        ["reset", repo] => {
            let c = history::reset(&Repos::open()?, repo)?;
            out(tr!("Took back {}", "取り下げました: {}", c.title));
            Ok(())
        }
        ["review", target, verdict @ ("approve" | "changes")] => {
            let (repo, line) = git::line_of(&Repos::open()?, target)?;
            let c = history::review(&repo, &line, verdict, &a.detail, &[])?;
            out(tr!("Reviewed version {} of {}", "{1} の第 {0} 版をレビューしました", c.version, text::named(Some(c.kind.as_str()).filter(|k| !k.is_empty()), &c.title)));
            Ok(())
        }
        ["reply", target, words] => {
            let (repo, line) = git::line_of(&Repos::open()?, target)?;
            let c = history::review(&repo, &line, "comment", words, &[])?;
            out(tr!("Replied under {}", "{} に返信しました", text::named(Some(c.kind.as_str()).filter(|k| !k.is_empty()), &c.title)));
            Ok(())
        }
        ["merge", target] => {
            let r = Repos::open()?;
            let (repo, line) = git::line_of(&r, target)?;
            let c = history::merge(&repo, &line)?;
            // Merged, the work is done: the repo shows main again.
            work::finish(&r, &repo, &c.line)?;
            out(tr!("Merged {} into main", "{} を main に Merge しました", text::named(Some(c.kind.as_str()).filter(|k| !k.is_empty()), &c.title)));
            send(&repo);
            Ok(())
        }
        ["reject", target] => {
            let (repo, line) = git::line_of(&Repos::open()?, target)?;
            let c = history::reject(&repo, &line, &a.detail)?;
            out(tr!("Rejected {} (its issue stays open)", "{} を Reject しました（Issue は開いたままです）", text::named(Some(c.kind.as_str()).filter(|k| !k.is_empty()), &c.title)));
            Ok(())
        }
        ["diff", target] => git::diff(target),
        ["log", repo] => {
            let list = history::log(&Repos::open()?, repo, 50)?;
            if a.json { return json(&list); }
            if list.is_empty() { out(tr!("No commits yet", "コミットはまだありません")); }
            for c in &list { cut_line(repo, c); }
            Ok(())
        }
        // Runtime
        ["runtime"] | ["free"] => runtime(&a),
        ["free", ids @ ..] => free(&a, ids),
        ["root"] => {
            let held = length3_core::root::held(&paths::data_dir());
            if a.json { return json(held.iter().map(|(r, c)| serde_json::json!({"root": r, "current": c})).collect::<Vec<_>>()); }
            if held.is_empty() { out(tr!("No root yet (l3 root fetch)", "root はまだありません（l3 root fetch）")); return Ok(()); }
            for (r, current) in held {
                out(format!("{} {}  {} · {}  {}{}", r.name, r.version, tr!("{} files", "{} ファイル", r.files), bytes(r.bytes), &r.sha256[..12],
                    if current { tr!("  in use", "  使用中") } else { String::new() }));
            }
            Ok(())
        }
        ["root", "fetch"] => {
            let url = remote::connection().map_or_else(remote::default_url, |c| c.url);
            let mut last = 0u64;
            let r = length3_core::root::fetch_and_install(&paths::data_dir(), &url, |p| match p {
                length3_core::fetch::Progress::Bytes(got, all) if got - last >= 4 << 20 || got == all => {
                    last = got;
                    eprint!("\r{}", tr!("Fetching {} / {}", "取得中 {} / {}", bytes(got), bytes(all)));
                }
                length3_core::fetch::Progress::Retry(n, why) => eprintln!("\n{}", tr!("{}. Continuing where it stopped (try {})", "{}。続きから取ります（{}回目）", why, n)),
                _ => {}
            })?;
            eprintln!();
            if a.json { return json(r); }
            out(tr!("Installed {} {} ({} files · {})", "{} {} を入れました（{} ファイル · {}）", r.name, r.version, r.files, bytes(r.bytes)));
            Ok(())
        }
        ["root", "install", bundle] => {
            let r = length3_core::root::install(&paths::data_dir(), std::path::Path::new(bundle))?;
            if a.json { return json(r); }
            out(tr!("Installed {} {} ({} files · {})", "{} {} を入れました（{} ファイル · {}）", r.name, r.version, r.files, bytes(r.bytes)));
            Ok(())
        }
        // Inbox
        ["inbox"] => {
            let list = inbox::threads()?;
            if a.json { return json(&list); }
            if list.is_empty() { out(tr!("No messages yet (l3 inbox send ADDRESS \"text\")", "まだメッセージはありません（l3 inbox send ADDRESS \"本文\"）")); }
            for t in &list {
                let state = match t.state.as_str() { "request" => tr!(" · request", " · リクエスト"), "blocked" => tr!(" · blocked", " · ブロック"), _ => String::new() };
                out(format!("{}{}{}", t.address, state, if t.unread > 0 { format!("  ({})", t.unread) } else { String::new() }));
                out(format!("    {}{}{}", if t.last.mine { tr!("you: ", "あなた: ") } else { String::new() }, kind_word(&t.last.kind), t.last.body));
            }
            Ok(())
        }
        ["inbox", "send", to, words] => {
            // As in the app: named like an issue says what it is, a /root/… path what it is about.
            let (kind, body, repo) = inbox::written(words);
            let request = inbox::send(to, &body, kind, repo.as_deref())?;
            out(if request { tr!("Sent to {} as a request (they see it once they accept you)", "{} にリクエストとして送りました（相手が受けると読まれます）", to) } else { tr!("Sent to {}", "{} に送りました", to) });
            Ok(())
        }
        ["inbox", verb @ ("accept" | "block"), who] => {
            inbox::decide(who, if *verb == "accept" { "accepted" } else { "blocked" })?;
            out(if *verb == "accept" { tr!("Accepted {}", "{} を受けました", who) } else { tr!("Blocked {}", "{} をブロックしました", who) });
            Ok(())
        }
        ["inbox", who] => {
            let c = inbox::thread(who)?;
            if a.json { return json(&c); }
            out(format!("{}{}", c.address, if c.state == "request" { tr!("  (request: l3 inbox accept {})", "  （リクエスト: l3 inbox accept {}）", c.address) } else { String::new() }));
            for m in &c.messages {
                let who = if m.mine { tr!("you", "あなた") } else { c.address.clone() };
                out(format!("  {who} · {}{}  · {}", kind_word(&m.kind), m.body, ago(m.time)));
            }
            Ok(())
        }
        ["address"] => {
            let me = inbox::me()?;
            if a.json { return json(&me); }
            if me.addresses.is_empty() { out(tr!("No address yet (l3 address claim NAME, which is NAME@{})", "アドレスはまだありません（l3 address claim NAME で NAME@{} に）", me.domain)); }
            for x in &me.addresses { out(format!("{}{}", x.address, if x.ssh { tr!("  · SSH allowed", "  · SSH 許可") } else { String::new() })); }
            Ok(())
        }
        ["address", "domain", domain] => {
            let r = inbox::domain_record(domain)?;
            if a.json { return json(&r); }
            out(tr!("Put this record in {}'s DNS (it says this account holds addresses there, and on which Remote):", "{} の DNS にこのレコードを置きます（このアカウントがそこのアドレスを持つこと、どの Remote かを示します）:", domain));
            out(format!("  {}  {}  {}", r.name, r.kind, r.value));
            out(if r.found { tr!("Found: l3 address claim NAME@{} takes an address on it", "見つかりました: l3 address claim NAME@{} でアドレスを取れます", domain) } else { tr!("Not found yet", "まだ見つかりません") });
            Ok(())
        }
        ["address", "claim", name] => {
            out(tr!("Yours: {}", "あなたのアドレス: {}", inbox::claim(name)?));
            Ok(())
        }
        // Runtime: what the Prompt is given
        ["ssh"] => {
            let me = inbox::me()?;
            if a.json { return json(&me.addresses); }
            if me.addresses.is_empty() { out(tr!("No address yet (l3 address claim NAME)", "アドレスはまだありません（l3 address claim NAME）")); }
            for x in &me.addresses { out(format!("{}  {}", x.address, if x.ssh { tr!("SSH allowed", "SSH 許可") } else { tr!("SSH off", "SSH オフ") })); }
            out(tr!("  Connecting over SSH is not built yet", "  SSH の接続はまだありません"));
            Ok(())
        }
        ["ssh", on @ ("on" | "off"), address] => {
            inbox::set_ssh(address, *on == "on")?;
            out(if *on == "on" { tr!("SSH allowed for {}", "{} に SSH を許可しました", address) } else { tr!("SSH off for {}", "{} の SSH をオフにしました", address) });
            Ok(())
        }
        ["dotfiles"] => {
            let all = length3_core::launch::dotfiles();
            if a.json { return json(all.iter().map(|(n, t)| serde_json::json!({"name": n, "bytes": t.len()})).collect::<Vec<_>>()); }
            if all.is_empty() { out(tr!("No dotfiles yet (l3 dotfile write .profile < file)", "dotfile はまだありません（l3 dotfile write .profile < file）")); }
            for (n, t) in &all { out(format!("{n}  {}", bytes(t.len() as u64))); }
            Ok(())
        }
        ["dotfile", name] => {
            let all = length3_core::launch::dotfiles();
            let (_, text) = all.iter().find(|(n, _)| n == name).ok_or_else(|| tr!("No dotfile {}", "dotfile {} はありません", name))?;
            print!("{text}");
            Ok(())
        }
        ["dotfile", verb @ ("write" | "rm"), name] => {
            if !length3_core::launch::dotfile_name(name) { return Err(tr!("A dotfile is named with a dot first: .profile", "dotfile の名前は . で始めます: .profile")); }
            let mut all: std::collections::BTreeMap<String, String> = length3_core::launch::dotfiles().into_iter().collect();
            if *verb == "write" {
                let mut text = String::new();
                std::io::stdin().read_to_string(&mut text).map_err(|e| e.to_string())?;
                all.insert(name.to_string(), text);
            } else if all.remove(*name).is_none() { return Err(tr!("No dotfile {}", "dotfile {} はありません", name)); }
            length3_core::home::set("dotfiles", &serde_json::to_string(&all).map_err(|e| e.to_string())?)?;
            out(if *verb == "write" { tr!("Saved {} (every Prompt starts with it in /root)", "{} を保存しました（どの Prompt も /root に置いて始まります）", name) } else { tr!("Removed {}", "{} を消しました", name) });
            Ok(())
        }
        // Home: the profile and the language
        ["profile"] => {
            let p = profile();
            if a.json { return json(&p); }
            if p.name.is_empty() && p.handle.is_empty() { out(tr!("No name yet (l3 profile name \"Your name\")", "名前はまだありません（l3 profile name \"名前\"）")); }
            else { out(format!("{}{}", p.name, if p.handle.is_empty() { String::new() } else { format!("  @{}", p.handle) })); }
            if !p.bio.is_empty() { out(format!("  {}", p.bio)); }
            Ok(())
        }
        ["profile", field @ ("name" | "handle" | "bio"), value] => {
            let mut p = profile();
            let v = value.trim().to_string();
            match *field {
                "name" => { if v.chars().count() > 50 { return Err(tr!("A name is up to 50 characters", "名前は 50 文字までです")); } p.name = v; }
                "handle" => {
                    let h = v.trim_start_matches('@').to_ascii_lowercase();
                    if !h.is_empty() && !(h.len() <= 32 && h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')) {
                        return Err(tr!("A handle is up to 32 lowercase letters, digits, - and _", "ハンドルは英小文字・数字・- _ の 32 文字までです"));
                    }
                    p.handle = h;
                }
                _ => { if v.chars().count() > 160 { return Err(tr!("A bio is up to 160 characters", "自己紹介は 160 文字までです")); } p.bio = v; }
            }
            length3_core::home::set("profile", &serde_json::to_string(&p).map_err(|e| e.to_string())?)?;
            out(tr!("Saved your profile", "プロフィールを保存しました"));
            Ok(())
        }
        ["lang"] => { out(length3_core::home::get("lang")?.and_then(|t| serde_json::from_str::<String>(&t).ok()).unwrap_or_else(|| "en".into())); Ok(()) }
        ["lang", l @ ("en" | "ja")] => {
            length3_core::home::set("lang", &serde_json::to_string(l).map_err(|e| e.to_string())?)?;
            out(if *l == "ja" { "日本語で話します（アプリも同じです）".to_string() } else { "Speaking English (the app does too)".to_string() });
            Ok(())
        }
        // Forge: the band
        ["band"] => {
            let b = band(&Repos::open()?)?;
            if a.json { return json(&b); }
            if b.is_empty() { out(tr!("Nothing on the band (l3 band add REPO)", "帯には何もありません（l3 band add REPO）")); }
            for n in &b { out(n); }
            Ok(())
        }
        ["band", verb @ ("add" | "rm"), repo] => {
            let r = Repos::open()?;
            let mut b = band(&r)?;
            if *verb == "add" {
                if !r.list()?.iter().any(|s| s.name == *repo) { return Err(tr!("No repo {} here (l3 repo open {})", "この端末に repo {} はありません（l3 repo open {}）", repo, repo)); }
                if !b.iter().any(|n| n == repo) { b.push(repo.to_string()); }
            } else { b.retain(|n| n != repo); }
            length3_core::home::set("band", &serde_json::to_string(&b).map_err(|e| e.to_string())?)?;
            out(if *verb == "add" { tr!("{} is on the band", "{} を帯に出しました", repo) } else { tr!("{} is off the band", "{} を帯から下げました", repo) });
            Ok(())
        }
        // Remote
        ["remote"] => remote_page(&a),
        ["remote", "sign-in"] => {
            let (keys, code, providers) = (account::passkeys()?, account::off_code()?, account::providers()?);
            if a.json { return json(serde_json::json!({"passkeys": keys, "offCode": code, "providers": providers})); }
            out(tr!("Passkeys", "パスキー"));
            if keys.is_empty() { out(tr!("  None. With one, you sign in from any device without a provider (added in the browser).", "  ありません。あればプロバイダなしでどの端末からも入れます（ブラウザで追加）。")); }
            for k in &keys { out(format!("  {}  {}", k.name.as_deref().filter(|n| !n.is_empty()).unwrap_or("passkey"), k.created_at.get(..10).unwrap_or(&k.created_at))); }
            out(tr!("Code to turn a repo off", "repo を切るときのコード"));
            out(if code.set { tr!("  Set (another is set in the browser, with a passkey)", "  設定済み（変えるのはブラウザで、パスキーを使います）") } else { tr!("  Not set (set in the browser, with a passkey)", "  未設定（ブラウザで、パスキーを使って設定）") });
            out(tr!("Sign-in providers", "サインインのプロバイダ"));
            for p in &providers { out(format!("  {}  {}", p.provider, p.created_at.get(..10).unwrap_or(&p.created_at))); }
            Ok(())
        }
        ["remote", "devices"] => {
            let list = account::devices()?;
            if a.json { return json(&list); }
            for (k, d) in list.iter().enumerate() {
                out(format!("{}. {}  {}{}", k + 1, account::device_word(d.user_agent.as_deref()), d.updated_at.get(..10).unwrap_or(&d.updated_at),
                    if d.current { tr!("  · this device (l3 logout signs it out)", "  · この端末（l3 logout で外れます）") } else { String::new() }));
            }
            Ok(())
        }
        ["remote", "devices", "rm", n] => {
            let list = account::devices()?;
            let k: usize = n.parse().map_err(|_| tr!("Give the number l3 remote devices shows", "l3 remote devices の番号を指定してください"))?;
            let d = list.get(k.wrapping_sub(1)).ok_or_else(|| tr!("No device {}", "{} 番の端末はありません", k))?;
            if d.current { return Err(tr!("That is this device: l3 logout signs it out", "それはこの端末です。l3 logout で外れます")); }
            account::end_device(&d.token)?;
            out(tr!("Removed {}; it is approved again to come back", "{} を外しました。戻るにはもう一度承認します", account::device_word(d.user_agent.as_deref())));
            Ok(())
        }
        ["remote", "on", repo] => {
            remote::turn_on(repo)?;
            out(tr!("{} is on again", "{} を戻しました", repo));
            Ok(())
        }
        ["login"] => login(&remote::default_url()),
        ["login", url] => login(url.trim_end_matches('/')),
        ["logout"] => {
            remote::logout()?;
            out(tr!("This device is off the Remote (its repos stay here)", "この端末を Remote から外しました（repo はこの端末に残ります）"));
            Ok(())
        }
        // Kept in step by itself (take_in, send_changed): there is nothing to ask for.
        ["sync", ..] => Err(tr!("There is no l3 sync: every change goes to the Remote by itself, and the Remote's come in when a repo is read. l3 remote shows where each repo stands",
            "l3 sync はありません。変更はひとりでに Remote へ送られ、Remote の変更は repo を読むときに取り込まれます。l3 remote で各 repo の状態を見られます")),
        _ => Err(help::not_a_command(&w)),
    }
}

/// A message's kind as the app says it, before its text ("Review request · …"); a plain message says nothing.
fn kind_word(kind: &str) -> String {
    match kind {
        "review" => tr!("Review request · ", "レビュー依頼 · "),
        "question" => tr!("Question · ", "質問 · "),
        "run" => tr!("Run failed · ", "実行の失敗 · "),
        _ => String::new(),
    }
}

fn short(id: &str) -> &str { &id[..12.min(id.len())] }

fn synced_line(name: &str, r: &Result<remote::Synced, String>) {
    match r {
        Ok(s) => {
            let what = match (s.sent, s.taken) {
                (0, 0) => tr!("the same", "同じです"),
                (n, 0) => tr!("sent {}", "{} 件送りました", n),
                (0, n) => tr!("took in {}", "{} 件取り込みました", n),
                (a, b) => tr!("sent {}, took in {}", "{} 件送り、{} 件取り込みました", a, b),
            };
            out(format!("{name}  {what}"));
            for p in &s.both { out(tr!("    changed on both: {} (the other device's is \"{}\")", "    両方で変わっていました: {}（別の端末のものは「{}」に）", p, remote::beside(p))); }
            for (p, why) in &s.unsynced { out(tr!("    cannot be sent: {} ({})", "    送れないもの: {}（{}）", p, why)); }
        }
        Err(e) => out(tr!("{}  not sent: {}", "{}  送れていません: {}", name, e)),
    }
}

fn login(url: &str) -> Result<(), String> {
    let code = remote::device_start(url, "l3")?;
    out(tr!("Open this page in a browser and approve:", "ブラウザでこのページを開き、承認してください:"));
    out(format!("  {}", code.verification_uri_complete));
    out(tr!("  code {}", "  コード {}", code.user_code));
    eprint!("{}", tr!("Waiting for approval…", "承認を待っています…"));
    remote::device_finish(url, "l3", &code)?;
    eprintln!();
    out(tr!("Connected · {}", "つながりました · {}", url.split("://").nth(1).unwrap_or(url)));
    let all = remote::sync_all(&Repos::open()?)?;
    for (name, r) in &all { synced_line(name, r); }
    Ok(())
}

fn overview(a: &Args) -> Result<(), String> {
    let r = Repos::open()?;
    let list = r.list()?;
    let todos = if in_prompt() { Vec::new() } else { home::todos()? };
    let open = todos.iter().filter(|t| !t.done).count();
    let issues: usize = list.iter().map(|s| r.issues(&s.name).ok().flatten().map_or(0, |v| v.len())).sum();
    let c = if in_prompt() { None } else { remote::connection() };
    if a.json {
        return json(serde_json::json!({"repos": list.len(), "issues": issues, "todo": {"open": open, "all": todos.len()},
            "home": paths::data_dir(), "remote": c.as_ref().map(|c| &c.url)}));
    }
    if in_prompt() {
        out(tr!("Length³ OS  {} (this Prompt's repo; what you change is written back and sent by the app)", "Length³ OS  {}（この Prompt の repo。変えたファイルはアプリが書き戻し、Remote に送ります）", paths::repos_dir().display()));
    } else {
        out(format!("Length³ OS  {}", paths::data_dir().display()));
        out(match &c {
            Some(c) => tr!("  Remote {} (sent as you change)", "  Remote {}（変えるたびに送ります）", c.url.split("://").nth(1).unwrap_or(&c.url)),
            None => tr!("  Remote not connected (l3 login)", "  Remote まだつないでいません（l3 login）"),
        });
    }
    out(format!("  repo   {}", list.len()));
    out(format!("  Issue  {issues}"));
    if !in_prompt() { out(tr!("  TODO   {} open of {}", "  TODO   残り {} / {}", open, todos.len())); }
    out(tr!("`l3 help` shows how to use it", "`l3 help` で使い方を見られます"));
    Ok(())
}

fn repo_list(a: &Args) -> Result<(), String> {
    let r = Repos::open()?;
    let here = r.list()?;
    let there = if in_prompt() || remote::connection().is_none() { Vec::new() } else { remote::remote_repos().unwrap_or_default() };
    let only_there: Vec<&remote::RemoteRepo> = there.iter().filter(|t| !here.iter().any(|h| h.name == t.name)).collect();
    if a.json { return json(serde_json::json!({"here": here, "remote": only_there})); }
    if here.is_empty() && only_there.is_empty() { out(tr!("No repos yet (make one with l3 repo new NAME)", "repo はまだありません（l3 repo new NAME で作れます）")); return Ok(()); }
    for s in &here {
        let mut state = String::new();
        if !in_prompt() {
            let on = r.line(&s.name);
            if on != work::MAIN { state.push_str(&tr!(" · working on issue/{}.md", " · issue/{}.md の作業中", on)); }
            state.push_str(&match remote::status_of(&r, &s.name) {
                Ok(st) if remote::connection().is_none() => if st.unsynced.is_empty() { String::new() } else { tr!(" · some things cannot be sent", " · 送れないものあり") },
                Ok(st) if st.fresh => tr!(" · not sent yet", " · まだ送っていません"),
                Ok(st) if st.changed > 0 => tr!(" · {} not sent", " · {} 件未送信", st.changed),
                Ok(_) => tr!(" · in step", " · Remote と同じ"),
                Err(_) => String::new(),
            });
        }
        out(format!("{}\t{} · {}{state}", s.name, tr!("{} files", "{} ファイル", s.files), bytes(s.bytes)));
    }
    for t in only_there {
        out(tr!("{}\tonly on the Remote · {} (l3 repo open {})", "{}\tRemote だけ · {}（l3 repo open {} で開けます）", t.name, bytes(t.bytes), t.name));
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
                    if c.truncated { eprintln!("{}", tr!("l3: shown only the first {} (of {})", "l3: 先頭 {} だけ表示しました（全体 {}）", bytes(t.len() as u64), bytes(c.size))); }
                    Ok(())
                }
                None => Err(tr!("{}/{} is binary ({})", "{}/{} はバイナリです（{}）", repo, rel, bytes(c.size))),
            }
        }
    }
}

fn cut_done(a: &Args, c: history::Cut) -> Result<(), String> {
    if a.json { return json(c); }
    out(tr!("Committed {}  {} ({}{})", "Commit しました {}  {}（{}{}）", short(&c.id), history::line(&c), git::files(c.files as usize), lines(c.added, c.removed)));
    Ok(())
}

/// Lines added and removed, when they were counted (a merge or a repo's first commit is not).
fn lines(added: u64, removed: u64) -> String { if added == 0 && removed == 0 { String::new() } else { format!(" +{added} −{removed}") } }

fn cut_line(repo: &str, c: &history::Cut) {
    out(history::line(c));
    let places: Vec<String> = c.folders.iter().map(|f| if f.is_empty() { format!("{repo}/") } else { format!("{f}/") }).collect();
    let issue = c.issue.as_deref().map(|i| format!(" · {i}")).unwrap_or_default();
    let merged = if c.merged.is_some() { tr!(" · merge", " · Merge") } else { String::new() };
    out(format!("    {} · {} · {}{}{issue}{merged}", short(&c.id), ago(c.time), git::files(c.files as usize), lines(c.added, c.removed)));
    if !places.is_empty() { out(format!("    {}", places.join(" "))); }
}

fn ago(ms: u64) -> String {
    let s = now().saturating_sub(ms) / 1000;
    match s {
        0..=59 => tr!("just now", "たった今"),
        60..=3599 => tr!("{} min ago", "{} 分前", s / 60),
        3600..=86399 => tr!("{} h ago", "{} 時間前", s / 3600),
        _ => tr!("{} days ago", "{} 日前", s / 86400),
    }
}

fn todo_list(a: &Args) -> Result<(), String> {
    let list = home::todos()?;
    if a.json { return json(&list); }
    if list.is_empty() { out(tr!("No TODO yet (add one with l3 todo add \"Fix：title\")", "TODO はまだありません（l3 todo add \"Fix：件名\" で足せます）")); return Ok(()); }
    for (k, t) in list.iter().enumerate() {
        out(format!("{:>3} {} {}", k + 1, if t.done { "✓" } else { "○" }, text::named(t.kind.as_deref(), &t.title)));
        if !t.detail.is_empty() {
            for line in t.detail.lines() { out(format!("        {line}")); }
        }
    }
    Ok(())
}

/// Runtime: the root Prompts run on, then this device — everything this OS
/// holds, largest first, each with what can be done with it.
fn runtime(a: &Args) -> Result<(), String> {
    let s = usage::space(&paths::data_dir(), &paths::repos_dir(), &[]);
    if a.json { return json(s); }
    match length3_core::root::current(&paths::data_dir()) {
        Some((_, r)) => out(tr!("root  {} {} (where Prompts run)", "root  {} {}（Prompt が動く環境）", r.name, r.version)),
        None => out(tr!("root  none yet (l3 root fetch)", "root  まだありません（l3 root fetch）")),
    }
    out("");
    out(tr!("This device  {} free of {} (the host's figures) · this OS {}", "この端末  空き {} / {}（ホストの値） · このOS {}", bytes(s.host_free), bytes(s.host_total), bytes(s.allocated)));
    for i in &s.items {
        let act = match i.room { usage::Room::Free | usage::Room::SyncFree => tr!("free", "空ける"), usage::Room::Keep => tr!("stays", "残す") };
        out(format!("  {:>9}  {}  {}  {}", bytes(i.allocated), act, i.what, i.detail));
        out(format!("             {}{}", i.why, if i.room == usage::Room::Keep { String::new() } else { format!("  (l3 free {})", i.id.strip_prefix("repo:").unwrap_or(&i.id)) }));
    }
    if s.freeable > 0 { out(tr!("Can be freed: {} (all with l3 free all)", "空けられるもの {}（l3 free all で全部）", bytes(s.freeable))); }
    Ok(())
}

fn free(a: &Args, ids: &[&str]) -> Result<(), String> {
    let data = paths::data_dir();
    let ids: Vec<String> = if ids == ["all"] {
        usage::all_freeable(&usage::space(&data, &paths::repos_dir(), &[]))
    } else {
        ids.iter().map(|i| if i.contains(':') || *i == "home" { i.to_string() } else { format!("repo:{i}") }).collect()
    };
    if ids.is_empty() { out(tr!("Nothing can be freed", "空けられるものはありません")); return Ok(()); }
    let r = usage::free(&data, &paths::repos_dir(), &ids, &[]);
    if a.json { return json(r); }
    if !r.removed.is_empty() {
        out(tr!("Freed {} ({} things, counted from the files' blocks)", "{} を空けました（{} 件、ファイルの実割当で確認）", bytes(r.freed), r.removed.len()));
        let change = r.host_free_after as i64 - r.host_free_before as i64;
        match r.reflected_ms {
            Some(ms) => out(tr!("  host free space {:+} B (seen in {} ms; observed, other programs write too)", "  ホストの空き {:+} B（{} ms で反映。他のプログラムの書込も含む観測値）", change, ms)),
            None => out(tr!("  host free space {:+} B (not seen to change within 2 s)", "  ホストの空き {:+} B（2 秒以内には反映が見えませんでした）", change)),
        }
        for id in r.removed.iter().filter(|i| i.starts_with("repo:")) {
            out(tr!("  {} stays on the Remote; l3 repo open {} brings it back", "  {} は Remote にあります。l3 repo open {} で戻ります", &id[5..], &id[5..]));
        }
    }
    for (id, why) in &r.kept { out(tr!("  kept {}: {}", "  残したもの {}: {}", id, why)); }
    Ok(())
}

/// Remote: where this device is connected, and where each repo stands.
fn remote_page(a: &Args) -> Result<(), String> {
    let Some(c) = remote::connection() else {
        out(tr!("Remote  not connected", "Remote  まだつないでいません"));
        out(tr!("  l3 login, approved in the browser, connects this device; then the Remote keeps your repos, and each change goes there by itself.", "  l3 login をブラウザで承認するとこの端末がつながり、Remote があなたの repo を持ちます。変更はひとりでに Remote へ届きます。"));
        return Ok(());
    };
    let account = remote::account();
    let r = Repos::open()?;
    // Looking at the Remote finds every repo here in step with it.
    let synced = remote::sync_all(&r).unwrap_or_default();
    let here = remote::status(&r)?;
    let there = remote::remote_repos().unwrap_or_default();
    if a.json { return json(serde_json::json!({"url": c.url, "account": account.as_ref().ok(), "here": here, "remote": there})); }
    out(format!("Remote  {}{}", c.url.split("://").nth(1).unwrap_or(&c.url), account.as_ref().ok().and_then(|a| a.as_ref()).map(|a| format!(" · {}", a.name)).unwrap_or_default()));
    if let Err(e) = &account { out(format!("  {e}")); }
    for s in &here {
        let outcome = synced.iter().find(|(n, _)| *n == s.name).map(|(_, r)| r);
        let state = match outcome {
            Some(Err(e)) => tr!("not sent: {}", "送れていません: {}", e),
            _ if s.fresh => tr!("not sent yet", "まだ送っていません"),
            _ if s.changed > 0 => tr!("{} not sent", "{} 件未送信", s.changed),
            _ => tr!("in step", "同じ"),
        };
        let stuck = if s.unsynced.is_empty() { String::new() } else { tr!(" · {} cannot be sent", " · 送れないもの {} 件", s.unsynced.len()) };
        out(format!("  {}  {state}{stuck}", s.name));
        if let Some(Ok(sy)) = outcome {
            for p in &sy.both { out(tr!("    changed on both: {} (the other device's is \"{}\")", "    両方で変わっていました: {}（別の端末のものは「{}」に）", p, remote::beside(p))); }
        }
    }
    for t in there.iter().filter(|t| t.off_at.is_some()) {
        out(tr!("  {}  off · kept {} more (l3 remote on {})", "  {}  オフ · あと {} 残ります（l3 remote on {}）", t.name, left(t.until.unwrap_or(0)), t.name));
    }
    for t in there.iter().filter(|t| t.off_at.is_none() && !here.iter().any(|h| h.name == t.name)) {
        out(tr!("  {}  only on the Remote · {}", "  {}  Remote だけ · {}", t.name, bytes(t.bytes)));
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Profile { #[serde(default)] name: String, #[serde(default)] handle: String, #[serde(default)] bio: String }

/// Home's profile, as the app keeps it.
fn profile() -> Profile {
    length3_core::home::get("profile").ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Forge's band: the repos out on it, in order, only those here.
fn band(r: &Repos) -> Result<Vec<String>, String> {
    let here: Vec<String> = r.list()?.into_iter().map(|s| s.name).collect();
    let stored: Vec<String> = length3_core::home::get("band")?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for n in stored { if here.contains(&n) && !out.contains(&n) { out.push(n); } }
    Ok(out)
}

/// How long until `until` (ms since the epoch), in days, or hours on the last day.
fn left(until: u64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let h = until.saturating_sub(now) / 3_600_000;
    if h >= 24 { tr!("{} days", "{} 日", h / 24) } else { tr!("{} hours", "{} 時間", h.max(1)) }
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let done = parse(raw).and_then(|mut a| {
        a.words = fill(std::mem::take(&mut a.words));
        let words = a.words.clone();
        take_in(&words);
        let r = run(a);
        send_changed(&words);
        r
    });
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("l3: {e}");
            ExitCode::from(1)
        }
    }
}

