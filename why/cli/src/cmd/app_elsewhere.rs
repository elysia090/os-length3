//! `why app` where why does not open the app's window (Windows: the app is opened from its Start menu entry, and is
//! one at a time by itself). cmd/app.rs is the command on Linux and macOS.

use super::Ctx;
use crate::words::args::Call;
use crate::say::out::{Error, Reply, Result};
use why_core::tr;

/// `why app`: opened from the Start menu here.
pub fn open(_: &Ctx, _: &Call) -> Result<Reply> {
    Err(Error::Refused(tr!("Here the app is opened from its Start menu entry (why app opens it on Linux and macOS)",
        "ここではアプリはスタートメニューから開きます（why app で開くのは Linux と macOS）")))
}

/// `why app close`: closed by its window here.
pub fn close(_: &Ctx, _: &Call) -> Result<Reply> {
    Err(Error::Refused(tr!("Here the app is closed by its window's close button (why app close closes it on Linux and macOS)",
        "ここではアプリはウィンドウの閉じるボタンで閉じます（why app close で閉じるのは Linux と macOS）")))
}
