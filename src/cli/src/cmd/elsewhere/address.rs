//! `root3 address` where SSH into the Prompts is not (Windows: Prompts run translated there, as in a browser, and
//! there is no root of their own for a listener to take one into). Each form says so; cmd/address.rs is the
//! command on Linux and macOS.

use super::Ctx;
use crate::args::Call;
use crate::out::{Error, Reply, Result};
use length3_core::tr;

fn not_here() -> Error {
    Error::Refused(tr!("SSH into a Prompt is Linux only for now", "Prompt への SSH はいま Linux だけです"))
}

/// `root3 address`: nothing listens here.
pub fn show(_: &Ctx, _: &Call) -> Result<Reply> { Err(not_here()) }

/// `root3 address ssh on|off`: nothing to turn on here.
pub fn set(_: &Ctx, _: &Call) -> Result<Reply> { Err(not_here()) }

/// `root3 address ssh serve`: no listener here.
pub fn serve(_: &Ctx, _: &Call) -> Result<Reply> { Err(not_here()) }
