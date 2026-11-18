//! Exact captured producer transport. Only trusted non-reentrant raw relays
//! may borrow a view, and the selected owner never falls back to physical output.
use super::{execution_index, step, token, with_state, with_state_access, Access, State};
#[cfg(feature = "capture-result-v1")]
use crate::descriptor::capture::{Resident, ResidentTurn};
use crate::descriptor::{
    capture::{Access as CopyAccess, CallId, Finished, Receipt, Request},
    CaptureOutput, Target,
};
use crate::effect::Token;
use crate::syscall::Step;
use std::num::NonZeroUsize;

pub(super) enum Active {
    Write {
        execution: u64,
        call: CallId,
        viewing: bool,
    },
    #[cfg(feature = "capture-result-v1")]
    Resident {
        execution: u64,
        sequence: u32,
        retained: Resident,
    },
}
impl Active {
    fn execution(&self) -> u64 {
        match self {
            Self::Write { execution, .. } => *execution,
            #[cfg(feature = "capture-result-v1")]
            Self::Resident { execution, .. } => *execution,
        }
    }
    pub(super) fn blocks(&self, access: Access) -> bool {
        match self {
            Self::Write {
                call,
                execution,
                viewing: true,
            } => {
                access
                    != Access::CaptureFinish {
                        execution: *execution,
                        call: *call,
                    }
            }
            _ => false,
        }
    }
    pub(super) fn owns(&self, action: Token) -> bool {
        matches!(self, Self::Write {call, ..} if call.action == action)
    }
}
/// Only this raw adapter can construct the claim after matching the
/// exclusive exact view. This is not a public or hardware-minted receipt.
pub(crate) struct FinishEvidence(Receipt);
impl FinishEvidence {
    pub(crate) fn receipt(self) -> Receipt {
        self.0
    }
}

fn exact_length(length: u64, output: &CaptureOutput) -> Result<NonZeroUsize, i32> {
    #[cfg(feature = "capture-result-v1")]
    let maximum = output.maximum_request();
    #[cfg(not(feature = "capture-result-v1"))]
    let maximum = {
        let _ = output;
        4
    };
    usize::try_from(length)
        .ok()
        .filter(|n| *n <= maximum)
        .and_then(NonZeroUsize::new)
        .ok_or(-5)
}

/// Sequenced ingress for a selected captured execution. The adapter transports
/// the original request and handles only the returned command. The two narrow
/// producer branches verify captured targets and never try borrowed output.
#[cfg_attr(
    feature = "queued-worker-probe",
    export_name = "linux_queued_worker_probe_request"
)]
pub(super) extern "C" fn request(
    execution: u64,
    invocation: u64,
    sequence: u32,
    nr: u64,
    a: u64,
    b: u64,
    c: u64,
    d: u64,
    e: u64,
    f: u64,
    next: u64,
) -> i32 {
    match nr {
        1 => write(execution, invocation, sequence, a, b, c),
        40 => resident(execution, invocation, sequence, a, b, c, d),
        _ => super::sequenced_syscall(execution, invocation, sequence, nr, a, b, c, d, e, f, next),
    }
}

#[cfg_attr(
    feature = "queued-worker-probe",
    export_name = "linux_queued_worker_probe_write"
)]
extern "C" fn write(
    execution: u64,
    invocation: u64,
    sequence: u32,
    fd: u64,
    at: u64,
    length: u64,
) -> i32 {
    with_state(false, |s| {
        if s.capture_producer.is_some() {
            return Err(-4);
        }
        let index = execution_index(s, execution)?;
        let slot = s.executions[index].live_mut()?;
        let invocation = slot.execution.invocation(invocation).map_err(|_| -11)?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let table = slot.resources.table()?;
        let fd = fd as u32;
        if r.files.target(table, fd).map_err(|_| -12)? != Target::CapturedOutput {
            return Err(-12);
        }
        let (files, output) = r.capture_parts()?;
        let length = exact_length(length, output)?;
        // Reuse the exact continuation gate, not a physical command or an
        // earlier raw Unsupported sentinel.
        let continuation = slot.continuation.as_mut().ok_or(-11)?;
        let context = output.context(files, &mut s.domain, &mut slot.execution);
        let request = Request {
            invocation,
            sequence,
            fd,
            at,
            length,
        };
        #[cfg(feature = "capture-result-v1")]
        let command = continuation.admit_waitable_capture_write(context, table, request);
        #[cfg(not(feature = "capture-result-v1"))]
        let command = continuation.admit_capture_write(context, table, request);
        let command = command.map_err(|_| -12)?;
        let call = match command {
            Step::CaptureWrite { call, .. } => call,
            #[cfg(feature = "capture-result-v1")]
            Step::CapturePressure { call } => call,
            _ => unreachable!("installed exact captured call"),
        };
        s.capture_producer = Some(Active::Write {
            execution,
            call,
            viewing: false,
        });
        Ok(step(s, command))
    })
}

