//! Content identity for translations. No image, terminal, storage or product policy.
use sha2::{Digest as _, Sha256};

pub type Digest = [u8; 32];
pub fn digest(bytes: &[u8]) -> Digest { Sha256::digest(bytes).into() }

pub const DEFAULT_DISCOVERY_BUDGET: u64 = 1000;
#[derive(Clone, Copy, Debug)]
pub struct Profile { pub shared: bool, pub trace: bool, pub run_blocks: u32, pub discover_budget: u64 }
impl Default for Profile {
    fn default()->Self { Self{shared:false,trace:false,run_blocks:0,discover_budget:DEFAULT_DISCOVERY_BUDGET} }
}

#[derive(Clone, Copy, Debug)]
pub enum Mode<'a> {
    Entry,
    Whole,
    Seeded(&'a [u64]),
    More { seeds: &'a [u64], known: &'a [u64], base: u32 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct Key(Digest);
impl Key {
    /// Digests of the exact input ELF and translator binary; every output-affecting option is mandatory here.
    pub fn new(elf: Digest, translator: Digest, profile: Profile, mode: Mode<'_>) -> Self {
        let mut h = Sha256::new();
        h.update(b"sods-translation-v1\0");
        // Preparation and the execution ABI affect whether the same wasm can be reused.
        h.update(digest(include_bytes!("abi.rs")));
        h.update(digest(include_bytes!("../runtime/share.ts")));
        h.update(elf); h.update(translator);
        h.update([profile.shared as u8, profile.trace as u8]);
        h.update(profile.run_blocks.to_le_bytes());
        h.update(profile.discover_budget.to_le_bytes());
        let mut words = |tag: u8, xs: &[u64]| {
            h.update([tag]); h.update((xs.len() as u64).to_le_bytes());
            for x in xs { h.update(x.to_le_bytes()); }
        };
        match mode {
            Mode::Entry => h.update([0]),
            Mode::Whole => h.update([1]),
            Mode::Seeded(seeds) => words(2, seeds),
            Mode::More { seeds, known, base } => {
                words(3, seeds); words(4, known); h.update(base.to_le_bytes());
            }
        }
        Self(h.finalize().into())
    }
    pub fn bytes(&self) -> &Digest { &self.0 }
    pub fn hex(&self) -> [u8; 64] {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = [0; 64];
        for (i, byte) in self.0.iter().enumerate() {
            out[2*i] = HEX[(byte >> 4) as usize]; out[2*i+1] = HEX[(byte & 15) as usize];
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_translation_input_separates_keys() {
        let key = |elf, compiler, p, mode| Key::new(elf, compiler, p, mode);
        let (a,b,p)=(digest(b"elf"),digest(b"compiler"),Profile::default());
        let original=key(a,b,p,Mode::Entry);
        for different in [key(digest(b"other"),b,p,Mode::Entry), key(a,digest(b"other"),p,Mode::Entry),
            key(a,b,Profile{shared:true,..p},Mode::Entry), key(a,b,Profile{trace:true,..p},Mode::Entry),
            key(a,b,Profile{run_blocks:2,..p},Mode::Entry), key(a,b,Profile{discover_budget:3,..p},Mode::Entry), key(a,b,p,Mode::Whole),
            key(a,b,p,Mode::Seeded(&[1])), key(a,b,p,Mode::More{seeds:&[1],known:&[2],base:0}),
            key(a,b,p,Mode::More{seeds:&[],known:&[1,2],base:0})] { assert_ne!(original,different); }
        assert_ne!(key(a,b,p,Mode::More{seeds:&[1],known:&[2],base:0}),key(a,b,p,Mode::More{seeds:&[1],known:&[2],base:1}));
    }
}
