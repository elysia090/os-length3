//! Trusted diagnostic relay only; the normal host rejects this artifact.
//! Successful settlement means one independently owned host copy, not I/O.
use super::{queue_probe_error, with_state, with_state_access, Access};

#[derive(Default)]
pub(super) struct Receiver {
    sequence: u64,
    active: Option<View>,
}
struct View {
    lane: u32,
    head: u64,
    generation: u64,
    length: u32,
    uncertain: bool,
}
impl Receiver {
    pub(super) fn blocks(&self, access: Access) -> bool {
        self.active.is_some() && access != Access::ReceiveFinish(self.sequence)
    }
}

#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_receive_head(lane: u32) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        let q = r.queue_probe.as_mut().ok_or(-9)?;
        let Some((head, generation, length)) = q
            .receive_head(&mut r.files, lane)
            .map_err(queue_probe_error)?
        else {
            return Ok(0); // Temporary empty; not EOF or stopped.
        };
        s.auxiliary = head;
        s.length = length as u64;
        Ok(generation)
    })
}

#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_receive_start(
    lane: u32,
    head: u64,
    generation: u64,
) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        let q = r.queue_probe.as_mut().ok_or(-9)?;
        let attempt = s.capture_receiver.sequence.checked_add(1).ok_or(-6)?;
        let (pointer, length) = q
            .receive_start(&mut r.files, lane, head, generation)
            .map_err(queue_probe_error)?;
        s.capture_receiver.active = Some(View {
            lane,
            head,
            generation,
            length: length as u32,
            uncertain: false,
        });
        s.capture_receiver.sequence = attempt;
        s.length = length as u64;
        s.auxiliary = attempt;
        Ok(pointer as u64)
    })
}

#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_receive_finish(
    attempt: u64,
    evidence: u32,
    count: u32,
) -> i32 {
    with_state_access(Access::ReceiveFinish(attempt), |s| {
        let view = s.capture_receiver.active.as_mut().ok_or(-4)?;
        match evidence {
            0 if count == view.length => {
                if view.uncertain {
                    return Err(-4);
                }
                let r = s.sealed.as_mut().ok_or(-9)?;
                let q = r.queue_probe.as_mut().ok_or(-9)?;
                q.receive_commit(&mut r.files, view.lane, view.head, view.generation)
                    .map_err(queue_probe_error)?;
                let length = view.length;
                s.capture_receiver.active = None;
                Ok(u64::from(length))
            }
            1 if count == 0 => {
                s.capture_receiver.active = None;
                Ok(0)
            }
            // Unknown or one-sided access end: preserve the head and retain
            // the guard even at full progress. Do not later promote this copy.
            2..=4 if count <= view.length => {
                view.uncertain = true;
                Ok(0)
            }
            _ => Err(-5),
        }
    })
}
