//! What the repo's history says: how often each file changes, how often it is fixed, which files change together,
//! and what each fix said (the words an issue is written in). Read from git, read-only and offline (no lock taken, no
//! object fetched for a partial clone), the newest commits first, renames followed so a file's past is its own under
//! its name now.
//!
//! How often is weighed by how recently: a commit counts half as much as one HALF_LIFE commits newer (counted in
//! commits, not days, so a repo's quiet months are not its old age, and the answer does not change with the clock).
//! A commit that touches more than BULK files (a reformat, a vendored library, a mass rename) says nothing about any
//! one of them and is left out.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::path::Path;

/// Commits back to read: past it a commit weighs under a thousandth of the newest.
pub const LIMIT: usize = 2000;
pub const HALF_LIFE: f64 = 200.0;
pub const BULK: usize = 100;

#[derive(Clone, Debug, PartialEq)]
pub struct Commit {
    pub id: String,
    pub time: u64,
    pub subject: String,
    /// The files it changed that are in the repo now (by index), under their names now.
    pub files: Vec<usize>,
    /// Whether it fixed something (its subject says so).
    pub fix: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct History {
    /// Newest first.
    pub commits: Vec<Commit>,
    /// Commits read, the bulk ones among them.
    pub read: usize,
}

/// Whether a commit's subject says it fixed something: "fix", "fixes", "fixed", "bug", "regression", "crash",
/// "broken", "hotfix" as a word, or the OS's own "Fix：".
pub fn says_fix(subject: &str) -> bool {
    if subject.starts_with("Fix：") || subject.starts_with("Fix:") { return true; }
    subject.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| {
        matches!(w.to_ascii_lowercase().as_str(), "fix" | "fixes" | "fixed" | "fixing" | "bug" | "bugfix" | "regression" | "crash" | "crashes" | "broken" | "hotfix")
    })
}

/// The history of the git repository at `dir`, its paths mapped to `index` (the repo's files now); None when it is
/// not one (or git is not there).
pub fn from_git(dir: &Path, index: &HashMap<&str, usize>) -> Option<History> {
    from_git_keeping(dir, index, &crate::paths::data_dir().join("plan"))
}

/// `from_git`, what was read kept in `kept`.
pub fn from_git_keeping(dir: &Path, index: &HashMap<&str, usize>, kept: &Path) -> Option<History> {
    if !dir.join(".git").exists() { return None; }
    Some(log_of(dir, kept).map(|raw| parse(&raw, index)).unwrap_or_default())
}

fn git(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    std::process::Command::new("git").arg("-C").arg(dir).args(["-c", "core.quotePath=false"]).args(args)
        // Read-only and offline: no lock on the index, no object fetched for a partial clone, never a prompt.
        .env("GIT_OPTIONAL_LOCKS", "0").env("GIT_NO_LAZY_FETCH", "1").env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .output().ok()
}

const FORMAT: &str = "--format=%x01%H %ct %s";

/// `git log` from `range` with rename detection `renames`, or None if git said no.
fn log(dir: &Path, renames: &str, range: &str) -> Option<Vec<u8>> {
    let mut args = vec!["log", "--no-merges", renames, "--name-status", "-z", "-n"];
    let n = LIMIT.to_string();
    args.push(&n);
    args.push(FORMAT);
    if !range.is_empty() { args.push(range); }
    git(dir, &args).filter(|o| o.status.success()).map(|o| o.stdout)
}

