//! Private initial x86-64 stack construction, not execve or credential policy.
//! Byte inputs avoid the old TS UTF-8 join/NUL-rescan. Execfn is independent of
//! argv[0], and aux credentials are supplied by the authoritative exec decision.
//! Empty argv becomes one empty argument. This fixed wasm32 profile has explicit
//! budgets; it does not reproduce Linux RLIMIT_STACK/ARG_MAX, ASLR or guard pages.
//! Only the live suffix is allocated/initialized, never the whole stack region.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    Nul,
    EmptyPath,
    Random,
    Range,
    Overflow,
    Limit,
    Capacity,
}
#[derive(Debug, Clone, Copy)]
pub(crate) struct Facts {
    pub entry: u64,
    pub phdr: u64,
    pub phent: u64,
    pub phnum: u64,
}
#[derive(Debug, Clone, Copy)]
pub(crate) struct Credentials {
    pub uid: u32,
    pub euid: u32,
    pub gid: u32,
    pub egid: u32,
    pub secure: bool,
}
#[derive(Debug, Clone, Copy)]
pub(crate) struct Region {
    pub low: u64,
    pub top: u64,
    pub extent: u64,
}
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    /// Per string, including its terminating NUL (also execfn).
    pub max_string_bytes: u64,
    /// All strings plus NULs, including execfn and normalized empty argv[0].
    pub max_input_bytes: u64,
    /// argv + env pointer count, excluding fixed terminators and auxv.
    pub max_pointers: u64,
}
pub(crate) struct Input<'a> {
    pub execfn: &'a [u8],
    pub argv: &'a [&'a [u8]],
    pub env: &'a [&'a [u8]],
    pub facts: Facts,
    pub credentials: Credentials,
    pub random: &'a [u8],
    pub region: Region,
    pub limits: Limits,
}
#[derive(Debug)]
pub(crate) struct Stack {
    pub pointer: u64,
    pub bytes: Vec<u8>,
}
const AUX_PAIRS: u64 = 13;
fn add(a: u64, b: u64) -> Result<u64, Error> {
    a.checked_add(b).ok_or(Error::Overflow)
}
fn mul(a: u64, b: u64) -> Result<u64, Error> {
    a.checked_mul(b).ok_or(Error::Overflow)
}
fn sub(a: u64, b: u64) -> Result<u64, Error> {
    a.checked_sub(b).ok_or(Error::Range)
}
fn string_size(s: &[u8], limits: Limits) -> Result<u64, Error> {
    if s.contains(&0) {
        return Err(Error::Nul);
    }
    let n = add(u64::try_from(s.len()).map_err(|_| Error::Overflow)?, 1)?;
    if n > limits.max_string_bytes {
        return Err(Error::Limit);
    }
    Ok(n)
}
/// Preflight all caller input and arithmetic before allocating output. The output
/// owns bytes and contains absolute guest pointers; the host only copies it at
/// `pointer`. Entropy generation and physical memory lifetime are host duties.
pub(crate) fn build(input: Input<'_>) -> Result<Stack, Error> {
    let Input {
        execfn,
        argv,
        env,
        facts,
        credentials: c,
        random,
        region: r,
        limits,
    } = input;
    if execfn.is_empty() {
        return Err(Error::EmptyPath);
    }
    if random.len() != 16 {
        return Err(Error::Random);
    }
    if r.low >= r.top || r.top > r.extent || r.extent > 1u64 << 32 {
        return Err(Error::Range);
    }
    if facts.entry >= r.extent
        || facts.phdr > r.extent
        || add(facts.phdr, mul(facts.phent, facts.phnum)?)? > r.extent
    {
        return Err(Error::Range);
    }
    let argc = u64::try_from(argv.len().max(1)).map_err(|_| Error::Overflow)?;
    let envc = u64::try_from(env.len()).map_err(|_| Error::Overflow)?;
    let pointers = add(argc, envc)?;
    if pointers > limits.max_pointers {
        return Err(Error::Limit);
    }
    let mut strings = string_size(execfn, limits)?;
    if argv.is_empty() {
        strings = add(strings, string_size(b"", limits)?)?;
    }
    for s in argv.iter().chain(env.iter()) {
        strings = add(strings, string_size(s, limits)?)?;
    }
    if strings > limits.max_input_bytes {
        return Err(Error::Limit);
    }
    let strings_at = sub(r.top, strings)?;
    let random_at = sub(strings_at, 16)?;
    let words = add(add(pointers, 3)?, mul(AUX_PAIRS, 2)?)?;
    let pointer = sub(random_at, mul(words, 8)?)? & !15u64;
    if pointer < r.low {
        return Err(Error::Range);
    }
    let length = usize::try_from(sub(r.top, pointer)?).map_err(|_| Error::Overflow)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| Error::Capacity)?;
    bytes.resize(length, 0);
    let mut word_at = 0usize;
    fn word(bytes: &mut [u8], at: &mut usize, value: u64) {
        bytes[*at..*at + 8].copy_from_slice(&value.to_le_bytes());
        *at += 8;
    }
    fn string(bytes: &mut [u8], base: u64, cursor: &mut u64, s: &[u8]) -> u64 {
        let address = *cursor;
        let at = (address - base) as usize;
        bytes[at..at + s.len()].copy_from_slice(s);
        *cursor += s.len() as u64 + 1; // preflight proved all bounds; NUL already zero
        address
    }
    let mut cursor = strings_at;
    word(&mut bytes, &mut word_at, argc);
    if argv.is_empty() {
        let at = string(&mut bytes, pointer, &mut cursor, b"");
        word(&mut bytes, &mut word_at, at);
    } else {
        for s in argv {
            let at = string(&mut bytes, pointer, &mut cursor, s);
            word(&mut bytes, &mut word_at, at);
        }
    }
    word(&mut bytes, &mut word_at, 0);
    for s in env {
        let at = string(&mut bytes, pointer, &mut cursor, s);
        word(&mut bytes, &mut word_at, at);
    }
    word(&mut bytes, &mut word_at, 0);
    let exec = string(&mut bytes, pointer, &mut cursor, execfn);
    let aux = [
        (3, facts.phdr),
        (4, facts.phent),
        (5, facts.phnum),
        (6, 4096),
        (9, facts.entry),
        (11, c.uid as u64),
        (12, c.euid as u64),
        (13, c.gid as u64),
        (14, c.egid as u64),
        (23, u64::from(c.secure)),
        (25, random_at),
        (31, exec),
        (0, 0),
    ];
    for (key, value) in aux {
        word(&mut bytes, &mut word_at, key);
        word(&mut bytes, &mut word_at, value);
    }
    let at = (random_at - pointer) as usize;
    bytes[at..at + 16].copy_from_slice(random);
    debug_assert_eq!(cursor, r.top);
    Ok(Stack { pointer, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input<'a>(argv: &'a [&'a [u8]], env: &'a [&'a [u8]]) -> Input<'a> {
        Input {
            execfn: b"/bin/prog",
            argv,
            env,
            facts: Facts {
                entry: 4096,
                phdr: 64,
                phent: 56,
                phnum: 2,
            },
            credentials: Credentials {
                uid: 11,
                euid: 12,
                gid: 13,
                egid: 14,
                secure: true,
            },
            random: &[7; 16],
            region: Region {
                low: 8192,
                top: 16384,
                extent: 16384,
            },
            limits: Limits {
                max_string_bytes: 1024,
                max_input_bytes: 4096,
                max_pointers: 128,
            },
        }
    }
    fn word(s: &Stack, index: usize) -> u64 {
        u64::from_le_bytes(s.bytes[index * 8..index * 8 + 8].try_into().unwrap())
    }
    fn text(s: &Stack, address: u64) -> &[u8] {
        let b = &s.bytes[(address - s.pointer) as usize..];
        &b[..b.iter().position(|b| *b == 0).unwrap()]
    }
    #[test]
    fn bytes_order_aux_and_independent_execfn() {
        let s = build(input(&[b"alias", &[255]], &[b"A=1", b"A=2", b""])).unwrap();
        assert_eq!(s.pointer % 16, 0);
        assert_eq!(s.pointer + s.bytes.len() as u64, 16384);
        assert_eq!(word(&s, 0), 2);
        assert_eq!(text(&s, word(&s, 1)), b"alias");
        assert_eq!(text(&s, word(&s, 2)), &[255]);
        assert_eq!(word(&s, 3), 0);
        assert_eq!(text(&s, word(&s, 4)), b"A=1");
        assert_eq!(text(&s, word(&s, 5)), b"A=2");
        assert_eq!(text(&s, word(&s, 6)), b"");
        assert_eq!(word(&s, 7), 0);
        let aux: Vec<_> = (0..13)
            .map(|i| (word(&s, 8 + i * 2), word(&s, 9 + i * 2)))
            .collect();
        assert_eq!(
            &aux[5..10],
            &[(11, 11), (12, 12), (13, 13), (14, 14), (23, 1)]
        );
        assert_eq!(text(&s, aux[11].1), b"/bin/prog");
        let random = (aux[10].1 - s.pointer) as usize;
        assert_eq!(&s.bytes[random..random + 16], &[7; 16]);
        assert_eq!(aux[12], (0, 0));
    }
    #[test]
    fn empty_argv_normalized_and_exact_region_boundary() {
        let s = build(input(&[], &[])).unwrap();
        assert_eq!(word(&s, 0), 1);
        assert_eq!(text(&s, word(&s, 1)), b"");
        let mut i = input(&[], &[]);
        i.region.low = s.pointer;
        assert!(build(i).is_ok());
        let mut i = input(&[], &[]);
        i.region.low = s.pointer + 1;
        assert_eq!(build(i).unwrap_err(), Error::Range);
    }
    #[test]
    fn limits_nul_random_and_overflow_fail_before_output() {
        assert_eq!(build(input(&[b"a\0b"], &[])).unwrap_err(), Error::Nul);
        assert_eq!(build(input(&[], &[b"X\0"])).unwrap_err(), Error::Nul);
        let mut i = input(&[], &[]);
        i.execfn = b"";
        assert_eq!(build(i).unwrap_err(), Error::EmptyPath);
        let mut i = input(&[], &[]);
        i.execfn = b"/a\0";
        assert_eq!(build(i).unwrap_err(), Error::Nul);
        let mut i = input(&[], &[]);
        i.random = &[0; 15];
        assert_eq!(build(i).unwrap_err(), Error::Random);
        let mut i = input(&[], &[]);
        i.limits.max_pointers = 0;
        assert_eq!(build(i).unwrap_err(), Error::Limit);
        let mut i = input(&[], &[]);
        i.limits.max_string_bytes = 8;
        assert_eq!(build(i).unwrap_err(), Error::Limit);
        let mut i = input(&[], &[]);
        i.limits.max_input_bytes = 9;
        assert_eq!(build(i).unwrap_err(), Error::Limit);
        let mut i = input(&[], &[]);
        i.facts.phent = u64::MAX;
        assert_eq!(build(i).unwrap_err(), Error::Overflow);
        let mut i = input(&[], &[]);
        i.region.top = u64::MAX;
        assert_eq!(build(i).unwrap_err(), Error::Range);
    }
    #[test]
    fn high_addresses_are_unsigned_and_suffix_stays_small() {
        let mut i = input(&[b"x"], &[]);
        i.region = Region {
            low: 0xffff0000,
            top: 1u64 << 32,
            extent: 1u64 << 32,
        };
        let s = build(i).unwrap();
        assert!(s.pointer > i32::MAX as u64);
        assert!(word(&s, 1) > i32::MAX as u64);
        assert!(s.bytes.len() < 512);
        assert_eq!(s.pointer % 16, 0);
    }
}

/// Private diagnostic wire budget, not Linux ARG_MAX.
pub(crate) const MAX_WIRE_BYTES: usize = 2 * 1024 * 1024;
/// Decode a bounded frame. Header credentials/facts are transport inputs; this
/// parser does not establish their provenance or an exec credential decision.
pub(crate) fn build_wire(bytes: &[u8], expected_extent: u64) -> Result<Stack, Error> {
    if bytes.len() > MAX_WIRE_BYTES {
        return Err(Error::Limit);
    }
    struct Reader<'a> {
        bytes: &'a [u8],
        at: usize,
    }
    impl<'a> Reader<'a> {
        fn take(&mut self, n: u64) -> Result<&'a [u8], Error> {
            let n = usize::try_from(n).map_err(|_| Error::Overflow)?;
            let end = self.at.checked_add(n).ok_or(Error::Overflow)?;
            let data = self.bytes.get(self.at..end).ok_or(Error::Range)?;
            self.at = end;
            Ok(data)
        }
        fn word(&mut self) -> Result<u64, Error> {
            let b = self.take(8)?;
            Ok(u64::from_le_bytes(b.try_into().map_err(|_| Error::Range)?))
        }
        fn string(&mut self) -> Result<&'a [u8], Error> {
            let n = self.word()?;
            self.take(n)
        }
    }
    let mut r = Reader { bytes, at: 0 };
    let mut h = [0u64; 16];
    for word in &mut h {
        *word = r.word()?;
    }
    if h[0] != 1 || h[3] != expected_extent || h[12] > 1 {
        return Err(Error::Range);
    }
    let count = h[13].checked_add(h[14]).ok_or(Error::Overflow)?;
    if count > 65536 {
        return Err(Error::Limit);
    }
    let credential = |n| u32::try_from(n).map_err(|_| Error::Range);
    let credentials = Credentials {
        uid: credential(h[8])?,
        euid: credential(h[9])?,
        gid: credential(h[10])?,
        egid: credential(h[11])?,
        secure: h[12] == 1,
    };
    let random = r.take(16)?;
    let execfn = r.take(h[15])?;
    // Even empty arguments need a length word. Reject truncated framing before
    // reserving reference tables based on attacker-controlled counts.
    if count > ((bytes.len() - r.at) / 8) as u64 {
        return Err(Error::Range);
    }
    let mut argv = Vec::new();
    let mut env = Vec::new();
    argv.try_reserve_exact(h[13] as usize)
        .map_err(|_| Error::Capacity)?;
    env.try_reserve_exact(h[14] as usize)
        .map_err(|_| Error::Capacity)?;
    for _ in 0..h[13] {
        argv.push(r.string()?);
    }
    for _ in 0..h[14] {
        env.push(r.string()?);
    }
    if r.at != bytes.len() {
        return Err(Error::Range);
    }
    build(Input {
        execfn,
        argv: &argv,
        env: &env,
        random,
        credentials,
        facts: Facts {
            entry: h[4],
            phdr: h[5],
            phent: h[6],
            phnum: h[7],
        },
        region: Region {
            low: h[1],
            top: h[2],
            extent: h[3],
        },
        limits: Limits {
            max_string_bytes: 128 * 1024,
            max_input_bytes: MAX_WIRE_BYTES as u64,
            max_pointers: 65536,
        },
    })
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    fn wire() -> Vec<u8> {
        let h: [u64; 16] = [
            1, 4096, 65536, 65536, 128, 64, 56, 1, 0, 0, 0, 0, 0, 1, 0, 2,
        ];
        let mut b: Vec<u8> = h.iter().flat_map(|x| x.to_le_bytes()).collect();
        b.extend([7; 16]);
        b.extend(b"/x");
        b.extend(1u64.to_le_bytes());
        b.extend(b"x");
        b
    }
    #[test]
    fn exact_wire_and_extent() {
        let b = wire();
        let s = build_wire(&b, 65536).unwrap();
        assert_eq!(s.pointer % 16, 0);
        assert!(build_wire(&b, 131072).is_err());
        let mut extra = b.clone();
        extra.push(0);
        assert!(build_wire(&extra, 65536).is_err());
        for n in 0..b.len() {
            assert!(build_wire(&b[..n], 65536).is_err());
        }
    }
    #[test]
    fn rejects_bad_header_lengths_credentials_and_nul() {
        for (at, value) in [
            (0, 2u64),
            (8, 1u64 << 32),
            (12, 2),
            (13, 65537),
            (15, u64::MAX),
        ] {
            let mut b = wire();
            b[at * 8..at * 8 + 8].copy_from_slice(&value.to_le_bytes());
            assert!(build_wire(&b, 65536).is_err());
        }
        let mut b = wire();
        *b.last_mut().unwrap() = 0;
        assert_eq!(build_wire(&b, 65536).unwrap_err(), Error::Nul);
        assert_eq!(
            build_wire(&vec![0; MAX_WIRE_BYTES + 1], 65536).unwrap_err(),
            Error::Limit
        );
    }
}
