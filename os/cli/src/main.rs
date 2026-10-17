//! l3: Length³ OS on the command line. Its words and its order are the
//! app's rail: Home, Forge (and its Prompt), File, Git, Runtime, Remote,
//! then Server and Inbox. The same repos, issues, TODO and device, read and
//! written through the same core, so what one does here is what the app
//! shows, and back. It speaks English, or Japanese when Home's language is
//! (or LENGTH3_LANG=ja).
//!
//! One table (spec.rs) says every form; a call is read against it (args.rs),
//! may run where it is (cmd::before), is kept in step with the Remote around
//! it (sync.rs), and answers with text or, with --json, data (out.rs).

mod args;
mod cmd;
mod completion;
mod help;
mod out;
mod spec;
mod sync;
mod target;

use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let ctx = cmd::Ctx::new();
    let call = match args::parse(&argv, &ctx) {
        Ok(c) => c,
        Err(e) => return out::fail(&e, argv.iter().take_while(|a| *a != "--").any(|a| a == "--json")),
    };
    let done = cmd::before(&ctx, &call).and_then(|_| (call.form.run)(&ctx, &call));
    let offline = matches!(done, Err(out::Error::Offline(_)));
    let code = match done {
        Ok(reply) => { out::emit(reply, call.flags.json); ExitCode::SUCCESS }
        Err(e) => out::fail(&e, call.flags.json),
    };
    sync::after(&ctx, &call, offline);
    code
}
