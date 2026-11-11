//! cargo run --release --example phases -- ELF SEEDS KNOWN: how long a lazy translation spends parsing, discovering and lowering.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let words = |p: &str| std::fs::read_to_string(p).unwrap().split_whitespace().map(|w| w.parse::<u64>().unwrap()).collect::<Vec<u64>>();
    let t = std::time::Instant::now();
    let bytes = std::fs::read(&a[1]).unwrap();
    let read = t.elapsed();
    let elf = sods::elf::Elf::parse(&bytes).unwrap();
    let parse = t.elapsed();
    let known: std::collections::BTreeSet<u64> = words(&a[3]).into_iter().collect();
    let program = sods::find::discover_from(&elf, &words(&a[2]), &known);
    let discover = t.elapsed();
    let out = sods::image::translate_more(&elf, &program, known.len() as u32, sods::image::Options::default());
    let lower = t.elapsed();
    println!("read {read:?} parse {:?} discover {:?} lower {:?}; {} functions, {} bytes", parse - read, discover - parse, lower - discover, program.functions.len(), out.wasm.len());
}
