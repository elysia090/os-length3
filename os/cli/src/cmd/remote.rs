//! Remote: where this device is connected and where each repo stands; the
//! account's sign-in and devices; connecting and disconnecting.

use super::{host, Ctx};
use crate::args::Call;
use crate::out::{self, bytes, Error, Reply, Result};
use crate::spec::{Fact, On};
use length3_core::{account, remote, tr};
use serde_json::{json, Value};

/// What bringing a repo into step did, as a line (and its notes), and as data.
fn synced(name: &str, r: &std::result::Result<remote::Synced, String>) -> (Vec<String>, Value) {
    match r {
        Ok(s) => {
            let what = match (s.sent, s.taken) {
                (0, 0) => tr!("in step", "Remote と同じ"),
                (n, 0) => tr!("sent {}", "{}件送りました", n),
                (0, n) => tr!("took in {}", "{}件取り込みました", n),
                (a, b) => tr!("sent {}, took in {}", "{}件送り、{}件取り込みました", a, b),
            };
            let mut t = vec![format!("  {name}  {what}")];
            for p in &s.both { t.push(tr!("    changed on both: {} (the Remote's keeps the name; this device's is beside it, marked ({}))", "    両方で変わっていました：{}（その名前は Remote の版。この端末の版は（{}）を付けて横に）", p, remote::device_tag())); }
            for (p, why) in &s.unsynced { t.push(tr!("    cannot be sent: {} ({})", "    送れないもの：{}（{}）", p, why)); }
            (t, json!({"name": name, "sent": s.sent, "taken": s.taken, "both": s.both, "unsendable": s.unsynced.iter().map(|(p, _)| p).collect::<Vec<_>>()}))
        }
        Err(e) => (vec![tr!("  {}  not sent: {}", "  {}  送れていません：{}", name, e)], json!({"name": name, "error": e})),
    }
}

/// `l3 remote`: the Remote this device is on, and each repo brought into step with it.
pub fn page(ctx: &Ctx, _: &Call) -> Result<Reply> {
    let Some(c) = remote::connection() else {
        let t = [tr!("Remote  not signed in", "Remote  まだサインインしていません"),
            tr!("  l3 login, approved in the browser, signs this device in; then the Remote keeps your repos, and each change goes there by itself.", "  l3 login をブラウザで承認するとこの端末でサインインでき、Remote があなたの repo を持ちます。変更はひとりでに Remote へ届きます。")];
        return Ok(Reply::data(t.join("\n"), json!({"url": null})));
    };
    let r = ctx.repos()?;
    let account = remote::account();
    // Looking at the Remote brings every repo here into step with it.
    let all = remote::sync_all(&r).unwrap_or_default();
    let there = remote::remote_repos().unwrap_or_default();
    let here = remote::status(&r)?;
    let mut t = vec![format!("Remote  {}{}", host(&c.url), account.as_ref().ok().and_then(|a| a.as_ref()).map(|a| format!(" · {}", a.name)).unwrap_or_default())];
    if let Err(e) = &account { t.push(format!("  {e}")); }
    let mut rows = Vec::new();
    for s in &here {
        let outcome = all.iter().find(|(n, _)| *n == s.name).map(|(_, r)| r);
        let (state, said) = match outcome {
            Some(Err(e)) => ("notSent", tr!("not sent: {}", "送れていません：{}", e)),
            _ if s.fresh => ("notSent", tr!("not sent yet", "まだ送っていません")),
            _ if s.changed > 0 => ("changed", tr!("{} not sent", "{}件未送信", s.changed)),
            _ => ("inStep", tr!("in step", "Remote と同じ")),
        };
        let stuck = if s.unsynced.is_empty() { String::new() } else { tr!(" · {} cannot be sent", " · 送れないもの{}件", s.unsynced.len()) };
        t.push(format!("  {}  {said}{stuck}", s.name));
        if let Some(Ok(sy)) = outcome {
            for p in &sy.both { t.push(tr!("    changed on both: {} (the Remote's keeps the name; this device's is beside it, marked ({}))", "    両方で変わっていました：{}（その名前は Remote の版。この端末の版は（{}）を付けて横に）", p, remote::device_tag())); }
        }
        rows.push(json!({"name": s.name, "state": state, "changed": s.changed, "version": s.version, "head": s.head,
            "unsendable": s.unsynced.iter().map(|(p, _)| p).collect::<Vec<_>>(), "error": outcome.and_then(|o| o.as_ref().err())}));
    }
    for o in there.iter().filter(|o| o.off_at.is_some()) {
        crate::menu::see(|| crate::menu::Subject { on: On::RemoteRepo, word: o.name.clone(), repo: None, label: o.name.clone(),
            detail: tr!("off · kept {} more", "オフ · あと{}残ります", out::left(o.until.unwrap_or(0))), facts: vec![Fact::TurnedOff] });
        t.push(tr!("  {}  off · kept {} more (l3 remote on {})", "  {}  オフ · あと{}残ります（l3 remote on {}）", o.name, out::left(o.until.unwrap_or(0)), o.name));
    }
    for o in there.iter().filter(|o| o.off_at.is_none() && !here.iter().any(|h| h.name == o.name)) {
        crate::menu::see(|| crate::menu::Subject { on: On::RemoteRepo, word: o.name.clone(), repo: None, label: o.name.clone(),
            detail: tr!("only on the Remote · {}", "Remote にだけあります · {}", bytes(o.bytes)), facts: vec![Fact::OnlyThere] });
        t.push(tr!("  {}  only on the Remote · {} (l3 repo open {})", "  {}  Remote にだけあります · {}（l3 repo open {}）", o.name, bytes(o.bytes), o.name));
    }
    Ok(Reply::data(t.join("\n"), json!({"url": c.url, "account": account.ok().flatten(), "here": rows, "remote": there})))
}

