//! Inbox from the device (service/inbox.ts): the address people find you by
//! (name@domain), the conversations, and writing to someone. Live chat is the
//! app's (a WebRTC line between two open pages); here messages go through the
//! Remote as text.

use crate::remote::{Client, Reply};
use serde::{Deserialize, Serialize};
type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize, Debug)]
pub struct Me { pub domain: String, pub account: String, pub addresses: Vec<Address> }
#[derive(Serialize, Deserialize, Debug)]
pub struct Address { pub address: String, pub ssh: bool }
#[derive(Serialize, Deserialize, Debug)]
pub struct Last { #[serde(rename = "type")] pub kind: String, pub body: String, pub mine: bool, pub time: u64 }
#[derive(Serialize, Deserialize, Debug)]
pub struct Thread { pub address: String, pub name: String, pub state: String, pub unread: u64, pub last: Last }
#[derive(Serialize, Deserialize, Debug)]
pub struct Message { pub id: String, pub mine: bool, #[serde(rename = "type")] pub kind: String, pub target: serde_json::Value, pub body: String, pub time: u64 }
#[derive(Serialize, Deserialize, Debug)]
pub struct Conversation { pub address: String, pub state: String, pub mutual: bool, pub messages: Vec<Message> }

fn get<T: for<'a> Deserialize<'a>>(path: &str) -> Result<T> {
    serde_json::from_value(Client::open()?.json("GET", path, None)?).map_err(|e| e.to_string())
}

pub fn me() -> Result<Me> { get("/v1/inbox/me") }
pub fn threads() -> Result<Vec<Thread>> { get("/v1/inbox/threads") }

pub fn thread(address: &str) -> Result<Conversation> {
    let c: Conversation = get(&format!("/v1/inbox/threads/{address}"))?;
    let _ = Client::open()?.call("POST", &format!("/v1/inbox/threads/{address}/read"), Some(serde_json::json!({})));
    Ok(c)
}

/// Claim `name@domain` (the Remote's own domain when none is given).
pub fn claim(address: &str) -> Result<String> {
    let (name, domain) = address.split_once('@').map_or((address, None), |(n, d)| (n, Some(d)));
    let body = serde_json::json!({"name": name, "domain": domain});
    match Client::open()?.call("POST", "/v1/inbox/addresses", Some(body))? {
        Reply::Ok(v) => Ok(v["address"].as_str().unwrap_or_default().to_string()),
        Reply::Conflict(v) if v["publish"].is_object() => Err(crate::tr!("Publish this at https://{}/.well-known/length3, then claim again:\n{}",
            "これを https://{}/.well-known/length3 に置いてから、もう一度取ってください:\n{}", domain.unwrap_or(""), serde_json::to_string_pretty(&v["publish"]).unwrap_or_default())),
        Reply::Conflict(_) => Err(crate::tr!("That address is taken", "そのアドレスは使われています")),
        Reply::NotFound => Err(crate::tr!("The Remote has no Inbox", "Remote に Inbox がありません")),
    }
}

/// Write to `to`; `kind` is message, review, question or run. Returns whether it went as a request.
/// What a written message is, as in the app: its kind named first the way an issue is
/// ("Review：…", "Question：…"), and the repo a /root/… path in it is about.
pub fn written(text: &str) -> (&'static str, String, Option<String>) {
    let (kind, title) = crate::text::kind_of(text);
    let kind = match kind.as_deref().map(str::to_ascii_lowercase).as_deref() { Some("review") => "review", Some("question") => "question", _ => "message" };
    let body = if kind == "message" { text.trim().to_string() } else { title };
    let repo = text.split("/root/").nth(1).map(|rest| rest.chars().take_while(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).collect::<String>()).filter(|r| !r.is_empty());
    (kind, body, repo)
}

pub fn send(to: &str, body: &str, kind: &str, repo: Option<&str>) -> Result<bool> {
    let target = repo.map_or(serde_json::json!({}), |r| serde_json::json!({"repo": r}));
    let v = Client::open()?.call("POST", "/v1/inbox/messages", Some(serde_json::json!({"to": to, "body": body, "type": kind, "target": target})))?;
    match v {
        Reply::Ok(v) => Ok(v["request"].as_bool().unwrap_or(false)),
        Reply::Conflict(_) => Err(crate::tr!("Claim an address first (l3 address claim NAME)", "先にアドレスを持ってください（l3 address claim NAME）")),
        Reply::NotFound => Err(crate::tr!("No one has that address", "そのアドレスの人はいません")),
    }
}

/// Accept someone who wrote first, or block them.
pub fn decide(address: &str, state: &str) -> Result<()> {
    Client::open()?.json("POST", "/v1/inbox/contacts", Some(serde_json::json!({"address": address, "state": state}))).map(|_| ())
}
