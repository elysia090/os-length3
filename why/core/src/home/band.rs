//! Home's band: the repos the person keeps at hand, in their order.

use crate::Result;
use super::state::{get, set};

/// Put `repo` out on the band (`on`), or take it in. Whether the band changed.
pub fn set_band(here: &[String], repo: &str, on: bool) -> Result<bool> {
    let mut b = band(here)?;
    let was = b.iter().any(|n| n == repo);
    if was == on { return Ok(false); }
    if on { b.push(repo.to_string()); } else { b.retain(|n| n != repo); }
    set("band", &serde_json::to_string(&b).map_err(|e| e.to_string())?)?;
    Ok(true)
}

/// Forge's band: the repos out on it, in order, only those in `here` (why/app/home/band.ts).
/// Never chosen yet, it holds the first repo.
pub fn band(here: &[String]) -> Result<Vec<String>> {
    let Some(text) = get("band")? else { return Ok(here.first().cloned().into_iter().collect()) };
    let stored: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for n in stored.iter().filter_map(|v| v.as_str()) {
        if here.iter().any(|h| h == n) && !out.iter().any(|o| o == n) { out.push(n.to_string()); }
    }
    Ok(out)
}