pub fn on(_: &Ctx, call: &Call) -> Result<Reply> {
    let name = call.word(0).unwrap_or_default();
    let there = remote::remote_repos()?;
    let o = there.iter().find(|o| o.name == name).ok_or_else(|| Error::NotFound(tr!("The Remote has no repo {}", "Remote に repo {} はありません", name)))?;
    if o.off_at.is_none() { return Err(Error::Refused(tr!("{} is not turned off; there is nothing to bring back", "{} はオフになっていません。戻すものはありません", name))); }
    remote::turn_on(name)?;
    Ok(Reply::done(tr!("{} is on again", "{} を戻しました", name), json!({"repo": name, "on": true})))
}

pub fn sign_in(_: &Ctx, _: &Call) -> Result<Reply> {
    let (keys, code, providers) = (account::passkeys()?, account::off_code()?, account::providers()?);
    let mut t = vec![tr!("Passkeys", "パスキー")];
    if keys.is_empty() { t.push(tr!("  None. With one, you sign in from any device without a provider (added in the browser).", "  ありません。あればプロバイダーなしでどの端末からも入れます（ブラウザで追加）。")); }
    for k in &keys { t.push(format!("  {}  {}", k.name.as_deref().filter(|n| !n.is_empty()).unwrap_or("passkey"), k.created_at.get(..10).unwrap_or(&k.created_at))); }
    t.push(tr!("Code to turn a repo off", "repo をオフにするコード"));
    t.push(if code.set { tr!("  Set (another is set in the browser, with a passkey)", "  設定済み（変えるのはブラウザで、パスキーを使います）") } else { tr!("  Not set (set in the browser, with a passkey)", "  未設定（ブラウザで、パスキーを使って設定）") });
    t.push(tr!("Sign-in providers", "サインイン方法"));
    for p in &providers { t.push(format!("  {}  {}", p.provider, p.created_at.get(..10).unwrap_or(&p.created_at))); }
    Ok(Reply::data(t.join("\n"), json!({"passkeys": keys, "offCode": code, "providers": providers})))
}

