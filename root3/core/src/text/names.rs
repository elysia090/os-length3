//! Names as root3 and the app write them (DESIGN.md §5, "Names"): owner first,
//! as scp is. A name's kind is read from its shape, and what is left out is
//! filled from context; what could mean two things is an error, not a guess.
//!
//!   ren@length3.com            a principal: a person, or a server
//!   trip                       a principal on one's own domain (where one is meant)
//!   trip:hello                 a repo of a principal (`trip@length3.com:hello`)
//!   hello  hello/src/a.c       one's own repo, a file in it
//!   hello#3  trip:hello#3      an issue
//!   trip#general  #general     a server's board (the server one is in, when left out)

/// A principal's name: `name` alone is on one's own domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal { pub name: String, pub domain: Option<String> }

impl Principal {
    fn read(s: &str) -> Result<Principal, String> {
        let (name, domain) = s.split_once('@').map_or((s, None), |(n, d)| (n, Some(d.to_ascii_lowercase())));
        let ok = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !ok(name) || domain.as_deref().is_some_and(|d| !ok(d) || !d.contains('.')) {
            return Err(crate::tr!("Not a name: {}", "名前ではありません：{}", s));
        }
        Ok(Principal { name: name.to_ascii_lowercase(), domain })
    }
    /// Whether it is `address` (name@domain), the domain left out meaning `home`; as names are, without regard to case.
    pub fn is(&self, address: &str, home: &str) -> bool {
        address.split_once('@').is_some_and(|(name, domain)| {
            name.eq_ignore_ascii_case(&self.name) && domain.eq_ignore_ascii_case(self.domain.as_deref().unwrap_or(home))
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Name {
    Principal(Principal),
    /// A repo (of `owner`, or one's own), a path in it ('' for the repo), an issue.
    Repo { owner: Option<Principal>, repo: String, path: String, issue: Option<u32> },
    /// A server's board (the server one is in, when `server` is left out).
    Board { server: Option<Principal>, board: String },
}

/// Read `s` as a name. `principal`: where a principal is meant, a bare word is one (`trip`), not a repo.
pub fn read(s: &str, principal: bool) -> Result<Name, String> {
    let s = s.trim().trim_start_matches("/root/");
    if s.is_empty() { return Err(crate::tr!("A name is empty", "名前が空です")); }
    if let Some(board) = s.strip_prefix('#') {
        if board.is_empty() { return Err(crate::tr!("Which board? #NAME", "どの板ですか？ #名前")); }
        return Ok(Name::Board { server: None, board: board.into() });
    }
    // owner:repo… is another principal's repo.
    if let Some((owner, rest)) = s.split_once(':') {
        let (repo, path, issue) = repo(rest)?;
        return Ok(Name::Repo { owner: Some(Principal::read(owner)?), repo, path, issue });
    }
    // word#3 is a repo's issue; word#name a server's board.
    if let Some((head, tail)) = s.split_once('#') {
        if !tail.is_empty() && !tail.bytes().all(|b| b.is_ascii_digit()) {
            return Ok(Name::Board { server: Some(Principal::read(head)?), board: tail.into() });
        }
    }
    if s.contains('@') || (principal && !s.contains('/') && !s.contains('#')) { return Principal::read(s).map(Name::Principal); }
    let (repo, path, issue) = repo(s)?;
    Ok(Name::Repo { owner: None, repo, path, issue })
}

/// `repo[/path][#n]`: the repo, the path in it ('' for the repo), the issue.
fn repo(s: &str) -> Result<(String, String, Option<u32>), String> {
    let (s, issue) = match s.split_once('#') {
        Some((r, n)) => (r, Some(n.parse::<u32>().map_err(|_| crate::tr!("Not an issue number: #{}", "Issue の番号ではありません：#{}", n))?)),
        None => (s, None),
    };
    let s = s.trim_matches('/');
    let (repo, path) = s.split_once('/').map_or((s, ""), |(r, p)| (r, p));
    if repo.is_empty() { return Err(crate::tr!("Which repo?", "どの repo ですか？")); }
    Ok((repo.into(), path.into(), issue))
}

/// Whether a path part names a repo's `.git` however it is spelt: git, and
/// the file systems under it, treat `.GIT` (case-insensitive volumes),
/// `.git.` or `.git ` (trailing dots and spaces dropped), `git~1` (the short
/// name) and `.git` with invisible code points (ignored by HFS+) as `.git`
/// itself. Nothing reached through the store may land in it: its config and
/// hooks run commands on the host the next time git runs.
///
/// Read from the front, nothing copied: a name that is neither is told from its first character or two.
pub fn is_git_name(part: &str) -> bool {
    spelt(part, ".git") || spelt(part, "git~1")
}

/// Whether `part`, its invisible code points left out and case not minded, is `word` and then only dots and spaces.
fn spelt(part: &str, word: &str) -> bool {
    let mut seen = part.chars().filter(|c| !matches!(*c as u32, 0x200C..=0x200F | 0x202A..=0x202E | 0x206A..=0x206F | 0xFEFF));
    word.chars().all(|w| seen.next().is_some_and(|c| c.to_ascii_lowercase() == w)) && seen.all(|c| c == '.' || c == ' ')
}

/// Repo names are plain directory names: letters, digits, `.`, `_`, `-`.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

#[cfg(test)]
#[path = "names.test.rs"]
mod tests;
