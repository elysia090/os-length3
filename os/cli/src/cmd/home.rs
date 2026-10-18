//! Home: the TODO, the profile and the language, the same files the app keeps.

use super::Ctx;
use crate::args::Call;
use crate::out::{now_ms, Error, Reply, Result};
use crate::spec::{Fact, On};
use length3_core::{home, i18n, text, tr};
use serde_json::json;

pub fn todo_list(_: &Ctx, _: &Call) -> Result<Reply> {
    let list = home::todos()?;
    if list.is_empty() {
        return Ok(Reply::data(tr!("No TODO yet (l3 todo add \"Fix：title\")", "TODO はまだありません（l3 todo add \"Fix：件名\" で足せます）"), json!([])));
    }
    let mut t = Vec::new();
    for (k, item) in list.iter().enumerate() {
        let mark = if item.done { "✓" } else { "○" };
        crate::menu::see(|| crate::menu::Subject { on: On::Todo, word: (k + 1).to_string(), repo: None,
            label: format!("{mark} {}", text::named(item.kind.as_deref(), &item.title)), detail: String::new(),
            facts: vec![if item.done { Fact::Done } else { Fact::NotDone }] });
        t.push(format!("{:>3} {} {}", k + 1, mark, text::named(item.kind.as_deref(), &item.title)));
        for line in item.detail.lines() { t.push(format!("        {line}")); }
    }
    Ok(Reply::data(t.join("\n"), json!(list)))
}

pub fn todo_add(_: &Ctx, call: &Call) -> Result<Reply> {
    let mut list = home::todos()?;
    let item = home::todo_from(call.word(0).unwrap_or_default(), call.note(), now_ms())
        .ok_or_else(|| Error::Usage(tr!("The TODO's first line is empty", "TODO の1行目が空です")))?;
    fits(&item)?;
    let name = text::named(item.kind.as_deref(), &item.title);
    list.push(item.clone());
    home::save_todos(&list)?;
    let open = list.iter().filter(|t| !t.done).count();
    Ok(Reply::done(tr!("Added to TODO: {} ({} open)", "TODO に足しました：{}（残り{}件）", name, open), json!({"added": item, "number": list.len(), "open": open})))
}

/// The app reads no more than this of an item, so more would be lost there without a word.
fn fits(item: &home::Todo) -> Result<()> {
    for ((field, limit), text) in home::TODO_LIMITS.iter().zip([&item.title, &item.detail]) {
        if text.encode_utf16().count() > *limit {
            return Err(Error::Refused(if *field == "title" { tr!("A TODO's first line is up to {} characters", "TODO の1行目は{}文字までです", limit) } else { tr!("A TODO's detail is up to {} characters", "TODO の詳細は{}文字までです", limit) }));
        }
    }
    Ok(())
}

/// `l3 todo edit N "…" [-m detail]`: the Nth item's first line written again, as the app edits it in
/// place: the same item (its id, whether done, when made). Its detail is what follows the first line
/// and -m's when either is given; otherwise it stays.
pub fn todo_edit(_: &Ctx, call: &Call) -> Result<Reply> {
    let mut list = home::todos()?;
    let at = nth(&list, call.word(0).unwrap_or_default())?;
    let item = home::todo_edited(&list[at], call.word(1).unwrap_or_default(), call.flags.note.as_deref())
        .ok_or_else(|| Error::Usage(tr!("The TODO's first line is empty (l3 todo rm {} removes it)", "TODO の1行目が空です（消すなら l3 todo rm {}）", at + 1)))?;
    fits(&item)?;
    let changed = item != list[at];
    list[at] = item.clone();
    if changed { home::save_todos(&list)?; }
    let name = text::named(item.kind.as_deref(), &item.title);
    let text = if changed { tr!("Changed TODO {}: {}", "TODO {} を変えました：{}", at + 1, name) } else { tr!("TODO {} was so already: {}", "TODO {} はもうそのとおりです：{}", at + 1, name) };
    Ok(Reply::done(text, json!({"number": at + 1, "todo": item, "changed": changed})))
}

