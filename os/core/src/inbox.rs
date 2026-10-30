//! Inbox from the device (service/inbox.ts): the address people find you by
//! (name@domain), the conversations, and writing to someone. Live chat is the
//! app's (a WebRTC line between two open pages); here messages go through the
//! Remote as text.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::remote::{Client, Reply};
use serde::{Deserialize, Serialize};
type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize, Debug)]
pub struct Me { pub domain: String, pub account: String, #[serde(default)] pub code: String, pub addresses: Vec<Address> }
/// An address: a name on this Remote is its owner's as long as they keep it; one on a domain answers while its DNS
/// names this Remote (`lapsed` while not).
#[derive(Serialize, Deserialize, Debug)]
pub struct Address {
    pub address: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")] pub lapsed: bool,
}

impl Me {
    /// `address` as it is shown: a name on this Remote alone (`ren`), any other in full.
    pub fn shown<'a>(&self, address: &'a str) -> &'a str {
        address.strip_suffix(&format!("@{}", self.domain)).unwrap_or(address)
    }
    /// A name as written to the Remote: alone, it is on this Remote.
    pub fn full(&self, name: &str) -> String {
        if name.contains('@') { name.to_ascii_lowercase() } else { format!("{}@{}", name.to_ascii_lowercase(), self.domain) }
    }
}
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
    // Read is said again the next time it is opened; the conversation is shown either way.
    let _ = Client::open()?.call("POST", &format!("/v1/inbox/threads/{address}/read"), Some(serde_json::json!({})));
    Ok(c)
}

/// Claim `name@domain` (the Remote's own domain when none is given).
pub fn claim(address: &str) -> Result<String> {
    let (name, domain) = address.split_once('@').map_or((address, None), |(n, d)| (n, Some(d)));
    let body = serde_json::json!({"name": name, "domain": domain});
    match Client::open()?.call("POST", "/v1/inbox/addresses", Some(body))? {
        Reply::Ok(v) => Ok(v["address"].as_str().unwrap_or_default().to_string()),
        Reply::Conflict(v) if v["publish"].is_object() => {
            let p = &v["publish"];
            Err(crate::tr!("Put this record in {}'s DNS, then claim again (l3 name domain {} says when it is there):\n  {}  {}  {}",
                "{} の DNS にこのレコードを置いてから、もう一度取ってください（置けたかは l3 name domain {}）:\n  {}  {}  {}",
                domain.unwrap_or(""), domain.unwrap_or(""), p["name"].as_str().unwrap_or(""), p["type"].as_str().unwrap_or("TXT"), p["value"].as_str().unwrap_or("")))
        }
        Reply::Conflict(_) => Err(crate::tr!("That name is taken", "その名前は使われています")),
        Reply::NotFound(_) => Err(crate::tr!("The Remote has no Inbox", "Remote に Inbox がありません")),
    }
}

/// What a domain's DNS must say for this account to hold addresses on it, and whether it says so now.
#[derive(Serialize, Deserialize, Debug)]
pub struct Record { pub name: String, #[serde(rename = "type")] pub kind: String, pub value: String, pub found: bool }
pub fn domain_record(domain: &str) -> Result<Record> { get(&format!("/v1/inbox/domains/{}", domain.trim().to_ascii_lowercase())) }

/// Let `address` go: it answers no one from now, and is held for this account a while (claiming it again takes it back).
pub fn release(address: &str) -> Result<u64> {
    let v = Client::open()?.json("DELETE", &format!("/v1/inbox/addresses/{}", address.to_ascii_lowercase()), None)?;
    Ok(v["until"].as_u64().unwrap_or(0))
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
        Reply::Conflict(_) => Err(crate::tr!("Claim a name first (l3 name claim NAME)", "先に名前を取ってください（l3 name claim NAME）")),
        Reply::NotFound(_) => Err(crate::tr!("No one has that name", "その名前の人はいません")),
    }
}

/// Accept someone who wrote first, or block them.
pub fn decide(address: &str, state: &str) -> Result<()> {
    Client::open()?.json("POST", "/v1/inbox/contacts", Some(serde_json::json!({"address": address, "state": state}))).map(|_| ())
}
