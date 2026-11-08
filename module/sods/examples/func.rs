//! cargo run --release --example func -- ELF START: the function starting at START (hex), as code reached later sees it, disassembled by block.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let elf = xlat::elf::Elf::parse_owned(std::fs::read(&a[1]).unwrap()).unwrap();
    let start = u64::from_str_radix(a[2].trim_start_matches("0x"), 16).unwrap();
    let p = xlat::discover::discover_within(&elf, &[start], &Default::default(), 0);
    for f in p.functions.iter().filter(|f| f.start == start) {
        println!("function {:#x} {} ({} blocks)", f.start, f.name, f.blocks.len());
        for b in &f.blocks {
            println!("  block {:#x} {:?}{}", b.start, b.exit, if p.entries.contains_key(&b.start) { "  [entry]" } else { "" });
            for i in &b.code { println!("    {:#x}  {:?}", i.ip(), i.mnemonic()); }
        }
    }
}
