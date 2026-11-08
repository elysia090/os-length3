// A Rust program using std the way l3 does: arguments, environment, files,
// directories, renames, collections, formatting, and a panic-free exit code.
use std::collections::{BTreeMap, HashMap};
use std::fs;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    println!("args {args:?}");
    let dir = format!("/tmp/xlat-rust-{}", args.join("-"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(format!("{dir}/issue")).unwrap();
    for n in 1..=3 {
        fs::write(format!("{dir}/issue/{n:03}.md"), format!("Fix：件名 {n}\n")).unwrap();
    }
    fs::rename(format!("{dir}/issue/002.md"), format!("{dir}/issue/009.md")).unwrap();
    let mut names: Vec<String> = fs::read_dir(format!("{dir}/issue")).unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    println!("files {names:?}");
    let text = fs::read_to_string(format!("{dir}/issue/009.md")).unwrap();
    println!("read {:?} {} chars", text.trim(), text.chars().count());
    let mut counts: HashMap<char, usize> = HashMap::new();
    for c in "length3 os".chars() { *counts.entry(c).or_default() += 1; }
    let sorted: BTreeMap<char, usize> = counts.into_iter().collect();
    println!("counts {sorted:?}");
    let mut v: Vec<i64> = (0..2000).map(|i| (i * 7919) % 1009 - 500).collect();
    v.sort_unstable();
    v.dedup();
    println!("sorted {} first {} last {} sum {}", v.len(), v[0], v[v.len() - 1], v.iter().sum::<i64>());
    println!("float {:.3} {:e}", 2f64.sqrt() * 1e3, 12345.678f64);
    fs::remove_dir_all(&dir).unwrap();
    std::process::exit(if names.len() == 3 { 0 } else { 3 });
}
