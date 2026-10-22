//! cargo run --release --example eager -- ELF: how long a whole translation spends parsing, discovering and lowering.
fn main() {
    let p = std::env::args().nth(1).unwrap();
    let t = std::time::Instant::now();
    let bytes = std::fs::read(&p).unwrap();
    let elf = xlat::elf::Elf::parse(&bytes).unwrap();
    let a = t.elapsed();
    let program = xlat::discover::discover(&elf);
    let b = t.elapsed();
    let out = xlat::lower::translate(&elf, &program, Default::default());
    let c = t.elapsed();
    println!("read+parse {a:?} discover {:?} translate {:?} ({} bytes)", b - a, c - b, out.wasm.len());
}
