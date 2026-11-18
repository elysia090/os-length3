//! Which way a link to an address is made, from what the address is.

use crate::names::{number, Names};

/// Where a link goes: to a name cowboy gave the address to, or to the address as it stands.
#[derive(Debug, PartialEq, Eq)]
pub enum Way<'a> {
    Name(&'a [u8]),
    Address([u8; 4]),
}

/// The way to `address`. None where there is none: an address of cowboy's own that no name was given (nothing asked
/// for it), the resolver's own, or the machine's own (which never comes here: the machine answers it itself).
pub fn to(names: &Names, address: [u8; 4]) -> Option<Way<'_>> {
    if address[0] == 127 || address == [0; 4] { return None; }
    if address[0] == 198 && (address[1] == 18 || address[1] == 19) {
        return number(address).and_then(|n| names.name(n)).map(Way::Name);
    }
    Some(Way::Address(address))
}

#[cfg(test)]
#[path = "route.test.rs"]
mod tests;
