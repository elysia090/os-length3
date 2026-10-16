//! `xlat INPUT.elf OUTPUT.wasm` — translate a static x86-64 Linux program.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, output] = args.as_slice() else {
        eprintln!("usage: xlat INPUT.elf OUTPUT.wasm");
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
    let program = xlat::discover::discover(&elf);
    let translation = xlat::lower::translate(&elf, &program);
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
