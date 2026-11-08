//! cargo run --release --example replay -- ELF SEEDS: code reached later, as a
//! running program reaches it (one seed a line, in order, each past what the
//! ones before translated), timed by phase: what the browser's translator does
//! while gcc runs.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let elf = xlat::elf::Elf::parse_owned(std::fs::read(&a[1]).unwrap()).unwrap();
    let seeds: Vec<u64> = std::fs::read_to_string(&a[2]).unwrap().split_whitespace().map(|w| w.parse().unwrap()).collect();
    let mut known = std::collections::BTreeSet::new();
    let budget: usize = std::env::var("BUDGET").ok().and_then(|b| b.parse().ok()).unwrap_or(usize::MAX);
    // With a third argument (blocks a run entered, one a line): how much of what was translated ran.
    let ran: std::collections::HashSet<u64> = a.get(3).map(|p| std::fs::read_to_string(p).unwrap().split_whitespace().map(|w| w.parse().unwrap()).collect()).unwrap_or_default();
    let (mut blocks, mut ran_blocks, mut ran_functions, mut ran_instructions) = (0, 0, 0, 0);
    let (mut discover, mut lower) = (std::time::Duration::ZERO, std::time::Duration::ZERO);
    let (mut functions, mut instructions, mut bytes) = (0, 0, 0);
    for s in seeds {
        let t = std::time::Instant::now();
        let program = xlat::discover::discover_within(&elf, &[s], &known, budget);
        discover += t.elapsed();
        known.extend(program.functions.iter().map(|f| f.start));
        let t = std::time::Instant::now();
        let out = xlat::lower::translate_more(&program, 0, Default::default());
        lower += t.elapsed();
        functions += program.functions.len();
        for f in &program.functions {
            blocks += f.blocks.len();
            let r = f.blocks.iter().filter(|b| ran.contains(&b.start)).count();
            ran_blocks += r;
            if r > 0 { ran_functions += 1; ran_instructions += f.blocks.iter().map(|b| b.code.len()).sum::<usize>(); }
        }
        instructions += program.functions.iter().flat_map(|f| &f.blocks).map(|b| b.code.len()).sum::<usize>();
        bytes += out.wasm.len();
    }
    println!("discover {discover:?} lower {lower:?}; {functions} functions, {blocks} blocks, {instructions} instructions, {bytes} bytes of wasm");
    if !ran.is_empty() { println!("ran: {ran_blocks} of those blocks, in {ran_functions} functions holding {ran_instructions} instructions"); }
}
