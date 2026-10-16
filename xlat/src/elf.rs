//! Just enough ELF64 to translate a static x86-64 executable: loadable
//! segments, the entry point, function symbols and the relocations that name
//! code addresses stored in data: those kept by `--emit-relocs`, or, for a
//! static position-independent executable (static-pie, as the distribution
//! builds them), its own R_X86_64_RELATIVE relocations. A static-pie is
//! placed at `PIE_BASE`, where its startup code (musl's _dlstart) finds
//! itself and applies those relocations as on Linux.

use std::fmt;

#[derive(Debug)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

fn err<T>(message: impl Into<String>) -> Result<T, Error> {
    Err(Error(message.into()))
}

#[derive(Clone, Debug)]
pub struct Segment {
    pub offset: u64,
    pub vaddr: u64,
    pub memsz: u64,
    pub data: Vec<u8>,
    pub executable: bool,
    pub writable: bool,
}

#[derive(Clone, Debug)]
pub struct Symbol {
    pub name: String,
    pub value: u64,
    pub size: u64,
    pub function: bool,
}

#[derive(Debug)]
pub struct Elf {
    pub entry: u64,
    pub segments: Vec<Segment>,
    pub symbols: Vec<Symbol>,
    /// Absolute targets of relocations: every place the link stored an address.
    pub relocation_targets: Vec<u64>,
    /// Loaded addresses holding a 32-bit PC-relative value: the entries of
    /// position-relative jump tables, among others.
    pub relative_slots: Vec<u64>,
    /// Thread-local template, if the program has one.
    pub tls: Option<Tls>,
    pub phoff: u64,
    pub phnum: u64,
}

#[derive(Clone, Debug)]
pub struct Tls {
    pub vaddr: u64,
    pub filesz: u64,
    pub memsz: u64,
    pub align: u64,
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn bytes(&self, at: u64, n: u64) -> Result<&[u8], Error> {
        let start = usize::try_from(at).map_err(|_| Error("offset".into()))?;
        // try_from, not `as`: on wasm32 a 64-bit size must not wrap to a small one.
        let n = usize::try_from(n).map_err(|_| Error("size".into()))?;
        let end = start.checked_add(n).ok_or_else(|| Error("offset overflow".into()))?;
        self.0.get(start..end).ok_or_else(|| Error(format!("truncated at {at:#x}+{n:#x}")))
    }
    fn u16(&self, at: u64) -> Result<u16, Error> {
        Ok(u16::from_le_bytes(self.bytes(at, 2)?.try_into().unwrap()))
    }
    fn u32(&self, at: u64) -> Result<u32, Error> {
        Ok(u32::from_le_bytes(self.bytes(at, 4)?.try_into().unwrap()))
    }
    fn u64(&self, at: u64) -> Result<u64, Error> {
        Ok(u64::from_le_bytes(self.bytes(at, 8)?.try_into().unwrap()))
    }
}

/// Where a static-pie is loaded: where a non-PIE x86-64 program starts, so
/// the first page stays unmapped and a null pointer still faults.
pub const PIE_BASE: u64 = 0x40_0000;

const PT_LOAD: u32 = 1;
const PT_INTERP: u32 = 3;
const PT_TLS: u32 = 7;
const SHT_SYMTAB: u32 = 2;
const SHT_RELA: u32 = 4;
const STT_FUNC: u8 = 2;
const STT_TLS: u8 = 6;
const SHN_ABS: u16 = 0xfff1;
const R_X86_64_RELATIVE: u32 = 8;
const R_X86_64_IRELATIVE: u32 = 37;
const SHF_ALLOC: u64 = 2;