/// The pressure token is interpreted only by the stored producer arm. A
/// file cursor reservation is not a guest-memory token and exposes no view.
#[cfg(feature = "capture-result-v1")]
#[no_mangle]
pub extern "C" fn linux_capture_result_resume(execution: u64, sequence: u32, action: u64) -> i32 {
    with_state(false, |s| {
        let index = execution_index(s, execution);
        let owner = s
            .capture_producer
            .as_mut()
            .filter(|p| p.execution() == execution)
            .ok_or(-4)?;
        let slot = s.executions[index?].live_mut()?;
        let (files, output) = s.sealed.as_mut().ok_or(-9)?.capture_parts()?;
        let mut ctx = output.context(files, &mut s.domain, &mut slot.execution);
        let command = match owner {
            Active::Write {
                call,
                viewing: false,
                ..
            } if call.sequence == sequence && call.action.sequence() == action => slot
                .continuation
                .as_mut()
                .ok_or(-11)?
                .resume_capture_write(ctx, *call)
                .map_err(|_| -12)?,
            Active::Resident {
                sequence: owned,
                retained,
                ..
            } if *owned == sequence => {
                let id = retained
                    .id()
                    .filter(|value| value.get() == action)
                    .ok_or(-4)?;
                let resumed = retained.resume(&mut ctx, id);
                if retained.id().is_none() {
                    s.capture_producer = None;
                }
                match resumed.map_err(|_| -12)? {
                    Some(count) => Step::CapturedAccepted(count.get() as u64),
                    None => Step::CaptureResidentPressure {
                        sequence,
                        source: id,
                    },
                }
            }
            _ => return Err(-4),
        };
        Ok(step(s, command))
    })
}

/// NULL-offset exact resident sendfile into the same held lane as
/// captured writes. This is in-memory acceptance, not physical delivery.
#[cfg_attr(
    feature = "queued-worker-probe",
    export_name = "linux_queued_worker_probe_sendfile"
)]
extern "C" fn resident(
    execution: u64,
    invocation: u64,
    sequence: u32,
    out: u64,
    input: u64,
    offset: u64,
    length: u64,
) -> i32 {
    with_state(false, |s| {
        if s.capture_producer.is_some() {
            return Err(-4);
        }
        if offset != 0 {
            return Err(-5);
        }
        let index = execution_index(s, execution)?;
        let slot = s.executions[index].live_mut()?;
        let invocation = slot.execution.invocation(invocation).map_err(|_| -11)?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let table = slot.resources.table()?;
        let out = out as u32;
        if r.files.target(table, out).map_err(|_| -12)? != Target::CapturedOutput {
            return Err(-12);
        }
        let (files, output) = r.capture_parts()?;
        let length = exact_length(length, output)?;
        slot.continuation
            .as_mut()
            .ok_or(-11)?
            .admit_request(&s.domain, &slot.execution, invocation, Some(sequence))
            .map_err(|_| -12)?;
        #[cfg(feature = "capture-result-v1")]
        let command = match Resident::admit(
            &mut output.context(files, &mut s.domain, &mut slot.execution),
            table,
            out,
            input as u32,
            length,
            invocation,
        )
        .map_err(|_| -12)?
        {
            ResidentTurn::Accepted(count) => Step::CapturedAccepted(count.get() as u64),
            ResidentTurn::Waiting(retained) => {
                let source = retained.id().expect("fresh resident cursor");
                s.capture_producer = Some(Active::Resident {
                    execution,
                    sequence,
                    retained,
                });
                Step::CaptureResidentPressure { sequence, source }
            }
        };
        #[cfg(not(feature = "capture-result-v1"))]
        let command = Step::Return(
            output
                .publish_resident_request(
                    files,
                    table,
                    out,
                    input as u32,
                    length,
                    &mut slot.execution,
                    invocation,
                )
                .map_err(|_| -12)?
                .get() as i64,
        );
        Ok(step(s, command))
    })
}

