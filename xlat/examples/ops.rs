//! cargo run --release --example ops -- WASM NAME: the operators of each function whose name holds NAME, one a line
//! (what the translation made of a guest function: its calls, its register traffic, its checks).
use wasmparser::{KnownCustom, Name, Parser, Payload};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&a[1]).unwrap();
    let want = &a[2];
    let mut names = std::collections::HashMap::new();
    let mut imported = 0u32;
    let mut bodies = Vec::new();
    for payload in Parser::new(0).parse_all(&bytes) {
        match payload.unwrap() {
            Payload::ImportSection(r) => {
                for i in r.into_imports() {
                    if matches!(i.unwrap().ty, wasmparser::TypeRef::Func(_)) { imported += 1; }
                }
            }
            Payload::CodeSectionEntry(body) => bodies.push(body),
            Payload::CustomSection(c) => {
                if let KnownCustom::Name(r) = c.as_known() {
                    for n in r {
                        if let Ok(Name::Function(map)) = n {
                            for naming in map { let naming = naming.unwrap(); names.insert(naming.index, naming.name.to_string()); }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    for (k, body) in bodies.iter().enumerate() {
        let index = imported + k as u32;
        let name = names.get(&index).cloned().unwrap_or_default();
        if !name.contains(want.as_str()) { continue; }
        let ops: Vec<String> = body.get_operators_reader().unwrap().into_iter().map(|o| format!("{:?}", o.unwrap())).collect();
        println!("== {name} (function {index}): {} operators", ops.len());
        for o in ops { println!("  {o}"); }
    }
}
