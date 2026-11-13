//! The one way a page asks the core: a command's name and its arguments as JSON, its answer as JSON.
//! The app's window asks it through Tauri (why/desktop/src/main.rs), a browser through the same core built
//! for the web (web/), and why calls the modules themselves: what a person can do is done by this code alone,
//! whichever of the three they are in front of. What only a host can do (open a page in the browser, start a
//! Prompt on the root, SSH) is the host's, around this.

// No unsafe code here.
#![forbid(unsafe_code)]

mod args;
mod call;

use serde_json::{json, Value};

use crate::remote;

pub use call::call;

/// Files the editor may save; anything read in part is never written back.
pub const READ_LIMIT: u64 = 256 * 1024;

/// The commands that write a repo's files or Home's state: a host runs them in the order the page sent them
/// (the app on its window's thread), never side by side with each other.
pub const WRITES: &[&str] = &["repo_create", "repo_write", "repo_put", "repo_add", "repo_mkdir", "repo_remove", "repo_move", "repo_rename",
    "repo_delete", "state_set", "dotfile_set", "dotfiles_take"];

/// The answer as a host passes it on: `{"ok": …}` or `{"error": "…"}`.
///
/// A refusal of the Remote's says how it answered too: `status` (0: not reached, 401: it no longer knows
/// this device) and its `detail` (a plan's rule, say), so a page tells a refusal from a fault as the app does.
pub fn answer(name: &str, args: &Value) -> Value {
    remote::forget_failure();
    match call(name, args) {
        Ok(v) => json!({"ok": v}),
        Err(e) => match remote::last_failure().filter(|(_, said)| *said == e) {
            Some((f, _)) => {
                let status = match f { remote::Failure::Status(code) => code, remote::Failure::Unknown => 401, _ => 0 };
                json!({"error": e, "status": status, "detail": remote::last_detail()})
            }
            None => json!({"error": e}),
        },
    }
}