impl Elf {
    pub fn parse(file: &[u8]) -> Result<Elf, Error> {
        let r = Reader(file);
        if r.bytes(0, 4)? != b"\x7fELF" {
            return err("not an ELF file");
        }
        if r.bytes(4, 2)? != [2, 1] {
            return err("not a little-endian ELF64 file");
        }
        if r.u16(18)? != 62 {
            return err("not an x86-64 ELF file");
        }
        // ET_EXEC, or ET_DYN without an interpreter (static-pie; checked below).
        let pie = match r.u16(16)? {
            2 => false,
            3 => true,
            _ => return err("not an executable"),
        };
        let base = if pie { PIE_BASE } else { 0 };
        let entry = r.u64(24)?.wrapping_add(base);
        let (phoff, shoff) = (r.u64(32)?, r.u64(40)?);
        let (phentsize, phnum) = (r.u16(54)? as u64, r.u16(56)? as u64);
        let (shentsize, shnum) = (r.u16(58)? as u64, r.u16(60)? as u64);

        let mut segments = Vec::new();
        let mut tls = None;
        let row = |base: u64, i: u64, size: u64| i.checked_mul(size).and_then(|o| base.checked_add(o)).ok_or_else(|| Error("header table overflow".into()));
        for i in 0..phnum {
            let at = row(phoff, i, phentsize)?;
            let kind = r.u32(at)?;
            let flags = r.u32(at + 4)?;
            let (offset, vaddr, filesz, memsz, align) =
                (r.u64(at + 8)?, r.u64(at + 16)?, r.u64(at + 32)?, r.u64(at + 40)?, r.u64(at + 48)?);
            match kind {
                PT_INTERP => return err("dynamically linked; only static executables are translated"),
                PT_LOAD if filesz > memsz || vaddr.checked_add(base).and_then(|v| v.checked_add(memsz)).is_none_or(|end| end > 1 << 47) =>
                    return err("a loadable segment does not fit the address space"),
                PT_LOAD => segments.push(Segment {
                    offset,
                    vaddr: vaddr + base,
                    memsz,
                    data: r.bytes(offset, filesz)?.to_vec(),
                    executable: flags & 1 != 0,
                    writable: flags & 2 != 0,
                }),
                PT_TLS => tls = Some(Tls { vaddr: vaddr.wrapping_add(base), filesz, memsz, align: align.max(1) }),
                _ => {}
            }
        }

        let mut symbols = Vec::new();
        let mut relocation_targets = Vec::new();
        let mut relative_slots = Vec::new();
        for i in 0..shnum {
            let at = row(shoff, i, shentsize)?;
            let kind = r.u32(at + 4)?;
            let (offset, size, link, entsize) = (r.u64(at + 24)?, r.u64(at + 32)?, r.u32(at + 40)?, r.u64(at + 56)?);
            if kind == SHT_SYMTAB && entsize >= 24 {
                let strtab = row(shoff, link as u64, shentsize)?;
                let (str_off, str_size) = (r.u64(strtab + 24)?, r.u64(strtab + 32)?);
                let strings = r.bytes(str_off, str_size)?;
                for s in 0..size / entsize {
                    let e = row(offset, s, entsize)?;
                    let name_at = r.u32(e)? as usize;
                    let info = r.bytes(e + 4, 1)?[0];
                    let shndx = r.u16(e + 6)?;
                    let (value, sym_size) = (r.u64(e + 8)?, r.u64(e + 16)?);
                    if shndx == 0 || value == 0 {
                        continue;
                    }
                    // Absolute values and thread-local offsets are not addresses in the image.
                    let value = if shndx == SHN_ABS || info & 0xf == STT_TLS { value } else { value.wrapping_add(base) };
                    let name = strings.get(name_at..).and_then(|s| s.split(|&b| b == 0).next()).unwrap_or(&[]);
                    symbols.push(Symbol {
                        name: String::from_utf8_lossy(name).into_owned(),
                        value,
                        size: sym_size,
                        function: info & 0xf == STT_FUNC,
                    });
                }
            }
            // A static-pie's own relocations (.rela.dyn, loaded with it):
            // each RELATIVE one stores base + addend, a pointer into the image;
            // an IRELATIVE one names an ifunc resolver.
            let dynamic = pie && kind == SHT_RELA && r.u64(at + 8)? & SHF_ALLOC != 0;
            if dynamic && entsize >= 24 {
                for e in 0..size / entsize {
                    let rel = row(offset, e, entsize)?;
                    let kind = (r.u64(rel + 8)? & 0xffff_ffff) as u32;
                    if matches!(kind, R_X86_64_RELATIVE | R_X86_64_IRELATIVE) {
                        relocation_targets.push((r.u64(rel + 16)? as i64 as u64).wrapping_add(base));
                    }
                }
                continue;
            }
            // Only relocations of loaded sections describe the image; debug
            // sections relocate offsets that merely look like addresses.
            let loaded = kind == SHT_RELA && {
                let applies_to = r.u32(at + 44)? as u64;
                applies_to < shnum && r.u64(row(shoff, applies_to, shentsize)? + 8)? & SHF_ALLOC != 0
            };
            if kind == SHT_RELA && entsize >= 24 && loaded {
                // With --emit-relocs the symbol index refers to the static
                // symtab; S + A is the stored address for absolute kinds.
                let symtab = row(shoff, link as u64, shentsize)?;
                let (sym_off, sym_ent) = (r.u64(symtab + 24)?, r.u64(symtab + 56)?.max(24));
                for e in 0..size / entsize {
                    let rel = row(offset, e, entsize)?;
                    let info = r.u64(rel + 8)?;
                    let addend = r.u64(rel + 16)? as i64;
                    let (sym, kind) = (info >> 32, (info & 0xffff_ffff) as u32);
                    let place = r.u64(rel)?.wrapping_add(base);
                    if kind == 2 {
                        relative_slots.push(place);
                        continue;
                    }
                    // R_X86_64_64, _32, _32S store absolute addresses.
                    if !matches!(kind, 1 | 10 | 11) {
                        continue;
                    }
                    let value = if sym == 0 { 0 } else { r.u64(sym_off + sym * sym_ent + 8)?.wrapping_add(base) };
                    relocation_targets.push(value.wrapping_add(addend as u64));
                }
            }
        }
        relocation_targets.sort_unstable();
        relocation_targets.dedup();
        relative_slots.sort_unstable();
        relative_slots.dedup();
        let mut elf = Elf { entry, segments, symbols, relocation_targets, relative_slots, tls, phoff, phnum };
        // Slots inside code are rip-relative operands, not data tables.
        let slots = std::mem::take(&mut elf.relative_slots);
        elf.relative_slots = slots.into_iter().filter(|&p| !elf.is_code(p) && elf.read_i32(p).is_some()).collect();
        Ok(elf)
    }