pub fn devices(_: &Ctx, _: &Call) -> Result<Reply> {
    let list = account::devices()?;
    let t: Vec<String> = list.iter().enumerate().map(|(k, d)| format!("{}. {}  {}{}", k + 1, account::device_word(d.user_agent.as_deref()), d.updated_at.get(..10).unwrap_or(&d.updated_at),
        if d.current { tr!("  · this device (l3 logout signs it out)", "  · この端末（l3 logout でサインアウト）") } else { String::new() })).collect();
    // Each device's token stays here: it is the session itself (account::Device never writes it out).
    Ok(Reply::data(t.join("\n"), json!(list)))
}

pub fn devices_rm(_: &Ctx, call: &Call) -> Result<Reply> {
    let list = account::devices()?;
    // Said as written: a number too large to read is no device either (it was said as 0).
    let given = call.word(1).unwrap_or_default();
    let k: usize = given.parse().unwrap_or(0);
    let d = list.get(k.wrapping_sub(1)).ok_or_else(|| Error::NotFound(tr!("There is no device {} (l3 remote devices numbers them, 1 to {})", "{} 番の端末はありません（l3 remote devices の番号、1〜{}）", given, list.len())))?;
    if d.current { return Err(Error::Refused(tr!("That is this device: l3 logout signs it out", "それはこの端末です。l3 logout でサインアウトします"))); }
    account::end_device(&d.token)?;
    let word = account::device_word(d.user_agent.as_deref());
    Ok(Reply::done(tr!("Signed out {}; it is approved again to come back", "{} をサインアウトさせました。戻るにはもう一度承認します", word), json!({"removed": k, "device": word})))
}

/// `l3 login [URL]`: a code to approve in a browser, then every repo here brought into step.
pub fn login(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let url = call.word(0).map_or_else(remote::default_url, |u| u.trim_end_matches('/').to_string());
    if !remote::valid_url(&url) {
        return Err(Error::Usage(tr!("{} is not a Remote's address: http(s)://host[:port]", "{} は Remote のアドレスではありません：http(s)://host[:port]", url)));
    }
    let code = remote::device_start(&url, "l3")?;
    // Seen before l3 waits (on standard error when standard output is data).
    let say = |s: &str| if call.flags.json { eprintln!("{s}") } else { out::line(s) };
    say(&tr!("Open this page in a browser and approve:", "ブラウザでこのページを開き、承認してください："));
    say(&format!("  {}", code.verification_uri_complete));
    say(&tr!("  code {}", "  コード {}", code.user_code));
    eprint!("{}", tr!("Waiting for approval…", "承認を待っています…"));
    let done = remote::device_finish(&url, "l3", &code);
    eprintln!();
    done?;
    let mut t = vec![tr!("Signed in · {}", "サインインしました · {}", host(&url))];
    let mut rows = Vec::new();
    for (name, r) in &remote::sync_all(&ctx.repos()?)? {
        let (lines, row) = synced(name, r);
        t.extend(lines);
        rows.push(row);
    }
    Ok(Reply::done(t.join("\n"), json!({"url": url, "repos": rows})))
}

pub fn logout(ctx: &Ctx, _: &Call) -> Result<Reply> {
    if remote::connection().is_none() {
        return Ok(Reply::done(tr!("This device is not signed in; nothing to do", "この端末はサインインしていません。することはありません"), json!({"connected": false, "changed": false})));
    }
    remote::logout(&ctx.repos()?)?;
    Ok(Reply::done(tr!("Every repo was sent, and this device is signed out (its repos stay here)", "各 repo を送り、この端末をサインアウトしました（repo はこの端末に残ります）"), json!({"connected": false, "changed": true})))
}

/// Kept in step by itself (sync.rs): there is nothing to ask for.
pub fn no_sync(_: &Ctx, _: &Call) -> Result<Reply> {
    Err(Error::Usage(tr!("There is no l3 sync: every change goes to the Remote by itself, and the Remote's come in when a repo is read. l3 remote shows where each repo stands",
        "l3 sync はありません。変更はひとりでに Remote へ送られ、Remote の変更は repo を読むときに取り込まれます。l3 remote で各 repo の状態を見られます")))
}
