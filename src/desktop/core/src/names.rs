//! Names as l3 and the app write them (DESIGN.md §0, "Names"): owner first,
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
            return Err(crate::tr!("Not a name: {}", "名前ではありません: {}", s));
        }
        Ok(Principal { name: name.to_ascii_lowercase(), domain })
    }
    /// Whether it is `address` (name@domain), the domain left out meaning `home`.
    pub fn is(&self, address: &str, home: &str) -> bool {
        format!("{}@{}", self.name, self.domain.as_deref().unwrap_or(home)) == address.to_ascii_lowercase()
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
        let Name::Repo { repo, path, issue, .. } = repo(rest)? else { unreachable!() };
        return Ok(Name::Repo { owner: Some(Principal::read(owner)?), repo, path, issue });
    }
    // word#3 is a repo's issue; word#name a server's board.
    if let Some((head, tail)) = s.split_once('#') {
        if !tail.is_empty() && !tail.bytes().all(|b| b.is_ascii_digit()) {
            return Ok(Name::Board { server: Some(Principal::read(head)?), board: tail.into() });
        }
    }
    if s.contains('@') || (principal && !s.contains('/') && !s.contains('#')) { return Principal::read(s).map(Name::Principal); }
    repo(s)
}

/// `repo[/path][#n]`, one's own.
fn repo(s: &str) -> Result<Name, String> {
    let (s, issue) = match s.split_once('#') {
        Some((r, n)) => (r, Some(n.parse::<u32>().map_err(|_| crate::tr!("Not an issue number: #{}", "Issue の番号ではありません: #{}", n))?)),
        None => (s, None),
    };
    let s = s.trim_matches('/');
    let (repo, path) = s.split_once('/').map_or((s, ""), |(r, p)| (r, p));
    if repo.is_empty() { return Err(crate::tr!("Which repo?", "どの repo ですか？")); }
    Ok(Name::Repo { owner: None, repo: repo.into(), path: path.into(), issue })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(n: &str, d: Option<&str>) -> Principal { Principal { name: n.into(), domain: d.map(Into::into) } }

    #[test]
    fn a_names_kind_is_read_from_its_shape() {
        assert_eq!(read("ren@length3.com", false).unwrap(), Name::Principal(p("ren", Some("length3.com"))));
        assert_eq!(read("trip", true).unwrap(), Name::Principal(p("trip", None)));
        assert_eq!(read("hello", false).unwrap(), Name::Repo { owner: None, repo: "hello".into(), path: "".into(), issue: None });
        assert_eq!(read("/root/hello/src/a.c", false).unwrap(), Name::Repo { owner: None, repo: "hello".into(), path: "src/a.c".into(), issue: None });
        assert_eq!(read("hello#3", false).unwrap(), Name::Repo { owner: None, repo: "hello".into(), path: "".into(), issue: Some(3) });
        assert_eq!(read("trip@length3.com:hello#3", false).unwrap(), Name::Repo { owner: Some(p("trip", Some("length3.com"))), repo: "hello".into(), path: "".into(), issue: Some(3) });
        assert_eq!(read("trip:hello/src", false).unwrap(), Name::Repo { owner: Some(p("trip", None)), repo: "hello".into(), path: "src".into(), issue: None });
        assert_eq!(read("trip#general", false).unwrap(), Name::Board { server: Some(p("trip", None)), board: "general".into() });
        assert_eq!(read("#general", false).unwrap(), Name::Board { server: None, board: "general".into() });
        assert!(read("hello#x3", false).is_ok_and(|n| matches!(n, Name::Board { .. })));
        assert!(read("a b:c", false).is_err());
        assert!(read("hello#", false).is_err());
        assert!(p("trip", None).is("trip@length3.com", "length3.com"));
        assert!(!p("trip", Some("ren.dev")).is("trip@length3.com", "length3.com"));
    }
}
