//! l3: Length³ OS on the command line. Its words and its order are the
//! app's rail: Home, Forge (and its Prompt), File, Git, Runtime, Remote.
//! The same repos, issues, TODO and device, read and written through the
//! same core, so what one does here is what the app shows, and back.
//!
//! The canonical copy is the Remote's. Every change made here is sent at
//! once (the draft); 区切る makes the draft history; a repo whose copy is on
//! the Remote can be let go here (空ける) and comes back when opened.

use length3_core::{history, home, paths, remote, repos::Repos, templates, text, usage};
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

const HELP: &str = "l3 — Length³ OS をコマンドで。アプリの rail と同じ言葉と順番です。

Home
  l3                         この端末と Remote、repo、TODO
  l3 todo                    TODO
  l3 todo add \"Fix：件名\" [-m 詳細]
  l3 todo done N             N 番目を完了に（もう一度で戻す）
Forge
  l3 repo                    repo（この端末にあるもの、Remote だけにあるもの）
  l3 repo new NAME [-t standard|c|empty]
  l3 repo open NAME          Remote から持ってくる（開けば戻ってきます）
  l3 prompt REPO [-- CMD…]   Prompt: root の中で repo を開く（権限なし）
      --network              ネットワークを渡す（既定ではなし）
File
  l3 file [REPO[/PATH]]      ディレクトリなら中身、ファイルなら本文
  l3 file write REPO/PATH    標準入力で既存のファイルを置き換える
Git
  l3 git [REPO]              Issue と、まだ区切っていない変更
  l3 issue [REPO | REPO/NNN.md]
  l3 issue new REPO \"Fix：件名\" [-m 詳細]
  l3 cut REPO/issue/NNN.md [-m メモ]   その Issue として区切る
  l3 cut REPO \"Fix：件名\" [-m メモ]    Issue なしで区切る
  l3 log REPO                区切り
Runtime
  l3 runtime                 root と この端末: 容量順、空けられるもの
  l3 free ID… | l3 free all  空ける（変更があれば送ってから）
  l3 root fetch | install BUNDLE
Remote
  l3 remote                  つながっている Remote と、repo の同期
  l3 login [URL]             ブラウザで承認してつなぐ（パスキー）
  l3 logout
  l3 sync [REPO]             いま送る・取り込む（ふだんは変えるたびに自動）

  --json で JSON に。パスは File と同じ /root/<repo>/… でも書けます。
  置き場所: $LENGTH3_HOME（なければアプリと同じデータの場所）";

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
            for p in &s.both { eprintln!("l3: {p} は別の端末でも変わっていました。そちらを「{}」に置きました", remote::beside(p)); }
        }
        Err(e) => eprintln!("l3: まだ送れていません（{e}）。次の同期で送ります"),
    }
}

#[cfg(target_os = "linux")]
fn prompt(a: &Args, repo: &str, rest: &[&str]) -> Result<(), String> {
    let (root, _) = length3_core::root::current(&paths::data_dir()).ok_or("root がありません（l3 root fetch）")?;
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
    Err("l3 prompt はいま Linux だけです".into())
}

