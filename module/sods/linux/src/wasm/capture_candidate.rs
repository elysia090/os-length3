//! Separate private artifact identities. Neither is an ordinary admission.
#[cfg(feature = "capture-result-v1")]
use super::{descriptor::CaptureOutput, with_state};
use super::{with_state_access, Access};

#[cfg(not(feature = "capture-result-v1"))]
const PROFILE: u32 = 1;
#[cfg(feature = "capture-result-v1")]
const PROFILE: u32 = 2;

// magic + Core ABI + capture wire version + profile + readiness (candidate).
// Inspect before instantiation; export signatures alone cannot establish it.
#[used]
#[link_section = "sods.linux.capture"]
#[cfg(not(feature = "capture-result-v1"))]
static CAPTURE_ID: [u8; 12] = *b"SODSCAP\0\x07\x01\x01\x00";
#[used]
#[link_section = "sods.linux.capture"]
#[cfg(feature = "capture-result-v1")]
static CAPTURE_ID: [u8; 12] = *b"SODSCAP\0\x07\x05\x02\x00";

#[no_mangle]
pub extern "C" fn linux_capture_candidate() -> u32 {
    PROFILE
}

#[no_mangle]
pub extern "C" fn linux_capture_select(profile: u32) -> i32 {
    with_state_access(Access::CaptureSelection, |s| {
        if profile != PROFILE {
            return Err(-12);
        }
        if s.capture_selected {
            return Err(-4);
        }
        s.capture_selected = true;
        Ok(0)
    })
}

/// Provision the one independent receiver on prepared Files. Preparing it
/// conveys no physical sink, Worker or result, and it cannot be replaced.
#[cfg(feature = "capture-result-v1")]
#[no_mangle]
pub extern "C" fn linux_capture_result_init(maximum_request: u32, queue_bytes: u32) -> i32 {
    with_state(false, |s| {
        let sealed = s.sealed.as_mut().ok_or(-9)?;
        if sealed.root.is_none() {
            return Err(-11);
        }
        if sealed.capture_output.is_some() {
            return Err(-4);
        }
        // Bound the private witness, not the Linux write syscall. Neither
        // startup nor a bad request spends any of the byte/record credits.
        if maximum_request == 0 || maximum_request > queue_bytes || queue_bytes > 64 * 1024 {
            return Err(-5);
        }
        sealed.capture_output = Some(
            CaptureOutput::single_result(
                &mut sealed.files,
                maximum_request as usize,
                queue_bytes as usize,
            )
            .map_err(|_| -1)?,
        );
        Ok(0)
    })
}
