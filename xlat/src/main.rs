//! `xlat [--whole] INPUT.elf OUTPUT.wasm` — translate a static x86-64 Linux
//! program: what it runs first, or with --whole all of it, ahead of time
//! (discover::discover_whole).
//! `xlat --seeds=SEEDS INPUT.elf OUTPUT.wasm` — as the first, and from the function starts listed in SEEDS (one
//! address a line) too: a program with the code its runs reached later, in one module.
//! `xlat --more=SEEDS --known=KNOWN --base=N INPUT.elf OUTPUT.wasm` — code
//! reached later from the addresses in SEEDS (one per line), past what
//! KNOWN lists as translated, as a module filling table slots from N.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let trace = args.iter().any(|a| a == "--trace");
    let paths: Vec<&String> = args.iter().skip(1).filter(|a| !a.starts_with("--")).collect();
    let [input, output] = paths.as_slice() else {
        eprintln!("usage: xlat [--trace] [--whole] INPUT.elf OUTPUT.wasm");
        return ExitCode::from(2);
    };
    let bytes = match std::fs::read(input) {
        Ok(b) => b,
        Err(e) => { eprintln!("xlat: {input}: {e}"); return ExitCode::FAILURE; }
    };
    let elf = match xlat::elf::Elf::parse(&bytes) {
        Ok(e) => e,
        Err(e) => { eprintln!("xlat: {input}: {e}"); return ExitCode::FAILURE; }
    };
    let started = std::time::Instant::now();
    let flag = |name: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{name}=")).map(str::to_string));
    let list = |path: Option<String>| -> Vec<u64> {
        path.and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default().lines().filter_map(|l| l.trim().parse().ok()).collect()
    };
    let translation = if let Some(seeds) = flag("more") {
        let known: std::collections::BTreeSet<u64> = list(flag("known")).into_iter().collect();
        let base: u32 = flag("base").and_then(|b| b.parse().ok()).unwrap_or(0);
        let program = xlat::discover::discover_within(&elf, &list(Some(seeds)), &known, xlat::discover::BUDGET);
        xlat::lower::translate_more(&program, base, xlat::lower::Options { trace })
    } else {
        let program = if args.iter().any(|a| a == "--whole") {
            xlat::discover::discover_whole(&elf)
        } else if let Some(seeds) = flag("seeds") {
            xlat::discover::discover_seeded(&elf, &list(Some(seeds)))
        } else {
            xlat::discover::discover(&elf)
        };
        xlat::lower::translate(&elf, &program, xlat::lower::Options { trace })
    };
    if let Err(e) = std::fs::write(output, &translation.wasm) {
        eprintln!("xlat: {output}: {e}");
        return ExitCode::FAILURE;
    }
    let r = &translation.report;
    let unsupported: Vec<String> = r.unsupported.iter().map(|(m, n)| format!("\"{m}\":{n}")).collect();
    eprintln!(
        "{{\"functions\":{},\"blocks\":{},\"instructions\":{},\"entries\":{},\"wasmBytes\":{},\"ms\":{},\"unsupported\":{{{}}}}}",
        r.functions, r.blocks, r.instructions, r.entries, translation.wasm.len(), started.elapsed().as_millis(),
        unsupported.join(",")
    );
    ExitCode::SUCCESS
}