fn run(a: Args) -> Result<(), String> {
    let w: Vec<&str> = a.words.iter().map(String::as_str).collect();
    if in_prompt() {
        let elsewhere = match w.first().copied() {
            Some("todo") => Some("Home の TODO"),
            Some("runtime") | Some("free") | Some("root") => Some("この端末の容量と root"),
            Some("remote") | Some("login") | Some("logout") | Some("sync") | Some("cut") | Some("log") => Some("Remote と区切り"),
            Some("repo") if w.len() > 1 => Some("repo を作ること・持ってくること"),
            Some("prompt") => Some("Prompt を開くこと"),
            _ => None,
        };
        if let Some(what) = elsewhere {
            return Err(format!("{what} はこの Prompt からは扱えません。アプリか、端末の l3 でどうぞ"));
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
        // Home
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
        // Forge
        ["repo"] | ["repo", "ls"] => repo_list(&a),
        ["repo", "new", name] => {
            let s = Repos::open()?.create(name, &a.template)?;
            send(name);
            if a.json { return json(s); }
            out(format!("{} を作りました（{} · {} ファイル）", s.name, a.template, s.files));
            Ok(())
        }
        ["repo", "open", name] => {
            let s = remote::fetch(&Repos::open()?, name)?;
            if a.json { return json(s); }
            out(format!("{name} をこの端末に開きました（{} 件を取り込み）", s.taken));
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
            out(format!("{repo}/{rel} を保存しました（{}）", bytes(n)));
            Ok(())
        }
        ["file", path] => file(&a, path),
        // Git
        ["git"] => issues(&a, None),
        ["git", repo] => { issues(&a, Some(repo))?; if !a.json { out(""); changes(&a, repo)?; } Ok(()) }
        ["issue"] => issues(&a, None),
        ["issue", "new", repo, line] => {
            let (kind, title) = text::kind_of(line);
            let name = Repos::open()?.add_issue(repo, kind.as_deref(), &title, &a.detail)?;
            send(repo);
            out(format!("{repo}/issue/{name} に書きました"));
            Ok(())
        }
        ["issue", target] if target.trim_end_matches('/').contains('/') => issue_one(&a, target),
        ["issue", repo] => issues(&a, Some(repo)),
        ["cut", target] => {
            let (repo, rel) = split(target);
            if !rel.starts_with("issue/") { return Err("l3 cut REPO/issue/NNN.md か l3 cut REPO \"Fix：件名\"".into()); }
            cut_done(&a, history::cut(&Repos::open()?, &repo, Some(&rel), "", &a.detail)?)
        }
        ["cut", repo, line] => cut_done(&a, history::cut(&Repos::open()?, repo, None, line, &a.detail)?),
        ["log", repo] => {
            let list = history::log(repo, 50)?;
            if a.json { return json(&list); }
            if list.is_empty() { out("区切りはまだありません"); }
            for c in &list { cut_line(c); }
            Ok(())
        }
        // Runtime
        ["runtime"] => runtime(&a),
        ["free"] => runtime(&a),
        ["free", ids @ ..] => {
            let data = paths::data_dir();
            let ids: Vec<String> = if ids == ["all"] {
                usage::all_freeable(&usage::space(&data, &paths::repos_dir(), &[]))
            } else {
                ids.iter().map(|i| if i.contains(':') || *i == "home" { i.to_string() } else { format!("repo:{i}") }).collect()
            };
            if ids.is_empty() { out("空けられるものはありません"); return Ok(()); }
            let r = usage::free(&data, &paths::repos_dir(), &ids, &[]);
            if a.json { return json(r); }
            if !r.removed.is_empty() {
                out(format!("{} を空けました（{} 件、ファイルの実割当で確認）", bytes(r.freed), r.removed.len()));
                let change = r.host_free_after as i64 - r.host_free_before as i64;
                match r.reflected_ms {
                    Some(ms) => out(format!("  ホストの空き {:+} B（{} ms で反映。他のプログラムの書込も含む観測値）", change, ms)),
                    None => out(format!("  ホストの空き {:+} B（2 秒以内には反映が見えませんでした）", change)),
                }
                for id in r.removed.iter().filter(|i| i.starts_with("repo:")) {
                    out(format!("  {} は Remote にあります。l3 repo open {} で戻ります", &id[5..], &id[5..]));
                }
            }
            for (id, why) in &r.kept { out(format!("  残したもの {id}: {why}")); }
            Ok(())
        }
        ["root"] => {
            let held = length3_core::root::held(&paths::data_dir());
            if a.json { return json(held.iter().map(|(r, c)| serde_json::json!({"root": r, "current": c})).collect::<Vec<_>>()); }
            if held.is_empty() { out("root はまだありません（l3 root fetch）"); return Ok(()); }
            for (r, current) in held {
                out(format!("{} {}  {} ファイル · {}  {}{}", r.name, r.version, r.files, bytes(r.bytes), &r.sha256[..12], if current { "  使用中" } else { "" }));
            }
            Ok(())
        }
        ["root", "fetch"] => {
            let url = remote::connection().map_or_else(remote::default_url, |c| c.url);
            let mut last = 0u64;
            let r = length3_core::root::fetch_and_install(&paths::data_dir(), &url, |p| match p {
                length3_core::fetch::Progress::Bytes(got, all) if got - last >= 4 << 20 || got == all => {
                    last = got;
                    eprint!("\r取得中 {} / {}", bytes(got), bytes(all));
                }
                length3_core::fetch::Progress::Retry(n, why) => eprintln!("\n{why}。続きから取ります（{n}回目）"),
                _ => {}
            })?;
            eprintln!();
            if a.json { return json(r); }
            out(format!("{} {} を入れました（{} ファイル · {}）", r.name, r.version, r.files, bytes(r.bytes)));
            Ok(())
        }
        ["root", "install", bundle] => {
            let r = length3_core::root::install(&paths::data_dir(), std::path::Path::new(bundle))?;
            if a.json { return json(r); }
            out(format!("{} {} を入れました（{} ファイル · {}）", r.name, r.version, r.files, bytes(r.bytes)));
            Ok(())
        }
        // Remote
        ["remote"] => remote_page(&a),
        ["login"] => login(&remote::default_url()),
        ["login", url] => login(url.trim_end_matches('/')),
        ["logout"] => {
            remote::logout()?;
            out("この端末を Remote から外しました（repo はこの端末に残ります）");
            Ok(())
        }
        ["sync"] => {
            let all = remote::sync_all(&Repos::open()?)?;
            if a.json { return json(all.iter().map(|(n, r)| serde_json::json!({"repo": n, "ok": r.as_ref().ok(), "error": r.as_ref().err()})).collect::<Vec<_>>()); }
            for (name, r) in &all { synced_line(name, r); }
            if all.is_empty() { out("この端末に repo はありません（Remote の repo は l3 repo open NAME）"); }
            Ok(())
        }
        ["sync", repo] => {
            let r = remote::sync(&Repos::open()?, repo);
            if a.json { return json(&r); }
            synced_line(repo, &r);
            r.map(|_| ())
        }
        _ => Err(format!("わからないコマンドです: l3 {}\n`l3 help` で使い方を見られます", w.join(" "))),
    }
}

fn synced_line(name: &str, r: &Result<remote::Synced, String>) {
    match r {
        Ok(s) => {
            let what = match (s.sent, s.taken) { (0, 0) => "同じです".to_string(), (n, 0) => format!("{n} 件送りました"), (0, n) => format!("{n} 件取り込みました"), (a, b) => format!("{a} 件送り、{b} 件取り込みました") };
            out(format!("{name}  {what}"));
            for p in &s.both { out(format!("    両方で変わっていました: {p}（別の端末のものは「{}」に）", remote::beside(p))); }
            for (p, why) in &s.unsynced { out(format!("    送れないもの: {p}（{why}）")); }
        }
        Err(e) => out(format!("{name}  送れていません: {e}")),
    }
}

fn login(url: &str) -> Result<(), String> {
    let code = remote::device_start(url, "l3")?;
    out("ブラウザでこのページを開き、パスキーで承認してください:");
    out(format!("  {}", code.verification_uri_complete));
    out(format!("  コード {}", code.user_code));
    eprint!("承認を待っています…");
    remote::device_finish(url, "l3", &code)?;
    eprintln!();
    out(format!("つながりました · {}", url.split("://").nth(1).unwrap_or(url)));
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
        out(format!("Length³ OS  {}（この Prompt の repo。変えたファイルはアプリが書き戻し、Remote に送ります）", paths::repos_dir().display()));
    } else {
        out(format!("Length³ OS  {}", paths::data_dir().display()));
        out(match &c { Some(c) => format!("  Remote {}（変えるたびに送ります）", c.url.split("://").nth(1).unwrap_or(&c.url)), None => "  Remote まだつないでいません（l3 login）".into() });
    }
    out(format!("  repo   {}", list.len()));
    out(format!("  Issue  {issues}"));
    if !in_prompt() { out(format!("  TODO   残り {open} / {}", todos.len())); }
    out("`l3 help` で使い方を見られます");
    Ok(())
}

