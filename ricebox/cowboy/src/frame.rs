//! What goes over a relay. One line of where to, in letters anyone reads: the name (or the address, in dots) and
//! the port, `example.org:443\n`. One byte back: 0, the link is made; else why not, as Linux numbers it (111
//! refused, 101 no way there, 110 no answer in time, 113 no such host). Then nothing but the bytes, each way, as
//! they come: no length, no kind, no number of a stream (a relay's connection carries one link). What is said over
//! it is sealed between the box and the host it reaches (TLS, SSH), and a relay reads none of it.

use crate::route::Way;

/// The longest a first line is: a name of 253 bytes, a colon, a port's five digits, the end of the line.
pub const LINE: usize = 253 + 1 + 5 + 1;

/// The first line of a link `way` at `port`, written into `out`: how long it is (0: no room).
pub fn line(way: &Way, port: u16, out: &mut [u8]) -> usize {
    let mut at = 0;
    let mut put = |bytes: &[u8], at: &mut usize| -> bool {
        if *at + bytes.len() > out.len() { return false; }
        out[*at..*at + bytes.len()].copy_from_slice(bytes);
        *at += bytes.len();
        true
    };
    let mut digits = [0u8; 5];
    let number = |n: u16, digits: &mut [u8; 5]| -> usize {
        let (mut n, mut from) = (n, 5);
        loop { from -= 1; digits[from] = b'0' + (n % 10) as u8; n /= 10; if n == 0 { break from; } }
    };
    match way {
        Way::Name(name) => { if !put(name, &mut at) { return 0; } }
        Way::Address(a) => {
            for (k, &part) in a.iter().enumerate() {
                if k > 0 && !put(b".", &mut at) { return 0; }
                let from = number(part as u16, &mut digits);
                if !put(&digits[from..], &mut at) { return 0; }
            }
        }
    }
    let from = number(port, &mut digits);
    if !put(b":", &mut at) || !put(&digits[from..], &mut at) || !put(b"\n", &mut at) { return 0; }
    at
}

#[cfg(test)]
#[path = "frame.test.rs"]
mod tests;
