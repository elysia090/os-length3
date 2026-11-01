//! `l3 app` where l3 does not open the app's window (Windows: the app is opened from its Start menu entry, and is
//! one at a time by itself). cmd/app.rs is the command on Linux and macOS.

use super::Ctx;
use crate::args::Call;
use crate::out::{Error, Reply, Result};
use length3_core::tr;

/// `l3 app`: opened from the Start menu here.
pub fn open(_: &Ctx, _: &Call) -> Result<Reply> {
    Err(Error::Refused(tr!("Here the app is opened from its Start menu entry (l3 app opens it on Linux and macOS)",
        "ここではアプリはスタートメニューから開きます（l3 app で開くのは Linux と macOS）")))
}

/// `l3 app close`: closed by its window here.
pub fn close(_: &Ctx, _: &Call) -> Result<Reply> {
    Err(Error::Refused(tr!("Here the app is closed by its window's close button (l3 app close closes it on Linux and macOS)",
        "ここではアプリはウィンドウの閉じるボタンで閉じます（l3 app close で閉じるのは Linux と macOS）")))
}