fn repo_list(a: &Args) -> Result<(), String> {
    let r = Repos::open()?;
    let here = r.list()?;
    let there = if in_prompt() || remote::connection().is_none() { Vec::new() } else { remote::remote_repos().unwrap_or_default() };
    let only_there: Vec<&remote::RemoteRepo> = there.iter().filter(|t| !here.iter().any(|h| h.name == t.name)).collect();
    if a.json { return json(serde_json::json!({"here": here, "remote": only_there})); }
    if here.is_empty() && only_there.is_empty() { out("repo はまだありません（l3 repo new NAME で作れます）"); return Ok(()); }
    for s in &here {
        let state = if in_prompt() { String::new() } else {
            match remote::status_of(&r, &s.name) {
                Ok(st) if remote::connection().is_none() => if st.unsynced.is_empty() { String::new() } else { " · 送れないものあり".into() },
                Ok(st) if st.fresh => " · まだ送っていません".into(),
                Ok(st) if st.changed > 0 => format!(" · {} 件未送信", st.changed),
                Ok(_) => " · Remote と同じ".into(),
                Err(_) => String::new(),
            }
        };
        out(format!("{}\t{} ファイル · {}{state}", s.name, s.files, bytes(s.bytes)));
    }
    for t in only_there {
        out(format!("{}\tRemote だけ · {}（l3 repo open {} で開けます）", t.name, bytes(t.bytes), t.name));
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
    if all.is_empty() { out("Issue はまだありません（l3 issue new REPO \"Fix：件名\" で書けます）"); }
    for i in &all {
        out(text::named(i.kind.as_deref(), &i.title));
        out(format!("    {} · issue/{}", i.repo, i.file));
    }
    if !missing.is_empty() { out(format!("issue/ がない repo: {}", missing.join(", "))); }
    Ok(())
}

fn cut_done(a: &Args, c: history::Cut) -> Result<(), String> {
    if a.json { return json(c); }
    out(format!("区切りました {}  {}（{} ファイル +{} −{}）", &c.id[..12.min(c.id.len())], history::line(&c), c.files, c.added, c.removed));
    Ok(())
}

fn cut_line(c: &history::Cut) {
    out(history::line(c));
    let places: Vec<String> = c.folders.iter().map(|f| if f.is_empty() { "/".into() } else { format!("{f}/") }).collect();
    let issue = c.issue.as_deref().map(|i| format!(" · {i}")).unwrap_or_default();
    out(format!("    {} · {} · {} ファイル +{} −{}{issue}", &c.id[..12.min(c.id.len())], ago(c.time), c.files, c.added, c.removed));
    if !places.is_empty() { out(format!("    {}", places.join(" "))); }
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

/// What is not yet cut, folder by folder, as Git shows it.
fn changes(a: &Args, repo: &str) -> Result<(), String> {
    let c = history::changes(&Repos::open()?, repo)?;
    if a.json { return json(&c); }
    if c.files == 0 { out("まだ区切っていない変更はありません"); return Ok(()); }
    out(format!("まだ区切っていない変更  {} ファイル +{} −{}", c.files, c.added, c.removed));
    for f in &c.folders {
        out(format!("  {}/  +{} −{}", if f.folder.is_empty() { repo } else { &f.folder }, f.added, f.removed));
        for x in &f.files {
            let word = match x.status { "added" => "追加", "removed" => "削除", _ => "変更" };
            out(format!("      {word}  {}{}", x.path, if x.binary { "  （バイナリ）".to_string() } else { format!("  +{} −{}", x.added, x.removed) }));
        }
    }
    if c.connected { out("区切るには: l3 cut REPO/issue/NNN.md（その Issue として）か l3 cut REPO \"Fix：件名\""); }
    else { out("区切りは Remote に残ります。l3 login でつなぐと区切れます"); }
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
    if in_prompt() { return Ok(()); }
    let path = format!("issue/{}", i.file);
    let cuts: Vec<history::Cut> = history::log(&repo, 200)?.into_iter().filter(|c| c.issue.as_deref() == Some(&path)).collect();
    out("");
    if cuts.is_empty() { out(format!("この Issue の区切りはまだありません（l3 cut {repo}/{path} で区切れます）")); }
    for c in &cuts { cut_line(c); }
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

/// Runtime: the root Prompts run on, then この端末 — everything this OS holds,
/// largest first, each with what can be done with it.
fn runtime(a: &Args) -> Result<(), String> {
    let s = usage::space(&paths::data_dir(), &paths::repos_dir(), &[]);
    if a.json { return json(s); }
    match length3_core::root::current(&paths::data_dir()) {
        Some((_, r)) => out(format!("root  {} {}（Prompt が動く環境）", r.name, r.version)),
        None => out("root  まだありません（l3 root fetch）"),
    }
    out("");
    out(format!("この端末  空き {} / {}（ホストの値） · このOS {}", bytes(s.host_free), bytes(s.host_total), bytes(s.allocated)));
    for i in &s.items {
        let act = match i.room { usage::Room::Free => "空ける", usage::Room::SyncFree => "同期して空ける", usage::Room::Keep => "残す" };
        out(format!("  {:>9}  {}  {}  {}", bytes(i.allocated), act, i.what, i.detail));
        out(format!("             {}{}", i.why, if i.room == usage::Room::Keep { String::new() } else { format!("  （l3 free {}）", i.id.strip_prefix("repo:").unwrap_or(&i.id)) }));
    }
    if s.freeable > 0 { out(format!("空けられるもの {}（l3 free all で全部）", bytes(s.freeable))); }
    Ok(())
}

/// Remote: where this device is connected, and where each repo stands.
fn remote_page(a: &Args) -> Result<(), String> {
    let Some(c) = remote::connection() else {
        out("Remote  まだつないでいません");
        out("  正本は Remote に置かれます。l3 login でブラウザのパスキーで承認すると、この端末がつながります。");
        return Ok(());
    };
    let account = remote::account();
    let here = remote::status(&Repos::open()?)?;
    let there = remote::remote_repos().unwrap_or_default();
    if a.json { return json(serde_json::json!({"url": c.url, "account": account.as_ref().ok(), "here": here, "remote": there})); }
    out(format!("Remote  {}", c.url.split("://").nth(1).unwrap_or(&c.url)));
    if let Err(e) = &account { out(format!("  {e}")); }
    for s in &here {
        let state = if s.fresh { "まだ送っていません".to_string() } else if s.changed > 0 { format!("{} 件未送信", s.changed) } else { "同じ".into() };
        out(format!("  {}  {state}{}", s.name, if s.unsynced.is_empty() { String::new() } else { format!(" · 送れないもの {} 件", s.unsynced.len()) }));
    }
    for t in there.iter().filter(|t| !here.iter().any(|h| h.name == t.name)) {
        out(format!("  {}  Remote だけ · {}", t.name, bytes(t.bytes)));
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