#[cfg_attr(
    feature = "queued-worker-probe",
    export_name = "linux_queued_worker_probe_start"
)]
#[cfg_attr(
    feature = "capture-result-v1",
    export_name = "linux_capture_result_write_start"
)]
pub(super) extern "C" fn copy_start(execution: u64, sequence: u32, action: u64) -> i32 {
    with_state(false, |s| {
        let index = execution_index(s, execution)?;
        let slot = s.executions[index].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let id = CallId {
            sequence,
            action: token(action),
        };
        let Some(Active::Write {
            execution: owner,
            call,
            viewing,
        }) = s.capture_producer.as_mut()
        else {
            return Err(-4);
        };
        if *owner != execution || *call != id {
            return Err(-4);
        }
        let (files, output) = r.capture_parts()?;
        let (pointer, at, length) = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .start_raw_capture(
                output.context(files, &mut s.domain, &mut slot.execution),
                id,
            )
            .map_err(|_| -12)?;
        // One scalar checks this exact view before other execution scans. No
        // pointer escapes until the guard is installed; the guard is not stop.
        *viewing = true;
        s.auxiliary = at;
        s.length = length as u64;
        Ok(pointer as u64)
    })
}

#[cfg_attr(
    feature = "queued-worker-probe",
    export_name = "linux_queued_worker_probe_finish"
)]
#[cfg_attr(
    feature = "capture-result-v1",
    export_name = "linux_capture_result_write_finish"
)]
pub(super) extern "C" fn copy_finish(
    execution: u64,
    sequence: u32,
    action: u64,
    evidence: u32,
    count: u32,
) -> i32 {
    let id = CallId {
        sequence,
        action: token(action),
    };
    let access = Access::CaptureFinish {
        execution,
        call: id,
    };
    with_state_access(access, |s| {
        let index = execution_index(s, execution)?;
        let slot = s.executions[index].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        if !matches!(&s.capture_producer, Some(Active::Write {execution: owner, call, viewing: true})
            if *owner == execution && *call == id)
        {
            return Err(-4);
        }
        let (complete, access) = match evidence {
            0 => (Some(count as usize), CopyAccess::BothEnded),
            1 if count == 0 => (None, CopyAccess::BothEnded),
            2 => ((count != 0).then_some(count as usize), CopyAccess::Unknown),
            3 => (
                (count != 0).then_some(count as usize),
                CopyAccess::SourceEnded,
            ),
            4 => (
                (count != 0).then_some(count as usize),
                CopyAccess::StageEnded,
            ),
            _ => return Err(-5),
        };
        let receipt = FinishEvidence(Receipt { complete, access });
        let (files, output) = r.capture_parts()?;
        let finish = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .finish_raw_capture(
                &mut output.context(files, &mut s.domain, &mut slot.execution),
                id,
                receipt,
            )
            .map_err(|_| -12)?;
        let command = match finish {
            Finished::Waiting => return Ok(step(s, Step::Waiting)),
            #[cfg(feature = "capture-result-v1")]
            Finished::Accepted(length) => Step::CapturedAccepted(length.get() as u64),
            #[cfg(not(feature = "capture-result-v1"))]
            Finished::Accepted(length) => Step::Return(length.get() as i64),
            Finished::Discarded | Finished::Rejected(_) => Step::Waiting,
        };
        s.capture_producer = None;
        Ok(step(s, command))
    })
}

pub(super) fn abandon(s: &mut State, execution: u64) -> Result<bool, i32> {
    let index = execution_index(s, execution)?;
    let Some(owner) = s
        .capture_producer
        .as_mut()
        .filter(|p| p.execution() == execution)
    else {
        return Ok(true);
    };
    let slot = s.executions[index].live_mut()?;
    let (files, output) = s.sealed.as_mut().ok_or(-9)?.capture_parts()?;
    let mut ctx = output.context(files, &mut s.domain, &mut slot.execution);
    let ended = match owner {
        Active::Write { call, .. } => slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .cancel_capture(&mut ctx, *call)
            .map_err(|_| -12)?,
        #[cfg(feature = "capture-result-v1")]
        Active::Resident { retained, .. } => {
            let id = retained.id().ok_or(-4)?;
            retained.cancel(&mut ctx, id).map_err(|_| -12)?;
            true
        }
    };
    if ended {
        s.capture_producer = None;
    }
    Ok(ended)
}
