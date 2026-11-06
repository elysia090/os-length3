//! The lines of work on a repo as the Remote has them: each issue's branch, its head, what is pushed of it, its
//! base.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use crate::Result;
use super::http::{Client, Reply};

/// A line as the Remote has it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Line {
    pub line: String,
    #[serde(default)]
    pub issue: String,
    pub head: Option<String>,
    pub pushed: Option<String>,
    pub base: Option<String>,
    #[serde(default, rename = "startedBy")]
    pub started_by: String,
    #[serde(default, rename = "startedAt")]
    pub started_at: u64,
    #[serde(default)]
    pub version: i64,
}

pub fn lines(repo: &str) -> Result<Vec<Line>> {
    let v = Client::open()?.json("GET", &format!("/v1/repos/{repo}/lines"), None)?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

pub fn line(repo: &str, line: &str) -> Result<Option<Line>> {
    match Client::open()?.call("GET", &format!("/v1/repos/{repo}?line={line}"), None)? {
        Reply::Ok(v) => Ok(Some(serde_json::from_value(v).map_err(|e| e.to_string())?)),
        _ => Ok(None),
    }
}

