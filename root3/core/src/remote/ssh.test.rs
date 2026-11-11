//! The tests of remote/ssh.rs.

use super::*;

#[test]
fn the_listener_stops_when_turned_off_or_signed_out_and_not_when_the_remote_is_away() {
    assert!(goes_on(Heard::On));
    assert!(goes_on(Heard::Unreachable));
    assert!(!goes_on(Heard::Off));
    assert!(!goes_on(Heard::SignedOut));
    // A 401 (signed out from another device) and no connection here are both signed out; anything else is out of reach.
    assert_eq!(heard_failure(Some(Failure::Unknown)), Heard::SignedOut);
    assert_eq!(heard_failure(Some(Failure::NotConnected)), Heard::SignedOut);
    assert_eq!(heard_failure(Some(Failure::Unreachable)), Heard::Unreachable);
    assert_eq!(heard_failure(Some(Failure::Status(500))), Heard::Unreachable);
    assert_eq!(heard_failure(None), Heard::Unreachable);
}
