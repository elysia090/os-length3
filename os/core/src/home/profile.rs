//! Home's profile: the name, the handle and the few words a person says of themselves.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::Result;
use serde::{Deserialize, Serialize};
use super::state::{get, set};

/// Change one field of the profile ("name", "handle" or "bio"), checked as the app checks it.
pub fn set_profile(field: &str, value: &str) -> Result<Profile> {
    let mut p = profile();
    let v = value.trim().to_string();
    let limit = PROFILE_LIMITS.iter().find(|(f, _)| *f == field).map(|(_, n)| *n)
        .ok_or_else(|| crate::tr!("A profile has a name, a handle and a bio", "プロフィールは name、handle、bio です"))?;
    match field {
        "handle" => {
            let h = v.trim_start_matches('@').to_ascii_lowercase();
            if !h.is_empty() && !valid_handle(&h) {
                return Err(crate::tr!("Handle must be 2–31 lowercase letters, digits, or . - _", "ハンドル名は英小文字・数字・. - _ の2〜31文字で入力してください"));
            }
            p.handle = h;
        }
        _ if v.chars().count() > limit => {
            return Err(if field == "name" { crate::tr!("A name is up to {} characters", "名前は{}文字までです", limit) } else { crate::tr!("A bio is up to {} characters", "自己紹介は{}文字までです", limit) });
        }
        "name" => p.name = v,
        _ => p.bio = v,
    }
    set("profile", &serde_json::to_string(&p).map_err(|e| e.to_string())?)?;
    Ok(p)
}

pub fn profile() -> Profile {
    get("profile").ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// A handle is a username: 2–31 lowercase letters, digits, . - and _, from a letter or digit (src/home/profile.ts).
pub fn valid_handle(h: &str) -> bool {
    let word = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    (2..=31).contains(&h.len()) && h.bytes().next().is_some_and(word) && h.bytes().all(|b| word(b) || b"._-".contains(&b))
}

/// How long each field of a profile may be, in characters.
pub const PROFILE_LIMITS: [(&str, usize); 3] = [("name", 50), ("handle", 31), ("bio", 160)];

/// Home's profile, as the app keeps it (src/home/profile.ts).
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Profile {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub handle: String,
    #[serde(default)]
    pub bio: String,
}

