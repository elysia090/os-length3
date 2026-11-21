use sods::cache::{Cache,Entry};
use sods::identity::{digest,Key,Mode,Profile};
use std::{hint::black_box,time::Instant};
#[no_mangle]
#[inline(never)]
pub fn sods_cached_hit(entry:&Entry)->Option<&[u8]> {entry.cached()}
fn main(){
    let root=std::env::args().nth(1).expect("bench CACHE_DIRECTORY");let cache=Cache::open(&root).unwrap();
    let key=Key::new(digest(b"bench ELF"),digest(b"bench translator"),Profile::default(),Mode::Entry);
    let entry=cache.entry(key);entry.get_or_try_insert(||Ok(vec![7;4096])).unwrap();
    for sample in 0..9 {
        for borrowed in if sample%2==0 {[false,true]}else{[true,false]} {
            let n=2_000_000;let start=Instant::now();
            for _ in 0..n {if borrowed{black_box(sods_cached_hit(black_box(&entry)));}else{black_box(black_box(&entry).get().unwrap());}}
            println!("{{\"sample\":{sample},\"kind\":\"{}\",\"iterations\":{n},\"ns\":{}}}",if borrowed{"borrowed"}else{"owned"},start.elapsed().as_nanos());
        }
    }
    let n=1000;let start=Instant::now();for _ in 0..n {black_box(cache.entry(key).get().unwrap());}
    println!("{{\"kind\":\"disk_verified\",\"bytes\":4096,\"iterations\":{n},\"ns\":{}}}",start.elapsed().as_nanos());
}
