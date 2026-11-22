//! The load plan of an ordinary ELF64 x86-64 PIE, interpreter or DSO. This
//! does not select a file, load or link it, or admit it to the static compiler.
use super::{err, Error, Reader, PT_DYNAMIC, PT_INTERP, PT_LOAD};

const HEADER: u64 = 64;
const PHENT: u64 = 56;
const PAGE: u64 = 4096;
const MAX_FILE: usize = 64 << 20;
const PT_PHDR: u32 = 6;
const PT_GNU_STACK: u32 = 0x6474_e551;
const X: u32 = 1;
const W: u32 = 2;
const R: u32 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    Main = 1,
    Interpreter = 2,
    SharedObject = 3,
}

impl Role {
    pub(crate) fn from_wire(role: u32) -> Result<Self, Error> {
        match role {
            1 => Ok(Self::Main),
            2 => Ok(Self::Interpreter),
            3 => Ok(Self::SharedObject),
            _ => err("unknown ELF load role"),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Header {
    kind: u32,
    flags: u32,
    offset: u64,
    vaddr: u64,
    filesz: u64,
    memsz: u64,
    align: u64,
}

impl Header {
    fn read(r: &Reader, at: u64) -> Result<Self, Error> {
        Ok(Self {
            kind: r.u32(at)?,
            flags: r.u32(at + 4)?,
            offset: r.u64(at + 8)?,
            vaddr: r.u64(at + 16)?,
            filesz: r.u64(at + 32)?,
            memsz: r.u64(at + 40)?,
            align: r.u64(at + 48)?,
        })
    }

    /// Guest address corresponding to a complete file-backed interval.
    fn address(self, offset: u64, size: u64) -> Option<u64> {
        let relative = offset.checked_sub(self.offset)?;
        (self.flags & R != 0 && relative.checked_add(size)? <= self.filesz)
            .then(|| self.vaddr + relative)
    }

    fn validate_load(self, r: &Reader) -> Result<(), Error> {
        if self.filesz > self.memsz
            || self.vaddr.checked_add(self.memsz).is_none_or(|end| end > 1 << 32)
            || [self.offset, self.vaddr, self.filesz, self.memsz, self.align]
                .iter().any(|&word| word > u32::MAX.into())
            || self.flags & !(R | W | X) != 0
            || self.flags & (W | X) == W | X
            || self.offset % PAGE != self.vaddr % PAGE
            || self.align > 1 && (!self.align.is_power_of_two() || self.offset % self.align != self.vaddr % self.align)
        {
            return err("invalid or unsupported PT_LOAD");
        }
        r.bytes(self.offset, self.filesz)?;
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct LoadSpec {
    role: Role,
    entry: u64,
    phdr: u64,
    phnum: u64,
    interpreter: Option<String>,
    loads: Vec<Header>,
}

impl LoadSpec {
    pub(crate) fn read(file: &[u8], role: Role) -> Result<Self, Error> {
        let r = Reader(file);
        if file.len() > MAX_FILE
            || r.bytes(0, HEADER)?[..7] != [0x7f, b'E', b'L', b'F', 2, 1, 1]
            || r.u16(16)? != 3
            || r.u16(18)? != 62
            || r.u32(20)? != 1
            || r.u16(52)? as u64 != HEADER
            || r.u16(54)? as u64 != PHENT
        {
            return err("expected an ELF64 x86-64 dynamic object");
        }
        let (entry, phoff, phnum) = (r.u64(24)?, r.u64(32)?, r.u16(56)? as u64);
        let bytes = phnum * PHENT;
        if phoff < HEADER || bytes == 0 || bytes > 65536 {
            return err("invalid ELF program-header table");
        }
        r.bytes(phoff, bytes)?;

        let (mut interpreter, mut dynamic, mut phdr) = (None, None, None);
        let mut loads: Vec<Header> = Vec::new();
        for i in 0..phnum {
            let h = Header::read(&r, phoff + i * PHENT)?;
            match h.kind {
                PT_LOAD => {
                    h.validate_load(&r)?;
                    // This profile has one owner per mapped page. Adjacent
                    // file-backed ranges need not be adjacent in the file.
                    if h.memsz > 0 {
                        if loads.last().is_some_and(|p| {
                            (p.vaddr + p.memsz).next_multiple_of(PAGE) > h.vaddr / PAGE * PAGE
                        }) {
                            return err("overlapping or out-of-order PT_LOAD pages");
                        }
                        loads.push(h);
                    }
                }
                // glibc's libc itself is also directly runnable; its
                // PT_INTERP is not consulted when ld.so maps it as a DSO.
                PT_INTERP if role == Role::SharedObject => {}
                PT_INTERP => {
                    if role != Role::Main || interpreter.is_some() || !(2..=4096).contains(&h.filesz) {
                        return err("invalid or unexpected PT_INTERP");
                    }
                    let path = r.bytes(h.offset, h.filesz)?;
                    if path[0] != b'/' || path[h.filesz as usize - 1] != 0 || path[..path.len() - 1].contains(&0) {
                        return err("expected an absolute, NUL-terminated PT_INTERP path");
                    }
                    interpreter = Some(std::str::from_utf8(&path[..path.len() - 1])
                        .map_err(|_| Error("PT_INTERP is not a UTF-8 path".into()))?.to_owned());
                }
                PT_DYNAMIC => {
                    if dynamic.is_some() { return err("repeated PT_DYNAMIC"); }
                    dynamic = Some(h);
                }
                PT_PHDR => {
                    if phdr.is_some() { return err("repeated PT_PHDR"); }
                    phdr = Some(h);
                }
                PT_GNU_STACK if h.flags & X != 0 => return err("an executable stack is not supported"),
                _ => {}
            }
        }
        if role == Role::Main && interpreter.is_none() { return err("a dynamic PIE needs PT_INTERP"); }
        if !loads.iter().any(|h| h.flags & X != 0 && h.filesz != 0
            && (role == Role::SharedObject || entry >= h.vaddr && entry < h.vaddr + h.filesz)) {
            return err("missing file-backed executable entry or text");
        }

        let program_headers = loads.iter().find_map(|h| h.address(phoff, bytes))
            .ok_or_else(|| Error("program-header table is not fully mapped".into()))?;
        if phdr.is_some_and(|h| h.offset != phoff || h.vaddr != program_headers || h.filesz < bytes || h.memsz < bytes) {
            return err("PT_PHDR does not match the mapped table");
        }
        let dynamic = dynamic.ok_or_else(|| Error("missing PT_DYNAMIC".into()))?;
        if dynamic.filesz < 16 || dynamic.filesz % 16 != 0 || dynamic.filesz > 65536
            || dynamic.memsz < dynamic.filesz
            || !loads.iter().any(|h| h.address(dynamic.offset, dynamic.filesz) == Some(dynamic.vaddr)) {
            return err("PT_DYNAMIC is not a valid file-backed table");
        }
        let mut terminated = false;
        for i in (0..dynamic.filesz).step_by(16) {
            let at = dynamic.offset + i;
            match r.u64(at)? {
                0 => { terminated = true; break; }
                // DT_TEXTREL or DT_FLAGS with DF_TEXTREL. The loader owns all
                // other dependencies, symbols, TLS and relocation semantics.
                22 => return err("text relocations are not supported"),
                30 if r.u64(at + 8)? & 4 != 0 => return err("text relocations are not supported"),
                // DT_FLAGS_1 with DF_1_PIE is an executable, not a library.
                0x6fff_fffb if role == Role::SharedObject && r.u64(at + 8)? & 0x0800_0000 != 0 =>
                    return err("a PIE executable is not a shared library"),
                _ => {}
            }
        }
        if !terminated { return err("unterminated PT_DYNAMIC"); }

        Ok(Self {role, entry: if role == Role::SharedObject { 0 } else { entry },
            phdr: program_headers, phnum, interpreter, loads})
    }

    /// Code visible through one complete, immutable, file-backed RX mapping.
    /// Discovery cannot walk into another segment or use unmapped file data.
    #[cfg(feature = "mapped-code")]
    pub(crate) fn placed_text(
        file: Vec<u8>, role: Role, bias: u64, address: u64, offset: u64, length: u64,
    ) -> Result<super::Elf, Error> {
        use super::{Bytes, Elf, Segment};
        use std::sync::Arc;
        let spec = Self::read(&file, role)?;
        let alignment = spec.loads.iter().map(|h| h.align).max().unwrap_or(PAGE).max(PAGE);
        if bias % alignment != 0 || address < PAGE || length == 0
            || address.checked_add(length).is_none_or(|end| end > 1 << 32)
        {
            return err("mapped text does not fit a biased ELF");
        }
        let h = spec.loads.iter().find(|h| {
            h.flags == R | X && h.offset == offset && h.filesz == length &&
                bias.checked_add(h.vaddr) == Some(address)
        }).ok_or_else(|| Error("executable bytes do not match one file-backed RX segment".into()))?;
        let data = Bytes {file: Arc::new(file), start: h.offset as usize, len: h.filesz as usize};
        Ok(Elf {
            entry: address,
            segments: vec![Segment {offset, vaddr: address, memsz: length, data, executable: true, writable: false}],
            symbols: Vec::new(), relocation_targets: Vec::new(), data_pointers: Vec::new(),
            fixed: false, relative_slots: Vec::new(), tls: None, phoff: 0, phnum: 0, mapped: true,
        })
    }

    /// Versioned little-endian wire data between the translator and the
    /// runtime; no usable guest address until the runtime chooses a bias.
    pub(crate) fn encode(&self) -> Vec<u8> {
        let path = self.interpreter.as_deref().unwrap_or("").as_bytes();
        let mut out = b"SLD1".to_vec();
        let header = [self.role as u32, self.entry as u32, self.phdr as u32, self.phnum as u32,
            self.loads.len() as u32, path.len() as u32];
        for word in header { out.extend(word.to_le_bytes()); }
        for s in &self.loads {
            for word in [s.offset as u32, s.vaddr as u32, s.filesz as u32, s.memsz as u32, s.align as u32, s.flags] {
                out.extend(word.to_le_bytes());
            }
        }
        out.extend(path);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &[u8] = b"/lib64/ld-linux-x86-64.so.2\0";
    const DYNAMIC: usize = 64 + 56;
    const INTERP: usize = 64 + 2 * 56;

    fn u16_at(file: &mut [u8], at: usize, n: u16) { file[at..at + 2].copy_from_slice(&n.to_le_bytes()); }
    fn u32_at(file: &mut [u8], at: usize, n: u32) { file[at..at + 4].copy_from_slice(&n.to_le_bytes()); }
    fn u64_at(file: &mut [u8], at: usize, n: u64) { file[at..at + 8].copy_from_slice(&n.to_le_bytes()); }

    fn fixture() -> Vec<u8> {
        let mut f = vec![0; 4096];
        f[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        u16_at(&mut f, 16, 3);
        u16_at(&mut f, 18, 62);
        u32_at(&mut f, 20, 1);
        u64_at(&mut f, 24, 0x700);
        u64_at(&mut f, 32, 64);
        u16_at(&mut f, 52, 64);
        u16_at(&mut f, 54, 56);
        u16_at(&mut f, 56, 3);
        u32_at(&mut f, 64, PT_LOAD);
        u32_at(&mut f, 68, R | X);
        u64_at(&mut f, 96, 4096);
        u64_at(&mut f, 104, 4096);
        u64_at(&mut f, 112, 4096);
        u32_at(&mut f, DYNAMIC, PT_DYNAMIC);
        for (offset, value) in [(8, 0x600), (16, 0x600), (32, 16), (40, 16)] {
            u64_at(&mut f, DYNAMIC + offset, value);
        }
        u32_at(&mut f, INTERP, PT_INTERP);
        u64_at(&mut f, INTERP + 8, 0x500);
        u64_at(&mut f, INTERP + 32, PATH.len() as u64);
        f[0x500..0x500 + PATH.len()].copy_from_slice(PATH);
        f
    }

    #[test]
    fn main_and_interpreter_roles_do_not_alias_static_admission() {
        let mut file = fixture();
        let main = LoadSpec::read(&file, Role::from_wire(1).unwrap()).unwrap();
        assert_eq!(main.interpreter.as_deref(), Some("/lib64/ld-linux-x86-64.so.2"));
        assert_eq!(main.phdr, 64);
        assert_eq!(&main.encode()[..4], b"SLD1");
        assert!(super::super::Elf::parse(&file).is_err());
        assert!(LoadSpec::read(&file, Role::Interpreter).is_err());
        u16_at(&mut file, 56, 2);
        assert!(LoadSpec::read(&file, Role::Main).is_err());
        assert_eq!(LoadSpec::read(&file, Role::Interpreter).unwrap().entry, 0x700);
        assert_eq!(LoadSpec::read(&file, Role::SharedObject).unwrap().entry, 0);
    }

    #[test]
    fn malformed_or_incompatible_ordinary_metadata_is_rejected() {
        let mut file = fixture();
        assert!(LoadSpec::read(&file[..130], Role::Main).is_err());
        file[0x500] = b'l';
        assert!(LoadSpec::read(&file, Role::Main).is_err());
        file[0x500] = b'/';
        u32_at(&mut file, 68, R | W | X);
        assert!(LoadSpec::read(&file, Role::Main).is_err());
        u32_at(&mut file, 68, R | X);
        u64_at(&mut file, 0x600, 22);
        assert!(LoadSpec::read(&file, Role::Main).is_err());
        u64_at(&mut file, 0x600, 0);
        u64_at(&mut file, 24, 4096);
        assert!(LoadSpec::read(&file, Role::Main).is_err());
    }
}