/// The newest LIMIT commits as `git log` gives them (parse reads them). Kept beside the OS's data by the head they
/// were read at: the next read asks git only for what is newer (a few milliseconds where reading 2000 commits takes a
/// second), and reads all again when the head moved anywhere but forward. Renames by likeness need both files'
/// contents, which a partial clone may not have here (and none is fetched): then renames are followed only where the
/// file is unchanged, and failing that not at all.
fn log_of(dir: &Path, kept_in: &Path) -> Option<Vec<u8>> {
    let head = git(dir, &["rev-parse", "--verify", "-q", "HEAD"]).filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())?;
    use sha2::{Digest, Sha256};
    let key: String = Sha256::digest(dir.to_string_lossy().as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    let at = kept_in.join(format!("{key}.log"));
    let kept = std::fs::read(&at).ok().and_then(|b| {
        let nl = b.iter().position(|&c| c == b'\n')?;
        let head_line = String::from_utf8_lossy(&b[..nl]).into_owned();
        let mut w = head_line.split(' ');
        let (was, mode) = (w.next()?.to_string(), w.next()?.to_string());
        Some((was, mode, b[nl + 1..].to_vec()))
    });
    let (mode, raw) = match kept {
        Some((was, _, raw)) if was == head => return Some(raw),
        Some((was, mode, raw)) if git(dir, &["merge-base", "--is-ancestor", &was, &head]).is_some_and(|o| o.status.success()) => {
            let newer = log(dir, &mode, &format!("{was}..{head}"))?;
            (mode, [newer, raw].concat())
        }
        _ => ["-M", "-M100%", "--no-renames"].iter().find_map(|m| log(dir, m, "").map(|raw| (m.to_string(), raw)))?,
    };
    // The newest LIMIT only.
    let raw = match raw.iter().enumerate().filter(|&(_, &c)| c == 0x01).nth(LIMIT) { Some((cut, _)) => raw[..cut].to_vec(), None => raw };
    if let Some(parent) = at.parent() { let _ = std::fs::create_dir_all(parent); }
    let _ = crate::atomic::replace(&at, &[format!("{head} {mode}\n").into_bytes(), raw.clone()].concat(), crate::atomic::How::CACHE);
    Some(raw)
}

/// `git log -M --name-status -z --format=%x01%H %ct %s`, newest first, read into a history of the files now.
pub fn parse(raw: &[u8], index: &HashMap<&str, usize>) -> History {
    // Renames seen so far (newest first): an older name to the name it has now.
    let mut now_of: HashMap<String, String> = HashMap::new();
    let mut commits = Vec::new();
    let mut read = 0;
    for record in raw.split(|&b| b == 0x01).filter(|r| !r.is_empty()) {
        let mut fields = record.split(|&b| b == 0).map(|f| f.strip_prefix(b"\n").unwrap_or(f));
        let Some(head) = fields.next() else { continue };
        let head = String::from_utf8_lossy(head);
        let mut parts = head.splitn(3, ' ');
        let id = parts.next().unwrap_or_default().to_string();
        let time = parts.next().and_then(|t| t.parse().ok()).unwrap_or(0);
        let subject = parts.next().unwrap_or_default().to_string();
        read += 1;
        let mut touched: Vec<String> = Vec::new();
        let rest: Vec<&[u8]> = fields.filter(|f| !f.is_empty()).collect();
        let mut i = 0;
        while i < rest.len() {
            let status = rest[i];
            let name = |k: usize| rest.get(k).map(|p| String::from_utf8_lossy(p).into_owned());
            match status.first() {
                // A rename or copy: old, new. The old name's past is the new one's.
                Some(b'R') | Some(b'C') => {
                    let (Some(old), Some(new)) = (name(i + 1), name(i + 2)) else { break };
                    let current = now_of.get(&new).cloned().unwrap_or(new);
                    if status[0] == b'R' { now_of.insert(old, current.clone()); }
                    touched.push(current);
                    i += 3;
                }
                Some(b'A' | b'M' | b'D' | b'T' | b'U' | b'X') => {
                    let Some(p) = name(i + 1) else { break };
                    touched.push(now_of.get(&p).cloned().unwrap_or(p));
                    i += 2;
                }
                // Not a status: the record is not what was asked for; what is read so far stands.
                _ => break,
            }
        }
        if touched.len() > BULK { continue; }
        let mut files: Vec<usize> = touched.iter().filter_map(|p| index.get(p.as_str()).copied()).collect();
        files.sort_unstable();
        files.dedup();
        commits.push(Commit { fix: says_fix(&subject), id, time, subject, files });
    }
    History { commits, read }
}

/// How often each file changed and was fixed, per hundred commits, weighed by recency; how many commits touched it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rates {
    pub change: Vec<f64>,
    pub fix: Vec<f64>,
    pub count: Vec<u32>,
    /// Whether there was a history to weigh (without one every rate is the same).
    pub known: bool,
}