    /// Where the program headers are mapped, which static libc startup reads
    /// through AT_PHDR to find its TLS template.
    pub fn phdr_address(&self) -> Option<u64> {
        self.segments.iter()
            .find(|s| self.phoff >= s.offset && self.phoff < s.offset + s.data.len() as u64)
            .map(|s| s.vaddr + (self.phoff - s.offset))
    }

    /// The 32-bit value stored at a loaded address, if initialized there.
    pub fn read_i32(&self, address: u64) -> Option<i32> {
        let s = self.segments.iter().find(|s| address >= s.vaddr && address + 4 <= s.vaddr + s.data.len() as u64)?;
        let at = (address - s.vaddr) as usize;
        Some(i32::from_le_bytes(s.data[at..at + 4].try_into().unwrap()))
    }

    pub fn is_code(&self, address: u64) -> bool {
        self.segments.iter().any(|s| s.executable && address >= s.vaddr && address < s.vaddr + s.data.len() as u64)
    }

    /// Bytes of executable code starting at `address`, up to the segment end.
    pub fn code_at(&self, address: u64) -> Option<&[u8]> {
        self.segments.iter().find(|s| s.executable && address >= s.vaddr && address < s.vaddr + s.data.len() as u64)
            .map(|s| &s.data[(address - s.vaddr) as usize..])
    }
}
