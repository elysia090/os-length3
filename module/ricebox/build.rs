//! In a build made to work on (debug, for x86-64 Linux, on Linux): the two programs a box is started with are made
//! beside it, so a test or a run from the tree finds them (src/run.rs `beside`): muk (module/muk, by
//! module/lib/build.sh) and prompt (module/prompt, by its own cargo). A release is given both by what packages it.

use std::path::Path;
use std::process::Command;

fn main() {
    let var = |k: &str| std::env::var(k).unwrap_or_default();
    println!("cargo:rerun-if-changed=build.rs");
    if var("CARGO_CFG_TARGET_OS") != "linux" || var("CARGO_CFG_TARGET_ARCH") != "x86_64" || var("PROFILE") != "debug" || !cfg!(target_os = "linux") { return; }
    let top = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let out = std::path::PathBuf::from(var("OUT_DIR"));
    for watched in ["module/muk/src", "module/lib", "module/prompt/src", "module/prompt/Cargo.toml"] { println!("cargo:rerun-if-changed={}", top.join(watched).display()); }
    let muk = out.join("muk");
    let made = Command::new("sh").arg(top.join("module/lib/build.sh")).arg(top.join("module/muk/src/muk.c")).arg(&muk).status();
    if made.is_ok_and(|s| s.success()) { println!("cargo:rustc-env=RICEBOX_BUILT_MUK={}", muk.display()); }
    else { println!("cargo:warning=muk was not built (module/lib/build.sh): a Prompt started from this build finds none"); }
    let target = out.join("prompt");
    let mut cargo = Command::new(var("CARGO"));
    cargo.args(["build", "--release", "--manifest-path"]).arg(top.join("module/prompt/Cargo.toml")).arg("--target-dir").arg(&target);
    for k in ["CARGO_ENCODED_RUSTFLAGS", "RUSTFLAGS", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"] { cargo.env_remove(k); }
    if cargo.status().is_ok_and(|s| s.success()) { println!("cargo:rustc-env=RICEBOX_BUILT_PROMPT={}", target.join("release/prompt").display()); }
    else { println!("cargo:warning=prompt was not built (module/prompt): a Prompt at a terminal started from this build finds none"); }
}
