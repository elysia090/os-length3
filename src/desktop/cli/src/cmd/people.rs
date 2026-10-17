//! The two whose subject is people: Server (boards: a talk and a TODO kept
//! together) and Inbox (conversations, and the addresses people find you by).

use super::Ctx;
use crate::args::Call;
use crate::out::{ago, day, Error, Reply, Result};
use crate::target;
use length3_core::{inbox, servers, tr};
use serde_json::json;

pub fn servers(_: &Ctx, _: &Call) -> Result<Reply> {
    let list = servers::list()?;
    let mut t = Vec::new();
    if list.is_empty() { t.push(tr!("In no server yet (make one in the app's Server)", "まだどのサーバーにも入っていません（アプリの Server で作れます）")); }
    for s in &list {
        t.push(format!("{}{}", s.name, if s.owner { tr!(" · owner", " · オーナー") } else { String::new() }));
        for b in &s.boards {
            let open = match (b.open, b.guests) { (true, true) => tr!(" · open, guests write", " · 公開・ゲストも書ける"), (true, false) => tr!(" · open", " · 公開"), _ => String::new() };
            t.push(format!("  #{}{open}", b.name));
        }
    }
    Ok(Reply::data(t.join("\n"), json!(list)))
}

/// A board's file name: server-board[-todo].md, plain characters only.
fn file_name(server: &str, board: &str, todo: bool) -> String {
    format!("{server}-{board}{}.md", if todo { "-todo" } else { "" })
        .chars().map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' }).collect()
}

/// `l3 server get SERVER[#BOARD]`: the boards as text on standard output;
/// with -o, into that file (or, a folder, a file each).
pub fn server_get(_: &Ctx, call: &Call) -> Result<Reply> {
    let (server, boards) = servers::find(call.word(0).unwrap_or_default())?;
    let todo = call.flags.todo;
    let mut texts = Vec::new();
    for b in &boards { texts.push((b.name.clone(), servers::archive(&b.id, true, !todo)?)); }
    let data = json!(texts.iter().map(|(b, t)| json!({"server": server.name, "board": b, "text": t})).collect::<Vec<_>>());
    let Some(to) = &call.flags.out else {
        let all: Vec<&str> = texts.iter().map(|(_, t)| t.as_str()).collect();
        let mut text = all.join("\n\n");
        if !text.ends_with('\n') { text.push('\n'); }
        return Ok(Reply::Raw { text, json: data });
    };
    let to = std::path::Path::new(to);
    let mut wrote = Vec::new();
    if to.is_dir() {
        for (b, t) in &texts {
            let at = to.join(file_name(&server.name, b, todo));
            std::fs::write(&at, t).map_err(|e| Error::Io(tr!("{}: {}", "{}：{}", at.display(), e)))?;
            wrote.push(at.display().to_string());
        }
    } else {
        let all: Vec<&str> = texts.iter().map(|(_, t)| t.as_str()).collect();
        std::fs::write(to, all.join("\n\n")).map_err(|e| Error::Io(tr!("{}: {}", "{}：{}", to.display(), e)))?;
        wrote.push(to.display().to_string());
    }
    Ok(Reply::done(tr!("Wrote {}", "{} に書きました", wrote.join(", ")), json!({"wrote": wrote, "boards": data})))
}