/// How well the rates foretold where changes went: the history's newest `held` commits held out, the rates from the
/// commits before them, and where those commits' changes landed. `top` is the share of their changes (file touches)
/// that landed in the tenth of the files the rates ranked first; `even` what that share would be by chance (a tenth),
/// and `rho` Spearman's rank correlation of the rates with the changes, over the files that changed either before or
/// after.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Foretold { pub held: usize, pub changes: usize, pub top: f64, pub rho: f64 }

pub fn foretold(h: &History, n: usize, held: usize, half_life: f64) -> Option<Foretold> {
    if h.commits.len() < held * 2 || n < 10 { return None; }
    let older = History { commits: h.commits[held..].to_vec(), read: h.read.saturating_sub(held) };
    let r = rates_with(&older, n, half_life);
    let mut actual = vec![0.0; n];
    for c in &h.commits[..held] { for &f in &c.files { actual[f] += 1.0; } }
    let changes: f64 = actual.iter().sum();
    if changes == 0.0 { return None; }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&x, &y| r.change[y].total_cmp(&r.change[x]).then(x.cmp(&y)));
    let top: f64 = order.iter().take(n.div_ceil(10)).map(|&f| actual[f]).sum::<f64>() / changes;
    let seen: Vec<usize> = (0..n).filter(|&f| r.change[f] > 0.0 || actual[f] > 0.0).collect();
    Some(Foretold { held, changes: changes as usize, top, rho: spearman(&seen.iter().map(|&f| r.change[f]).collect::<Vec<_>>(), &seen.iter().map(|&f| actual[f]).collect::<Vec<_>>()) })
}

/// Spearman's ρ: the correlation of the two lists' ranks (ties sharing their mean rank).
pub fn spearman(a: &[f64], b: &[f64]) -> f64 {
    fn ranks(v: &[f64]) -> Vec<f64> {
        let mut idx: Vec<usize> = (0..v.len()).collect();
        idx.sort_by(|&x, &y| v[x].total_cmp(&v[y]));
        let mut r = vec![0.0; v.len()];
        let mut i = 0;
        while i < idx.len() {
            let mut j = i;
            while j + 1 < idx.len() && v[idx[j + 1]] == v[idx[i]] { j += 1; }
            let mean = (i + j) as f64 / 2.0 + 1.0;
            for k in i..=j { r[idx[k]] = mean; }
            i = j + 1;
        }
        r
    }
    let (ra, rb) = (ranks(a), ranks(b));
    let n = a.len() as f64;
    if n < 2.0 { return 0.0; }
    let (ma, mb) = (ra.iter().sum::<f64>() / n, rb.iter().sum::<f64>() / n);
    let cov: f64 = ra.iter().zip(&rb).map(|(x, y)| (x - ma) * (y - mb)).sum();
    let va: f64 = ra.iter().map(|x| (x - ma).powi(2)).sum();
    let vb: f64 = rb.iter().map(|y| (y - mb).powi(2)).sum();
    if va == 0.0 || vb == 0.0 { 0.0 } else { cov / (va * vb).sqrt() }
}

pub fn rates(h: &History, n: usize) -> Rates { rates_with(h, n, HALF_LIFE) }

