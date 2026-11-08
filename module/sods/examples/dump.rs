//! cargo run --example dump -- ELF ADDRESS: the function holding ADDRESS as discover sees it.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&a[1]).unwrap();
    let elf = xlat::elf::Elf::parse(&bytes).unwrap();
    let at = u64::from_str_radix(a[2].trim_start_matches("0x"), 16).unwrap();
    let p = xlat::discover::discover(&elf);
    for f in &p.functions {
        if f.blocks.iter().any(|b| b.start <= at && at < b.start + b.code.iter().map(|i| i.len() as u64).sum::<u64>()) {
            println!("function {:#x} {}", f.start, f.name);
            for b in &f.blocks { println!("  block {:#x} ({} instr) {:?}{}", b.start, b.code.len(), b.exit, if p.entries.contains_key(&b.start) { "  [entry]" } else { "" }); }
        }
    }
}