pub fn server_post(_: &Ctx, call: &Call) -> Result<Reply> {
    let target = call.word(0).unwrap_or_default();
    let words = call.word(1).unwrap_or_default();
    if words.trim().is_empty() { return Err(Error::Usage(tr!("A post needs words", "書き込みには本文がいります"))); }
    let (server, boards) = servers::find(target)?;
    let [b] = boards.as_slice() else {
        return Err(Error::Usage(tr!("Name the board: l3 server post {}#BOARD \"text\"", "板を書いてください：l3 server post {}#BOARD \"本文\"", target)));
    };
    servers::post(&b.id, words)?;
    Ok(Reply::done(tr!("Wrote in {}#{}", "{}#{} に書きました", server.name, b.name), json!({"server": server.name, "board": b.name})))
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

/// Whether `address` is one of yours (a talk with yourself is no request).
fn mine(me: &inbox::Me, address: &str) -> bool {
    me.addresses.iter().any(|a| a.address.eq_ignore_ascii_case(address))
}

pub fn inbox_list(_: &Ctx, _: &Call) -> Result<Reply> {
    let list = inbox::threads()?;
    let me = inbox::me()?;
    let mut t = Vec::new();
    if list.is_empty() { t.push(tr!("No messages yet (l3 inbox send ADDRESS \"text\")", "まだメッセージはありません（l3 inbox send ADDRESS \"本文\"）")); }
    let mut rows = Vec::new();
    for th in &list {
        let yours = mine(&me, &th.address);
        let state = match th.state.as_str() {
            _ if yours => tr!(" · you", " · あなた"),
            "request" => tr!(" · request", " · リクエスト"),
            "blocked" => tr!(" · blocked", " · ブロック"),
            _ => String::new(),
        };
        t.push(format!("{}{}{}", me.shown(&th.address), state, if th.unread > 0 { format!("  ({})", th.unread) } else { String::new() }));
        t.push(format!("    {}{}{}", if th.last.mine { tr!("you: ", "あなた：") } else { String::new() }, kind_word(&th.last.kind), th.last.body));
        rows.push(json!({"address": th.address, "name": th.name, "state": if yours { "yourself" } else { th.state.as_str() }, "unread": th.unread, "last": th.last}));
    }
    Ok(Reply::data(t.join("\n"), json!(rows)))
}

pub fn inbox_thread(_: &Ctx, call: &Call) -> Result<Reply> {
    let address = target::address(call.word(0).unwrap_or_default())?;
    let c = inbox::thread(&address)?;
    let me = inbox::me()?;
    let yours = mine(&me, &c.address);
    let mut t = vec![format!("{}{}", me.shown(&c.address), if c.state == "request" && !yours { tr!("  (request: l3 inbox accept {})", "  （リクエスト：l3 inbox accept {}）", me.shown(&c.address)) } else { String::new() })];
    if c.messages.is_empty() { t.push(tr!("  Nothing written yet", "  まだ何も書かれていません")); }
    for m in &c.messages {
        let who = if m.mine { tr!("you", "あなた") } else { me.shown(&c.address).to_string() };
        t.push(format!("  {who} · {}{}  · {}", kind_word(&m.kind), m.body, ago(m.time)));
    }
    let state = if yours { "yourself".to_string() } else { c.state.clone() };
    Ok(Reply::data(t.join("\n"), json!({"address": c.address, "state": state, "mutual": c.mutual, "messages": c.messages})))
}

pub fn inbox_send(_: &Ctx, call: &Call) -> Result<Reply> {
    let to = target::address(call.word(0).unwrap_or_default())?;
    let words = call.word(1).unwrap_or_default();
    if words.trim().is_empty() { return Err(Error::Usage(tr!("A message needs words", "メッセージには本文がいります"))); }
    // As in the app: named like an issue says what it is, a /root/… path what it is about.
    let (kind, body, repo) = inbox::written(words);
    let request = inbox::send(&to, &body, kind, repo.as_deref())?;
    let text = if request { tr!("Sent to {} as a request (they see it once they accept you)", "{} にリクエストとして送りました（相手が受けると読まれます）", to) } else { tr!("Sent to {}", "{} に送りました", to) };
    Ok(Reply::done(text, json!({"to": to, "type": kind, "repo": repo, "request": request})))
}

pub fn inbox_decide(_: &Ctx, call: &Call) -> Result<Reply> {
    let accept = call.word(0) == Some("accept");
    let who = target::address(call.word(1).unwrap_or_default())?;
    inbox::decide(&who, if accept { "accepted" } else { "blocked" })?;
    Ok(Reply::done(if accept { tr!("Accepted {}", "{} を受けました", who) } else { tr!("Blocked {}", "{} をブロックしました", who) }, json!({"address": who, "state": if accept { "accepted" } else { "blocked" }})))
}

pub fn addresses(_: &Ctx, _: &Call) -> Result<Reply> {
    let me = inbox::me()?;
    let mut t = Vec::new();
    if me.addresses.is_empty() { t.push(tr!("No name yet (l3 address claim NAME: first come, yours for five years at a time)", "名前はまだありません（l3 address claim NAME：早い者勝ち、5年ごとの更新であなたのもの）")); }
    for x in &me.addresses {
        let state = if x.lapsed { tr!("  · its domain no longer names this Remote", "  · ドメインがこの Remote を指していません") }
            else if x.ended { tr!("  · its term ended: l3 address renew {}", "  · 期限切れ：l3 address renew {}", me.shown(&x.address)) }
            else if let Some(u) = x.until { tr!("  · until {}", "  · {} まで", day(u)) } else { String::new() };
        t.push(format!("{}{state}{}", me.shown(&x.address), if x.ssh { tr!("  · SSH allowed", "  · SSH 許可") } else { String::new() }));
    }
    if !me.code.is_empty() { t.push(tr!("Your code: {} (anyone can find you by it)", "あなたのコード：{}（これで見つけてもらえます）", me.code)); }
    Ok(Reply::data(t.join("\n"), json!(me)))
}

pub fn address_claim(_: &Ctx, call: &Call) -> Result<Reply> {
    let a = inbox::claim(call.word(0).unwrap_or_default())?;
    Ok(Reply::done(tr!("Yours: {}", "あなたのアドレス：{}", a), json!({"address": a})))
}

/// One of your addresses, by its name here (`ren`) or in full.
fn yours(word: &str) -> Result<(inbox::Me, String)> {
    let address = target::address(word)?;
    let me = inbox::me()?;
    if !mine(&me, &address) {
        return Err(Error::NotFound(tr!("{} is not one of your addresses (l3 address lists them)", "{} はあなたのアドレスではありません（l3 address で一覧）", me.shown(&address))));
    }
    Ok((me, address))
}

pub fn address_renew(_: &Ctx, call: &Call) -> Result<Reply> {
    let (me, address) = yours(call.word(0).unwrap_or_default())?;
    let until = inbox::renew(&address)?;
    Ok(Reply::done(tr!("{} is yours until {}", "{} は {} まであなたのものです", me.shown(&address), day(until)), json!({"address": address, "until": until})))
}

pub fn address_release(_: &Ctx, call: &Call) -> Result<Reply> {
    let (me, address) = yours(call.word(0).unwrap_or_default())?;
    let until = inbox::release(&address)?;
    Ok(Reply::done(tr!("Let go of {} (held for you until {}; claim it again to take it back)", "{} を手放しました（{} まであなたのために取り置き。取り直せば戻ります）", me.shown(&address), day(until)), json!({"address": address, "heldUntil": until})))
}

pub fn address_domain(_: &Ctx, call: &Call) -> Result<Reply> {
    let domain = call.word(0).unwrap_or_default();
    let r = inbox::domain_record(domain)?;
    let t = [
        tr!("Put this record in {}'s DNS (it says this account holds addresses there, and on which Remote):", "{} の DNS にこのレコードを置きます（このアカウントがそこのアドレスを持つこと、どの Remote かを示します）：", domain),
        format!("  {}  {}  {}", r.name, r.kind, r.value),
        if r.found { tr!("Found: l3 address claim NAME@{} takes an address on it", "見つかりました：l3 address claim NAME@{} でアドレスを取れます", domain) } else { tr!("Not found yet", "まだ見つかりません") },
    ];
    Ok(Reply::data(t.join("\n"), json!(r)))
}
