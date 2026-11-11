//! root3: Length³ OS on the command line. Its words and its order are the
//! app's rail: Home, Forge (and its Prompt), File, Git, Runtime, Remote,
//! then Server and Inbox. The same repos, issues, TODO and device, read and
//! written through the same core, so what one does here is what the app
//! shows, and back. It speaks English, or Japanese when Home's language is
//! (or LENGTH3_LANG=ja).
//!
//! One table (words/spec.rs) says every form; a call is read against it (words/args.rs),
//! may run where it is (cmd::before), is kept in step with the Remote around
//! it (cmd/sync.rs), and answers with text or, with --json, data (say/out.rs). At a
//! terminal, bare `root3` is the menu (say/menu.rs), and a command typed is followed
//! by its next deeds, both read from the same table; anywhere else root3 is only
//! the command (say/term.rs interactive).

mod cmd;
mod say;
mod words;

use say::{menu, out, term};
use words::args;

use std::process::ExitCode;

fn main() -> ExitCode {
    // A session's program made what an SSH session's must be, before anything else is done (cmd/ssh.rs).
    #[cfg(all(target_os = "linux", feature = "ssh"))]
    cmd::ssh::session_start();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let ctx = cmd::Ctx::new();
    let call = match args::parse(&argv, &ctx) {
        Ok(c) => c,
        Err(e) => return out::fail(&e, argv.iter().take_while(|a| *a != "--").any(|a| a == "--json")),
    };
    let person = term::interactive(call.flags.json);
    if person && call.command.name.is_empty() { return menu::rail(&ctx); }
    if person && call.command.name == "next" { return menu::next(&ctx); }
    let (done, seen) = if person { menu::noting(|| cmd::perform(&ctx, &call)) } else { (cmd::perform(&ctx, &call), menu::Seen::default()) };
    let offline = matches!(done, Err(out::Error::Offline(_)));
    let ok = done.is_ok();
    let made = done.as_ref().ok().and_then(|r| menu::made(&call, r));
    let code = match done {
        Ok(reply) => { out::emit(reply, call.flags.json); ExitCode::SUCCESS }
        Err(e) => out::fail(&e, call.flags.json),
    };
    cmd::sync::after(&ctx, &call, offline);
    if person && ok { menu::after(&ctx, &call, &argv, seen, made); }
    code
}
