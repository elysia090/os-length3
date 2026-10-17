//! Servers from the device (service/servers.ts): the one thing whose subject
//! is people, not a repo. A server is a group of people who know each other;
//! each of its boards holds a plan they write together and the talk around
//! it. All of it is kept on the Remote; any board can be taken home here as
//! one text (its plan, its talk, or both).

use crate::remote::Client;
use serde::{Deserialize, Serialize};
type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Board { pub id: String, pub name: String, pub open: bool, pub guests: bool }
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Server { pub id: String, pub name: String, pub owner: bool, pub boards: Vec<Board> }

/// The servers this account is in, each with its boards.
pub fn list() -> Result<Vec<Server>> {
    serde_json::from_value(Client::open()?.json("GET", "/v1/servers", None)?).map_err(|e| e.to_string())
}

/// `SERVER` or `SERVER/BOARD`, by name (any case) or id: the server, and the boards meant (all of them when none is named).
pub fn find(target: &str) -> Result<(Server, Vec<Board>)> {
    let (s, b) = target.split_once('/').map_or((target, None), |(s, b)| (s, Some(b)));
    let same = |name: &str, id: &str, want: &str| id == want || name.eq_ignore_ascii_case(want);
    let server = list()?.into_iter().find(|x| same(&x.name, &x.id, s))
        .ok_or_else(|| crate::tr!("You are in no server called {}", "{} というサーバーには入っていません", s))?;
    let boards = match b {
        None | Some("") => server.boards.clone(),
        Some(b) => vec![server.boards.iter().find(|x| same(&x.name, &x.id, b)).cloned()
            .ok_or_else(|| crate::tr!("{} has no board called {}", "{} に {} という板はありません", server.name, b))?],
    };
    Ok((server, boards))
}

/// A board as one markdown text: its plan, its talk, or both.
pub fn archive(board: &str, plan: bool, talk: bool) -> Result<String> {
    Client::open()?.text(&format!("/v1/boards/{board}/archive?plan={}&talk={}", u8::from(plan), u8::from(talk)))
}

/// Write in a board, as one of its people.
pub fn post(board: &str, body: &str) -> Result<()> {
    Client::open()?.json("POST", &format!("/v1/boards/{board}/posts"), Some(serde_json::json!({"body": body}))).map(|_| ())
}
