//! SSH into a repo's Prompt from any OpenSSH client. The listener is l3's
//! (l3/src/ssh.rs, `l3 address ssh serve`, started by turning SSH on); what
//! the app and l3 share of it is here:
//!
//!   keys       the Runtime dotfile `.authorized_keys`, one OpenSSH public
//!              key a line (Home keeps dotfiles on the Remote, so a key added
//!              on one device is taken on every one)
//!   port       one a person on a host: 22000 plus their user number, the
//!              same every time (whatever repos there are) and never another
//!              person's on the same host; each repo is reached at it by its
//!              name as the SSH user (`ssh -p 22000 notes@127.0.0.1`)
//!   scope      who may connect, chosen when it is turned on and kept on this
//!              device alone (`<data>/ssh/scope.json`): this device only
//!              (the default: 127.0.0.1 and ::1, so no other PC finds the
//!              port open at all), or PCs on the same network too (each LAN
//!              address of the host besides, and a VPN interface's 100.64/10
//!              one, one by one; never 0.0.0.0, a public address, a carrier's
//!              shared one, a bridge's or a container's, nor IPv6 but ::1),
//!              looked at again every few seconds so an address that goes or
//!              changes is let go; a connection is taken only from the
//!              network of the address it came in on (admit), or from the
//!              device itself
//!   record     `<data>/ssh/listening.json` while the listener runs, as a
//!              running Prompt records itself (prompt/running.rs), so l3 and the app
//!              see it and stop it; the host key beside it, made once
//!   Remote     only that a device listens, and to whom (its scope word),
//!              per device (remote/ssh.ts): no address, port or repo name
//!              leaves the device. The listener says so when it starts and
//!              asks every few seconds whether it still should (off from any
//!              page stops it); where it is reached is worked out and shown
//!              on the device alone (`l3 address`, the app's Runtime)

mod keys;
mod reach;
mod listener;

pub use self::keys::{fingerprint, Key, KEYS, Keys, keys, KINDS, parse_keys};
pub use self::reach::{admit, BASE_PORT, bridge, BRIDGES, canonical, destinations, dir, host, Iface, interfaces, listen_on, listened, port, port_for, repo_names, route_dev, Scope, scope, set_scope, Taken, taken, TRIES, Tries, TRIES_WHILE, vpn, VPNS};
pub use self::listener::{Here, here, host_key, Listening, listening, record, Recorded, rescope, stop};

#[cfg(test)]
#[path = "tests/ssh.rs"]
mod tests;
