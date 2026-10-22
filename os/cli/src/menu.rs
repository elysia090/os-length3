//! The menu: l3 for a person at a terminal, who need not know its words.
//!
//! Bare `l3` shows the rail (Home, Forge, File, Git, Runtime, Remote,
//! Server, Inbox, +), each with what is there now; a purpose picked prints
//! its page as `l3 <page>` prints it, then the deeds of each thing on the page
//! and of the page itself, picked with the keyboard. A deed is a form of the
//! table (spec.rs): the thing it is pressed on gives it its word, the rest is
//! asked in place, one line each, and it runs as the command it is, said
//! first (`→ l3 start notes#1`), so the words are learned by seeing them.
//! After a command typed by hand, its next deeds are offered the same way,
//! in a short row that Enter or Esc passes by.
//!
//! What it offers is read from the table and from what each page shows
//! (its things and their facts, noted while the page is made: `see`), so the
//! menu, the help and the completion cannot drift apart. Off a terminal, with
//! --json, TERM=dumb or L3_PLAIN set, none of this happens (term::interactive).

use crate::args;
use crate::cmd::{self, Ctx};
use crate::out::{self, Error};
use crate::spec::{self, say, Arg, Command, Deed, Fact, Flag, Form, Group, On};
use crate::term::{self, Block, Key, Keys, Style};
use length3_core::{home, i18n, paths, remote, root, tr};
use std::cell::{Cell, RefCell};
use std::process::ExitCode;

// ---- What a page shows ----

/// A thing on a page that deeds are pressed on: an issue, a TODO item, a repo…
#[derive(Clone, Debug, PartialEq)]
pub struct Subject {
    pub on: On,
    /// The word that names it in a command (notes#1, 2, notes/src).
    pub word: String,
    /// The repo it is in, for a form whose slot is the repo (Commit on an issue).
    pub repo: Option<String>,
    /// As the page names it, and where it stands.
    pub label: String,
    pub detail: String,
    pub facts: Vec<Fact>,
}

/// What a page showed: its things, and what holds of the page as a whole.
#[derive(Default, Debug)]
pub struct Seen { pub subjects: Vec<Subject>, pub facts: Vec<Fact> }

thread_local! {
    static SEEN: RefCell<Option<Seen>> = const { RefCell::new(None) };
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
}

/// Note a thing the page shows, while the menu is noting (made only then).
pub fn see(make: impl FnOnce() -> Subject) {
    if SEEN.with(|s| s.borrow().is_none()) { return; }
    let s = make();
    SEEN.with(|seen| if let Some(seen) = seen.borrow_mut().as_mut() { seen.subjects.push(s) });
}

/// Note what holds of the page as a whole.
pub fn page_fact(f: Fact) {
    SEEN.with(|seen| if let Some(seen) = seen.borrow_mut().as_mut() { if !seen.facts.contains(&f) { seen.facts.push(f) } });
}

/// Run `f`, noting what it shows.
pub fn noting<T>(f: impl FnOnce() -> T) -> (T, Seen) {
    let outer = SEEN.with(|s| s.replace(Some(Seen::default())));
    let t = f();
    let seen = SEEN.with(|s| s.replace(outer)).unwrap_or_default();
    (t, seen)
}

/// Whether the menu is running (a Prompt opened from it gives the terminal back to it when it ends).
pub fn active() -> bool { ACTIVE.with(|a| a.get()) }

// ---- What is offered ----

/// Where l3 runs, as far as what may run there goes.
#[derive(Clone, Copy, Debug)]
pub struct Env { pub prompt: bool, pub connected: bool }

impl Env {
    fn of(ctx: &Ctx) -> Env { Env { prompt: ctx.prompt, connected: ctx.connected() } }
}

/// What holds of this device.
fn device(ctx: &Ctx) -> Vec<Fact> {
    let mut f = vec![if ctx.connected() { Fact::SignedIn } else { Fact::SignedOut }];
    if root::current(&paths::data_dir()).is_none() { f.push(Fact::NoRoot); }
    f
}

