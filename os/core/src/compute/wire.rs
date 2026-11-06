//! What a host and its guest say to each other over the VM's vsock: frames, each a kind (one byte), a length (four,
//! big-endian) and that many bytes. The host gives the run (its Spec, as JSON); the guest says what it prints, as
//! it prints it, then the repo's files as the run left them (a tar stream), then its exit code. A frame larger than
//! FRAME is no frame: the line is let go.

use std::io::{self, Read, Write};

/// The most one frame may hold.
pub const FRAME: usize = 64 << 20;
/// The port a guest's agent connects to on its host (CID 2).
pub const PORT: u32 = 1024;

#[derive(Debug, PartialEq)]
pub enum Frame {
    /// Host to guest: the run (compute/spec.rs Spec, JSON).
    Spec(Vec<u8>),
    /// Guest to host: what the run printed to standard output, and to standard error.
    Out(Vec<u8>),
    Err(Vec<u8>),
    /// Guest to host: the repo as the run left it, a tar stream.
    Files(Vec<u8>),
    /// Guest to host: the run's exit code; the last frame.
    Exit(i32),
}

impl Frame {
    fn kind(&self) -> u8 {
        match self { Frame::Spec(_) => 1, Frame::Out(_) => 2, Frame::Err(_) => 3, Frame::Files(_) => 4, Frame::Exit(_) => 5 }
    }
}

pub fn write(w: &mut impl Write, f: &Frame) -> io::Result<()> {
    let code;
    let body: &[u8] = match f {
        Frame::Spec(b) | Frame::Out(b) | Frame::Err(b) | Frame::Files(b) => b,
        Frame::Exit(c) => { code = c.to_be_bytes(); &code }
    };
    if body.len() > FRAME { return Err(io::Error::new(io::ErrorKind::InvalidInput, "a frame too large")); }
    let mut head = [0u8; 5];
    head[0] = f.kind();
    head[1..].copy_from_slice(&(body.len() as u32).to_be_bytes());
    w.write_all(&head)?;
    w.write_all(body)?;
    w.flush()
}

/// The next frame, or None at the line's end (between frames).
pub fn read(r: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut head = [0u8; 5];
    match r.read_exact(&mut head) {
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        other => other?,
    }
    let len = u32::from_be_bytes(head[1..].try_into().unwrap()) as usize;
    if len > FRAME { return Err(io::Error::new(io::ErrorKind::InvalidData, "a frame too large")); }
    let mut body = vec![0; len];
    r.read_exact(&mut body)?;
    Ok(Some(match head[0] {
        1 => Frame::Spec(body),
        2 => Frame::Out(body),
        3 => Frame::Err(body),
        4 => Frame::Files(body),
        5 if len == 4 => Frame::Exit(i32::from_be_bytes(body[..].try_into().unwrap())),
        k => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("no frame of kind {k}"))),
    }))
}

#[cfg(test)]
#[path = "tests/wire.rs"]
mod tests;
