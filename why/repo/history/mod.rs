//! History in the issues' terms (issue #17). An issue is the unit of work;
//! its branch and worktree are the OS's to keep (repo/history/work.rs). The operations
//! a person does are few, and are the same from the app, why and a browser
//! (why/repo/history.ts):
//!
//!   Commit         what is not committed becomes history on the work's line,
//!                  named after its issue ("Fix：件名"), on one's own Remote;
//!   Submit         the line's commits become its state there (`push`, the
//!                  line's own word for it) and go to main as a change; again
//!                  after more commits, as its next version; Reset takes it
//!                  back. A push in a person's words is to a server or
//!                  another's Remote, never this
//!   Review         of one version of a change: approve, ask for changes, comment
//!   Merge, Reject  the receiver's: main takes the change, or does not
//!
//! What is not committed is the draft against the line's last commit, shown
//! by the folder it is in, so a reader enters from the area they look after.

// No unsafe code in this layer.
#![forbid(unsafe_code)]

pub mod work;
mod changes;
mod commits;
mod log;
mod review;

pub use self::changes::{at_head, changed, Changes, changes, diff, DiffLine, FileChange, FileDiff, Folder};
pub use self::commits::{commit_issue, cut, cut_on, issue_words, settle_issues};
pub use self::log::{Cut, line, log, log_of};
pub(crate) use self::log::progress;
pub use self::review::{Change, change_diff, change_diff_at, change_line_source, changes_of_repo, hand_in, HandIn, merge, merge_at, merged_seen, push, reject, reject_at, reset, Review, ReviewLine, Revision, review, review_at, state_word, submit, submit_at, work_diff_at};
pub(crate) use self::review::{listed, remember_merged};
