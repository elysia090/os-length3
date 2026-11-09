//! cargo run --release --example seeded -- ELF SEEDS: how long translating a program again as one module from the
//! starts it reached takes (the kernel's consolidation): parsing, discovering, lowering, and how large.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let seeds: Vec<u64> = std::fs::read_to_string(&a[2]).unwrap().split_whitespace().map(|w| w.parse().unwrap()).collect();
    let t = std::time::Instant::now();
    let elf = xlat::elf::Elf::parse_owned(std::fs::read(&a[1]).unwrap()).unwrap();
    let parse = t.elapsed();
    let program = xlat::find::discover_seeded(&elf, &seeds);
    let discover = t.elapsed();
    let blocks: usize = program.functions.iter().map(|f| f.blocks.len()).sum();
    let out = xlat::image::translate(&elf, &program, Default::default());
    let lower = t.elapsed();
    println!("parse {parse:?} discover {:?} lower {:?}; {} seeds, {} functions, {blocks} blocks, {} bytes", discover - parse, lower - discover, seeds.len(), program.functions.len(), out.wasm.len());
}
