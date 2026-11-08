//! This device and the Remote (remote/app.ts), for l3 and the app alike.
//! The canonical copy is the Remote's; a repo here is a copy kept in step
//! with it:
//!
//!   draft   the working tree, sent as a diff after every change, each on
//!           the version it was read at (so nothing sent is overwritten)
//!   cut     Commit: the draft at a version becomes history (history/)
//!
//! Taking in is file by file against the last version agreed with the
//! Remote (the base): a file only changed there is written here, one only
//! changed here is sent, and when both changed one, the Remote's (it got
//! there first) keeps the name and this device's is written beside it as
//! "name (<this device>).ext", so neither is lost and the name says whose.
//! Files that cannot travel (links, files over 16 MiB) and a repo's own
//! .git are not sent, and are named; a repo holding them is never freed.
//!
//! A repo on the Remote need not be here: 空ける removes the copy once the
//! Remote holds all of it, and opening the repo brings it back.
//!
//! Here: the session, what was agreed (the base) and syncing, which uses
//!   http    requests to the Remote and how each failed
//!   login   signing a device in and out
//!   local   the copy here as the Remote would hold it
//!   merge   the plan for taking in, and writing it into the copy

// No unsafe code in this layer.
#![forbid(unsafe_code)]

pub mod account;
mod http;
pub mod inbox;
mod local;
mod login;
mod merge;
pub mod servers;
#[cfg(unix)]
pub mod ssh;
mod connection;
mod base;
mod sync;
mod copies;
mod home;
mod lines;

pub use self::http::{ask, Asked, Failure, forget_failure, last_detail, last_failure};
pub(crate) use self::http::{Client, refused_in, Reply};
pub use self::local::{BLOB_LIMIT, held_open, Local, local_tree, local_tree_fresh, Modes, Tree};
pub use self::login::{Account, account, app_origin, connect, device_finish, device_page_ok, device_start, DeviceCode, valid_url};
pub use self::merge::{beside, beside_as, device_tag, Plan, plan};
pub use self::connection::{Connection, connection, current_url, DEFAULT_URL, default_url, forget_connection, FORMER_URL, save_connection};
pub use self::base::{Base, base, forget_line, key, key_of};
pub(crate) use self::base::{at_path, set_head, set_head_from, tree_of};
pub use self::sync::{fetch, logout, Status, status, status_of, sync, sync_all, Synced};
pub use self::copies::{agreed, delete_repo, free, remote_repos, RemoteRepo, rename_repo, turn_on};
pub use self::home::{home_waiting, leave_home, sync_home};
pub use self::lines::{Line, line, lines};

#[cfg(test)]
#[path = "tests/remote.rs"]
mod tests;
