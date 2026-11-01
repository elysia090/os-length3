//! `l3 plan`: what to fix first in a repo, and where an issue's fix likely goes (core plan/). Read-only: the repo
//! and its git history are read, nothing is written, nothing is fetched.

use super::Ctx;
use crate::args::Call;
use crate::out::{self, Error, Reply, Result};
use crate::target;
use length3_core::plan::{self, debt, locate};
use length3_core::{tasks, tr};
use serde_json::json;

/// Steps said in full; the rest are counted (all are in --json).
const SHOWN: usize = 10;

fn say_lines(a: u32, b: u32) -> String { if a == b { a.to_string() } else { format!("{a}-{b}") } }

fn at(x: &debt::At) -> String { format!("{}:{}", x.path, say_lines(x.line, x.end)) }

/// "1, 2 and 4" / "1、2、4".
fn listed(ns: &[String]) -> String {
    if length3_core::i18n::ja() { return ns.join("、"); }
    match ns {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// Commits, as a payback is said: whole, at least one.
fn soon(c: f64) -> String { out::commits(c.ceil().max(1.0) as usize) }

fn step_text(n: usize, s: &debt::Step) -> Vec<String> {
    let mut t = Vec::new();
    match (&s.kind, &s.facts) {
        (debt::Kind::Rewrite, debt::Facts::Function { complexity, changes, .. }) => {
            let name = s.at[0].name.clone().unwrap_or_default();
            if name == length3_core::plan::shape::TOP {
                t.push(tr!("{}. Break the top level of {} into functions (lines {})", "{}. {} の関数の外のコードを関数に分ける（{} 行目）", n, s.at[0].path, say_lines(s.at[0].line, s.at[0].end)));
            } else {
                let shown = if name.starts_with('(') { name } else { format!("{name}()") };
                t.push(tr!("{}. Rewrite {} in {}", "{}. {} を書き直す（{}）", n, shown, at(&s.at[0])));
            }
            t.push(tr!("   complexity {} (over {} by {}) · changes land in it {:.1} times per 100 commits",
                "   複雑さ {}（{} を {} 超える）· 100 コミットに {:.1} 回ここが変わる", complexity, debt::T, complexity - debt::T, changes));
            t.push(tr!("   pays back in {} · done when it is at most {} and the tests pass", "   {}で元が取れる · {} 以下になり、テストが通れば完了", soon(s.payback), debt::T));
        }
        (debt::Kind::Untangle, debt::Facts::Circle { files, cut, .. }) => {
            t.push(tr!("{}. Untangle the circle of {} around {}", "{}. {} の循環をほどく（{} のまわり）", n, out::files(*files), s.at[0].path));
            let cuts: Vec<String> = cut.iter().take(3).map(|c| {
                let lines = c.lines.iter().filter(|&&l| l > 0).map(u32::to_string).collect::<Vec<_>>();
                let place = match lines.len() { 0 => String::new(), 1 => tr!(" (line {})", "（{} 行目）", lines[0]), _ => tr!(" (lines {})", "（{} 行目）", lines.join(", ")) };
                format!("{} → {}{place}", c.from, c.to)
            }).collect();
            let uses: u32 = cut.iter().map(|c| c.uses).sum();
            let more = if cut.len() > 3 { tr!(", and {} more", "、ほか {}", cut.len() - 3) } else { String::new() };
            t.push(tr!("   move {} {}: {}{}", "   {} {}を移す：{}{}", uses, if uses == 1 { "use" } else { "uses" }, cuts.join(", "), more));
            t.push(tr!("   pays back in {} · done when they are no circle and the tests pass", "   {}で元が取れる · 循環がなくなり、テストが通れば完了", soon(s.payback)));
        }
        (debt::Kind::Fold, debt::Facts::Copies { copies, lines, .. }) => {
            let places: Vec<String> = s.at.iter().take(3).map(at).collect();
            let more = if s.at.len() > 3 { tr!(", and {} more", "、ほか {}", s.at.len() - 3) } else { String::new() };
            t.push(tr!("{}. Fold {} copies of {} lines into one: {}{}", "{}. {} か所の {} 行の写しをひとつにまとめる：{}{}", n, copies, lines, places.join(", "), more));
            t.push(tr!("   pays back in {} · done when no copy is left between them and the tests pass", "   {}で元が取れる · 写しがなくなり、テストが通れば完了", soon(s.payback)));
        }
        _ => {}
    }
    t
}

fn read(ctx: &Ctx, repo: &str, words: bool) -> Result<(plan::Snapshot, plan::Analysis)> {
    let dir = ctx.repos()?.dir(repo).map_err(Error::NotFound)?;
    Ok(plan::analyze_dir(&dir, words))
}

fn read_line(p: &debt::Plan) -> String {
    let s = &p.summary;
    let mut t = tr!("Read {} ({} lines of code, {} functions)", "{}（コード {} 行、関数 {}）を読みました", out::files(s.files), s.lines, s.functions);
    if p.history { t += &tr!(" and {}", "。履歴は {}", out::commits(s.commits)); }
    else { t += &tr!("; no history here (not a git repository): every file is taken to change as often", "。履歴がありません（git のリポジトリではない）：どのファイルも同じだけ変わるとみなしました"); }
    t
}

/// `l3 plan [REPO]`: the repo's debt, what to do about it first.
pub fn debt(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let (_, a) = read(ctx, &repo, false)?;
    let p = debt::plan(&a);
    let mut t = Vec::new();
    let dominant: Vec<String> = p.steps.iter().enumerate().filter(|(_, s)| s.dominant).map(|(i, _)| (i + 1).to_string()).collect();
    let kept_dominant = p.kept.iter().filter(|s| s.dominant).count();
    if p.steps.is_empty() && p.kept.is_empty() {
        t.push(tr!("{}: no debt the plan can see that costs anything (no function over {}, circle or copy that changes)",
            "{}：コストのかかる負債は見当たりません（変わる箇所に、{} を超える関数も循環も写しもありません）", repo, debt::T));
    } else if p.steps.is_empty() {
        t.push(tr!("{}: nothing pays back within {}", "{}：{}以内に元が取れるものはありません", repo, out::commits(p.horizon as usize)));
    } else {
        let head = tr!("{}: {}, the soonest to pay back first", "{}：{}件の手順（早く元が取れる順）", repo, if length3_core::i18n::ja() { p.steps.len().to_string() } else { out::count(p.steps.len(), "step", "steps", "{}") });
        let spread = dominant.len() + kept_dominant > 5;
        let carry = match (dominant.as_slice(), kept_dominant) {
            _ if spread => tr!(". No few steps dominate: {} of them carry {}% of what the debt costs", "。少数の手順に偏っていません：{}件で負債のコストの {}%", p.dominant, (debt::DOMINANT * 100.0) as u32),
            ([], _) => String::new(),
            (d, 0) if d.len() == 1 => tr!(". Step {} carries {}% of what the debt costs", "。{} が負債のコストの {}% を占めます", d[0], (debt::DOMINANT * 100.0) as u32),
            (d, 0) => tr!(". Steps {} carry {}% of what the debt costs", "。{} で負債のコストの {}% を占めます", listed(d), (debt::DOMINANT * 100.0) as u32),
            (d, k) => tr!(". Steps {} and {} kept carry {}% of what the debt costs", "。{} と残す {}件で負債のコストの {}% を占めます", listed(d), k, (debt::DOMINANT * 100.0) as u32),
        };
        t.push(format!("{head}{carry}"));
    }
    for (i, s) in p.steps.iter().enumerate().take(SHOWN) {
        t.push(String::new());
        t.extend(step_text(i + 1, s));
    }
    if p.steps.len() > SHOWN {
        t.push(String::new());
        t.push(tr!("And {} more (l3 plan {} --json lists them)", "ほかに {}件（l3 plan {} --json で一覧）", p.steps.len() - SHOWN, repo));
    }
    t.push(String::new());
    if !p.kept.is_empty() {
        t.push(tr!("Kept: {} cost less to keep than to pay off within {} (l3 plan {} --json lists them)",
            "残す：{}件は {}以内では直すより残すほうが安くつきます（l3 plan {} --json で一覧）",
            if length3_core::i18n::ja() { p.kept.len().to_string() } else { out::count(p.kept.len(), "debt", "debts", "{}") }, out::commits(p.horizon as usize), repo));
    }
    t.push(read_line(&p));
    if let Some(f) = &p.foretold {
        t.push(tr!("Checked against its own history: of the last {} commits' changes, {:.0}% landed in the tenth of the files the commits before them changed most (a tenth by chance)",
            "履歴で確かめました：直近 {} コミットの変更の {:.0}% が、それ以前によく変わっていた上位1割のファイルに入りました（偶然なら1割）", f.held, f.top * 100.0));
    }
    let mut v = serde_json::to_value(&p).map_err(|e| Error::Io(e.to_string()))?;
    v["repo"] = json!(repo);
    Ok(Reply::data(t.join("\n"), v))
}

/// `l3 plan REPO#N`: where an issue's fix likely goes, what to read first, and what then.
pub fn issue(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let at = target::issue(ctx, call, 0)?;
    let r = ctx.repos()?.on_main();
    let text = r.read(&at.repo, &at.path(), 256 * 1024)?.text.unwrap_or_default();
    let i = length3_core::issues::parse(&at.repo, &at.file, &text);
    let (snap, a) = read(ctx, &at.repo, true)?;
    let texts: Vec<&[u8]> = snap.texts.iter().map(|t| t.bytes.as_slice()).collect();
    let (places, fit) = locate::locate(&a, &texts, &i.title, &i.detail, 5);
    let order = locate::reading_order(&places);
    let number = i.n.map(|n| format!("#{n}")).unwrap_or_default();
    let mut t = vec![format!("{}{} {}", at.repo, number, at.title), tr!("Where its fix likely goes", "直す場所の見込み")];
    let shown: Vec<&locate::Place> = places.iter().filter(|p| p.chance >= 0.01).collect();
    for p in &shown {
        let what = p.func.as_ref().map(|f| format!(" {f}()")).unwrap_or_default();
        t.push(format!("  {:>3.0}%  {}:{}{what}", p.chance * 100.0, p.path, say_lines(p.line, p.end)));
    }
    if shown.is_empty() { t.push(tr!("  nowhere in particular: no file holds its words", "  特定できません（その言葉を含むファイルがありません）")); }
    let reading: Vec<String> = order.iter().filter(|&&k| places[k].chance >= 0.01).map(|&k| {
        let p = &places[k];
        match &p.func { Some(f) => format!("{f}() ({}:{})", p.path, p.line), None => p.path.clone() }
    }).collect();
    if reading.len() > 1 {
        t.push(tr!("Read in this order, the least reading on average to find it: {}", "この順に読むと、見つかるまでに読む量が平均で最も少なくなります：{}", reading.join(", ")));
    }
    // What then: a test that shows it, the fix, and what it is done when; while there, a function over T rewritten.
    let dir = ctx.repos()?.dir(&at.repo).map_err(Error::NotFound)?;
    let tests = tasks::tests_command(&dir);
    t.push(tr!("Then", "それから"));
    let mut n = 1;
    match &tests {
        Some(cmd) => t.push(tr!("  {}. Write a test that fails because of {} ({})", "  {}. {} のせいで落ちるテストを書く（{}）", n, if number.is_empty() { "it".to_string() } else { number.clone() }, cmd)),
        None => t.push(tr!("  {}. Show it failing: there are no tests here to add one to", "  {}. 落ちることを確かめる（ここにはテストがありません）", n)),
    }
    n += 1;
    let over = places.first().and_then(|p| {
        let f = &a.files[p.file];
        f.funcs.iter().find(|g| Some(&g.name) == p.func.as_ref() && g.complexity > debt::T).map(|g| (g.name.clone(), g.complexity))
    });
    match &over {
        Some((name, c)) => t.push(tr!("  {}. Fix it there, rewriting {}() while there: its complexity {} is over {}", "  {}. そこを直す。ついでに {}() を書き直す（複雑さ {} は {} を超えています）", n, name, c, debt::T)),
        None => t.push(tr!("  {}. Fix it there", "  {}. そこを直す", n)),
    }
    n += 1;
    t.push(tr!("  {}. Done when the new test and the others pass, and nothing it touched is over {}", "  {}. 新しいテストとほかのテストが通り、触れたところが {} を超えなければ完了", n, debt::T));
    match &fit {
        Some(f) => t.push(tr!("On {} past fixes here, its place came first for {:.0}% and in the first five for {:.0}% (the words alone: {:.0}%, the history alone: {:.0}%)",
            "ここの過去の Fix {}件では、直した場所が1番目に出たのが {:.0}%、5番目までが {:.0}%（言葉だけなら {:.0}%、履歴だけなら {:.0}%）",
            f.held_out, f.first * 100.0, f.top5 * 100.0, f.words_top5 * 100.0, f.history_top5 * 100.0)),
        None => t.push(tr!("Too few past fixes here to check this against: by the issue's words alone", "照らし合わせられる過去の Fix が少なすぎます：Issue の言葉だけで見ています")),
    }
    let places_json: Vec<serde_json::Value> = places.iter().map(|p| json!({"path": p.path, "line": p.line, "end": p.end, "function": p.func, "chance": p.chance, "read": p.read})).collect();
    Ok(Reply::data(t.join("\n"), json!({
        "repo": at.repo, "issue": i.n, "title": at.title, "places": places_json,
        "order": order.iter().map(|&k| places[k].path.clone()).collect::<Vec<_>>(), "fit": fit, "tests": tests,
        "rewrite": over.map(|(name, complexity)| json!({"function": name, "complexity": complexity})),
    })))
}