/// Where in `list` the Nth item is, as `l3 todo` numbers them; the number said as it was written.
fn nth(list: &[home::Todo], word: &str) -> Result<usize> {
    match word.parse::<usize>() {
        Ok(k) if (1..=list.len()).contains(&k) => Ok(k - 1),
        _ => Err(Error::NotFound(match list.len() {
            0 => tr!("There is no TODO yet", "TODO はまだありません"),
            n => tr!("There is no TODO number {} (1 to {})", "{} 番目の TODO はありません（1〜{}）", word, n),
        })),
    }
}

pub fn todo_done(_: &Ctx, call: &Call) -> Result<Reply> {
    let mut list = home::todos()?;
    let at = nth(&list, call.word(0).unwrap_or_default())?;
    let k = at + 1;
    let item = &mut list[at];
    item.done = !item.done;
    let (name, done, item) = (text::named(item.kind.as_deref(), &item.title), item.done, item.clone());
    home::save_todos(&list)?;
    Ok(Reply::done(if done { tr!("Done: {}", "完了にしました：{}", name) } else { tr!("Not done again: {}", "未完了に戻しました：{}", name) }, json!({"number": k, "todo": item})))
}

/// `l3 todo rm N`: the Nth item goes, as emptying it does in the app.
pub fn todo_rm(_: &Ctx, call: &Call) -> Result<Reply> {
    let mut list = home::todos()?;
    let at = nth(&list, call.word(0).unwrap_or_default())?;
    let item = list.remove(at);
    home::save_todos(&list)?;
    let open = list.iter().filter(|t| !t.done).count();
    Ok(Reply::done(tr!("Removed from TODO: {} ({} open)", "TODO から消しました：{}（残り{}件）", text::named(item.kind.as_deref(), &item.title), open),
        json!({"removed": item, "number": at + 1, "open": open})))
}

pub fn profile_show(_: &Ctx, _: &Call) -> Result<Reply> {
    let p = home::profile();
    let mut t = Vec::new();
    if p.name.is_empty() && p.handle.is_empty() { t.push(tr!("No name yet (l3 profile name \"Your name\")", "名前はまだありません（l3 profile name \"名前\"）")); }
    else { t.push(format!("{}{}", p.name, if p.handle.is_empty() { String::new() } else { format!("  @{}", p.handle) })); }
    if !p.bio.is_empty() { t.push(format!("  {}", p.bio)); }
    Ok(Reply::data(t.join("\n"), json!(p)))
}

pub fn profile_set(_: &Ctx, call: &Call) -> Result<Reply> {
    let field = call.word(0).unwrap_or_default();
    let p = home::set_profile(field, call.word(1).unwrap_or_default()).map_err(Error::Refused)?;
    let what = match field { "name" => tr!("name", "名前"), "handle" => tr!("handle", "ハンドル"), _ => tr!("bio", "自己紹介") };
    Ok(Reply::done(tr!("Saved your {}", "{}を保存しました", what), json!(p)))
}

pub fn lang_show(_: &Ctx, _: &Call) -> Result<Reply> {
    let kept = i18n::lang();
    let spoken = if i18n::ja() { "ja" } else { "en" };
    let mut text = kept.clone();
    if spoken != kept { text += &tr!(" (LENGTH3_LANG speaks {} now)", "（いまは LENGTH3_LANG で {}）", spoken); }
    Ok(Reply::data(text, json!({"lang": kept, "spoken": spoken})))
}

pub fn lang_set(_: &Ctx, call: &Call) -> Result<Reply> {
    let l = call.word(0).unwrap_or_default();
    i18n::set_lang(l).map_err(Error::Usage)?;
    // Said in the language just chosen.
    let text = if l == "ja" { "日本語で話します（アプリも同じです）" } else { "Speaking English (the app does too)" };
    Ok(Reply::done(text, json!({"lang": l})))
}
