//! Trusted relay only; the normal host rejects these separate artifacts.
//! Successful settlement means one independently owned host copy, not I/O.
#[cfg(feature = "queued-worker-probe")]
use super::queue_probe_error;
use super::{with_state, with_state_access, Access};
#[cfg(feature = "queued-worker-probe")]
use crate::descriptor::{SinkEvidence, SinkOutcome};

#[derive(Default)]
pub(super) struct Receiver {
    sequence: u64,
    active: Option<View>,
}
struct View {
    #[cfg(feature = "queued-worker-probe")]
    lane: u32,
    head: u64,
    generation: u64,
    length: u32,
    uncertain: bool,
    #[cfg(feature = "queued-worker-probe")]
    sink: bool,
}
impl Receiver {
    pub(super) fn blocks(&self, access: Access) -> bool {
        self.active.is_some() && access != Access::ReceiveFinish(self.sequence)
    }
}

#[no_mangle]
#[cfg(feature = "queued-worker-probe")]
pub extern "C" fn linux_queued_worker_probe_receive_head(lane: u32) -> i32 {
    head(lane, false)
}

#[no_mangle]
#[cfg(feature = "queued-worker-probe")]
pub extern "C" fn linux_queued_worker_probe_sink_head(lane: u32) -> i32 {
    head(lane, true)
}

#[cfg(feature = "capture-result-v1")]
#[no_mangle]
pub extern "C" fn linux_capture_result_head() -> i32 {
    head(0, false)
}

fn head(_lane: u32, _sink: bool) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        #[cfg(feature = "queued-worker-probe")]
        let chunk = r
            .queue_probe
            .as_mut()
            .ok_or(-9)?
            .receive_head(&mut r.files, _lane, _sink)
            .map_err(queue_probe_error)?
            .map(|(head, generation, length)| (head, generation, length, 0));
        #[cfg(feature = "capture-result-v1")]
        let chunk = {
            let (files, output) = r.capture_parts()?;
            output
                .result_head(files)
                .map_err(|_| -10)?
                .map(|(slot, generation, length, origin)| {
                    (u64::from(slot), generation, length, origin as u64)
                })
        };
        let Some((head, generation, length, origin)) = chunk else {
            return Ok(0); // Temporary empty; not EOF or stopped.
        };
        s.auxiliary = head;
        s.length = length as u64;
        s.endpoint = origin;
        Ok(generation)
    })
}

#[no_mangle]
#[cfg(feature = "queued-worker-probe")]
pub extern "C" fn linux_queued_worker_probe_receive_start(
    lane: u32,
    head: u64,
    generation: u64,
) -> i32 {
    start(lane, head, generation, false)
}

#[no_mangle]
#[cfg(feature = "queued-worker-probe")]
pub extern "C" fn linux_queued_worker_probe_sink_copy_start(
    lane: u32,
    head: u64,
    generation: u64,
) -> i32 {
    start(lane, head, generation, true)
}

#[cfg(feature = "capture-result-v1")]
#[no_mangle]
pub extern "C" fn linux_capture_result_copy_start(slot: u32, generation: u64) -> i32 {
    start(0, u64::from(slot), generation, false)
}

fn start(_lane: u32, head: u64, generation: u64, _sink: bool) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        let attempt = s.capture_receiver.sequence.checked_add(1).ok_or(-6)?;
        #[cfg(feature = "queued-worker-probe")]
        let (pointer, length, origin) = r
            .queue_probe
            .as_mut()
            .ok_or(-9)?
            .receive_start(&mut r.files, _lane, head, generation, _sink)
            .map_err(queue_probe_error)
            .map(|(pointer, length)| (pointer, length, 0))?;
        #[cfg(feature = "capture-result-v1")]
        let (pointer, length, origin) = {
            let (files, output) = r.capture_parts()?;
            let (pointer, length, origin) = output
                .result_copy(files, head as u32, generation)
                .map_err(|_| -10)?;
            (pointer, length, origin as u64)
        };
        s.capture_receiver.active = Some(View {
            #[cfg(feature = "queued-worker-probe")]
            lane: _lane,
            head,
            generation,
            length: length as u32,
            uncertain: false,
            #[cfg(feature = "queued-worker-probe")]
            sink: _sink,
        });
        s.capture_receiver.sequence = attempt;
        s.length = length as u64;
        s.auxiliary = attempt;
        s.endpoint = origin;
        Ok(pointer as u64)
    })
}

