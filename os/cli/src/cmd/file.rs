//! File: a folder's entries, a file's text; writing a file from standard
//! input, making a folder, removing. Paths are a repo's (REPO/PATH), or from
//! where you are in one.

use super::{stdin_text, Ctx};
use crate::args::Call;
use crate::out::{bytes, files, note, Error, Reply, Result};
use crate::spec::{Fact, On};
use crate::target;
use length3_core::repos::shown;
use length3_core::tr;
use serde_json::json;

/// What l3 reads or writes of a file at most.
const LIMIT: u64 = 256 * 1024;

pub fn read(ctx: &Ctx, call: &Call) -> Result<Reply> {
    // Outside a repo, with nothing named (or /root, where they are): the repos.
    if ctx.here.is_none() && call.word(0).is_none_or(|w| w.trim_end_matches('/') == "/root") { return super::forge::repo_list(ctx, call); }
    let (repo, rel) = target::path(ctx, call, 0)?;
    let r = ctx.repos()?;
    let at = shown(&repo, &rel);
    if !ctx.exists(&repo, &rel) { return Err(Error::NotFound(tr!("There is no {}", "{} はありません", at))); }
    // A link to nothing is there, but what it names is not (4, as for anything not there; bug: 1).
    if r.dangling(&repo, &rel) { return Err(Error::NotFound(tr!("{} is a link to something that is not there", "{} はリンクですが、指す先がありません", at))); }
    if let Ok(entries) = r.tree(&repo, &rel) {
        // The folder is where the menu is now, empty or not: what it offers next is done here.
        crate::menu::shown_at(if rel.is_empty() { repo.clone() } else { format!("{repo}/{rel}") });
        // Each entry, for the menu, named as File names it (REPO/PATH).
        for e in &entries {
            crate::menu::see(|| {
                let path = if rel.is_empty() { format!("{repo}/{}", e.name) } else { format!("{repo}/{rel}/{}", e.name) };
                let dir = e.kind == "dir";
                crate::menu::Subject { on: On::Path, word: path, repo: Some(repo.clone()), label: format!("{}{}", e.name, if dir { "/" } else { "" }),
                    detail: if dir || e.kind == "link" { String::new() } else { bytes(e.size) }, facts: if dir { vec![Fact::Folder] } else { Vec::new() } }
            });
        }
        // Folders first, like File.
        let t: Vec<String> = entries.iter().map(|e| match e.kind { "dir" => format!("{}/", e.name), "link" => format!("{}@", e.name), _ => format!("{}\t{}", e.name, bytes(e.size)) }).collect();
        let text = if t.is_empty() { tr!("{} is empty", "{} は空です", at) } else { t.join("\n") };
        return Ok(Reply::data(text, json!({"repo": repo, "path": rel, "entries": entries})));
    }
    let c = r.read(&repo, &rel, LIMIT)?;
    let json = json!({"repo": repo, "path": rel, "size": c.size, "truncated": c.truncated, "binary": c.text.is_none(), "text": c.text});
    match c.text {
        Some(t) => {
            if c.truncated && !call.flags.json { note(&tr!("shown only the first {} of {}", "先頭 {} だけ表示しました（全体 {}）", bytes(t.len() as u64), bytes(c.size))); }
            Ok(Reply::Raw { text: t, json })
        }
        None if call.flags.json => Ok(Reply::data(String::new(), json)),
        None => Err(Error::Refused(tr!("{} is binary ({}); l3 shows text", "{} はバイナリです（{}）。l3 が見せるのはテキストです", at, bytes(c.size)))),
    }
}

pub fn write(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let (repo, rel) = target::path(ctx, call, 0)?;
    let at = shown(&repo, &rel);
    if rel.is_empty() { return Err(Error::Usage(tr!("Name a file in {}: {}/PATH", "{} の中のファイルを書いてください：{}/PATH", repo, repo))); }
    let text = stdin_text(&at, call.flags.empty, LIMIT)?;
    let (n, made) = ctx.repos()?.put(&repo, &rel, &text, LIMIT, true)?;
    let said = if made { tr!("Made {} ({})", "{} を作りました（{}）", at, bytes(n)) } else { tr!("Saved {} ({})", "{} を保存しました（{}）", at, bytes(n)) };
    Ok(Reply::done(said, json!({"repo": repo, "path": rel, "bytes": n, "made": made})))
}

pub fn mkdir(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let (repo, rel) = target::path(ctx, call, 0)?;
    let at = shown(&repo, &rel);
    if rel.is_empty() { return Err(Error::Usage(tr!("Name a folder in {}: {}/PATH", "{} の中のフォルダーを書いてください：{}/PATH", repo, repo))); }
    let was = ctx.exists(&repo, &rel);
    ctx.repos()?.mkdir(&repo, &rel)?;
    let said = if was { tr!("{} was there already", "{} はもうありました", at) } else { tr!("Made the folder {}", "フォルダー {} を作りました", at) };
    Ok(Reply::done(said, json!({"repo": repo, "path": rel, "made": !was})))
}

pub fn rm(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let (repo, rel) = target::path(ctx, call, 0)?;
    let at = shown(&repo, &rel);
    if rel.is_empty() { return Err(Error::Refused(tr!("The repo itself is not removed this way", "repo そのものはこの方法では消せません"))); }
    if !ctx.exists(&repo, &rel) { return Err(Error::NotFound(tr!("There is no {}", "{} はありません", at))); }
    let r = ctx.repos()?;
    // A folder says how much went with it, counted through the core so nothing outside the repo is walked.
    // A link is removed itself, never what it names.
    let link = r.place(&repo).is_ok_and(|d| d.join(&rel).is_symlink());
    let inside = if link { None } else { r.tree(&repo, &rel).ok().map(|_| count(&r, &repo, &rel)) };
    r.remove(&repo, &rel)?;
    let said = match inside { Some(n) => tr!("Deleted the folder {} ({})", "フォルダー {} を消しました（{}）", at, files(n)), None => tr!("Deleted {}", "{} を消しました", at) };
    Ok(Reply::done(said, json!({"repo": repo, "path": rel, "files": inside})))
}

/// The files in the folder `rel` of `repo` and in each folder under it (a link counts as one).
fn count(r: &length3_core::repos::Repos, repo: &str, rel: &str) -> usize {
    r.tree(repo, rel).unwrap_or_default().iter().map(|e| if e.kind == "dir" { count(r, repo, &format!("{rel}/{}", e.name)) } else { 1 }).sum()
}
