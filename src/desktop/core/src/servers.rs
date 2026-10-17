//! Servers from the device (service/servers.ts): the one thing whose subject
//! is people, not a repo. A server is a group of people who know each other;
//! each of its boards is a conversation and a TODO they keep together. All of
//! it is kept on the Remote; any board can be taken home here as one text
//! (its TODO, its talk, or both).

use crate::remote::Client;
use serde::{Deserialize, Serialize};
type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Board { pub id: String, pub name: String, pub open: bool, pub guests: bool }
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Server { pub id: String, pub name: String, #[serde(default)] pub address: String, pub owner: bool, pub boards: Vec<Board> }

/// The servers this account is in, each with its boards.
pub fn list() -> Result<Vec<Server>> {
    serde_json::from_value(Client::open()?.json("GET", "/v1/servers", None)?).map_err(|e| e.to_string())
}

/// A server, or one of its boards, as names are written (names.rs): `trip`, `trip@length3.com`,
/// `trip#general`, or `#general` when one is in one server only. The server, and the boards meant
/// (all of them when none is named).
pub fn find(target: &str) -> Result<(Server, Vec<Board>)> {
    use crate::names::{read, Name};
    let (who, board) = match read(target, true)? {
        Name::Principal(p) => (Some(p), None),
        Name::Board { server, board } => (server, Some(board)),
        Name::Repo { .. } => return Err(crate::tr!("{} is a repo; a server is name or name@domain, a board server#board", "{} は repo です。サーバーは name か name@domain、板は server#board", target)),
    };
    let all = list()?;
    let home = all.iter().find_map(|s| s.address.split_once('@').map(|(_, d)| d.to_string())).unwrap_or_default();
    let server = match &who {
        // By its name as a principal, or (where that is plain) by what it is called.
        Some(p) => all.into_iter().find(|s| p.is(&s.address, &home) || (p.domain.is_none() && s.name.eq_ignore_ascii_case(&p.name)) || s.id == p.name)
            .ok_or_else(|| crate::tr!("You are in no server called {}", "{} というサーバーには入っていません", target))?,
        None => match all.len() {
            1 => all.into_iter().next().unwrap(),
            0 => return Err(crate::tr!("You are in no server yet", "まだどのサーバーにも入っていません")),
            _ => return Err(crate::tr!("Which server's board? Write it as server#board", "どのサーバーの板ですか？ server#board と書いてください")),
        },
    };
    let boards = match board {
        None => server.boards.clone(),
        Some(b) => vec![server.boards.iter().find(|x| x.id == b || x.name.eq_ignore_ascii_case(&b)).cloned()
            .ok_or_else(|| crate::tr!("{} has no board called {}", "{} に {} という板はありません", server.name, b))?],
    };
    Ok((server, boards))
}

/// A board as one markdown text: its TODO, its talk, or both.
pub fn archive(board: &str, todo: bool, talk: bool) -> Result<String> {
    Client::open()?.text(&format!("/v1/boards/{board}/archive?todo={}&talk={}", u8::from(todo), u8::from(talk)))
}

/// Write in a board, as one of its people.
pub fn post(board: &str, body: &str) -> Result<()> {
    Client::open()?.json("POST", &format!("/v1/boards/{board}/posts"), Some(serde_json::json!({"body": body}))).map(|_| ())
}
