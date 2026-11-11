//! cargo run --example dump -- ELF ADDRESS: the function holding ADDRESS as discover sees it.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&a[1]).unwrap();
    let elf = sods::elf::Elf::parse(&bytes).unwrap();
    let at = u64::from_str_radix(a[2].trim_start_matches("0x"), 16).unwrap();
    let p = sods::find::discover(&elf);
    for f in &p.functions {
        if f.blocks.iter().any(|b| b.start <= at && at < b.end()) {
            println!("function {:#x} {}", f.start, f.shown(&mut String::new()));
            for b in &f.blocks { println!("  block {:#x} ({} instr) {:?}{}", b.start, b.count, b.exit, if p.entries.contains_key(&b.start) { "  [entry]" } else { "" }); }
        }
    }
}