/// A deed of the table with the form and command it does.
#[derive(Clone, Copy)]
pub struct Offer { pub command: &'static Command, pub form: &'static Form, pub deed: &'static Deed }

impl Offer {
    pub fn label(&self) -> &'static str { say(self.deed.label) }
}

/// Every deed offered on a purpose, in the table's order.
pub fn deeds_of(group: Group) -> Vec<Offer> {
    spec::COMMANDS.iter()
        .flat_map(|c| c.forms.iter().flat_map(move |f| f.deeds.iter().map(move |d| Offer { command: c, form: f, deed: d })))
        .filter(|o| o.command.group == group || o.deed.also.contains(&group))
        .collect()
}

/// Whether a deed is offered where `facts` hold.
pub fn holds(d: &Deed, facts: &[Fact]) -> bool {
    d.when.iter().all(|f| facts.contains(f)) && !d.unless.iter().any(|f| facts.contains(f))
}

/// Whether a form may run here (as cmd::before would let it).
fn may_run(f: &Form, env: Env) -> bool {
    !(env.prompt && !f.needs.in_prompt) && !(f.needs.remote && !env.connected)
}

/// The deeds offered on a thing (or the page, `On::Page`) where `facts` hold: what the thing is for first.
pub fn offered(group: Group, on: On, facts: &[Fact], env: Env) -> Vec<Offer> {
    let mut v: Vec<Offer> = deeds_of(group).into_iter().filter(|o| o.deed.on == on && holds(o.deed, facts) && may_run(o.form, env)).collect();
    v.sort_by_key(|o| o.deed.weight);
    v
}

/// The forms that make a purpose's page, in the table's order.
pub fn page_forms(group: Group) -> Vec<(&'static Command, &'static Form)> {
    spec::COMMANDS.iter().filter(|c| c.group == group).flat_map(|c| c.forms.iter().filter(|f| f.page).map(move |f| (c, f))).collect()
}

/// A page as the menu holds it: the things on it, whether it is the purpose's own page, and the
/// command lines that made it (read again after a deed, so the page stays the one the person was on).
pub struct View { pub group: Group, pub subjects: Vec<Subject>, pub facts: Vec<Fact>, pub own: bool, pub made_by: Vec<Vec<String>> }

/// Where a row leads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Go { Thing(usize), Page, Purpose(Group), Rail }

/// A row of the menu: a thing with its deeds, a deed of the page, or a place to go.
#[derive(Clone)]
pub struct Row { pub label: String, pub detail: String, pub offers: Vec<Offer>, pub go: Go }

/// The rows of a page: each thing that has a deed, then the page's own deeds, then the way back.
pub fn rows(view: &View, env: Env, device: &[Fact]) -> Vec<Row> {
    let mut rows = Vec::new();
    for (k, s) in view.subjects.iter().enumerate() {
        let facts: Vec<Fact> = s.facts.iter().chain(device).copied().collect();
        let offers = offered(view.group, s.on, &facts, env);
        if !offers.is_empty() { rows.push(Row { label: s.label.clone(), detail: s.detail.clone(), offers, go: Go::Thing(k) }); }
    }
    let facts: Vec<Fact> = view.facts.iter().chain(device).copied().collect();
    for o in offered(view.group, On::Page, &facts, env) {
        rows.push(Row { label: o.label().to_string(), detail: String::new(), offers: vec![o], go: Go::Page });
    }
    if !view.own && !page_forms(view.group).is_empty() {
        rows.push(Row { label: view.group.name().to_string(), detail: say(view.group.role()).to_string(), offers: Vec::new(), go: Go::Purpose(view.group) });
    }
    rows.push(Row { label: tr!("Purposes", "目的"), detail: String::new(), offers: Vec::new(), go: Go::Rail });
    rows
}

// ---- How it is drawn ----

fn pad(s: &str, cols: usize) -> String { format!("{s}{}", " ".repeat(cols.saturating_sub(term::width(s)))) }

/// The rows as lines: the focused one marked › with its deeds under it, the
/// chosen deed in brackets; numbers to jump by; at most `height` lines, the
/// rest said as more above or below. `focus` None: the rows as they were left.
pub fn draw(rows: &[Row], focus: Option<(usize, usize)>, cols: usize, height: usize, style: Style, hint: &str) -> Vec<String> {
    let lw = rows.iter().map(|r| term::width(&r.label)).max().unwrap_or(0).min(34);
    let room = height.saturating_sub(4).max(3);
    let at = focus.map_or(0, |f| f.0);
    let (from, to) = if rows.len() <= room { (0, rows.len()) } else {
        let from = at.saturating_sub(room / 2).min(rows.len() - room);
        (from, from + room)
    };
    let mut out = Vec::new();
    if from > 0 { out.push(style.dim(&format!("      {}", tr!("↑ {} more", "↑ ほか{}件", from)))); }
    for (i, r) in rows.iter().enumerate().take(to).skip(from) {
        let here = focus.is_some_and(|f| f.0 == i);
        let num = if i < 9 { (i + 1).to_string() } else { " ".to_string() };
        let label = if here { style.bold(&pad(&r.label, lw)) } else { pad(&r.label, lw) };
        let detail = if r.detail.is_empty() { String::new() } else { format!("  {}", style.dim(&r.detail)) };
        out.push(format!("  {} {num}  {label}{detail}", if here { "›" } else { " " }).trim_end().to_string());
        // The deeds of the focused thing, under it; a row that is one deed is its own button.
        if let (true, Some((_, d))) = (here, focus) {
            if matches!(r.go, Go::Thing(_)) || r.offers.len() > 1 {
                let words: Vec<String> = r.offers.iter().enumerate().map(|(j, o)| if j == d { format!("[{}]", style.bold(o.label())) } else { format!(" {} ", o.label()) }).collect();
                out.extend(wrap(&words, "       ", cols).into_iter().map(|l| l.trim_end().to_string()));
            }
        }
    }
    if to < rows.len() { out.push(style.dim(&format!("      {}", tr!("↓ {} more", "↓ ほか{}件", rows.len() - to)))); }
    if focus.is_some() && !hint.is_empty() { out.push(style.dim(&format!("  {hint}"))); }
    out
}

/// Words in lines no wider than `cols`, each line starting with `lead`.
fn wrap(words: &[String], lead: &str, cols: usize) -> Vec<String> {
    let mut lines = vec![lead.to_string()];
    for w in words {
        let last = lines.last_mut().expect("a line");
        if term::width(last) + term::width(w) + 1 > cols.max(20) && term::width(last) > term::width(lead) {
            lines.push(format!("{lead}{w}"));
        } else {
            if term::width(last) > term::width(lead) { last.push(' '); }
            last.push_str(w);
        }
    }
    lines
}

fn hint_rail() -> String { tr!("↑↓ choose · Enter open · 1-9 or a letter jumps · q leaves", "↑↓ 選ぶ · Enter 開く · 1-9 か頭文字で移る · q 終わる") }
fn hint_after() -> String { tr!("←→ choose, then Enter · Enter alone or Esc goes on", "←→ で選んで Enter · Enter だけか Esc でそのまま") }
fn hint_page() -> String { tr!("↑↓ choose · ←→ deed · Enter do · Backspace purposes · q leaves", "↑↓ 選ぶ · ←→ 操作 · Enter 実行 · Backspace 目的 · q 終わる") }

// ---- Picking ----

enum Picked { Do(usize, usize), Leave, Rail }

/// The rows, drawn in place and walked with the keys, until one is done or the person leaves.
fn pick(rows: &[Row], focus: &mut (usize, usize), hint: &str) -> Picked {
    let Some(keys) = Keys::take() else { return Picked::Leave };
    let style = Style::now();
    let mut block = Block::default();
    focus.0 = focus.0.min(rows.len().saturating_sub(1));
    let mut letter: Option<char> = None;
    loop {
        let (cols, height) = term::size();
        block.draw(&draw(rows, Some(*focus), cols.saturating_sub(1), height, style, hint));
        let deeds = rows[focus.0].offers.len().max(1);
        let key = keys.next();
        if !matches!(key, Key::Char(_)) { letter = None; }
        match key {
            Key::Up | Key::BackTab => *focus = ((focus.0 + rows.len() - 1) % rows.len(), 0),
            Key::Down | Key::Tab => *focus = ((focus.0 + 1) % rows.len(), 0),
            Key::Left => focus.1 = focus.1.saturating_sub(1),
            Key::Right => focus.1 = (focus.1 + 1).min(deeds - 1),
            Key::Home => *focus = (0, 0),
            Key::End => *focus = (rows.len() - 1, 0),
            Key::Enter => {
                // What stays is the rows as they were, without the mark: the menu's last state, as text.
                block.clear();
                drop(keys);
                return Picked::Do(focus.0, focus.1);
            }
            Key::Esc | Key::Quit | Key::Char('q') => {
                block.draw(&draw(rows, None, cols.saturating_sub(1), height, style, ""));
                block.keep();
                return Picked::Leave;
            }
            Key::Back => { block.clear(); return Picked::Rail; }
            Key::Char(c) if c.is_ascii_digit() && c != '0' => {
                let n = c as usize - '1' as usize;
                if n < rows.len() { *focus = (n, 0); }
            }
            Key::Char(c) => {
                // A letter goes to the next row whose name starts with it (Runtime, then Remote).
                let c = c.to_lowercase().next().unwrap_or(c);
                let starts = |r: &Row| r.label.to_lowercase().starts_with(c);
                let from = if letter == Some(c) { focus.0 + 1 } else { focus.0 };
                if let Some(k) = (0..rows.len()).map(|k| (from + k) % rows.len()).find(|k| starts(&rows[*k])) { *focus = (k, 0); }
                letter = Some(c);
            }
            _ => {}
        }
    }
}

/// One line of choices (a repo, a template, yes or no, the next deeds), walked with the keys.
/// `start`: the choice focused first; None: none, and Enter passes by (the short row after a command).
fn choose(lead: &str, items: &[String], start: Option<usize>, hint: &str) -> Option<usize> {
    let keys = Keys::take()?;
    let style = Style::now();
    let mut block = Block::default();
    let mut at = start;
    let n = items.len();
    loop {
        let words: Vec<String> = items.iter().enumerate().map(|(j, w)| if Some(j) == at { format!("[{}]", style.bold(w)) } else { format!(" {w} ") }).collect();
        let cols = term::size().0.saturating_sub(1);
        let mut lines = wrap(&words, "  ", cols);
        lines[0] = format!("{lead}{}", &lines[0][2..]);
        if !hint.is_empty() { lines.push(style.dim(&format!("  {hint}"))); }
        block.draw(&lines);
        match keys.next() {
            Key::Right | Key::Down | Key::Tab => at = Some(at.map_or(0, |a| (a + 1).min(n - 1))),
            Key::Left | Key::Up | Key::BackTab => at = Some(at.map_or(n - 1, |a| a.saturating_sub(1))),
            Key::Char(c) if c.is_ascii_digit() && c != '0' && (c as usize - '1' as usize) < n => at = Some(c as usize - '1' as usize),
            Key::Enter => { block.clear(); return at; }
            Key::Esc | Key::Quit | Key::Back | Key::Char('q') => { block.clear(); return None; }
            // Passing by: any other key leaves the row, so the next command is never taken for a choice.
            _ if start.is_none() => { block.clear(); return None; }
            _ => {}
        }
    }
}

/// One line written in place, as the terminal edits a line; None when nothing is written or input ends.
fn line(label: &str, hint: &str) -> Option<String> {
    let style = Style::now();
    term::put(&format!("  {}{}\n  › ", style.bold(label), if hint.is_empty() { String::new() } else { format!("  {}", style.dim(hint)) }));
    let mut bytes = Vec::new();
    let mut b = [0u8; 1];
    loop {
        // Byte by byte, so nothing typed after the line is read here and lost.
        let n = unsafe { libc::read(0, b.as_mut_ptr().cast(), 1) };
        if n <= 0 { if n < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted { continue; } term::put("\n"); return None; }
        if b[0] == b'\n' { break; }
        bytes.push(b[0]);
    }
    let s = String::from_utf8_lossy(&bytes).trim().to_string();
    (!s.is_empty()).then_some(s)
}

// ---- Doing a deed ----

/// Whether a thing of kind `on` gives a word to a slot like `a`.
pub fn takes(a: Arg, on: On) -> bool {
    matches!((a, on), (Arg::Issue, On::Issue) | (Arg::Repo { .. }, On::Repo | On::Issue) | (Arg::Path { .. }, On::Path | On::Repo)
        | (Arg::Number(_), On::Todo) | (Arg::Address, On::Thread) | (Arg::Many(_), On::Thing) | (Arg::Text(_), On::RemoteRepo | On::Board))
}

/// The word a thing gives a slot of its kind: its own, or (an issue, to a repo's slot) its repo's.
fn fills(a: Arg, s: &Subject) -> Option<String> {
    if !takes(a, s.on) { return None; }
    if matches!((a, s.on), (Arg::Repo { .. }, On::Issue)) { s.repo.clone() } else { Some(s.word.clone()) }
}

/// A word as it is written on a command line: quoted when a shell would split or read it.
pub fn shell_word(w: &str) -> String {
    let plain = !w.is_empty() && !w.starts_with(['#', '~']) && w.chars().all(|c| !c.is_ascii() && !c.is_whitespace() || c.is_ascii_alphanumeric() || "-_./:#@+=,%".contains(c));
    if plain { return w.to_string(); }
    let mut q = String::from("\"");
    for c in w.chars() { if matches!(c, '"' | '\\' | '$' | '`') { q.push('\\'); } q.push(c); }
    q.push('"');
    q
}

/// The command a deed is, as words: the form's words, then its flags; `--` before them when a word starts with one.
pub fn command_line(c: &Command, f: &Form, words: &[Option<String>], flags: &[(Flag, String)]) -> Vec<String> {
    let mut argv = vec![c.name.to_string()];
    if let Some(v) = f.verb { argv.push(v.to_string()); }
    let given: Vec<String> = words.iter().flatten().cloned().collect();
    let mut flag_words = Vec::new();
    for (fl, v) in flags {
        match fl { Flag::Note(_) => flag_words.extend(["-m".to_string(), v.clone()]), Flag::Template => flag_words.extend(["-t".to_string(), v.clone()]), _ => {} }
    }
    if given.iter().any(|w| w.starts_with('-')) {
        argv.extend(flag_words);
        argv.push("--".into());
        argv.extend(given);
    } else {
        argv.extend(given);
        argv.extend(flag_words);
    }
    argv
}

/// What came of a deed.
enum Done { Ran { ok: bool, seen: Seen, argv: Vec<String> }, NotNow }

/// Say what is being done, as the command it is.
fn said(argv: &[String]) {
    let style = Style::now();
    term::put(&format!("{}\n", style.dim(&format!("→ l3 {}", argv.iter().map(|w| shell_word(w)).collect::<Vec<_>>().join(" ")))));
}

/// Run a command line through l3 as if typed: parsed, checked, run, answered, kept in step.
/// An error the person's words caused is given back (to be said under the field), the rest said as l3 says it.
fn perform(ctx: &Ctx, argv: &[String], words_asked: bool) -> (Result<(), Error>, Seen) {
    let call = match args::parse(argv, ctx) {
        Ok(c) => c,
        Err(e) => { if words_asked { return (Err(e), Seen::default()); } out::fail(&e, false); return (Ok(()), Seen::default()); }
    };
    let (done, seen) = noting(|| cmd::perform(ctx, &call));
    let offline = matches!(done, Err(Error::Offline(_)));
    let result = match done {
        Ok(reply) => { out::emit(reply, false); Ok(()) }
        Err(e) if words_asked && matches!(e, Error::Usage(_) | Error::Refused(_) | Error::NotFound(_)) => Err(e),
        Err(e) => { out::fail(&e, false); Err(Error::Io(String::new())) }
    };
    crate::sync::after(ctx, &call, offline);
    (result, seen)
}

/// Do a deed on a thing (or on the page): its words from the thing and from the deed, the rest asked in place.
fn run(ctx: &Ctx, offer: Offer, subject: Option<&Subject>) -> Done {
    let style = Style::now();
    let deed = offer.deed;
    term::put(&format!("{}\n", style.bold(&format!("› {}{}", offer.label(), subject.map(|s| format!("  {}", s.label)).unwrap_or_default()))));
    let mut words: Vec<Option<String>> = vec![None; offer.form.args.len()];
    let mut typed: Vec<usize> = Vec::new();
    let mut given = subject.is_none();
    for (i, a) in offer.form.args.iter().enumerate() {
        if let Some((_, w)) = deed.gives.iter().find(|(k, _)| *k == i) { words[i] = Some(w.to_string()); continue; }
        if !given { if let Some(w) = subject.and_then(|s| fills(*a, s)) { words[i] = Some(w); given = true; continue; } }
        match a {
            Arg::Argv => {}
            Arg::Repo { .. } => {
                let (label, _) = spec::field_words(*a);
                let here: Vec<String> = ctx.repos().and_then(|r| Ok(r.list()?)).map(|l| l.into_iter().map(|s| s.name).collect()).unwrap_or_default();
                let at = ctx.here.as_ref().and_then(|h| here.iter().position(|n| *n == h.repo));
                let pick = match (here.len(), at) {
                    (0, _) => { out::note(&tr!("No repos yet (l3 repo new NAME makes one)", "repo はまだありません（l3 repo new NAME で作れます）")); return Done::NotNow; }
                    (1, _) => Some(0),
                    (_, start) => choose(&format!("  {}  ", style.bold(say(label))), &here, Some(start.unwrap_or(0)), ""),
                };
                let Some(k) = pick else { return Done::NotNow };
                term::put(&format!("  {}  {}\n", style.bold(say(label)), here[k]));
                words[i] = Some(here[k].clone());
            }
            Arg::Choice(c) => {
                let k = choose("  ", &c.iter().map(|s| s.to_string()).collect::<Vec<_>>(), Some(0), "");
                let Some(k) = k else { return Done::NotNow };
                term::put(&format!("  {}\n", c[k]));
                words[i] = Some(c[k].to_string());
            }
            _ => typed.push(i),
        }
    }
    let mut flags: Vec<(Flag, String)> = Vec::new();
    if deed.asks.contains(&Flag::Template) {
        let ids: Vec<String> = length3_core::templates::all().into_iter().map(|t| t.id).collect();
        let label = say(spec::flag_words(Flag::Template));
        let Some(k) = choose(&format!("  {}  ", style.bold(label)), &ids, Some(0), "") else { return Done::NotNow };
        term::put(&format!("  {}  {}\n", style.bold(label), ids[k]));
        flags.push((Flag::Template, ids[k].clone()));
    }
    let mut confirmed = !deed.confirm;
    loop {
        // Each word written, one line each, under its name and what goes in it.
        for &i in &typed {
            let (label, hint) = spec::field_words(offer.form.args[i]);
            let label = deed.field.map_or(say(label), say);
            match line(label, say(hint)) { Some(w) => words[i] = Some(w), None => { term::put(&format!("{}\n", style.dim(&format!("  {}", tr!("Not done", "していません"))))); return Done::NotNow; } }
        }
        for f in deed.asks.iter().filter(|f| matches!(f, Flag::Note(_))) {
            flags.retain(|(g, _)| !matches!(g, Flag::Note(_)));
            if let Some(w) = line(say(spec::flag_words(*f)), "") { flags.push((*f, w)); }
        }
        // What cannot be undone at once is asked first, as the app asks in the card: Not now, or the deed.
        if !confirmed {
            let items = [tr!("Not now", "やめる"), offer.label().to_string()];
            if choose("  ", &items, Some(0), "") != Some(1) { term::put(&format!("{}\n", style.dim(&format!("  {}", tr!("Not done", "していません"))))); return Done::NotNow; }
            confirmed = true;
        }
        let argv = command_line(offer.command, offer.form, &words, &flags);
        said(&argv);
        match perform(ctx, &argv, !typed.is_empty()) {
            (Ok(()), seen) => return Done::Ran { ok: true, seen, argv },
            // The person's words were refused: said under the field, and asked again.
            (Err(e), _) if !typed.is_empty() && !e.message().is_empty() => {
                for l in e.message().lines() { term::put(&format!("    {l}\n")); }
            }
            (Err(_), seen) => return Done::Ran { ok: false, seen, argv },
        }
    }
}

// ---- The rail, a page, and the row after a command ----

enum Flow { Leave, Rail }

/// A purpose's page: each of its forms said as the command it is, then what it answers (printed),
/// or only read for its things (not printed: after a deed, to offer what comes next).
fn page(ctx: &Ctx, group: Group, print: bool) -> View {
    let made_by: Vec<Vec<String>> = page_forms(group).into_iter().map(|(c, f)| command_line(c, f, &[], &[])).collect();
    let seen = read(ctx, &made_by, print);
    View { group, subjects: seen.subjects, facts: seen.facts, own: true, made_by }
}

/// Run these command lines as l3 runs them, for what they show; printed (each said first), or not.
fn read(ctx: &Ctx, lines: &[Vec<String>], print: bool) -> Seen {
    let mut all = Seen::default();
    for argv in lines {
        if print { said(argv); }
        let Ok(call) = args::parse(argv, ctx) else { continue };
        let (done, seen) = noting(|| cmd::perform(ctx, &call));
        let offline = matches!(done, Err(Error::Offline(_)));
        match done {
            Ok(r) => if print { out::emit(r, false) },
            Err(e) => if print { out::fail(&e, false); },
        }
        crate::sync::after(ctx, &call, offline);
        all.subjects.extend(seen.subjects);
        all.facts.extend(seen.facts);
    }
    all
}

/// After a deed: what it showed is the page now (an issue opened, a folder); else the page as it was made, read again.
fn next_view(ctx: &Ctx, view: &View, seen: Seen, argv: Vec<String>) -> View {
    if !seen.subjects.is_empty() { return View { group: view.group, subjects: seen.subjects, facts: seen.facts, own: false, made_by: vec![argv] }; }
    let again = read(ctx, &view.made_by, false);
    View { group: view.group, subjects: again.subjects, facts: again.facts, own: view.own, made_by: view.made_by.clone() }
}

/// What is there now in each place on the rail, in a few words (as bare `l3` says it off a terminal).
fn states(ctx: &Ctx) -> Vec<String> {
    let r = ctx.repos().ok();
    let list = r.as_ref().and_then(|r| r.list().ok()).unwrap_or_default();
    let names: Vec<String> = list.iter().map(|s| s.name.clone()).collect();
    let repos = |n: usize| if i18n::ja() { format!("repo {n}") } else if n == 1 { "1 repo".to_string() } else { format!("{n} repos") };
    let connected = ctx.connected();
    // What only the Remote knows, asked side by side and waited for a moment only, so the rail is never slow.
    let (tx, rx) = std::sync::mpsc::channel();
    if connected {
        let t = tx.clone();
        std::thread::spawn(move || { let _ = t.send(("server", length3_core::servers::list().map(|l| l.len()).ok())); });
        std::thread::spawn(move || { let _ = tx.send(("inbox", length3_core::inbox::threads().map(|l| l.iter().filter(|t| t.unread > 0).count()).ok())); });
    } else { drop(tx); }
    let todos = if ctx.prompt { Vec::new() } else { home::todos().unwrap_or_default() };
    let open_issues: usize = names.iter().map(|n| {
        let merged = length3_core::history::merged_seen(n);
        r.as_ref().and_then(|r| r.issues(n).ok()).unwrap_or_default().iter().filter(|i| i.closed.is_none() && !merged.contains(&format!("issue/{}", i.file))).count()
    }).sum();
    let band = home::band(&names).map(|b| b.len()).unwrap_or(0);
    let running = length3_core::prompt::running(&paths::data_dir()).len();
    let root_now = root::current(&paths::data_dir()).map(|(_, i)| format!("root {} {}", i.name, i.version)).unwrap_or_else(|| tr!("no root yet", "root はまだありません"));
    let not_sent = r.as_ref().and_then(|r| remote::status(r).ok()).map_or(0, |l| l.iter().filter(|s| s.fresh || s.changed > 0).count());
    let signed_out = tr!("not signed in", "サインインしていません");
    let mut server = if connected { "—".to_string() } else { signed_out.clone() };
    let mut inbox = server.clone();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
    while let Ok((what, n)) = rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
        let Some(n) = n else { continue };
        if what == "server" { server = if i18n::ja() { format!("サーバー {n}") } else if n == 1 { "1 server".into() } else { format!("{n} servers") }; }
        else { inbox = if n == 0 { tr!("all read", "未読なし") } else { tr!("{} not read", "未読 {}件", n) }; }
    }
    Group::RAIL.iter().map(|g| match g {
        Group::Home => tr!("TODO {} open of {}", "TODO 残り {} / {}", todos.iter().filter(|t| !t.done).count(), todos.len()),
        Group::Forge => tr!("{} · {} on the band", "{} · 帯に {}", repos(list.len()), band),
        Group::File => tr!("/root holds {}", "/root に {}", repos(list.len())),
        Group::Git => if i18n::ja() { format!("開いている Issue {open_issues}件") } else if open_issues == 1 { "1 issue open".into() } else { format!("{open_issues} issues open") },
        Group::Runtime => if running > 0 { tr!("{} · {} Prompts running", "{} · Prompt {} 個が動いています", root_now, running) } else { root_now.clone() },
        Group::Remote => match remote::connection().filter(|_| connected) {
            Some(c) => format!("{} · {}", cmd::host(&c.url), if not_sent == 0 { tr!("in step", "Remote と同じ") } else { if not_sent == 1 { tr!("1 repo not sent", "未送信の repo 1") } else { tr!("{} repos not sent", "未送信の repo {}", not_sent) } }),
            None => signed_out.clone(),
        },
        Group::Server => server.clone(),
        Group::Inbox => inbox.clone(),
        _ => String::new(),
    }).collect()
}

