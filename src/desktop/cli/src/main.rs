//! l3: Length³ OS on the command line. Its words and its order are the
//! app's rail: Home, Forge (and its Prompt), File, Git, Runtime, Remote.
//! The same repos, issues, TODO and device, read and written through the
//! same core, so what one does here is what the app shows, and back. It
//! speaks English, or Japanese when Home's language is (or LENGTH3_LANG=ja).
//!
//! The canonical copy is the Remote's. Every change made here is sent at
//! once (the draft). Work on an issue has its own copy, which the repo
//! shows while you work on it; commit, push and Submit change hand it to
//! main, where it is reviewed and merged or rejected.

use length3_core::{history, home, paths, remote, repos::Repos, templates, text, tr, usage, work};
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

fn help() -> String {
    tr!("l3 — Length³ OS on the command line, in the app's words and order.

Home
  l3                          this device and the Remote, repos, TODO
  l3 todo                     TODO
  l3 todo add \"Fix：title\" [-m detail]
  l3 todo done N              mark the Nth done (again to undo)
Forge
  l3 repo                     repos here, and those only on the Remote
  l3 repo new NAME [-t standard|c|empty]
  l3 repo open NAME           bring one from the Remote
  l3 prompt REPO [-- CMD…]    the Prompt: the repo inside the root (no privileges)
      --network               give it the network (off by default)
File
  l3 file [REPO[/PATH]]       a directory's entries, or a file's text
  l3 file write REPO/PATH     replace a file with standard input
Git
  l3 git [REPO]               issues, the work on them, and changes handed in
  l3 issue [REPO | REPO/NNN.md]
  l3 issue new REPO \"Fix：title\" [-m detail]
  l3 work REPO/issue/NNN.md   work on that issue (its own copy of the repo)
  l3 work REPO main           back to main
  l3 commit REPO [-m note]    commit the work, named after its issue
  l3 commit REPO \"Fix：title\" on main, named by the line
  l3 push REPO                push the work's commits
  l3 submit REPO [-m note]    Submit change (again after more commits)
  l3 reset REPO               take back the change you submitted
  l3 changes REPO             changes handed in to main, with reviews
  l3 review REPO ID approve|changes|comment [-m note]
  l3 merge REPO ID            main takes the change
  l3 reject REPO ID [-m why]  main does not
  l3 log REPO                 the commits of the work shown
Runtime
  l3 runtime                  the root, and this device by size: what can go
  l3 free ID… | l3 free all   free (sync and free for a repo with changes)
  l3 root fetch | install BUNDLE
Remote
  l3 remote                   the Remote this device is on, and each repo
  l3 login [URL]              connect: approve in the browser
  l3 logout
  l3 sync [REPO]              now (it also happens after every change)

  --json for JSON. Paths may be written as File shows them: /root/<repo>/….
  Where: $LENGTH3_HOME (else the app's own data directory).
  Language: Home's (the app's menu), or LENGTH3_LANG=ja|en.", "l3 — Length³ OS をコマンドで。アプリの rail と同じ言葉と順番です。

Home
  l3                          この端末と Remote、repo、TODO
  l3 todo                     TODO
  l3 todo add \"Fix：件名\" [-m 詳細]
  l3 todo done N              N 番目を完了に（もう一度で戻す）
Forge
  l3 repo                     repo（この端末にあるもの、Remote だけにあるもの）
  l3 repo new NAME [-t standard|c|empty]
  l3 repo open NAME           Remote から持ってくる
  l3 prompt REPO [-- CMD…]    Prompt: root の中で repo を開く（権限なし）
      --network               ネットワークを渡す（既定ではなし）
File
  l3 file [REPO[/PATH]]       ディレクトリなら中身、ファイルなら本文
  l3 file write REPO/PATH     標準入力で既存のファイルを置き換える
Git
  l3 git [REPO]               Issue と、その作業、届いた変更
  l3 issue [REPO | REPO/NNN.md]
  l3 issue new REPO \"Fix：件名\" [-m 詳細]
  l3 work REPO/issue/NNN.md   その Issue の作業をする（repo の写しがその作業になる）
  l3 work REPO main           main に戻る
  l3 commit REPO [-m メモ]    作業を区切る（Issue の名前で）
  l3 commit REPO \"Fix：件名\"  main で区切る
  l3 push REPO                作業の区切りを push
  l3 submit REPO [-m メモ]    Submit change（区切りを足したらもう一度）
  l3 reset REPO               提出した変更を取り下げる
  l3 changes REPO             main に届いた変更とレビュー
  l3 review REPO ID approve|changes|comment [-m メモ]
  l3 merge REPO ID            main に取り込む
  l3 reject REPO ID [-m 理由] 取り込まない
  l3 log REPO                 いまの作業の区切り
Runtime
  l3 runtime                  root と この端末: 容量順、空けられるもの
  l3 free ID… | l3 free all   空ける（変更があれば送ってから）
  l3 root fetch | install BUNDLE
Remote
  l3 remote                   つながっている Remote と、repo の同期
  l3 login [URL]              ブラウザで承認してつなぐ
  l3 logout
  l3 sync [REPO]              いま送る・取り込む（ふだんは変えるたびに自動）

  --json で JSON に。パスは File と同じ /root/<repo>/… でも書けます。
  置き場所: $LENGTH3_HOME（なければアプリと同じデータの場所）
  言語: Home の設定（アプリのメニュー）か LENGTH3_LANG=ja|en")
}

/// Inside the app's Prompt only the open repo is here (under /root) and is
/// written back by the app, which also sends it; Home, the Remote and the
/// device belong to the app.
fn in_prompt() -> bool {
    std::env::var_os("L3_PROMPT").is_some()
}

/// After a change: send it, if this device is on a Remote. Offline, it waits
/// for the next sync and says so.
fn send(repo: &str) {
    if in_prompt() || remote::connection().is_none() { return; }
    match Repos::open().and_then(|r| remote::sync(&r, repo)) {
        Ok(s) => {
            for p in &s.both { eprintln!("{}", tr!("l3: {} changed on another device too; theirs is beside it as \"{}\"", "l3: {} は別の端末でも変わっていました。そちらを「{}」に置きました", p, remote::beside(p))); }
        }
        Err(e) => eprintln!("{}", tr!("l3: not sent yet ({}); the next sync sends it", "l3: まだ送れていません（{}）。次の同期で送ります", e)),
    }
}

#[cfg(target_os = "linux")]
fn prompt(a: &Args, repo: &str, rest: &[&str]) -> Result<(), String> {
    let (root, _) = length3_core::root::current(&paths::data_dir()).ok_or_else(|| tr!("No root yet (l3 root fetch)", "root がありません（l3 root fetch）"))?;
    let dir = Repos::open()?.dir(repo)?;
    let argv: Vec<String> = match rest {
        ["--", cmd @ ..] if !cmd.is_empty() => cmd.iter().map(|s| s.to_string()).collect(),
        [] => vec!["/bin/sh".into(), "-i".into()],
        _ => return Err("l3 prompt REPO [-- CMD…]".into()),
    };
    let s = length3_core::launch::Sandbox { root, repo: dir, name: repo.to_string(), argv, network: a.network };
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
            Some("remote" | "login" | "logout" | "sync" | "work" | "commit" | "push" | "submit" | "reset" | "changes" | "review" | "merge" | "reject" | "log") =>
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
        ["help"] | ["help", ..] => {
            out(help());
            let t: Vec<String> = templates::all().into_iter().map(|t| format!("{} ({})", t.id, t.label)).collect();
            out(tr!("  templates: {}", "  テンプレート: {}", t.join(" ")));
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
        ["git"] => issues(&a, None),
        ["git", repo] => git_page(&a, repo),
        ["issue"] => issues(&a, None),
        ["issue", "new", repo, line] => {
            let (kind, title) = text::kind_of(line);
            let name = Repos::open()?.add_issue(repo, kind.as_deref(), &title, &a.detail)?;
            send(repo);
            out(tr!("Wrote {}/issue/{}", "{}/issue/{} に書きました", repo, name));
            Ok(())
        }
        ["issue", target] if target.trim_end_matches('/').contains('/') => issue_one(&a, target),
        ["issue", repo] => issues(&a, Some(repo)),
        ["work", repo, "main"] => {
            work::switch(&Repos::open()?, repo, work::MAIN)?;
            out(tr!("{} shows main now", "{} は main を見せています", repo));
            Ok(())
        }
        ["work", target] => {
            let (repo, rel) = split(target);
            let l = work::start(&Repos::open()?, &repo, &rel)?;
            if a.json { return json(l); }
            out(tr!("Working on {} — {} shows this work's copy now (back with: l3 work {} main)", "{} の作業をしています。{} はこの作業の写しを見せています（戻るには l3 work {} main）", rel, repo, repo));
            Ok(())
        }
        ["commit", target] if target.contains('/') => {
            let (repo, rel) = split(target);
            cut_done(&a, history::cut(&Repos::open()?, &repo, Some(&rel), "", &a.detail)?)
        }
        ["commit", repo] => cut_done(&a, history::cut(&Repos::open()?, repo, None, "", &a.detail)?),
        ["commit", repo, line] => cut_done(&a, history::cut(&Repos::open()?, repo, None, line, &a.detail)?),
        ["push", repo] => {
            let head = history::push(&Repos::open()?, repo)?;
            out(tr!("Pushed {}", "push しました {}", short(&head)));
            Ok(())
        }
        ["submit", repo] => {
            let c = history::submit(&Repos::open()?, repo, &a.detail)?;
            if a.json { return json(c); }
            out(tr!("Submitted {} as version {} ({})", "{} を提出しました（第 {} 版 · {}）", text::named(Some(&c.kind).filter(|k| !k.is_empty()).map(|s| s.as_str()), &c.title), c.version, short(&c.id)));
            Ok(())
        }
        ["reset", repo] => {
            let c = history::reset(&Repos::open()?, repo)?;
            out(tr!("Took back {}", "取り下げました: {}", c.title));
            Ok(())
        }
        ["changes", repo] => changes_in(&a, repo),
        ["review", repo, id, verdict] => {
            let c = history::review(repo, id, verdict, &a.detail)?;
            out(tr!("Reviewed version {} of {}", "{1} の第 {0} 版をレビューしました", c.version, c.title));
            Ok(())
        }
        ["merge", repo, id] => {
            let c = history::merge(repo, id)?;
            out(tr!("Merged {} into main", "{} を main に Merge しました", c.title));
            send(repo);
            Ok(())
        }
        ["reject", repo, id] => {
            let c = history::reject(repo, id, &a.detail)?;
            out(tr!("Rejected {} (its issue stays open)", "{} を Reject しました（Issue は開いたままです）", c.title));
            Ok(())
        }
        ["log", repo] => {
            let list = history::log(&Repos::open()?, repo, 50)?;
            if a.json { return json(&list); }
            if list.is_empty() { out(tr!("No commits yet", "区切りはまだありません")); }
            for c in &list { cut_line(c); }
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
        // Remote
        ["remote"] => remote_page(&a),
        ["login"] => login(&remote::default_url()),
        ["login", url] => login(url.trim_end_matches('/')),
        ["logout"] => {
            remote::logout()?;
            out(tr!("This device is off the Remote (its repos stay here)", "この端末を Remote から外しました（repo はこの端末に残ります）"));
            Ok(())
        }
        ["sync"] => {
            let all = remote::sync_all(&Repos::open()?)?;
            if a.json { return json(all.iter().map(|(n, r)| serde_json::json!({"repo": n, "ok": r.as_ref().ok(), "error": r.as_ref().err()})).collect::<Vec<_>>()); }
            for (name, r) in &all { synced_line(name, r); }
            if all.is_empty() { out(tr!("No repos on this device (bring one from the Remote with l3 repo open NAME)", "この端末に repo はありません（Remote の repo は l3 repo open NAME）")); }
            Ok(())
        }
        ["sync", repo] => {
            let r = remote::sync(&Repos::open()?, repo);
            if a.json { return json(&r); }
            synced_line(repo, &r);
            r.map(|_| ())
        }
        _ => Err(tr!("Not a command: l3 {}\n`l3 help` shows how to use it", "わからないコマンドです: l3 {}\n`l3 help` で使い方を見られます", w.join(" "))),
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

fn issues(a: &Args, only: Option<&str>) -> Result<(), String> {
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
    if all.is_empty() { out(tr!("No issues yet (write one with l3 issue new REPO \"Fix：title\")", "Issue はまだありません（l3 issue new REPO \"Fix：件名\" で書けます）")); }
    for i in &all {
        out(text::named(i.kind.as_deref(), &i.title));
        out(format!("    {} · issue/{}", i.repo, i.file));
    }
    if !missing.is_empty() { out(tr!("repos without issue/: {}", "issue/ がない repo: {}", missing.join(", "))); }
    Ok(())
}

/// The Git page for one repo: its issues, the work it shows, what is not
/// committed, and the changes handed to main.
fn git_page(a: &Args, repo: &str) -> Result<(), String> {
    issues(a, Some(repo))?;
    if a.json || in_prompt() { return Ok(()); }
    let r = Repos::open()?;
    out("");
    if remote::connection().is_some() {
        match history::work(&r, repo) {
            Ok(wk) if wk.line != work::MAIN => {
                out(tr!("Work: {} · {} · started {}", "作業: {} · {} · {} に開始", wk.issue.as_deref().unwrap_or(&wk.line), if wk.started_by.is_empty() { "—" } else { &wk.started_by }, ago(wk.started_at)));
                out(tr!("  {} commits, {} not pushed{}", "  区切り {} · 未 push {}{}", wk.commits, wk.unpushed,
                    wk.change.as_ref().map(|c| tr!(" · submitted (version {}, {})", " · 提出済み（第 {} 版 · {}）", c.version, state_word(&c.state))).unwrap_or_default()));
            }
            Ok(_) => out(tr!("Work: main", "作業: main")),
            Err(e) => out(tr!("Work: ({})", "作業: （{}）", e)),
        }
    }
    changes(a, repo)?;
    if remote::connection().is_some() {
        out("");
        changes_in(a, repo)?;
    }
    Ok(())
}

fn state_word(s: &str) -> String {
    match s {
        "open" => tr!("open", "未決"),
        "merged" => tr!("merged", "Merge 済み"),
        "rejected" => tr!("rejected", "Reject"),
        "reset" => tr!("taken back", "取り下げ"),
        other => other.to_string(),
    }
}

/// Changes handed in to main, each with where it reaches and its reviews.
fn changes_in(a: &Args, repo: &str) -> Result<(), String> {
    let list = history::changes_of_repo(repo)?;
    if a.json { return json(&list); }
    out(tr!("Changes handed in", "提出された変更"));
    if list.is_empty() { out(tr!("  none yet", "  まだありません")); }
    for c in &list {
        out(format!("  {}  {}", text::named(Some(c.kind.as_str()).filter(|k| !k.is_empty()), &c.title), state_word(&c.state)));
        let places: Vec<String> = c.folders.iter().map(|f| if f.is_empty() { "/".into() } else { format!("{f}/") }).collect();
        out(tr!("    {} · version {} · {} · {} files · {}", "    {} · 第 {} 版 · {} · {} ファイル · {}", short(&c.id), c.version, c.submitted_by, c.files, places.join(" ")));
        for rv in c.reviews.iter().take(3) {
            let verdict = match rv.verdict.as_str() { "approve" => tr!("approved", "承認"), "changes" => tr!("asked for changes", "変更を依頼"), _ => tr!("commented", "コメント") };
            let stale = if rv.version != c.version { tr!(" (of version {})", "（第 {} 版へ）", rv.version) } else { String::new() };
            out(format!("      {} {}{}{}", rv.by, verdict, stale, if rv.note.is_empty() { String::new() } else { format!(": {}", rv.note) }));
        }
    }
    Ok(())
}

fn cut_done(a: &Args, c: history::Cut) -> Result<(), String> {
    if a.json { return json(c); }
    out(tr!("Committed {}  {} ({} files +{} −{})", "区切りました {}  {}（{} ファイル +{} −{}）", short(&c.id), history::line(&c), c.files, c.added, c.removed));
    Ok(())
}

fn cut_line(c: &history::Cut) {
    out(history::line(c));
    let places: Vec<String> = c.folders.iter().map(|f| if f.is_empty() { "/".into() } else { format!("{f}/") }).collect();
    let issue = c.issue.as_deref().map(|i| format!(" · {i}")).unwrap_or_default();
    let merged = if c.merged.is_some() { tr!(" · merge", " · Merge") } else { String::new() };
    out(format!("    {} · {} · {} +{} −{}{issue}{merged}", short(&c.id), ago(c.time), tr!("{} files", "{} ファイル", c.files), c.added, c.removed));
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

/// What is not committed yet, folder by folder, as Git shows it.
fn changes(a: &Args, repo: &str) -> Result<(), String> {
    let c = history::changes(&Repos::open()?, repo)?;
    if a.json { return json(&c); }
    if c.files == 0 { out(tr!("Nothing uncommitted", "まだ区切っていない変更はありません")); return Ok(()); }
    out(tr!("Not committed  {} files +{} −{}", "まだ区切っていない変更  {} ファイル +{} −{}", c.files, c.added, c.removed));
    for f in &c.folders {
        out(format!("  {}/  +{} −{}", if f.folder.is_empty() { repo } else { &f.folder }, f.added, f.removed));
        for x in &f.files {
            let word = match x.status { "added" => tr!("added", "追加"), "removed" => tr!("removed", "削除"), _ => tr!("changed", "変更") };
            out(format!("      {word}  {}{}", x.path, if x.binary { tr!("  (binary)", "  （バイナリ）") } else { format!("  +{} −{}", x.added, x.removed) }));
        }
    }
    if c.connected { out(tr!("To commit: l3 commit REPO (the work's issue names it), or l3 commit REPO \"Fix：title\" on main", "区切るには: l3 commit REPO（作業の Issue の名前で）か、main なら l3 commit REPO \"Fix：件名\"")); }
    else { out(tr!("Commits are kept on the Remote; connect with l3 login to commit", "区切りは Remote に残ります。l3 login でつなぐと区切れます")); }
    Ok(())
}

fn issue_one(a: &Args, target: &str) -> Result<(), String> {
    let (repo, rel) = split(target);
    let file = rel.trim_start_matches("issue/");
    let r = Repos::open()?;
    let c = r.read(&repo, &format!("issue/{file}"), 256 * 1024)?;
    let i = length3_core::issues::parse(&repo, file, &c.text.ok_or_else(|| tr!("It is binary", "バイナリです"))?);
    if a.json { return json(&i); }
    out(text::named(i.kind.as_deref(), &i.title));
    out(format!("{} · issue/{}", i.repo, i.file));
    if !i.detail.is_empty() { out(""); out(&i.detail); }
    if in_prompt() { return Ok(()); }
    let path = format!("issue/{}", i.file);
    out("");
    if let Some(line) = work::line_for(&path) {
        let cuts = history::log_of(&repo, &line, 200).unwrap_or_default();
        if cuts.is_empty() { out(tr!("No work on this issue yet (l3 work {}/{} to start)", "この Issue の作業はまだありません（l3 work {}/{} で始められます）", repo, path)); }
        for c in &cuts { cut_line(c); }
    }
    Ok(())
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
        let act = match i.room { usage::Room::Free => tr!("free", "空ける"), usage::Room::SyncFree => tr!("sync and free", "同期して空ける"), usage::Room::Keep => tr!("stays", "残す") };
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
        out(tr!("  The canonical copy is kept on the Remote. l3 login connects this device once you approve in the browser.", "  正本は Remote に置かれます。l3 login でブラウザで承認すると、この端末がつながります。"));
        return Ok(());
    };
    let account = remote::account();
    let here = remote::status(&Repos::open()?)?;
    let there = remote::remote_repos().unwrap_or_default();
    if a.json { return json(serde_json::json!({"url": c.url, "account": account.as_ref().ok(), "here": here, "remote": there})); }
    out(format!("Remote  {}{}", c.url.split("://").nth(1).unwrap_or(&c.url), account.as_ref().ok().and_then(|a| a.as_ref()).map(|a| format!(" · {}", a.name)).unwrap_or_default()));
    if let Err(e) = &account { out(format!("  {e}")); }
    for s in &here {
        let state = if s.fresh { tr!("not sent yet", "まだ送っていません") } else if s.changed > 0 { tr!("{} not sent", "{} 件未送信", s.changed) } else { tr!("in step", "同じ") };
        let stuck = if s.unsynced.is_empty() { String::new() } else { tr!(" · {} cannot be sent", " · 送れないもの {} 件", s.unsynced.len()) };
        out(format!("  {}  {state}{stuck}", s.name));
    }
    for t in there.iter().filter(|t| !here.iter().any(|h| h.name == t.name)) {
        out(tr!("  {}  only on the Remote · {}", "  {}  Remote だけ · {}", t.name, bytes(t.bytes)));
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
