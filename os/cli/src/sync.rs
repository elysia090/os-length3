//! There is no command to sync: the Remote and this device keep in step by
//! themselves, around each command, as its form says (spec::Sync). A form
//! that reads a repo takes in the Remote's changes to it first; after a
//! command, each repo whose files differ from what was last agreed is sent.
//! Which differ is seen here, from the digests kept, so a repo in step costs
//! no request. Offline, changes wait here and l3 says so once.

use crate::args::Call;
use crate::cmd::Ctx;
use crate::out::note;
use crate::spec::{Arg, Sync};
use crate::target;
use length3_core::remote::{self, Failure};
use length3_core::{repos::Repos, tr};
use std::sync::atomic::{AtomicBool, Ordering};

pub fn before(ctx: &Ctx, call: &Call) {
    if !ctx.connected() || call.form.sync != Sync::TakeIn { return; }
    match named(ctx, call) {
        Some(repo) => { send(&repo); }
        None => send_changed(),
    }
}

/// The Remote was found out of reach in this run: say it once, then leave it.
static OUT_OF_REACH: AtomicBool = AtomicBool::new(false);

/// After the form: send what changed, unless the form keeps in step itself
/// or the Remote was just found out of reach.
pub fn after(ctx: &Ctx, call: &Call, offline: bool) {
    if offline || OUT_OF_REACH.load(Ordering::Relaxed) || !ctx.connected() || call.form.sync == Sync::None { return; }
    send_changed();
}

/// The repo a call names, when it is here.
fn named(ctx: &Ctx, call: &Call) -> Option<String> {
    call.form.args.iter().enumerate().find_map(|(i, a)| match a {
        Arg::Repo { .. } => target::repo(ctx, call, i).ok(),
        Arg::Path { .. } => target::path(ctx, call, i).ok().map(|(r, _)| r),
        Arg::Issue => target::issue_parts(ctx, call.word(i)?).ok().map(|(r, _)| r).filter(|r| ctx.has_repo(r)),
        _ => None,
    })
}

/// Bring one repo into step (send, take in). Whether the Remote could be reached.
pub fn send(repo: &str) -> bool {
    if OUT_OF_REACH.load(Ordering::Relaxed) { return false; }
    match Repos::open().and_then(|r| remote::sync(&r, repo)) {
        Ok(s) => {
            for p in &s.both { note(&tr!("{} changed on another device too: the Remote's keeps the name, and this device's is beside it, marked ({})", "{} は別の端末でも変わっていました。その名前は Remote の版にし、この端末の版は（{}）を付けて横に置きました", p, remote::device_tag())); }
            true
        }
        Err(e) => {
            note(&tr!("{} is not sent yet: {}; it goes after a later command", "{} はまだ送れていません：{}。後のコマンドのあとに送ります", repo, e));
            let reached = !matches!(remote::last_failure(), Some((Failure::Unreachable | Failure::Unknown, _)));
            if !reached { OUT_OF_REACH.store(true, Ordering::Relaxed); }
            reached
        }
    }
}

/// Send every repo that changed here since it was last agreed; stop at the first the Remote cannot be reached for.
pub fn send_changed() {
    let Ok(r) = Repos::open() else { return };
    for s in r.list().unwrap_or_default() {
        if matches!(remote::status_of(&r, &s.name), Ok(st) if st.fresh || st.changed > 0) && !send(&s.name) { return; }
    }
}
