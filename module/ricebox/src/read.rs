//! A bundle as it is read: every frame of a zstd stream one after another, and the digest of all that was read,
//! taken as it goes by.

use sha2::{Digest, Sha256};
use std::io::{self, Read};

pub(crate) fn bad(e: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// What is read through it is hashed as it passes: each byte once, on its one way from the file.
pub(crate) struct Hashed<R: Read> {
    inner: R,
    sha: Sha256,
    pub(crate) bytes: u64,
}

impl<R: Read> Hashed<R> {
    pub(crate) fn new(inner: R) -> Hashed<R> { Hashed { inner, sha: Sha256::new(), bytes: 0 } }

    /// The sha256 of all that was read, once what is left has been read too: the whole file's.
    pub(crate) fn finish(mut self) -> io::Result<(String, u64)> {
        let mut rest = vec![0u8; 1 << 16];
        while self.read(&mut rest)? > 0 {}
        Ok((hex(&self.sha.finalize()), self.bytes))
    }
}

impl<R: Read> Read for Hashed<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(out)?;
        self.sha.update(&out[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes { out.push(HEX[(b >> 4) as usize] as char); out.push(HEX[(b & 15) as usize] as char); }
    out
}

/// A file's sha256 and length, read through `file` (which is left at its end): what a bundle is, where it is not
/// yet known which root it is to be.
pub fn digest_of(file: impl Read) -> io::Result<(String, u64)> {
    Hashed::new(file).finish()
}

type Decoder<R> = ruzstd::decoding::StreamingDecoder<io::BufReader<R>, ruzstd::decoding::FrameDecoder>;

/// Every frame of a zstd stream, one after another.
pub(crate) struct Frames<R: Read> {
    inner: Option<Decoder<R>>,
}

impl<R: Read> Frames<R> {
    pub(crate) fn new(source: R) -> io::Result<Frames<R>> {
        Ok(Frames { inner: Some(Decoder::new(io::BufReader::with_capacity(1 << 20, source)).map_err(bad)?) })
    }
}

impl<R: Read> Read for Frames<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        loop {
            let Some(d) = self.inner.as_mut() else { return Ok(0) };
            let n = d.read(out)?;
            if n > 0 || out.is_empty() { return Ok(n); }
            // This frame is done: the next one, if more follows.
            let Some(done) = self.inner.take() else { return Ok(0) };
            let (mut source, decoder) = done.into_parts();
            if io::BufRead::fill_buf(&mut source)?.is_empty() { return Ok(0); }
            self.inner = Some(ruzstd::decoding::StreamingDecoder::new_with_decoder(source, decoder).map_err(bad)?);
        }
    }
}
