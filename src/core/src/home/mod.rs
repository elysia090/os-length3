//! Home's state as files the person owns: `<data>/home/<key>.json`. The app
//! keeps its profile, TODO and band here (in a browser, in its storage), and
//! root3 reads and writes the same TODO.

// No unsafe code in this layer.
#![forbid(unsafe_code)]

mod state;
mod todo;
mod profile;
mod band;
mod network;
mod dotfiles;
mod agree;

pub use self::state::{get, KEYS, lang, LANGS, remove, set, set_lang};
pub use self::todo::{join_todo, parse_todos, save_todos, Todo, todo_edited, todo_from, TODO_LIMITS, todos};
pub use self::profile::{Profile, profile, PROFILE_LIMITS, set_profile, valid_handle};
pub use self::band::{band, set_band};
pub use self::network::{network, networked, set_network};
pub use self::dotfiles::{COMMON_DOTFILES, dotfile_name, dotfiles, dotfiles_in_effect, dotfiles_waiting, keep_trust, set_dotfile, take_dotfiles};
pub use self::agree::{agree_with, Agreed, Files, got, HomeHere, HomeSynced, HomeThere, leave, put_body, put_version, SYNCED, waiting};

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