/// The rail as rows: each place, what it is for, and what is there now (`states`, in the rail's order).
fn rail_rows(states: Vec<String>) -> Vec<Row> {
    Group::RAIL.iter().zip(states).map(|(g, state)| Row {
        label: g.name().to_string(),
        detail: [say(g.role()), state.as_str()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · "),
        offers: Vec::new(), go: Go::Purpose(*g),
    }).collect()
}

/// The line over the rail: the OS, and where it is kept.
fn heading(ctx: &Ctx) -> String {
    let where_ = if ctx.prompt { tr!("this Prompt's repo", "この Prompt の repo") } else {
        match remote::connection() { Some(c) => cmd::host(&c.url).to_string(), None => tr!("not signed in", "サインインしていません") }
    };
    format!("Length³ OS · {where_}")
}

/// Bare `l3` on a terminal: the rail, then whatever the person goes to, until they leave.
pub fn rail(ctx: &Ctx) -> ExitCode {
    ACTIVE.with(|a| a.set(true));
    let style = Style::now();
    term::put(&format!("{}\n", style.bold(&heading(ctx))));
    let mut focus = (0, 0);
    loop {
        let rows = rail_rows(states(ctx));
        match pick(&rows, &mut focus, &hint_rail()) {
            Picked::Leave => return ExitCode::SUCCESS,
            Picked::Rail => {}
            Picked::Do(k, _) => {
                let g = Group::RAIL[k];
                // + is its deed, which says itself.
                if g != Group::New { term::put(&format!("{}\n", style.bold(&format!("› {}  {}", g.name(), say(g.role()))))); }
                let flow = if g == Group::New { new_repo(ctx) } else { let view = page(ctx, g, true); browse(ctx, view, None) };
                match flow {
                    Flow::Leave => return ExitCode::SUCCESS,
                    Flow::Rail => term::put(&format!("{}\n", style.bold(&heading(ctx)))),
                }
            }
        }
    }
}

/// +: a new repo made, then Forge with it on the band.
fn new_repo(ctx: &Ctx) -> Flow {
    let Some(offer) = offered(Group::New, On::Page, &device(ctx), Env::of(ctx)).into_iter().next() else { return Flow::Rail };
    let before = page(ctx, Group::Forge, false);
    match run(ctx, offer, None) {
        Done::Ran { ok: true, .. } => {
            let view = page(ctx, Group::Forge, false);
            let land = view.subjects.iter().find(|s| !before.subjects.iter().any(|b| b.word == s.word)).map(|s| s.word.clone());
            term::put("\n");
            browse(ctx, view, land)
        }
        _ => Flow::Rail,
    }
}

/// A page's rows, walked and done, each deed's answer and the next deeds after it, until the person goes back or leaves.
fn browse(ctx: &Ctx, mut view: View, mut land: Option<String>) -> Flow {
    let style = Style::now();
    let mut focus = (0, 0);
    loop {
        let rows = rows(&view, Env::of(ctx), &device(ctx));
        // A thing just made or done is landed on, as the app lands on it.
        if let Some(w) = land.take() {
            if let Some(k) = rows.iter().position(|r| matches!(r.go, Go::Thing(k) if view.subjects[k].word == w)) { focus = (k, 0); }
        }
        term::put("\n");
        match pick(&rows, &mut focus, &hint_page()) {
            Picked::Leave => return Flow::Leave,
            Picked::Rail => return Flow::Rail,
            Picked::Do(r, d) => match rows[r].go {
                Go::Rail => return Flow::Rail,
                Go::Purpose(g) => {
                    term::put(&format!("{}\n", style.bold(&format!("› {}  {}", g.name(), say(g.role())))));
                    view = page(ctx, g, true);
                    focus = (0, 0);
                }
                Go::Thing(_) | Go::Page => {
                    let subject = match rows[r].go { Go::Thing(k) => Some(view.subjects[k].clone()), _ => None };
                    let offer = rows[r].offers[d];
                    let before: Vec<String> = view.subjects.iter().map(|s| s.word.clone()).collect();
                    if let Done::Ran { seen, argv, .. } = run(ctx, offer, subject.as_ref()) {
                        view = next_view(ctx, &view, seen, argv);
                        land = subject.map(|s| s.word).filter(|w| view.subjects.iter().any(|s| s.word == *w))
                            .or_else(|| view.subjects.iter().find(|s| !before.contains(&s.word)).map(|s| s.word.clone()));
                    }
                }
            },
        }
    }
}

/// What a typed command was about: the thing its words name, as the page names it.
fn named(ctx: &Ctx, call: &args::Call) -> Option<String> {
    // A repo beside words written is where something new went (`issue new notes "…"`), not the thing.
    let writes = call.form.args.iter().any(|a| matches!(a, Arg::Text(_)));
    call.form.args.iter().enumerate().find_map(|(i, a)| match a {
        Arg::Issue => crate::target::issue(ctx, call, i).ok().map(|r| r.name()),
        Arg::Repo { .. } if !writes => crate::target::repo(ctx, call, i).ok(),
        Arg::Path { .. } => crate::target::path(ctx, call, i).ok().map(|(r, p)| if p.is_empty() { r } else { format!("{r}/{p}") }),
        Arg::Number(_) | Arg::Address => call.word(i).map(String::from),
        _ => None,
    })
}

/// Whether a thing is what `word` names: by its word, or (an issue) by its repo, as `l3 commit notes` names the work in notes.
fn is(s: &Subject, word: &str) -> bool {
    s.word == word || (s.on == On::Issue && s.repo.as_deref() == Some(word))
}

/// After a command typed by hand, on a terminal: its next deeds in a short row that Enter or Esc passes by.
pub fn after(ctx: &Ctx, call: &args::Call, argv: &[String], seen: Seen) {
    let c = call.command;
    if c.group == Group::Other || c.hidden || call.form.args.contains(&Arg::Argv) { return; }
    if seen.subjects.is_empty() && !call.form.page && call.form.deeds.is_empty() { return; }
    ACTIVE.with(|a| a.set(true));
    // What the command showed; else its purpose's page, read (not printed) for what is there now.
    let mut word = if seen.subjects.is_empty() { named(ctx, call) } else { None };
    let mut view = if !seen.subjects.is_empty() { View { group: c.group, subjects: seen.subjects, facts: seen.facts, own: call.form.page, made_by: vec![argv.to_vec()] } }
        else { page(ctx, c.group, false) };
    loop {
        // Never take keys the person typed ahead for their next command.
        if term::typed_ahead() { return; }
        let env = Env::of(ctx);
        let dev = device(ctx);
        let thing = word.as_deref().and_then(|w| view.subjects.iter().position(|s| is(s, w) && s.facts.contains(&Fact::WorkedHere)).or_else(|| view.subjects.iter().position(|s| is(s, w))));
        // The deeds of the thing it was about; else each thing's first deed, then the page's.
        let mut items: Vec<(Option<usize>, Offer, String)> = Vec::new();
        let lead = match thing {
            Some(k) => {
                let s = &view.subjects[k];
                let facts: Vec<Fact> = s.facts.iter().chain(&dev).copied().collect();
                for o in offered(view.group, s.on, &facts, env) { items.push((Some(k), o, o.label().to_string())); }
                // Named as a command names it, but a TODO item or a thing by size, by what it says.
                if matches!(s.on, On::Todo | On::Thing) { s.label.clone() } else { s.word.clone() }
            }
            None => {
                for (k, s) in view.subjects.iter().enumerate() {
                    let facts: Vec<Fact> = s.facts.iter().chain(&dev).copied().collect();
                    if let Some(o) = offered(view.group, s.on, &facts, env).into_iter().next() { items.push((Some(k), o, format!("{} {}", o.label(), s.word))); }
                }
                let facts: Vec<Fact> = view.facts.iter().chain(&dev).copied().collect();
                for o in offered(view.group, On::Page, &facts, env) { items.push((None, o, o.label().to_string())); }
                tr!("Next", "次")
            }
        };
        items.truncate(12);
        if items.is_empty() { return; }
        let style = Style::now();
        let words: Vec<String> = items.iter().map(|(_, _, w)| w.clone()).collect();
        let Some(k) = choose(&format!("{}  ", style.dim(&lead)), &words, None, &hint_after()) else { return };
        let (thing, offer, _) = items[k].clone();
        let subject = thing.map(|k| view.subjects[k].clone());
        let before: Vec<String> = view.subjects.iter().map(|s| s.word.clone()).collect();
        let Done::Ran { seen, argv, .. } = run(ctx, offer, subject.as_ref()) else { return };
        view = next_view(ctx, &view, seen, argv);
        word = subject.map(|s| s.word).filter(|w| view.subjects.iter().any(|s| s.word == *w))
            .or_else(|| view.subjects.iter().find(|s| !before.contains(&s.word)).map(|s| s.word.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use length3_core::i18n::ja;

    const ONLINE: Env = Env { prompt: false, connected: true };
    const OFFLINE: Env = Env { prompt: false, connected: false };
    const IN_A_PROMPT: Env = Env { prompt: true, connected: false };

    /// The deeds offered, by their English words (the same whatever is spoken).
    fn deeds(group: Group, on: On, facts: &[Fact], env: Env) -> Vec<&'static str> {
        let device = if env.connected { Fact::SignedIn } else { Fact::SignedOut };
        let facts: Vec<Fact> = facts.iter().copied().chain([device]).collect();
        offered(group, on, &facts, env).iter().map(|o| o.deed.label[0]).collect()
    }

    fn issue(n: u32, title: &str, detail: &str, facts: &[Fact]) -> Subject {
        Subject { on: On::Issue, word: format!("notes#{n}"), repo: Some("notes".into()), label: format!("#{n} {title}"), detail: detail.into(), facts: facts.to_vec() }
    }

    #[test]
    fn an_issue_offers_what_comes_next_for_where_it_stands() {
        use Fact::*;
        assert_eq!(deeds(Group::Git, On::Issue, &[CanStart], ONLINE), ["Start", "Open", "Close"]);
        assert_eq!(deeds(Group::Git, On::Issue, &[WorkedHere, OnWork], ONLINE), ["Open", "Back to main"]);
        assert_eq!(deeds(Group::Git, On::Issue, &[WorkedHere, CanCommit, OnWork], ONLINE), ["Commit", "Open", "Diff", "Back to main"]);
        assert_eq!(deeds(Group::Git, On::Issue, &[WorkedHere, CanPush, OnWork], ONLINE), ["Push", "Open", "Back to main"]);
        assert_eq!(deeds(Group::Git, On::Issue, &[WorkedHere, Undecided, OnWork], ONLINE),
            ["Approve", "Merge", "Open", "Diff", "Ask for changes", "Reply", "Back to main", "Reset", "Reject"]);
        // Approved, Merge comes first; handed in from another device, nothing of the work here.
        assert_eq!(deeds(Group::Git, On::Issue, &[Undecided, Approved], ONLINE), ["Merge", "Open", "Diff", "Ask for changes", "Reply", "Reject"]);
        assert_eq!(deeds(Group::Git, On::Issue, &[Closed], ONLINE), ["Reopen", "Open"]);
        assert_eq!(deeds(Group::Git, On::Page, &[], ONLINE), ["Write an issue", "Log"]);
    }

    #[test]
    fn signed_out_or_in_a_prompt_only_what_can_run_there_is_offered() {
        // Signed out: what needs the Remote is not offered, and signing in is.
        assert_eq!(deeds(Group::Git, On::Issue, &[], OFFLINE), ["Open", "Close"]);
        assert_eq!(deeds(Group::Git, On::Page, &[], OFFLINE), ["Write an issue", "Sign in"]);
        assert_eq!(deeds(Group::Inbox, On::Page, &[], OFFLINE), ["Sign in"]);
        assert_eq!(deeds(Group::Remote, On::Page, &[], ONLINE), ["Sign-in", "Devices", "Plan", "Sign out"]);
        // In the app's Prompt only what may run there: the device and the Remote are the app's.
        assert_eq!(deeds(Group::Git, On::Issue, &[Fact::CanStart], IN_A_PROMPT), ["Open", "Close"]);
        assert_eq!(deeds(Group::Git, On::Page, &[], IN_A_PROMPT), ["Write an issue"]);
        assert!(deeds(Group::Home, On::Page, &[], IN_A_PROMPT).is_empty());
    }

    #[test]
    fn a_todo_a_repo_a_conversation_and_a_thing_by_size_offer_their_own_deeds() {
        use Fact::*;
        assert_eq!(deeds(Group::Home, On::Todo, &[NotDone], OFFLINE), ["Done", "Edit", "Remove"]);
        assert_eq!(deeds(Group::Home, On::Todo, &[Done], OFFLINE), ["Edit", "Not done", "Remove"]);
        assert_eq!(deeds(Group::Home, On::Page, &[], ONLINE), ["Add a TODO", "Edit name", "Edit handle", "Edit bio"]);
        assert_eq!(deeds(Group::Forge, On::Repo, &[OnBand], OFFLINE), ["Prompt", "Take off the band"]);
        assert_eq!(deeds(Group::Forge, On::Repo, &[OffBand, NoRoot], OFFLINE), ["Put on the band"]);
        assert_eq!(deeds(Group::Forge, On::Repo, &[OnBand, Running], OFFLINE), ["Prompt", "Take off the band", "Stop"]);
        assert_eq!(deeds(Group::Inbox, On::Thread, &[Request], ONLINE), ["Accept", "Open", "Write", "Block"]);
        assert_eq!(deeds(Group::Inbox, On::Thread, &[], ONLINE), ["Open", "Write"]);
        assert_eq!(deeds(Group::Runtime, On::Thing, &[Freeable], OFFLINE), ["Free"]);
        assert_eq!(deeds(Group::Runtime, On::Page, &[AnyFreeable, NoRoot], OFFLINE), ["Fetch the root", "Free all", "Use a root"]);
        assert_eq!(deeds(Group::Remote, On::RemoteRepo, &[TurnedOff], ONLINE), ["Turn on"]);
        assert_eq!(deeds(Group::File, On::RemoteRepo, &[OnlyThere], ONLINE), ["Open here"]);
        assert_eq!(deeds(Group::New, On::Page, &[], OFFLINE), ["New repo"]);
    }

    fn git_page() -> View {
        View { group: Group::Git, own: true, facts: Vec::new(), made_by: Vec::new(), subjects: vec![
            issue(1, "Fix：restart loses the draft", "notes · not started", &[Fact::CanStart]),
            issue(2, "Docs：readme", "notes · sora · started just now", &[Fact::WorkedHere, Fact::CanCommit, Fact::OnWork]),
        ] }
    }

    #[test]
    fn a_page_is_rows_with_the_focused_things_deeds_under_it() {
        let rows = rows(&git_page(), ONLINE, &[Fact::SignedIn]);
        let got = draw(&rows, Some((1, 0)), 80, 24, Style::PLAIN, &hint_page()).join("\n");
        let want = if ja() { [
            "    1  #1 Fix：restart loses the draft  notes · not started",
            "  › 2  #2 Docs：readme                  notes · sora · started just now",
            "       [Commit]  開く   Diff   main に戻る",
            "    3  Issue を書く",
            "    4  ログ",
            "    5  目的",
            "  ↑↓ 選ぶ · ←→ 操作 · Enter 実行 · Backspace 目的 · q 終わる"
        ].join("\n") } else { [
            "    1  #1 Fix：restart loses the draft  notes · not started",
            "  › 2  #2 Docs：readme                  notes · sora · started just now",
            "       [Commit]  Open   Diff   Back to main",
            "    3  Write an issue",
            "    4  Log",
            "    5  Purposes",
            "  ↑↓ choose · ←→ deed · Enter do · Backspace purposes · q leaves"
        ].join("\n") };
        assert_eq!(got, want, "\n{got}");
        // Left as it was: no mark, no deeds, no keys; the rows as text.
        let left = draw(&rows, None, 80, 24, Style::PLAIN, &hint_page()).join("\n");
        assert!(!left.contains('›') && !left.contains('[') && left.lines().count() == rows.len(), "{left}");
        // A page shown by a deed (an issue opened) leads back to its purpose's page.
        let opened = View { own: false, ..git_page() };
        assert!(super::rows(&opened, ONLINE, &[Fact::SignedIn]).iter().any(|r| r.go == Go::Purpose(Group::Git)));
    }

    #[test]
    fn the_rail_is_drawn_in_the_rails_order_and_words() {
        let states = if ja() { ["TODO 残り 1 / 2", "repo 1 · 帯に 1", "/root に repo 1", "開いている Issue 1件", "root はまだありません", "サインインしていません", "サインインしていません", "サインインしていません", ""] }
            else { ["TODO 1 open of 2", "1 repo · 1 on the band", "/root holds 1 repo", "1 issue open", "no root yet", "not signed in", "not signed in", "not signed in", ""] };
        let got = draw(&rail_rows(states.map(String::from).to_vec()), Some((3, 0)), 100, 24, Style::PLAIN, &hint_rail()).join("\n");
        let want = if ja() { [
            "    1  Home     プロフィール · TODO 残り 1 / 2",
            "    2  Forge    自分の作業場 · repo 1 · 帯に 1",
            "    3  File     / の tree · /root に repo 1",
            "  › 4  Git      Issue とコミット · 開いている Issue 1件",
            "    5  Runtime  この端末と環境 · root はまだありません",
            "    6  Remote   repo を置く場所 · サインインしていません",
            "    7  Server   知り合い · サインインしていません",
            "    8  Inbox    自分に届くメッセージ · サインインしていません",
            "    9  +        新しい repo",
            "  ↑↓ 選ぶ · Enter 開く · 1-9 か頭文字で移る · q 終わる"
        ].join("\n") } else { [
            "    1  Home     Profile · TODO 1 open of 2",
            "    2  Forge    Your workshop · 1 repo · 1 on the band",
            "    3  File     The tree of / · /root holds 1 repo",
            "  › 4  Git      Issues and commits · 1 issue open",
            "    5  Runtime  This device and its environments · no root yet",
            "    6  Remote   Where your repos are kept · not signed in",
            "    7  Server   People you know · not signed in",
            "    8  Inbox    Messages to you · not signed in",
            "    9  +        New repo",
            "  ↑↓ choose · Enter open · 1-9 or a letter jumps · q leaves"
        ].join("\n") };
        assert_eq!(got, want, "\n{got}");
    }

    #[test]
    fn a_long_page_says_how_much_is_above_and_below_the_focus() {
        let subjects = (1..=30).map(|n| issue(n, "Fix：x", "", &[Fact::CanStart])).collect();
        let rows = rows(&View { group: Group::Git, own: true, facts: Vec::new(), made_by: Vec::new(), subjects }, ONLINE, &[Fact::SignedIn]);
        let lines = draw(&rows, Some((15, 0)), 80, 12, Style::PLAIN, "keys");
        assert!(lines.len() <= 12, "{lines:?}");
        assert!(lines.first().is_some_and(|l| l.contains('↑')) && lines.iter().any(|l| l.contains('↓')), "{lines:?}");
        assert!(lines.iter().any(|l| l.contains("› ") && l.contains("#16")), "{lines:?}");
    }

    #[test]
    fn a_deed_is_said_as_the_command_it_runs() {
        let new = spec::find("issue").unwrap();
        let form = new.forms.iter().find(|f| f.verb == Some("new")).unwrap();
        let argv = command_line(new, form, &[Some("notes".into()), Some("Fix：restart loses the draft".into())], &[]);
        assert_eq!(argv.iter().map(|w| shell_word(w)).collect::<Vec<_>>().join(" "), "issue new notes \"Fix：restart loses the draft\"");
        // A word with a dash first comes after `--`, the flags before it.
        let todo = spec::find("todo").unwrap();
        let add = todo.forms.iter().find(|f| f.verb == Some("add")).unwrap();
        assert_eq!(command_line(todo, add, &[Some("-1 day".into())], &[(Flag::Note("detail"), "why".into())]), ["todo", "add", "-m", "why", "--", "-1 day"]);
        assert_eq!(shell_word("notes#1"), "notes#1");
        assert_eq!(shell_word("#1"), "\"#1\"");
        assert_eq!(shell_word("say \"hi\" $HOME"), "\"say \\\"hi\\\" \\$HOME\"");
        assert_eq!(shell_word("Fix：件名"), "Fix：件名");
    }

    #[test]
    fn what_a_page_shows_is_noted_only_while_the_menu_notes() {
        let s = || Subject { on: On::Todo, word: "1".into(), repo: None, label: String::new(), detail: String::new(), facts: Vec::new() };
        let mut made = false;
        see(|| { made = true; s() });
        assert!(!made, "nothing is made when nobody notes");
        let ((), seen) = noting(|| { see(s); page_fact(Fact::AnyFreeable); page_fact(Fact::AnyFreeable); });
        assert_eq!((seen.subjects.len(), seen.facts), (1, vec![Fact::AnyFreeable]));
    }
}
