//! Remote: where this device is connected and where each repo stands; the
//! account's sign-in and devices; connecting and disconnecting.

use super::{host, Ctx};
use crate::args::Call;
use crate::out::{self, bytes, Error, Reply, Result};
use crate::spec::{Fact, On};
use length3_core::{account, remote, tr};
use serde_json::{json, Value};

/// What bringing a repo into step did, as a line (and its notes), its name in `cols` columns, and as data.
fn synced(name: &str, cols: usize, r: &std::result::Result<remote::Synced, String>) -> (Vec<String>, Value) {
    let shown = crate::help::pad(name, cols);
    match r {
        Ok(s) => {
            // What was sent and taken in are files (and folders) by their paths: said as files (bug: "sent 5", of what).
            let what = match (s.sent, s.taken) {
                (0, 0) => tr!("in step", "Remote と同じ"),
                (n, 0) => tr!("sent {}", "{}を送りました", out::files(n)),
                (0, n) => tr!("took in {}", "{}を取り込みました", out::files(n)),
                (a, b) => tr!("sent {}, took in {}", "{}を送り、{}を取り込みました", out::files(a), out::files(b)),
            };
            let mut t = vec![format!("  {shown}  {what}")];
            for p in &s.both { t.push(tr!("    changed on both: {} (the Remote's keeps the name; this device's is beside it, marked ({}))", "    両方で変わっていました：{}（その名前は Remote の版。この端末の版は（{}）を付けて横に）", p, remote::device_tag())); }
            for (p, why) in &s.unsynced { t.push(tr!("    cannot be sent: {} ({})", "    送れないもの：{}（{}）", p, why)); }
            (t, json!({"name": name, "sent": s.sent, "taken": s.taken, "both": s.both, "unsendable": s.unsynced.iter().map(|(p, _)| p).collect::<Vec<_>>()}))
        }
        Err(e) => (vec![tr!("  {}  not sent: {}", "  {}  送れていません：{}", shown, e)], json!({"name": name, "error": e})),
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
    // Each repo's name in one column, as wide as the widest (as out::columns lines them up), its state after it.
    let cols = here.iter().map(|s| s.name.as_str())
        .chain(there.iter().filter(|o| o.off_at.is_some() || !here.iter().any(|h| h.name == o.name)).map(|o| o.name.as_str()))
        .map(crate::help::width).filter(|w| *w <= 24).max().unwrap_or(0);
    let name = |n: &str| crate::help::pad(n, cols);
    for s in &here {
        let outcome = all.iter().find(|(n, _)| *n == s.name).map(|(_, r)| r);
        let (state, said) = match outcome {
            Some(Err(e)) => ("notSent", tr!("not sent: {}", "送れていません：{}", e)),
            _ if s.fresh => ("notSent", tr!("not sent yet", "まだ送っていません")),
            _ if s.changed > 0 => ("changed", tr!("{} not sent", "{}件未送信", s.changed)),
            _ => ("inStep", tr!("in step", "Remote と同じ")),
        };
        let stuck = if s.unsynced.is_empty() { String::new() } else { tr!(" · {} cannot be sent", " · 送れないもの{}件", s.unsynced.len()) };
        t.push(format!("  {}  {said}{stuck}", name(&s.name)));
        if let Some(Ok(sy)) = outcome {
            for p in &sy.both { t.push(tr!("    changed on both: {} (the Remote's keeps the name; this device's is beside it, marked ({}))", "    両方で変わっていました：{}（その名前は Remote の版。この端末の版は（{}）を付けて横に）", p, remote::device_tag())); }
        }
        rows.push(json!({"name": s.name, "state": state, "changed": s.changed, "version": s.version, "head": s.head,
            "unsendable": s.unsynced.iter().map(|(p, _)| p).collect::<Vec<_>>(), "error": outcome.and_then(|o| o.as_ref().err())}));
    }
    for o in there.iter().filter(|o| o.off_at.is_some()) {
        crate::menu::see(|| crate::menu::Subject { on: On::RemoteRepo, word: o.name.clone(), repo: None, label: o.name.clone(),
            detail: tr!("off · kept {} more", "オフ · あと{}残ります", out::left(o.until.unwrap_or(0))), facts: vec![Fact::TurnedOff] });
        t.push(tr!("  {}  off · kept {} more (l3 remote on {})", "  {}  オフ · あと{}残ります（l3 remote on {}）", name(&o.name), out::left(o.until.unwrap_or(0)), o.name));
    }
    for o in there.iter().filter(|o| o.off_at.is_none() && !here.iter().any(|h| h.name == o.name)) {
        crate::menu::see(|| crate::menu::Subject { on: On::RemoteRepo, word: o.name.clone(), repo: None, label: o.name.clone(),
            detail: tr!("only on the Remote · {}", "Remote にだけあります · {}", bytes(o.bytes)), facts: vec![Fact::OnlyThere] });
        t.push(tr!("  {}  only on the Remote · {} (l3 repo open {})", "  {}  Remote にだけあります · {}（l3 repo open {}）", name(&o.name), bytes(o.bytes), o.name));
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
    // Signed in already, with a session the Remote still knows: run again, it is done (bug: each run made
    // one more session on the Remote and left the last one there, never ended); for another Remote, the
    // repos go to this one first, as signing out sends them.
    if let (Some(c), Ok(Some(a))) = (remote::connection(), remote::account()) {
        if c.url != remote::current_url(&url) {
            return Err(Error::Refused(tr!("This device is signed in to {}: l3 logout first (it sends every repo there), then l3 login {}", "この端末は {} にサインインしています。先に l3 logout（各 repo をそこへ送ります）、それから l3 login {}", host(&c.url), url)));
        }
        return Ok(Reply::done(tr!("Signed in already · {} as {}", "サインイン済みです · {}（{}）", host(&c.url), a.name), json!({"url": c.url, "changed": false, "repos": []})));
    }
    let code = remote::device_start(&url, "l3")?;
    // Only a page that Remote stands behind is shown to open, as the app opens only such a page (bug: l3
    // printed whatever page was named, for a person to open and approve this device on).
    if !remote::device_page_ok(&url, remote::app_origin(&url).as_deref(), &code.verification_uri_complete) {
        return Err(Error::Refused(tr!("{} named a page that is not its own to approve this device on; nothing was signed in", "{} が、この端末を承認するページとして自分のものでないページを示しました。サインインしていません", url)));
    }
    // Seen before l3 waits (on standard error when standard output is data).
    let say = |s: &str| if call.flags.json { eprintln!("{s}") } else { out::line(s) };
    say(&tr!("Open this page in a browser and approve:", "ブラウザでこのページを開き、承認してください："));
    say(&format!("  {}", out::plain(&code.verification_uri_complete)));
    say(&tr!("  code {}", "  コード {}", out::plain(&code.user_code)));
    eprint!("{}", tr!("Waiting for approval…", "承認を待っています…"));
    let done = remote::device_finish(&url, "l3", &code);
    eprintln!();
    done?;
    let mut t = vec![tr!("Signed in · {}", "サインインしました · {}", host(&url))];
    let mut rows = Vec::new();
    let all = remote::sync_all(&ctx.repos()?)?;
    let cols = all.iter().map(|(n, _)| crate::help::width(n)).filter(|w| *w <= 24).max().unwrap_or(0);
    for (name, r) in &all {
        let (lines, row) = synced(name, cols, r);
        t.extend(lines);
        rows.push(row);
    }
    Ok(Reply::done(t.join("\n"), json!({"url": url, "changed": true, "repos": rows})))
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

/// A size as the Remote's allowance is said (a megabyte a million bytes, as the app says it).
fn kept(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let (mut v, mut u) = (n as f64, 0);
    while v >= 1000.0 && u < units.len() - 1 { v /= 1000.0; u += 1; }
    if u == 0 { format!("{n} B") } else if v >= 100.0 { format!("{v:.0} {}", units[u]) } else { format!("{v:.1} {}", units[u]) }
}

/// What paid adds, the same three as the app's Plan says.
fn paid_adds() -> [String; 3] {
    [tr!("Keep more than the free allowance on the Remote", "無料の枠を超えて Remote に置ける"),
        tr!("Make servers: boards and talk with people you know", "サーバーを作れる：知り合いとの板と話"),
        tr!("Names on your own domain (name@yourdomain), and more names here", "自分のドメインの名前（name@yourdomain）と、この Remote での2つ目からの名前")]
}

/// A price in words, as the app's Plan says it: 14.00 USD a month (a currency without cents, 800 JPY).
fn price_words(p: &account::Price) -> String {
    let cur = p.currency.to_ascii_uppercase();
    let money = if ["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF"].contains(&cur.as_str()) { format!("{} {cur}", p.amount) }
        else { format!("{}.{:02} {cur}", p.amount / 100, p.amount % 100) };
    let per = match (p.interval.as_str(), p.every) {
        ("day", 1) => tr!("a day", "1日"), ("week", 1) => tr!("a week", "1週間"), ("year", 1) => tr!("a year", "年額"), (_, 1) => tr!("a month", "月額"),
        ("day", n) => tr!("every {} days", "{}日ごと", n), ("week", n) => tr!("every {} weeks", "{}週間ごと", n), ("year", n) => tr!("every {} years", "{}年ごと", n),
        (_, n) => tr!("every {} months", "{}か月ごと", n),
    };
    format!("{money} {per}")
}

/// `l3 remote plan`: the tier the account is on, until when, what the Remote keeps against what that tier keeps,
/// and the tiers beside it, as the Remote says it (it decides; l3 shows). The page to subscribe to a tier on is
/// `l3 remote plan subscribe TIER`; to change tier or manage, `l3 remote plan switch TIER` and `l3 remote plan manage`.
pub fn plan(_: &Ctx, _: &Call) -> Result<Reply> {
    let p = account::plan()?;
    if p.plan == "none" {
        return Ok(Reply::data(tr!("Plan  none: this Remote keeps everything for everyone", "プラン  なし：この Remote は誰のものでもすべて置きます"), json!(p)));
    }
    let paid = p.plan == "paid";
    let tier = p.tier.clone().filter(|t| account::TIERS.contains(&t.as_str()) && paid);
    let when = if let Some(g) = p.grace_until.filter(|_| paid) { tr!(" · a payment did not go through; paid until {}", " · 支払いができませんでした。{}まで有料プラン", out::day(g)) }
        else if let Some(e) = p.ends { if paid { tr!(" · ends {}", " · {}に終了", out::day(e)) } else { tr!(" · ended {}; what you made stays", " · {}に終了。作ったものはそのまま残ります", out::day(e)) } }
        else if let Some(r) = p.renews.filter(|_| paid) { tr!(" · renews {}", " · {}に更新", out::day(r)) }
        else { String::new() };
    let name = match &tier { Some(t) => account::tier_name(t), None if paid => tr!("paid", "有料"), None => tr!("free", "無料") };
    let mut t = vec![format!("{}  {name}{when}", tr!("Plan", "プラン"))];
    let (u, f) = (p.usage.unwrap_or_default(), p.free.unwrap_or_default());
    // Against what the tier keeps; a Remote from before there were tiers says only the free allowance, and paid had none.
    let keeps = p.allowance.unwrap_or(if paid { account::Keeps {repos: None, bytes: 0, names: None} } else { account::Keeps {repos: Some(f.repos), bytes: f.bytes, names: Some(f.names)} });
    let of = |used: String, cap: Option<String>| match cap { Some(c) => tr!("{} of {}", "{} / {}", used, c), None => used };
    t.push(format!("  {}  {}", tr!("Repos on the Remote", "Remote にある repo"), of(u.repos.to_string(), keeps.repos.map(|n| n.to_string()))));
    t.push(format!("  {}  {}", tr!("Kept on the Remote", "Remote に置いている量"), of(kept(u.bytes), (keeps.bytes > 0).then(|| kept(keeps.bytes)))));
    if p.allowance.is_some() { t.push(format!("  {}  {}", tr!("Names on this Remote", "この Remote の名前"), of(u.names.to_string(), keeps.names.map(|n| n.to_string())))); }
    if keeps.repos.is_some_and(|n| u.repos > n) || (keeps.bytes > 0 && u.bytes > keeps.bytes) {
        t.push(tr!("  The Remote keeps what is there; what is new stays on this device until there is room", "  Remote にあるものはそのままです。新しいものは空きができるまでこの端末に残ります"));
    }
    // Free and each tier sold, the account's own marked.
    let sold: Vec<_> = p.tiers.iter().filter(|x| x.tier != "free").collect();
    if !sold.is_empty() {
        t.push(tr!("Tiers", "プランの種類"));
        for x in sold {
            let mine = tier.as_deref() == Some(x.tier.as_str());
            t.push(format!("  {}  {}{}{}", account::tier_name(&x.tier), tr!("{} on the Remote", "Remote に {}", kept(x.allowance.bytes).replace(".0 ", " ")),
                x.price.as_ref().map(|p| format!(" · {}", price_words(p))).unwrap_or_default(), if mine { tr!(" · yours", " · いまのプラン") } else { String::new() }));
        }
    }
    t.push(if paid { tr!("Paid gives", "有料プランで使えるもの") } else { tr!("Paid adds", "有料プランで増えるもの") });
    for a in paid_adds() { t.push(format!("  {a}")); }
    t.push(if !p.buy { tr!("Paid features cannot be bought on this Remote yet", "この Remote ではまだ有料プランを購入できません") }
        else if paid && p.manage { tr!("l3 remote plan manage gives the page to manage or cancel it; l3 remote plan switch go|pro|max, to change tier",
            "l3 remote plan manage で管理・解約するページを、l3 remote plan switch go|pro|max でプランを変えるページを出します") }
        else if paid { String::new() }
        else { tr!("l3 remote plan subscribe go|pro|max gives the page to subscribe on", "l3 remote plan subscribe go|pro|max で登録するページを出します") });
    t.retain(|l| !l.is_empty());
    Ok(Reply::data(t.join("\n"), json!(p)))
}

/// `l3 remote plan subscribe [TIER]|manage|switch TIER`: the page, as the Remote makes it for this account (Stripe's),
/// to open in a browser: Checkout for a tier (none named, the least sold), the portal, or the portal at the step
/// that changes the tier.
pub fn plan_page(_: &Ctx, call: &Call) -> Result<Reply> {
    let (kind, tier) = match call.word(0) {
        Some("manage") => ("portal", None),
        Some("switch") => ("portal", call.word(1)),
        _ => ("checkout", call.word(1)),
    };
    let url = account::plan_page(kind, tier)?;
    let said = if kind == "portal" && tier.is_some() { tr!("Open this page in a browser to change the tier:", "ブラウザでこのページを開くと、プランを変えられます：") }
        else if kind == "portal" { tr!("Open this page in a browser to manage or cancel the plan:", "ブラウザでこのページを開くと、プランを管理・解約できます：") }
        else { tr!("Open this page in a browser to subscribe:", "ブラウザでこのページを開くと登録できます：") };
    Ok(Reply::data(format!("{said}\n  {url}"), json!({"url": url})))
}