#[cfg_attr(
    feature = "queued-worker-probe",
    export_name = "linux_queued_worker_probe_receive_finish"
)]
#[cfg_attr(
    feature = "capture-result-v1",
    export_name = "linux_capture_result_copy_finish"
)]
pub(super) extern "C" fn finish(attempt: u64, evidence: u32, count: u32) -> i32 {
    with_state_access(Access::ReceiveFinish(attempt), |s| {
        let view = s.capture_receiver.active.as_mut().ok_or(-4)?;
        match evidence {
            0 if count == view.length => {
                if view.uncertain {
                    return Err(-4);
                }
                let r = s.sealed.as_mut().ok_or(-9)?;
                #[cfg(feature = "queued-worker-probe")]
                r.queue_probe
                    .as_mut()
                    .ok_or(-9)?
                    .receive_commit(
                        &mut r.files,
                        view.lane,
                        view.head,
                        view.generation,
                        view.sink,
                    )
                    .map_err(queue_probe_error)?;
                #[cfg(feature = "capture-result-v1")]
                {
                    let (files, output) = r.capture_parts()?;
                    output
                        .result_commit(files, view.head as u32, view.generation)
                        .map_err(|_| -10)?;
                }
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

#[cfg(feature = "queued-worker-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_sink_bind(lane: u32) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.queue_probe
            .as_mut()
            .ok_or(-9)?
            .sink_bind(lane)
            .map_err(queue_probe_error)?;
        Ok(0)
    })
}

#[cfg(feature = "queued-worker-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_sink_offer(
    lane: u32,
    head: u64,
    generation: u64,
) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        let (action, range) = r
            .queue_probe
            .as_mut()
            .ok_or(-9)?
            .sink_offer(&mut r.files, lane, head, generation)
            .map_err(queue_probe_error)?;
        s.auxiliary = range.start as u64;
        s.length = range.end as u64;
        Ok(action)
    })
}

#[cfg(feature = "queued-worker-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_sink_receipt(
    lane: u32,
    head: u64,
    generation: u64,
    action: u64,
    confirmed: u32,
    evidence: u32,
) -> i32 {
    with_state(false, |s| {
        let evidence = match evidence {
            0 => SinkEvidence::AccessAndEffectsEnded,
            1 => SinkEvidence::Unknown,
            2 => SinkEvidence::AccessEnded,
            3 => SinkEvidence::EffectsStopped,
            _ => return Err(-5),
        };
        let r = s.sealed.as_mut().ok_or(-9)?;
        match r
            .queue_probe
            .as_mut()
            .ok_or(-9)?
            .sink_receipt(
                &mut r.files,
                lane,
                head,
                generation,
                action,
                confirmed,
                evidence,
            )
            .map_err(queue_probe_error)?
        {
            SinkOutcome::Waiting => {}
            SinkOutcome::Suffix(range) => {
                s.state = 1;
                s.auxiliary = range.start as u64;
                s.length = range.end as u64;
            }
            SinkOutcome::Complete => s.state = 2,
        }
        Ok(0)
    })
}

#[cfg(feature = "queued-worker-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_sink_cancel(
    lane: u32,
    head: u64,
    generation: u64,
    action: u64,
) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        r.queue_probe
            .as_mut()
            .ok_or(-9)?
            .sink_cancel(&mut r.files, lane, head, generation, action)
            .map_err(queue_probe_error)?;
        Ok(0)
    })
}

#[cfg(feature = "queued-worker-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_sink_discard(
    lane: u32,
    head: u64,
    generation: u64,
) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        let count = r
            .queue_probe
            .as_mut()
            .ok_or(-9)?
            .sink_discard(&mut r.files, lane, head, generation)
            .map_err(queue_probe_error)?;
        Ok(count as u64)
    })
}

#[cfg(feature = "queued-worker-probe")]
#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_sink_shutdown(lane: u32) -> i32 {
    with_state(false, |s| {
        let r = s.sealed.as_mut().ok_or(-9)?;
        let ended = r
            .queue_probe
            .as_mut()
            .ok_or(-9)?
            .sink_shutdown(&mut r.files, lane)
            .map_err(queue_probe_error)?;
        Ok(u64::from(ended))
    })
}