fn rates_with(h: &History, n: usize, half_life: f64) -> Rates {
    let mut change = vec![0.0; n];
    let mut fix = vec![0.0; n];
    let mut count = vec![0u32; n];
    let mut total = 0.0;
    for (age, c) in h.commits.iter().enumerate() {
        let w = if half_life.is_finite() { 0.5f64.powf(age as f64 / half_life) } else { 1.0 };
        total += w;
        for &f in &c.files {
            change[f] += w;
            count[f] += 1;
            if c.fix { fix[f] += w; }
        }
    }
    if total == 0.0 {
        let even = if n == 0 { 0.0 } else { 100.0 / n as f64 };
        return Rates { change: vec![even; n], fix: vec![0.0; n], count, known: false };
    }
    for v in change.iter_mut().chain(fix.iter_mut()) { *v *= 100.0 / total; }
    Rates { change, fix, count, known: true }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(commits: &[(&str, &[&str])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (i, (subject, entries)) in commits.iter().enumerate() {
            out.extend(format!("\x01{:040x} {} {subject}\0\n", i, 1000 - i).as_bytes());
            for e in *entries { for part in e.split('|') { out.extend(part.as_bytes()); out.push(0); } }
        }
        out
    }

    #[test]
    fn renames_give_a_file_its_past_under_its_name_now() {
        let idx: HashMap<&str, usize> = [("src/new.rs", 0), ("b.rs", 1)].into_iter().collect();
        // Newest first: renamed old→mid→new; before, old was changed twice; b deleted and made again.
        let h = parse(&raw(&[
            ("Move it again", &["R100|src/mid.rs|src/new.rs"]),
            ("Fix the parser", &["M|src/mid.rs", "M|b.rs"]),
            ("Move it", &["R087|old.rs|src/mid.rs"]),
            ("feat: grow", &["M|old.rs", "D|gone.rs"]),
            ("start", &["A|old.rs", "A|b.rs", "A|gone.rs"]),
        ]), &idx);
        let files: Vec<Vec<usize>> = h.commits.iter().map(|c| c.files.clone()).collect();
        assert_eq!(files, [vec![0], vec![0, 1], vec![0], vec![0], vec![0, 1]]);
        assert_eq!(h.commits.iter().map(|c| c.fix).collect::<Vec<_>>(), [false, true, false, false, false]);
        assert_eq!(h.read, 5);
        assert_eq!(h.commits[0].time, 1000);
    }

    #[test]
    fn bulk_commits_and_odd_paths() {
        let idx: HashMap<&str, usize> = [("a b/ü.c", 0), ("x\ny", 1)].into_iter().collect();
        let many: Vec<String> = (0..=BULK).map(|i| format!("M|f{i}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        let h = parse(&raw(&[("one", &["M|a b/ü.c", "M|x\ny"]), ("reformat", &many), ("empty", &[])]), &idx);
        assert_eq!(h.commits.len(), 2, "the bulk commit is left out");
        assert_eq!(h.commits[0].files, [0, 1]);
        assert_eq!(h.commits[1].files, Vec::<usize>::new());
        assert_eq!(h.read, 3);
        // Nothing, or garbage: no commits, no failure.
        assert_eq!(parse(b"", &idx), History::default());
        assert_eq!(parse(b"\x01\0\0\0garbage\x01", &idx).commits.len(), 1);
    }

    #[test]
    fn spearman_is_what_it_is() {
        assert!((spearman(&[1.0, 2.0, 3.0, 4.0], &[10.0, 20.0, 30.0, 40.0]) - 1.0).abs() < 1e-12);
        assert!((spearman(&[1.0, 2.0, 3.0, 4.0], &[4.0, 3.0, 2.0, 1.0]) + 1.0).abs() < 1e-12);
        assert_eq!(spearman(&[1.0, 1.0, 1.0], &[1.0, 2.0, 3.0]), 0.0, "no order in one: no correlation");
        // Ties share their mean rank: [1, 2, 2, 3] against itself is exactly 1.
        assert!((spearman(&[1.0, 2.0, 2.0, 3.0], &[5.0, 7.0, 7.0, 9.0]) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn what_changed_most_before_foretells_what_changes_after() {
        // Ten files, each changed in proportion to its number throughout: the held-out commits land where the rates said.
        let commits: Vec<Commit> = (0..2000).map(|i| Commit { id: i.to_string(), time: 0, subject: String::new(), files: vec![(0..55).map(|k| (1..=10).take_while(|n| k >= n * (n - 1) / 2).last().unwrap_or(1) - 1).nth(i % 55).unwrap_or(0)], fix: false }).collect();
        let f = foretold(&History { commits, read: 2000 }, 10, 300, HALF_LIFE).expect("enough history");
        assert!(f.rho > 0.9, "{f:?}");
        assert!(f.top > 0.15, "the most changed tenth took more than a tenth of the changes: {f:?}");
        assert_eq!(f.held, 300);
        assert!(foretold(&History::default(), 10, 300, HALF_LIFE).is_none());
    }

    #[test]
    fn fixes_by_their_words() {
        for s in ["Fix the build", "fix(parser): x", "Fixes #12", "Crash on empty input", "bug: y", "Fix：Inches round down", "regression in 1.2"] {
            assert!(says_fix(s), "{s}");
        }
        for s in ["Prefix the names", "Add fixtures", "Debugger support", "Fixed-width output"] {
            assert_eq!(says_fix(s), s == "Fixed-width output", "{s}");
        }
    }

    #[test]
    fn rates_weigh_recent_commits_more_and_sum_to_the_commits() {
        let h = History { commits: (0..400).map(|i| Commit { id: i.to_string(), time: 0, subject: String::new(), files: vec![if i < 200 { 0 } else { 1 }], fix: i % 2 == 0 }).collect(), read: 400 };
        let r = rates(&h, 3);
        assert!(r.known);
        assert!(r.change[0] > r.change[1], "{:?}", r.change);
        assert!((r.change[0] + r.change[1] - 100.0).abs() < 1e-9, "each commit touches one file: the rates sum to 100");
        assert_eq!(r.change[2], 0.0);
        assert_eq!(r.count, [200, 200, 0]);
        // A file changed in each commit of the newest half carries 2/3 of the weight (half-life 200 over 400).
        assert!((r.change[0] - 100.0 * (1.0 - 0.5) / (1.0 - 0.25)).abs() < 1e-6, "{}", r.change[0]);
        let none = rates(&History::default(), 4);
        assert!(!none.known);
        assert_eq!(none.change, [25.0; 4]);
    }

    #[test]
    #[cfg(unix)]
    fn a_kept_log_is_the_same_as_one_read_whole_and_follows_new_commits() {
        let root = crate::testing::dir("plan-past");
        let home = root.join("home");
        let repo = root.join("r");
        std::fs::create_dir_all(&repo).unwrap();
        let sh = |cmd: &str| assert!(std::process::Command::new("sh").arg("-c").arg(cmd).current_dir(&repo)
            .env("GIT_AUTHOR_NAME", "a").env("GIT_AUTHOR_EMAIL", "a@b").env("GIT_COMMITTER_NAME", "a").env("GIT_COMMITTER_EMAIL", "a@b")
            .env("GIT_CONFIG_GLOBAL", "/dev/null").status().unwrap().success(), "{cmd}");
        sh("git init -q . && echo a > a.c && git add -A && git commit -qm 'start' && git mv a.c b.c && git commit -qm 'Move it' && echo x >> b.c && git commit -qam 'Fix b'");
        let idx: HashMap<&str, usize> = [("b.c", 0)].into_iter().collect();
        let read = || from_git_keeping(&repo, &idx, &home).unwrap();
        let first = read();
        assert_eq!(first.commits.len(), 3);
        assert!(first.commits.iter().all(|c| c.files == [0]), "the rename gives a.c's past to b.c: {first:?}");
        assert_eq!(read(), first, "read from what was kept");
        sh("echo y >> b.c && git commit -qam 'Grow b'");
        let second = read();
        assert_eq!(second.commits.len(), 4);
        assert_eq!(second.commits[0].subject, "Grow b");
        assert_eq!(&second.commits[1..], &first.commits[..]);
        // A head moved elsewhere (history rewritten): read whole again, nothing of the old kept.
        sh("git reset -q --hard HEAD~2 && echo z >> b.c && git commit -qam 'Other'");
        let third = read();
        assert_eq!(third.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["Other", "Move it", "start"]);
        // No commits yet: an empty history.
        let empty = root.join("e");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&empty).status().unwrap().success());
        assert_eq!(from_git_keeping(&empty, &idx, &home), Some(History::default()));
    }

    #[test]
    #[cfg(unix)]
    fn a_real_repository_read_offline() {
        // This repository, if the tests run in its checkout (CI's is one commit deep, its one commit every file, a
        // bulk one): commits come back, at least one, newest first, only of files asked about, the same twice
        // (the second from what was kept).
        let here = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        if !here.join(".git").exists() { return; }
        let kept = crate::testing::dir("plan-real");
        let idx: HashMap<&str, usize> = [("os/core/src/lib.rs", 0)].into_iter().collect();
        let h = from_git_keeping(&here, &idx, &kept).expect("a git repository");
        assert!(h.read > 0);
        assert!(h.commits.iter().all(|c| c.files.iter().all(|&f| f == 0)));
        assert!(h.commits.windows(2).all(|w| !w[0].id.is_empty() && w[0].id != w[1].id));
        assert_eq!(from_git_keeping(&here, &idx, &kept), Some(h));
        assert!(from_git_keeping(Path::new("/nonexistent/plan"), &idx, &kept).is_none());
    }
}
