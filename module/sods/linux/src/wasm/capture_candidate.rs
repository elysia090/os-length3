//! Selection boundary only. This artifact branch exposes no guest startup.
use super::{with_state_access, Access};

const OWNED_NODE_FILE_V1: u32 = 1;

// magic + Core ABI + capture wire version + profile + readiness (candidate).
// Inspect before instantiation; export signatures alone cannot establish it.
#[used]
#[link_section = "sods.linux.capture"]
static CAPTURE_ID: [u8; 12] = *b"SODSCAP\0\x07\x01\x01\x00";

#[no_mangle]
pub extern "C" fn linux_capture_candidate() -> u32 {
    OWNED_NODE_FILE_V1
}

#[no_mangle]
pub extern "C" fn linux_capture_select(profile: u32) -> i32 {
    with_state_access(Access::CaptureSelection, |s| {
        if profile != OWNED_NODE_FILE_V1 {
            return Err(-12);
        }
        if s.capture_selected {
            return Err(-4);
        }
        s.capture_selected = true;
        Ok(0)
    })
}
